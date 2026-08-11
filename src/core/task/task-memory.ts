/**
 * TaskMemory — Phase 12, D2: the legacy `task-context.ts` "current task"
 * folded into the canonical Task system.
 *
 * The legacy manager kept its own `current_task.json` with a parallel
 * lifecycle (in-progress/paused/completed + context points + recent list).
 * This module re-implements that surface on top of TaskEngine — the same
 * `## Current Task (Resume)` summary prompt for the runner, the same
 * task_start/task_context/... actions for the `task_memory` skill — while the
 * canonical Task record (kind 'resume') is the single source of truth.
 * Context points become Task artifacts (kind 'context'); status maps to the
 * Task state machine; recents are terminal tasks for the session.
 *
 * `current_task.json` is no longer written by anything.
 */

import { TaskEngine, taskEngine } from './task-engine';
import { Task } from './task-types';
import { isTerminal } from './task-state';

export interface TaskMemoryOptions {
  engine?: TaskEngine;
}

/** Shape returned to clients, kept stable from the legacy TaskContextEntry. */
export interface TaskMemoryEntry {
  id: string;
  goal: string;
  status: 'in-progress' | 'paused' | 'completed';
  context: string[];
  lastActivity: number;
  sessionId: string;
  startedAt: number;
}

/** Kinds considered "the current task" for a session. */
const CURRENT_KINDS = new Set(['mission', 'resume']);

export class TaskMemory {
  private readonly engine: TaskEngine;

  constructor(options: TaskMemoryOptions = {}) {
    this.engine = options.engine || taskEngine;
  }

  /**
   * The active (non-terminal) mission/resume task for a session, most recent
   * first. During a mission this is the mission Task; after the model used
   * task_start it is the tracked resume Task.
   */
  current(sessionId: string): Task | undefined {
    return this.engine
      .list()
      .filter((task) => task.sessionId === sessionId
        && CURRENT_KINDS.has(task.kind)
        && !isTerminal(task.status))
      .sort((a, b) => b.timing.lastActivityAt - a.timing.lastActivityAt
        || b.timing.createdAt - a.timing.createdAt)[0];
  }

  /**
   * Start tracking a goal for a session. Mirrors the legacy setTask: an
   * existing non-terminal *resume* task is updated (goal + initial context);
   * otherwise a canonical Task of kind 'resume' is created. A running mission
   * task is never clobbered — only resume-kind tasks are reused.
   */
  async start(goal: string, sessionId: string, context: string[] = []): Promise<Task> {
    const existing = this.engine
      .list()
      .filter((task) => task.sessionId === sessionId && task.kind === 'resume' && !isTerminal(task.status))
      .sort((a, b) => b.timing.lastActivityAt - a.timing.lastActivityAt
        || b.timing.createdAt - a.timing.createdAt)[0];
    if (existing) {
      this.engine.store.update(existing.id, { goal });
      this.monotonicTouch(existing.id);
      for (const point of context) {
        await this.engine.recordArtifact(existing.id, { name: `context:${point.slice(0, 48)}`, kind: 'context', summary: point });
        this.monotonicTouch(existing.id);
      }
      return this.engine.get(existing.id)!;
    }
    const created = await this.engine.create({
      goal,
      kind: 'resume',
      priority: 'low',
      sessionId,
      context: { sessionId, userGoal: goal }
    });
    // Advance to EXECUTING so the task is "in progress" for the state machine
    // (and can be paused/completed/resumed like the legacy statuses).
    await this.engine.analyze(created.id);
    await this.engine.plan(created.id);
    await this.engine.start(created.id);
    for (const point of context) {
      await this.engine.recordArtifact(created.id, { name: `context:${point.slice(0, 48)}`, kind: 'context', summary: point });
    }
    // Strictly newer than every other task in the session (the engine's own
    // transitions can land in the same millisecond), so "current" is
    // deterministic even when the mission and the tracked goal tie on time.
    this.monotonicTouch(created.id);
    return this.engine.get(created.id)!;
  }

  /** Add a context point to the current task. Returns false when none active. */
  async addContext(sessionId: string, point: string): Promise<boolean> {
    const task = this.current(sessionId);
    if (!task) return false;
    await this.engine.recordArtifact(task.id, { name: `context:${point.slice(0, 48)}`, kind: 'context', summary: point });
    this.monotonicTouch(task.id);
    return true;
  }

  /** Update the current task's goal and/or status. Returns false when none active. */
  async update(
    sessionId: string,
    updates: { goal?: string; status?: 'in-progress' | 'paused' | 'completed' }
  ): Promise<boolean> {
    const task = this.current(sessionId);
    if (!task) return false;
    if (updates.goal) this.engine.store.update(task.id, { goal: updates.goal });
    if (updates.status) {
      if (updates.status === 'paused' && !isTerminal(task.status)) {
        await this.engine.pause(task.id);
        this.monotonicTouch(task.id);
      }
      else if (updates.status === 'completed' && !isTerminal(task.status)) {
        await this.advanceToExecuting(task);
        await this.engine.complete(task.id);
      } else if (updates.status === 'in-progress' && task.status === 'PAUSED') await this.engine.resume(task.id);
    }
    return true;
  }

