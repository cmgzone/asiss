/**
 * PolicyEngine — Hermes Evolution Phase 5.
 *
 * The authorization layer in front of every tool execution:
 *
 *   TOOL REQUEST
 *        |
 *   PolicyEngine
 *        |
 *   ALLOW | ASK | DENY
 *
 * Design rule: the DEFAULT configuration preserves current behavior — every
 * config-driven rule defaults to 'allow', and an unresolved ASK defaults to
 * allow. Only the always-on rules (workspace guard, allow/deny lists when
 * explicitly configured, agent permissions when granted) can deny by default.
 *
 * An ASK verdict is resolved through an approval handler (injected at engine
 * construction or per call via PolicyContext.approve). With no handler it
 * falls back to `policy.approval.defaultOutcome` (default 'allow'), so
 * adopting the engine never blocks work that ran before.
 */

import {
  ApprovalHandler,
  PolicyCheck,
  PolicyConfig,
  PolicyContext,
  PolicyVerdict,
  TaskRiskLevel,
  ToolRequest
} from './policy-types';
import { BUILT_IN_RULES, RuleInput, RuleResult } from './policy-rules';

export interface PolicyEngineOptions {
  /** Approval handler used to resolve ASK verdicts (engine-level default). */
  approvalHandler?: ApprovalHandler;
  /** Task risk reader: given a taskId, returns its risk level (or undefined). */
  getTaskRisk?: (taskId: string) => TaskRiskLevel | undefined;
  /** Compatibility with ToolEngineDeps.enforceAllowDeny. */
  enforceAllowDeny?: boolean;
  allowedTools?: string[];
  deniedTools?: string[];
}

export class PolicyEngine {
  private readonly approvalHandler?: ApprovalHandler;
  private readonly getTaskRisk?: (taskId: string) => TaskRiskLevel | undefined;
  private readonly baseConfig: Partial<PolicyConfig>;

  constructor(options: PolicyEngineOptions = {}) {
    this.approvalHandler = options.approvalHandler;
    this.getTaskRisk = options.getTaskRisk;
    this.baseConfig = {
      enforceAllowDeny: options.enforceAllowDeny,
      allowedTools: options.allowedTools,
      deniedTools: options.deniedTools
    };
  }

  /** Merge engine-level defaults with the per-request config. */
  private resolveConfig(ctx: PolicyContext): PolicyConfig {
    const policy: any = (ctx.config as any)?.policy || {};
    return {
      ...this.baseConfig,
      ...policy
    };
  }

  /** Resolve the task risk level for a request. */
  private resolveTaskRisk(ctx: PolicyContext): TaskRiskLevel {
    if (ctx.taskRisk) return ctx.taskRisk;
    if (ctx.taskId && this.getTaskRisk) {
      const fromTask = this.getTaskRisk(ctx.taskId);
      if (fromTask) return fromTask;
    }
    return 'low';
  }

  /**
   * Evaluate one tool request. Never throws: policy decisions are returned,
   * not raised. Returns a verdict with every rule check for observability.
   */
  async evaluate(request: ToolRequest, ctx: PolicyContext = {}): Promise<PolicyVerdict> {
    const config = this.resolveConfig(ctx);
    const taskRisk = this.resolveTaskRisk(ctx);

    if (config.enabled === false) {
      return {
        tool: request.name,
        arguments: (request.arguments as Record<string, unknown>) || {},
        decision: 'ALLOW',
        reasons: ['Policy engine disabled (policy.enabled = false).'],
        checks: [{ rule: 'policy-disabled', decision: 'N/A', reason: 'policy.enabled = false', risk: 0, config: 'policy.enabled' }],
        risk: 0,
        taskRisk
      };
    }

    const input: RuleInput = {
      request,
      config,
      native: ctx.native === true,
      projectId: ctx.projectId,
      workspacePath: ctx.workspacePath,
      agentPermissions: ctx.agentPermissions,
      taskRisk
    };

    const checks: PolicyCheck[] = [];
    for (const rule of BUILT_IN_RULES) {
      const result: RuleResult = rule(input);
      if (result) checks.push(result);
    }

    const reasons = checks
      .filter((c) => c.decision !== 'ALLOW')
      .map((c) => c.reason)
      .filter(Boolean) as string[];
    const risk = checks.reduce((max, c) => Math.max(max, c.risk), 0);

    const denies = checks.filter((c) => c.decision === 'DENY');
    if (denies.length > 0) {
      return {
        tool: request.name,
        arguments: (request.arguments as Record<string, unknown>) || {},
        decision: 'DENY',
        reasons: reasons.length > 0 ? reasons : ['Denied by policy.'],
        checks,
        risk,
        taskRisk,
        listBased: denies.some((c) => c.rule === 'allow-deny-lists')
      };
    }

    const asks = checks.filter((c) => c.decision === 'ASK');
    if (asks.length > 0) {
      // High-risk tasks escalate ASK -> DENY when configured.
      if (taskRisk === 'high' && config.escalateAskOnHighRisk !== false) {
        return {
          tool: request.name,
          arguments: (request.arguments as Record<string, unknown>) || {},
          decision: 'DENY',
          reasons: [...reasons, `ASK escalated to DENY: task risk is ${taskRisk}.`],
          checks,
          risk,
          taskRisk
        };
      }
      const pending: PolicyVerdict = { tool: request.name, arguments: (request.arguments as Record<string, unknown>) || {}, decision: 'ASK', reasons, checks, risk, taskRisk };
      const approve = ctx.approve || this.approvalHandler;
      let approved: boolean;
      if (typeof approve === 'function') {
        try {
          approved = Boolean(await approve(pending, ctx));
        } catch {
          approved = false;
        }
      } else {
        approved = config.approval?.defaultOutcome !== 'deny';
      }
      if (approved) {
        return { ...pending, decision: 'ALLOW', approved: true };
      }
      return { ...pending, decision: 'DENY', approved: false };
    }

    return { tool: request.name, arguments: (request.arguments as Record<string, unknown>) || {}, decision: 'ALLOW', reasons, checks, risk, taskRisk };
  }
}

/** Process-wide default PolicyEngine (default = allow everything that ran before). */
export const policyEngine = new PolicyEngine();
