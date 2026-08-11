/**
 * PolicyEngine types — Hermes Evolution Phase 5.
 *
 * The authorization layer in front of every tool execution:
 *
 *   TOOL REQUEST
 *        |
 *   PolicyEngine
 *        |
 *   ALLOW | ASK | DENY
 *
 * The verdict carries per-rule checks and a risk score so telemetry and the
 * audit trail can explain WHY a tool was denied, asked about, or allowed —
 * instead of a bare boolean.
 */

import { ToolRequest, ToolContext } from '../tools/tool-result';

export type PolicyDecision = 'ALLOW' | 'ASK' | 'DENY';

export type TaskRiskLevel = 'low' | 'medium' | 'high';

/** One evaluated rule within a verdict (observability + audit). */
export interface PolicyCheck {
  /** Rule identifier, e.g. 'workspace-guard', 'destructive-command'. */
  rule: string;
  decision: PolicyDecision | 'N/A';
  reason?: string;
  /** 0-100 contribution to the overall risk score. */
  risk: number;
  /** Which config knob drove this decision, e.g. 'policy.destructiveCommands'. */
  config?: string;
}

export interface PolicyVerdict {
  /** The tool this verdict applies to. */
  tool: string;
  /** The request arguments, for approval UIs and audit. */
  arguments?: Record<string, unknown>;
  decision: PolicyDecision;
  /** Human-readable summary of why. */
  reasons: string[];
  /** Every rule evaluated for this request. */
  checks: PolicyCheck[];
  /** Overall risk score (max of checks), 0-100. */
  risk: number;
  /** Task risk level considered during evaluation. */
  taskRisk: TaskRiskLevel;
  /** True when an ASK was resolved to allow by an approval handler / default. */
  approved?: boolean;
  /** True when the decision came from the allow/deny lists. */
  listBased?: boolean;
}

export type ApprovalHandler = (verdict: PolicyVerdict, ctx: PolicyContext) => Promise<boolean> | boolean;

/** Per-call / per-request context for policy evaluation. */
export interface PolicyContext extends ToolContext {
  /** True when the request resolves to a native skill (workspace guard scope). */
  native?: boolean;
}

/** Policy configuration — resolved from `config.policy` (all optional). */
export interface PolicyConfig {
  /** Master switch. false = always ALLOW (no checks). Default true. */
  enabled?: boolean;
  /** Workspace guard (shell/apply_patch/write_file need a workspace). Default true. */
  workspaceGuard?: boolean;
  /** Destructive shell commands (rm -rf, git push --force, drop table, ...). Default 'allow'. */
  destructiveCommands?: 'allow' | 'ask' | 'deny';
  /** Shell commands that look like they handle secrets (.env, keys, tokens). Default 'allow'. */
  secretScan?: 'allow' | 'ask' | 'deny';
  /** Tools that touch the network (web_search, web_fetch, playwright, ...). Default 'allow'. */
  networkTools?: 'allow' | 'ask' | 'deny';
  /** Workspace-mutating tools (apply_patch, write_file). Default 'allow'. */
  fileWrites?: 'allow' | 'ask' | 'deny';
  /** Elevated / remote-mutating commands (sudo, curl|sh, git push, npm publish). Default 'allow'. */
  elevatedCommands?: 'allow' | 'ask' | 'deny';
  /** Explicit allow/deny tool lists (native tools only, matching Phase 4 scope). */
  allowedTools?: string[];
  deniedTools?: string[];
  /** Compatibility with ToolEngineDeps.enforceAllowDeny. Default false. */
  enforceAllowDeny?: boolean;
  /** What an unresolved ASK falls back to. Default 'allow' (keeps current behavior). */
  approval?: { defaultOutcome?: 'allow' | 'deny' };
  /** Escalate ASK -> DENY for high-risk tasks. Default false. */
  escalateAskOnHighRisk?: boolean;
}

export type { ToolRequest };