  /** Mark the current task completed. Returns false when none active. */
  async complete(sessionId: string): Promise<boolean> {
    const task = this.current(sessionId);
    if (!task) return false;
    if (isTerminal(task.status)) return true;
    await this.advanceToExecuting(task);
    await this.engine.complete(task.id);
    this.monotonicTouch(task.id);
    return true;
  }

  /** Pause the current task without completing it. Returns false when none active. */
  async clear(sessionId: string): Promise<boolean> {
    const task = this.current(sessionId);
    if (!task) return false;
    if (!isTerminal(task.status)) {
      await this.engine.pause(task.id);
      this.monotonicTouch(task.id);
    }
    return true;
  }

  /** Terminal tasks for a session, most recent first (legacy recentTasks). */
  recent(sessionId: string, limit = 10): Task[] {
    return this.engine
      .list()
      .filter((task) => task.sessionId === sessionId && CURRENT_KINDS.has(task.kind) && isTerminal(task.status))
      .sort((a, b) => (b.timing.completedAt || b.timing.createdAt) - (a.timing.completedAt || a.timing.createdAt))
      .slice(0, limit);
  }

  hasUnfinishedTask(sessionId: string): boolean {
    return this.current(sessionId) !== undefined;
  }

  /**
   * Refresh a task's lastActivityAt to be strictly newer than every other
   * task in its session (and now), so "current" is deterministic even when
   * engine mutations land in the same millisecond.
   */
  private monotonicTouch(taskId: string): void {
    const task = this.engine.get(taskId);
    if (!task) return;
    const maxActivity = this.engine
      .list()
      .filter((other) => other.sessionId === task.sessionId)
      .reduce((max, other) => Math.max(max, other.timing.lastActivityAt), 0);
    this.engine.store.update(taskId, {
      timing: { ...task.timing, lastActivityAt: Math.max(Date.now(), maxActivity + 1) }
    });
  }

  /**
   * Advance an active non-terminal task to EXECUTING along the legal state
   * path (CREATED -> analyze -> plan -> start; PAUSED -> resume -> start),
   * so complete() works regardless of where the task paused. No-op for odd
   * transient states; BLOCKED tasks are left untouched.
   */
  private async advanceToExecuting(task: Task): Promise<void> {
    let current = task;
    try {
      if (current.status === 'CREATED') {
        await this.engine.analyze(current.id);
        current = this.engine.get(current.id)!;
      }
      if (current.status === 'PLANNING') {
        await this.engine.plan(current.id);
        current = this.engine.get(current.id)!;
      }
      if (current.status === 'PAUSED') {
        await this.engine.resume(current.id);
        current = this.engine.get(current.id)!;
      }
      if (current.status === 'READY') {
        await this.engine.start(current.id);
      }
    } catch (error: any) {
      // Never throw into the skill path for a tracking convenience.
      console.warn(`[TaskMemory] advanceToExecuting skipped: ${error?.message || error}`);
    }
  }

  /** Stable client-facing entry (legacy TaskContextEntry shape). */
  toEntry(task: Task): TaskMemoryEntry {
    return {
      id: task.id,
      goal: task.goal,
      status: task.status === 'PAUSED' ? 'paused' : task.status === 'COMPLETED' ? 'completed' : 'in-progress',
      context: task.artifacts.filter((a) => a.kind === 'context').map((a) => String(a.summary || '')),
      lastActivity: task.timing.lastActivityAt,
      sessionId: task.sessionId || 'unknown',
      startedAt: task.timing.createdAt
    };
  }

  /** The legacy "## Current Task (Resume)" summary, now rendered from the Task. */
  summaryPrompt(sessionId: string): string {
    const task = this.current(sessionId);
    if (!task) return '';
    const entry = this.toEntry(task);
    const minutesAgo = Math.max(0, Math.round((Date.now() - entry.lastActivity) / (60 * 1000)));

    let prompt = `\n## Current Task (Resume)\n`;
    prompt += `You were working on: **${entry.goal}**\n`;
    prompt += `Status: ${entry.status} (last activity: ${minutesAgo} minutes ago)\n`;

    if (entry.context.length > 0) {
      prompt += `\nContext points:\n`;
      entry.context.forEach((ctx, i) => {
        prompt += `${i + 1}. ${ctx}\n`;
      });
    }

    prompt += `\nYou should ask the user if they want to continue this task or start something new.\n`;
    return prompt;
  }
}

/** Process-wide default backed by the default TaskEngine. */
export const taskMemory = new TaskMemory();
