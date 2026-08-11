/**
 * TaskEventBus <-> hookManager bridge — Hermes Evolution Phase 3.
 *
 * Subscribes to task/tool lifecycle events and forwards them onto the existing
 * hook bus (audit JSONL + any hook subscribers). Systems like telemetry and
 * recovery can then observe the canonical Task system by subscribing to
 * hookManager — or directly to the TaskEventBus — without AgentRunner knowing.
 *
 *   TaskEngine --emits--> TaskEventBus
 *                                |
 *                          (this bridge)
 *                                v
 *                            hookManager (audit + subscribers)
 */

import { TaskEvent, TaskEventBus, taskEventBus } from './task-events';
import { HookEventName, hookManager } from '../hooks';

/** Minimal structural type so tests can pass a mock sink. */
export interface TaskHooksSink {
  emit(name: string, data: Record<string, unknown>, sessionId?: string): Promise<void> | void;
}

/**
 * Phase 12 D3: legacy tool-lifecycle aliases.
 *
 * AgentRunner used to emit `before_tool`/`after_tool`/`tool_error` directly to
 * hookManager, parallel to the canonical ToolStarted/ToolCompleted/ToolFailed
 * bus events (two observations of one lifecycle). The runner no longer emits
 * anything for the tool lifecycle; the bus is the single source. These aliases
 * forward the canonical events onto hookManager under the legacy names (with
 * equivalent payloads) so existing hook subscribers and the audit file keep
 * working unchanged.
 */
const TOOL_LIFECYCLE_ALIASES: Partial<Record<string, { name: HookEventName; payload: (event: TaskEvent) => Record<string, unknown> }>> = {
  ToolStarted: {
    name: 'before_tool',
    payload: (event) => ({
      tool: event.data?.tool,
      arguments: event.data?.arguments || {},
      ...(event.data?.projectId ? { projectId: event.data.projectId } : {}),
      taskId: event.taskId
    })
  },
  ToolCompleted: {
    name: 'after_tool',
    payload: (event) => ({
      tool: event.data?.tool,
      success: true,
      ...(event.data?.output !== undefined ? { output: String(event.data.output).slice(0, 5_000) } : {}),
      ...(event.data?.durationMs !== undefined ? { durationMs: event.data.durationMs } : {}),
      taskId: event.taskId
    })
  },
  ToolFailed: {
    name: 'tool_error',
    payload: (event) => ({
      tool: event.data?.tool,
      error: String(event.data?.error || 'Unknown error'),
      ...(event.data?.durationMs !== undefined ? { durationMs: event.data.durationMs } : {}),
      taskId: event.taskId
    })
  }
};

/**
 * Install the bridge on a bus (defaults to the process-wide bus and the real
 * hookManager). Returns an unsubscribe function.
 */
export function installTaskHooksBridge(
  bus: TaskEventBus = taskEventBus,
  hooks: TaskHooksSink = hookManager
): () => void {
  return bus.on('*', async (event: TaskEvent) => {
    try {
      const data: Record<string, unknown> = { ...(event.data || {}), taskId: event.taskId };
      const sessionId = typeof event.data?.sessionId === 'string' ? event.data.sessionId : undefined;
      await hooks.emit(event.name, data, sessionId);
      // Phase 12 D3: also forward the legacy tool-lifecycle hook names so
      // pre-bridge subscribers (audit consumers) see the same names/payloads
      // the runner used to emit, now sourced from the canonical bus events.
      const alias = TOOL_LIFECYCLE_ALIASES[event.name];
      if (alias) {
        await hooks.emit(alias.name, alias.payload(event), sessionId);
      }
    } catch (error) {
      // The bridge must never break task execution.
      console.warn(`[TaskHooksBridge] failed to forward ${event.name}:`, error);
    }
  });
}

/**
 * Auto-installed when this module is imported, so the app observes task events
 * through hookManager without any wiring in AgentRunner. The default bus is
 * only used by the default TaskEngine, so isolated test engines are unaffected.
 */
export const taskHooksBridge = installTaskHooksBridge();
