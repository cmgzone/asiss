/**
 * TaskLessonBridge — Phase 14 Move 5 (docs/hermes/MEMORY_AUDIT.md).
 *
 * Terminal canonical Task outcomes feed the learning pipeline. Subscribes to
 * the TaskEventBus terminal events (TaskCompleted / TaskFailed) and queues a
 * self-review for each task's outcome via LearningManager.queueTaskReview, so
 * engine-driven work (delegation, swarm, background, scheduled, mission)
 * enters the same approval pipeline as interactive lessons — and approved
 * lessons land as retrievable unified-memory records.
 *
 * The bridge is the learning half of the Phase 14 acceptance loop:
 *
 *   Task -> episode (EpisodicCapture, Move 2)
 *        -> self-review (this bridge) -> lesson -> approval -> applied rule
 *
 * It is a thin WHEN-trigger like the scheduler and background worker — it
 * creates work in the LearningManager pipeline; it is not an execution or
 * storage authority of its own.
 */

import type { TaskEngine, TaskEventBus, TaskEventName } from '../task';
import type { LearningManager } from '../learning-manager';
import { taskOutcomeSummary } from './episodic-capture';

const TERMINAL_EVENTS: TaskEventName[] = ['TaskCompleted', 'TaskFailed'];

export interface TaskLessonBridgeOptions {
  bus?: TaskEventBus;
  /** Skip failed tasks (default false — failures are the most valuable
   *  lessons). Cancelled tasks are never bridged. */
  includeFailures?: boolean;
}

export class TaskLessonBridge {
  private readonly unsubscribe: Array<() => void> = [];

  constructor(
    private readonly taskEngine: TaskEngine,
    private readonly learning: LearningManager,
    options: TaskLessonBridgeOptions = {}
  ) {
    if (!options.bus) return;
    const includeFailures = options.includeFailures !== false;
    for (const name of TERMINAL_EVENTS) {
      this.unsubscribe.push(
        options.bus.on(name, (event) => this.onTaskEvent(event.name, event.taskId, includeFailures))
      );
    }
  }

  /** Stop listening (no-op if never subscribed). */
  dispose(): void {
    for (const fn of this.unsubscribe) fn();
    this.unsubscribe.length = 0;
  }

  private onTaskEvent(name: TaskEventName, taskId: string, includeFailures: boolean): void {
    const task = this.taskEngine.get(taskId);
    if (!task) return;
    if (task.status === 'FAILED' && !includeFailures) return;
    const summary = taskOutcomeSummary(task);
    if (!summary) return;
    this.learning.queueTaskReview({
      taskId: task.id,
      sessionId: task.sessionId,
      kind: task.kind,
      status: task.status,
      goal: task.goal,
      summary
    });
  }
}
