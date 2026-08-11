/**
 * Canonical Task entity — Hermes Evolution Phase 1.
 *
 * The pure domain model: `createTask` builds a Task from input, and the `Task`
 * class is a read facade with fluent mutation helpers. No store or engine
 * coupling here — callers persist the resulting `record` through TaskStore and
 * drive the lifecycle through TaskEngine.
 */

import { v4 as uuidv4 } from 'uuid';
import {
  Task as TaskRecord,
  TaskArtifact,
  ToolExecution,
  TaskToolExecutionInput,
  TaskCheckpointRef,
  TaskCost,
  TaskDecision,
  TaskFailure,
  TaskInput,
  TaskOutcome,
  TaskPlanStep,
  TaskStatus,
  TaskVerification
} from './task-types';
import { assertTransition } from './task-state';

export interface CreateTaskOptions {
  /** Explicit id (e.g. reuse an existing run id). Defaults to a new uuid. */
  id?: string;
  /** Root task id. Required when `parentId` is set; engine resolves it. */
  rootId?: string;
}

/** Build a canonical Task from input with all defaults applied. */
export function createTask(input: TaskInput, options: CreateTaskOptions = {}): TaskRecord {
  if (!input.goal || !String(input.goal).trim()) {
    throw new Error('Task requires a goal.');
  }
  const id = options.id || uuidv4();
  const now = Date.now();
  return {
    id,
    parentId: input.parentId,
    rootId: options.rootId || (input.parentId ? '' : id),
    goal: String(input.goal).trim(),
    description: input.description,
    kind: input.kind || 'custom',
    status: 'CREATED',
    priority: input.priority || 'normal',
    constraints: input.constraints || {},
    context: input.context || {},
    subtasks: [],
    dependencies: input.dependencies || [],
    assignedAgent: input.assignedAgent,
    model: input.model,
    toolExecutions: [],
    artifacts: [],
    checkpoints: [],
    verification: [],
    cost: {},
    timing: {
      createdAt: now,
      lastActivityAt: now,
      attempts: 0
    },
    failures: [],
    decisions: [],
    progress: 0,
    progressNotes: [],
    sessionId: input.sessionId,
    metadata: input.metadata,
    version: 1
  };
}

/** Deep-ish clone (arrays/plain objects copied; metadata kept by reference). */
export function cloneTask(task: TaskRecord): TaskRecord {
  return {
    ...task,
    constraints: { ...task.constraints },
    context: { ...task.context },
    plan: task.plan ? task.plan.map((step) => ({ ...step })) : undefined,
    subtasks: [...task.subtasks],
    dependencies: [...task.dependencies],
    toolExecutions: task.toolExecutions.map((exec) => ({ ...exec })),
    artifacts: task.artifacts.map((artifact) => ({ ...artifact })),
    checkpoints: task.checkpoints.map((checkpoint) => ({ ...checkpoint })),
    verification: task.verification.map((verification) => ({ ...verification })),
    cost: { ...task.cost },
    timing: { ...task.timing },
    failures: task.failures.map((failure) => ({ ...failure })),
    decisions: task.decisions.map((decision) => ({ ...decision })),
    outcome: task.outcome ? { ...task.outcome } : undefined,
    progressNotes: [...task.progressNotes]
  };
}

export function newId(prefix: string): string {
  return `${prefix}_${uuidv4()}`;
}

/**
 * Read facade + fluent mutation helpers over a Task record. Every mutation
 * returns a NEW record (never mutates the wrapped one), so snapshots stay
 * safe. Version bumps and persistence are owned by TaskStore.update().
 */
export class TaskEntity {
  constructor(public readonly record: TaskRecord) {}

  get id(): string {
    return this.record.id;
  }

  get status(): TaskStatus {
    return this.record.status;
  }

  get rootId(): string {
    return this.record.rootId;
  }

  /** Apply a patch (arrays must be passed whole) and refresh activity time. */
  with(patch: Partial<TaskRecord>): TaskEntity {
    return new TaskEntity({
      ...this.record,
      ...patch,
      timing: { ...this.record.timing, ...patch.timing, lastActivityAt: Date.now() }
    });
  }

  /** Refresh lastActivityAt only. */
  touch(): TaskEntity {
    return this.with({});
  }

  /** Validate against the state machine and apply a status change. */
  transition(to: TaskStatus): TaskEntity {
    assertTransition(this.record.status, to);
    return this.with({ status: to });
  }

  setPlan(steps: TaskPlanStep[]): TaskEntity {
    return this.with({ plan: steps });
  }

  setProgress(percent: number, note?: string): TaskEntity {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    const notes = note ? [...this.record.progressNotes, note] : this.record.progressNotes;
    return this.with({ progress: clamped, progressNotes: notes });
  }

  setOutcome(outcome: TaskOutcome): TaskEntity {
    return this.with({ outcome });
  }

  recordCost(cost: TaskCost): TaskEntity {
    return this.with({ cost: { ...this.record.cost, ...cost } });
  }

  addSubtask(childId: string): TaskEntity {
    if (this.record.subtasks.includes(childId)) return this.touch();
    return this.with({ subtasks: [...this.record.subtasks, childId] });
  }

  addDependency(dependencyId: string): TaskEntity {
    if (this.record.dependencies.includes(dependencyId)) return this.touch();
    return this.with({ dependencies: [...this.record.dependencies, dependencyId] });
  }

  addToolExecution(execution: TaskToolExecutionInput): TaskEntity {
    const now = Date.now();
    const completed: ToolExecution = {
      id: newId('tool'),
      name: execution.name,
      arguments: execution.arguments,
      status: execution.status || 'COMPLETED',
      startedAt: execution.startedAt || now,
      completedAt: execution.completedAt,
      durationMs: execution.durationMs,
      output: execution.output,
      error: execution.error,
      projectId: execution.projectId,
      kind: execution.kind
    };
    return this.with({ toolExecutions: [...this.record.toolExecutions, completed] });
  }

  addArtifact(artifact: TaskArtifact): TaskEntity {
    return this.with({ artifacts: [...this.record.artifacts, artifact] });
  }

  addCheckpoint(checkpoint: TaskCheckpointRef): TaskEntity {
    return this.with({ checkpoints: [...this.record.checkpoints, checkpoint] });
  }

  addVerification(verification: TaskVerification): TaskEntity {
    return this.with({ verification: [...this.record.verification, verification] });
  }

  addFailure(failure: TaskFailure): TaskEntity {
    return this.with({ failures: [...this.record.failures, failure] });
  }

  addDecision(decision: TaskDecision): TaskEntity {
    return this.with({ decisions: [...this.record.decisions, decision] });
  }
}
