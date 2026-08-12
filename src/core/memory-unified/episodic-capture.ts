/**
 * EpisodicCapture — Phase 14 Move 2 (docs/hermes/MEMORY_AUDIT.md).
 *
 * Experience history from the canonical Task lifecycle. Subscribes to the
 * TaskEventBus terminal events (TaskCompleted / TaskFailed / TaskCancelled)
 * and projects each terminal task's outcome into a bounded in-memory episode
 * feed — the "what actually happened" episodic view, deduped by task id and
 * kept to the most recent N across sessions.
 *
 * Restart resilience: on construction the feed is seeded from the durable
 * TaskEngine store (terminal tasks with outcome summaries), so a fresh
 * process still recalls recent episodes without the old process alive. The
 * feed itself is ephemeral by design — durable record persistence lands with
 * Move 3 (consolidation/lifecycle).
 */

import type { TaskEngine, TaskEventBus, TaskEventName } from '../task';
import type { MemoryProvider } from './memory-catalog';
import {
  createMemoryRecord,
  memoryRecordId,
  recordSessionId,
  type MemoryRecord
} from './memory-record';

const TERMINAL_EVENTS: TaskEventName[] = ['TaskCompleted', 'TaskFailed', 'TaskCancelled'];

/**
 * Outcome evidence from a canonical Task: the AgentResult report first, then
 * the recorded failure (failTask stores failures, not outcome.result). Shared
 * by the episodic capture (Move 2) and the task lesson bridge (Move 5).
 */
export function taskOutcomeSummary(task: any): string {
  const result: any = task.outcome?.result;
  if (result?.summary) return String(result.summary);
  if (result?.finalOutput) return String(result.finalOutput);
  if (task.outcome?.summary) return String(task.outcome.summary);
  if (task.status === 'FAILED') {
    const failure = task.failures?.[task.failures.length - 1];
    if (failure?.error) return `Failed: ${String(failure.error)}`;
    if (task.goal) return `Failed: ${String(task.goal)}`;
    return 'Task failed.';
  }
  return '';
}

export interface EpisodicCaptureOptions {
  bus?: TaskEventBus;
  /** Bounded feed size across sessions. Default 50. */
  maxEpisodes?: number;
}

export class EpisodicCapture {
  private readonly episodes = new Map<string, MemoryRecord>(); // taskId -> episode
  private readonly order: string[] = []; // insertion order for eviction
  private readonly maxEpisodes: number;
  private readonly unsubscribe: Array<() => void> = [];

  constructor(private readonly taskEngine: TaskEngine, options: EpisodicCaptureOptions = {}) {
    this.maxEpisodes = Math.max(1, Math.floor(options.maxEpisodes || 50));
    this.seedFromEngine();
    if (options.bus) {
      for (const name of TERMINAL_EVENTS) {
        this.unsubscribe.push(options.bus.on(name, (event) => this.onTaskEvent(event.name, event.taskId)));
      }
    }
  }

  /** Stop listening (no-op if never subscribed). */
  dispose(): void {
    for (const fn of this.unsubscribe) fn();
    this.unsubscribe.length = 0;
  }

  /** Terminal episodes, newest first, optionally session-scoped. */
  recent(sessionId?: string, limit?: number): MemoryRecord[] {
    const all = this.order
      .map(taskId => this.episodes.get(taskId))
      .filter((r): r is MemoryRecord => Boolean(r))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const scoped = sessionId
      ? all.filter(r => recordSessionId(r) === sessionId)
      : all;
    const capped = limit && limit > 0 ? scoped.slice(0, limit) : scoped;
    return capped;
  }

  /** Feed as a catalog provider (source 'task', episodic only). */
  provider(): MemoryProvider {
    return {
      id: 'task',
      name: 'task-episodes',
      records: (sessionId?: string) => this.recent(sessionId)
    };
  }

  /** Restart resilience: backfill the feed from durable terminal tasks. */
  private seedFromEngine(): void {
    const terminal: Array<{ task: any; summary: string }> = [];
    for (const task of this.taskEngine.list()) {
      if (!this.isTerminal(task.status)) continue;
      const summary = this.summaryOf(task);
      if (!summary) continue;
      terminal.push({ task, summary });
    }
    terminal
      .sort((a, b) => (b.task.timing?.completedAt ?? 0) - (a.task.timing?.completedAt ?? 0))
      .forEach(({ task, summary }) => this.upsert(task, summary));
  }

  private onTaskEvent(name: TaskEventName, taskId: string): void {
    const task = this.taskEngine.get(taskId);
    if (!task || !this.isTerminal(task.status)) return;
    const summary = this.summaryOf(task);
    if (!summary) return;
    this.upsert(task, summary);
  }

  private summaryOf(task: any): string {
    return taskOutcomeSummary(task);
  }

  private upsert(task: any, summary: string): void {
    const id = memoryRecordId('task', task.id);
    const completedAt = task.timing?.completedAt ?? task.timing?.lastActivityAt ?? Date.now();
    const failed = task.status === 'FAILED';
    const record = createMemoryRecord({
      id,
      type: 'episodic',
      content: `Task ${task.kind} ${failed ? 'failed' : task.status.toLowerCase()} (${task.status}): ${task.goal}\n${summary}`,
      source: 'task',
      scope: 'session',
      // Failures are the most valuable experience — rank them above success.
      importance: failed ? 4 : 3,
      confidence: failed ? 0.5 : 0.8,
      createdAt: task.timing?.createdAt ?? completedAt,
      updatedAt: completedAt,
      metadata: { sessionId: task.sessionId, taskId: task.id, kind: task.kind, status: task.status }
    });

    if (!this.episodes.has(id)) {
      this.order.push(id);
    }
    this.episodes.set(id, record);

    // Bounded: evict the oldest episode beyond the cap.
    while (this.order.length > this.maxEpisodes) {
      const oldest = this.order.shift();
      if (oldest !== undefined) this.episodes.delete(oldest);
    }
  }

  private isTerminal(status: string): boolean {
    return status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED';
  }
}
