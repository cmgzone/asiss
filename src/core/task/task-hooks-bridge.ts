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
import { hookManager } from '../hooks';

/** Minimal structural type so tests can pass a mock sink. */
export interface TaskHooksSink {
  emit(name: string, data: Record<string, unknown>, sessionId?: string): Promise<void> | void;
}

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
