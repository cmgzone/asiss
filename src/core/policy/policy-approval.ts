/**
 * ApprovalCoordinator — Hermes Evolution Phase 5 (the finished ASK path).
 *
 * Turns an ASK verdict into a real user decision instead of silently resolving
 * it with the default outcome:
 *
 *   PolicyEngine -> ASK
 *        |
 *   ApprovalCoordinator.requestApproval()
 *        |
 *   TaskEvent 'ApprovalRequired'   (bus -> hookManager audit -> UI via gateway)
 *        |
 *   user Allow / Deny
 *        |
 *   ApprovalCoordinator.resolveApproval(id, allowed)
 *        |
 *   TaskEvent 'ApprovalGranted' | 'ApprovalDenied'  (+ Task decision record)
 *        |
 *   PolicyEngine executes or blocks
 *
 * The coordinator is gateway-agnostic: it emits TaskEvents (which the bridge
 * already forwards to hookManager) and records the decision on the canonical
 * Task, so every client observes the same state. The host (AgentRunner) is
 * responsible for pushing those events to its gateway and for routing user
 * responses back into resolveApproval().
 */

import { randomUUID } from 'crypto';
import { TaskEngine, TaskEventBus, taskEventBus } from '../task';
import { PolicyCheck, PolicyContext, PolicyVerdict } from './policy-types';

export type ApprovalStatus = 'pending' | 'allowed' | 'denied';

export interface ApprovalRequest {
  id: string;
  taskId?: string;
  sessionId?: string;
  tool: string;
  arguments?: Record<string, unknown>;
  /** Overall risk score 0-100 from the policy verdict. */
  risk: number;
  riskLabel: 'low' | 'medium' | 'high';
  reasons: string[];
  checks: PolicyCheck[];
  createdAt: number;
  status: ApprovalStatus;
}

export interface ApprovalCoordinatorOptions {
  /** TaskEventBus to emit on (defaults to the process-wide bus). */
  bus?: TaskEventBus;
  /** TaskEngine to record the decision on the canonical Task. */
  taskEngine?: TaskEngine;
  /** How long to wait for the user before resolving the request. */
  timeoutMs?: number;
  /** What an unanswered request resolves to. Default 'deny' (fail closed). */
  onTimeout?: 'allow' | 'deny';
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

function riskLabel(risk: number): 'low' | 'medium' | 'high' {
  if (risk >= 67) return 'high';
  if (risk >= 34) return 'medium';
  return 'low';
}

export class ApprovalCoordinator {
  private readonly bus: TaskEventBus;
  private readonly taskEngine?: TaskEngine;
  private readonly timeoutMs: number;
  private readonly onTimeout: 'allow' | 'deny';
  private readonly pending = new Map<string, {
    request: ApprovalRequest;
    resolve: (allowed: boolean) => void;
    timer: NodeJS.Timeout;
  }>();

  constructor(options: ApprovalCoordinatorOptions = {}) {
    this.bus = options.bus || taskEventBus;
    this.taskEngine = options.taskEngine;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.onTimeout = options.onTimeout || 'deny';
  }

  pendingCount(): number {
    return this.pending.size;
  }

  listPending(): ApprovalRequest[] {
    return Array.from(this.pending.values()).map((e) => e.request);
  }

  get(approvalId: string): ApprovalRequest | undefined {
    return this.pending.get(approvalId)?.request;
  }

  /**
   * PolicyEngine approval handler: registers the request, emits
   * ApprovalRequired, and waits for the user (or the timeout). Never throws —
   * an error or timeout still resolves to a decision.
   */
  async requestApproval(verdict: PolicyVerdict, ctx: PolicyContext): Promise<boolean> {
    const request: ApprovalRequest = {
      id: randomUUID(),
      taskId: ctx.taskId,
      sessionId: ctx.sessionId,
      tool: verdict.tool,
      arguments: verdict.arguments ? { ...verdict.arguments } : undefined,
      risk: verdict.risk,
      riskLabel: riskLabel(verdict.risk),
      reasons: verdict.reasons,
      checks: verdict.checks,
      createdAt: Date.now(),
      status: 'pending'
    };

    const decision = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        const allowed = this.onTimeout === 'allow';
        void this.emitDecision(request, allowed, undefined, `timed out after ${this.timeoutMs}ms`);
        resolve(allowed);
      }, this.timeoutMs);
      this.pending.set(request.id, { request, resolve, timer });
    });

    // Emit AFTER registering so a fast response cannot resolve an unknown id.
    await this.emit(request, 'ApprovalRequired');
    return decision;
  }

  /**
   * Resolve a pending approval (called by the host when the user answers, or
   * by any client via the gateway). Emits the decision TaskEvent, records it
   * on the Task, and unblocks the waiting tool call.
   */
  async resolveApproval(
    approvalId: string,
    allowed: boolean,
    opts: { userId?: string } = {}
  ): Promise<ApprovalRequest | undefined> {
    const entry = this.pending.get(approvalId);
    if (!entry) return undefined;
    clearTimeout(entry.timer);
    this.pending.delete(approvalId);
    entry.request.status = allowed ? 'allowed' : 'denied';
    await this.emitDecision(entry.request, allowed, opts.userId);
    entry.resolve(allowed);
    return entry.request;
  }

  private async emitDecision(
    request: ApprovalRequest,
    allowed: boolean,
    userId?: string,
    note?: string
  ): Promise<void> {
    if (request.taskId && this.taskEngine) {
      try {
        await this.taskEngine.recordDecision(
          request.taskId,
          `${allowed ? 'User approved' : 'User denied'} tool '${request.tool}'${userId ? ` (${userId})` : ''}${note ? ` — ${note}` : ''}.`,
          JSON.stringify({
            approvalId: request.id,
            tool: request.tool,
            allowed,
            risk: request.risk,
            reasons: request.reasons,
            userId: userId || null
          })
        );
      } catch (taskError: any) {
        console.warn('[ApprovalCoordinator] record decision failed:', taskError?.message || taskError);
      }
    }
    await this.emit(request, allowed ? 'ApprovalGranted' : 'ApprovalDenied', { allowed, userId, note });
  }

  private async emit(
    request: ApprovalRequest,
    name: 'ApprovalRequired' | 'ApprovalGranted' | 'ApprovalDenied',
    extra: Record<string, unknown> = {}
  ): Promise<void> {
    await this.bus.emit({
      name,
      taskId: request.taskId || '',
      timestamp: Date.now(),
      data: {
        approvalId: request.id,
        sessionId: request.sessionId,
        tool: request.tool,
        arguments: request.arguments,
        risk: request.risk,
        riskLabel: request.riskLabel,
        reasons: request.reasons,
        ...extra
      }
    });
  }
}

/** Process-wide default coordinator (no task engine attached; hosts wire one). */
export const approvalCoordinator = new ApprovalCoordinator();
