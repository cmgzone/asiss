/**
 * Typed event-to-channel projection — architecture review Move 3.
 *
 * Replaces the hand-wired TaskEvent forwards in AgentRunner (approval ×3,
 * repository warmth ×1) with one typed table: `TaskEventName -> stream-event
 * factory`. Adding a TaskEvent to the union grows the table type, so every
 * host that installs projections is forced to decide whether the event has a
 * channel representation. Events without an entry are simply not routed.
 *
 * The bus stays the only coupling: installers subscribe (never emit), so
 * TaskEngine and ContextEngine remain unaware of the gateway, the web UI, or
 * Telegram — exactly like the hooks bridge already does for audit.
 */

import { TaskEvent, TaskEventBus, TaskEventName, taskEventBus } from './task-events';
import { StreamEventPayload } from '../types';

/** Turns one TaskEvent into a client-facing stream event (null = don't send). */
export type TaskEventProjection = (event: TaskEvent) => StreamEventPayload | null | undefined;

/** Enough of the gateway to deliver stream events (structural). */
export interface StreamEventSink {
  sendStreamEvent(sessionId: string, event: StreamEventPayload): Promise<void> | void;
}

/**
 * The canonical projection table. `Partial` over the full event-name union:
 * events without a channel representation are explicitly absent here.
 */
export const TASK_EVENT_PROJECTIONS: Partial<Record<TaskEventName, TaskEventProjection>> = {
  // Phase 5 ASK path: approvals are streamed so every client renders the card.
  ApprovalRequired: (event) => {
    const approvalId = String(event.data?.approvalId || '');
    return {
      type: 'approval_required',
      runId: `approval:${approvalId}`,
      messageId: `approval:${approvalId}`,
      approvalId,
      name: String(event.data?.tool || 'tool'),
      tool: String(event.data?.tool || 'tool'),
      arguments: event.data?.arguments,
      risk: Number(event.data?.risk || 0),
      riskLabel: String(event.data?.riskLabel || 'low'),
      reasons: Array.isArray(event.data?.reasons) ? (event.data.reasons as string[]) : []
    };
  },
  ApprovalGranted: (event) => approvalDecision(event, true),
  ApprovalDenied: (event) => approvalDecision(event, false),

  // Phase 9 telemetry: index warmth refreshes reach the sidebar indicator.
  RepositoryIndexRefreshed: (event) => ({
    type: 'repository_refreshed',
    runId: 'repo-index',
    messageId: 'repo-index',
    root: String(event.data?.root || ''),
    fileCount: Number(event.data?.fileCount || 0),
    filesReParsed: Number(event.data?.filesReParsed || 0),
    symbolsRefreshed: Number(event.data?.symbolsRefreshed || 0),
    timestamp: Number(event.timestamp || Date.now())
  }),

  // Move 2 recovery events: one compact stream type, stage-discriminated, so
  // clients can render "diagnosing / verified / verification failed / test
  // passed / test failed" without the runner wiring anything.
  TaskVerifying: (event) => recoveryEvent(event, 'verifying'),
  TaskVerified: (event) => recoveryEvent(event, 'verified'),
  TaskVerificationFailed: (event) => recoveryEvent(event, 'verification_failed'),
  TestPassed: (event) => recoveryEvent(event, 'test_passed'),
  TestFailed: (event) => recoveryEvent(event, 'test_failed')
};

function approvalDecision(event: TaskEvent, allowed: boolean): StreamEventPayload {
  const approvalId = String(event.data?.approvalId || '');
  return {
    type: allowed ? 'approval_granted' : 'approval_denied',
    runId: `approval:${approvalId}`,
    messageId: `approval:${approvalId}`,
    approvalId,
    tool: String(event.data?.tool || 'tool'),
    allowed
  };
}

function recoveryEvent(
  event: TaskEvent,
  stage: 'verifying' | 'verified' | 'verification_failed' | 'test_passed' | 'test_failed'
): StreamEventPayload {
  return {
    type: 'recovery',
    runId: `recovery:${event.taskId}`,
    messageId: `recovery:${event.taskId}:${event.timestamp}`,
    status: stage,
    name: String(event.data?.command || event.data?.detail || ''),
    output: event.data?.detail !== undefined ? String(event.data.detail) : undefined,
    ...(event.data?.exitCode !== undefined ? { error: String(event.data.exitCode) } : {})
  };
}

export interface TaskEventProjectionOptions {
  /** Event table to install (defaults to the canonical table). */
  table?: Partial<Record<TaskEventName, TaskEventProjection>>;
  /** Bus to subscribe on (defaults to the process-wide bus). */
  bus?: TaskEventBus;
}

/**
 * Subscribe the sink to every projected TaskEvent. Returns an unsubscribe that
 * detaches all handlers. Never throws: a projection failure is logged per
 * event and the stream continues.
 */
export function installTaskEventProjections(
  sink: StreamEventSink,
  options: TaskEventProjectionOptions = {}
): () => void {
  const table = options.table || TASK_EVENT_PROJECTIONS;
  const bus = options.bus || taskEventBus;
  const unsubscribers: Array<() => void> = [];
  for (const name of Object.keys(table) as TaskEventName[]) {
    const project = table[name];
    if (!project) continue;
    unsubscribers.push(bus.on(name, (event) => {
      try {
        const payload = project(event);
        if (!payload) return;
        const sessionId = String(event.data?.sessionId || '');
        if (!sessionId) return;
        void sink.sendStreamEvent(sessionId, payload);
      } catch (error) {
        console.warn(`[TaskEventProjection] ${name} projection failed:`, error);
      }
    }));
  }
  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}
