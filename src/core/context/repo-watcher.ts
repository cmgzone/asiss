/**
 * Repository event-warming — Hermes Evolution Phase 9 (suggestion 2).
 *
 * Instead of waiting for the next mission turn to refresh the repository
 * index, subscribe to the TaskEventBus and refresh as soon as a workspace-
 * mutating tool completes:
 *
 *   apply_patch -> ToolCompleted -> TaskEventBus -> warmOnToolEvents
 *                                              -> refreshRepository (debounced)
 *                                              -> fresh symbols
 *
 * Debouncing collapses bursts of tool completions into one incremental
 * refresh. Returns an unsubscribe that also cancels the pending debounce.
 */

import { TaskEvent, TaskEventBus } from '../task/task-events';
import { ContextEngine } from './context-engine';

/** Tools that can change files in the workspace. */
export const MUTATING_TOOLS = new Set([
  'apply_patch',
  'shell',
  'write_file',
  'edit_file',
  'create_file',
  'delete_file',
  'move_file',
  'rename_file',
  'copy_file'
]);

export interface WarmOnToolEventsOptions {
  /** Min gap between refreshes triggered by events (ms). Default 500. */
  debounceMs?: number;
  sessionId?: string;
  taskId?: string;
  /** Refresh only these tools; defaults to MUTATING_TOOLS. */
  tools?: ReadonlySet<string>;
}

/**
 * Subscribe a workspace root to tool-completion events and refresh its index
 * (debounced) when a mutating tool finishes — successfully or not (a failed
 * patch may still have written files). Returns an unsubscribe function.
 */
export function warmOnToolEvents(
  bus: TaskEventBus,
  root: string,
  engine: ContextEngine,
  options: WarmOnToolEventsOptions = {}
): () => void {
  const debounceMs = options.debounceMs ?? 500;
  const tools = options.tools || MUTATING_TOOLS;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const trigger = (): void => {
    engine.refreshRepository(root, {
      force: true,
      sessionId: options.sessionId,
      taskId: options.taskId
    });
  };

  const handle = (event: TaskEvent): void => {
    if (event.name !== 'ToolCompleted' && event.name !== 'ToolFailed') return;
    const tool = typeof event.data?.tool === 'string' ? event.data.tool : '';
    if (!tool || !tools.has(tool)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      trigger();
    }, debounceMs);
  };

  const unsubscribe = bus.on('*', handle);
  return () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    unsubscribe();
  };
}
