/**
 * TaskEngine — Hermes Evolution Phase 1.
 *
 * Owns the Task lifecycle. Every autonomous operation should eventually belong
 * to a Task: missions, background goals, swarm jobs, workflow steps,
 * delegations and scheduled work all map here while the original subsystems
 * keep working.
 *
 * Lifecycle surface:
 *   create / createChildTask / analyze / plan / execute / verify
 *   pause / resume / cancel / retry / complete / run
 *
 * Recording surface (data + events for telemetry/recovery/learning):
 *   recordProgress / recordToolExecution / recordArtifact / recordCheckpoint
 *   recordDecision / recordCost / recordFailure / emitEvent
 *
 * The engine is decoupled from models, tools and agents: it calls injected
 * handlers (analyzer/planner/executor/verifier). Phase 2 wires AgentRunner to
 * those handlers; until then the engine is fully usable with plain callbacks.
 */

import {
  Task,
  TaskArtifact,
  TaskCheckpointRef,
  TaskCost,
  TaskDecision,
  TaskInput,
  TaskOutcome,
  TaskPlanStep,
  TaskStatus,
  TaskToolExecutionInput,
  TaskVerification,
  TaskVerificationKind,
  ToolExecution
} from './task-types';
import { TaskStore, taskStore } from './task-store';
import { TaskEventBus, TaskEventName, taskEventBus } from './task-events';
import { TaskEntity, createTask, newId } from './task';
import { isTerminal } from './task-state';

// --------------------------------------------------------------------- handlers

export type TaskAnalyzer = (task: Task, engine: TaskEngine) => void | Promise<void>;
export type TaskPlanner = (task: Task, engine: TaskEngine) => TaskPlanStep[] | void | Promise<TaskPlanStep[] | void>;
export type TaskExecutor = (task: Task, engine: TaskEngine) => TaskExecutionResult | Promise<TaskExecutionResult>;
export type TaskVerifier = (task: Task, engine: TaskEngine) => TaskVerificationResult | Promise<TaskVerificationResult>;
export type TaskRepairer = (task: Task, engine: TaskEngine) => void | Promise<void>;

export interface TaskExecutionResult {
  success: boolean;
  summary?: string;
  result?: unknown;
  confidence?: number;
  unresolvedQuestions?: string[];
  error?: string;
  /** True to skip verification even when a verifier is wired (trusted outcome). */
  skipVerification?: boolean;
}

export interface TaskVerificationResult {
  passed: boolean;
  detail?: string;
}

export interface TaskRunOutcome {
  success: boolean;
  blocked?: boolean;
  completed?: boolean;
  failed?: boolean;
  error?: string;
}

export interface TaskEngineOptions {
  store?: TaskStore;
  bus?: TaskEventBus;
  analyzer?: TaskAnalyzer;
  planner?: TaskPlanner;
  executor?: TaskExecutor;
  verifier?: TaskVerifier;
}

export interface TaskRunOptions {
  executor?: TaskExecutor;
  verifier?: TaskVerifier;
  repair?: TaskRepairer;
}

// --------------------------------------------------------------------- engine

export class TaskEngine {
  readonly store: TaskStore;
  readonly bus: TaskEventBus;
  private readonly analyzer?: TaskAnalyzer;
  private readonly planner?: TaskPlanner;
  private readonly executor?: TaskExecutor;
  private readonly verifier?: TaskVerifier;

  constructor(options: TaskEngineOptions = {}) {
    this.store = options.store || taskStore;
    this.bus = options.bus || taskEventBus;
    this.analyzer = options.analyzer;
    this.planner = options.planner;
    this.executor = options.executor;
    this.verifier = options.verifier;
  }

  // ------------------------------------------------------------- queries

  get(taskId: string): Task | undefined {
    return this.store.get(taskId);
  }

  require(taskId: string): Task {
    return this.store.require(taskId);
  }

  list(): Task[] {
    return this.store.list();
  }

  listByStatus(status: TaskStatus): Task[] {
    return this.store.listByStatus(status);
  }

  listByParent(parentId: string): Task[] {
    return this.store.listByParent(parentId);
  }

  listByRoot(rootId: string): Task[] {
    return this.store.listByRoot(rootId);
  }

  // ------------------------------------------------------------- lifecycle

  /** Create a task. Child tasks inherit the parent's rootId and register on the parent. */
  async create(input: TaskInput): Promise<Task> {
    const parent = input.parentId ? this.store.get(input.parentId) : undefined;
    if (input.parentId && !parent) {
      throw new Error(`Parent task ${input.parentId} not found.`);
    }
    const record = createTask(input, parent ? { rootId: parent.rootId } : {});
    this.store.create(record);
    if (parent) {
      const updatedParent = new TaskEntity(parent).addSubtask(record.id);
      this.store.update(parent.id, updatedParent.record);
    }
    await this.emit('TaskCreated', record.id, { goal: record.goal, kind: record.kind, parentId: record.parentId });
    return this.store.require(record.id);
  }

  /** Create a child task under `parentId`. */
  async createChildTask(parentId: string, input: TaskInput): Promise<Task> {
    return this.create({ ...input, parentId, kind: input.kind || 'subtask' });
  }

  /** CREATED -> ANALYZING -> PLANNING. Runs the analyzer hook if wired. */
  async analyze(taskId: string): Promise<Task> {
    const record = this.require(taskId);
    const entity = new TaskEntity(record);
    if (entity.status !== 'CREATED') {
      throw new Error(`analyze() requires a CREATED task, got ${entity.status}.`);
    }
    let current = this.persist(entity.transition('ANALYZING').record, { analyzingAt: Date.now() });
    if (this.analyzer) {
      await this.analyzer(current, this);
      current = this.store.require(taskId);
    }
    current = this.persist(new TaskEntity(current).transition('PLANNING').record, { planningAt: Date.now() });
    await this.emit('TaskAnalyzed', taskId);
    return current;
  }

  /** PLANNING -> READY. Uses provided steps, the planner hook, or no plan. */
  async plan(taskId: string, steps?: TaskPlanStep[]): Promise<Task> {
    const record = this.require(taskId);
    const entity = new TaskEntity(record);
    if (entity.status !== 'PLANNING') {
      throw new Error(`plan() requires a PLANNING task, got ${entity.status}.`);
    }
    let plan = steps;
    if (!plan && this.planner) {
      const planned = await this.planner(entity.record, this);
      plan = planned || undefined;
    }
    let current = plan ? new TaskEntity(entity.record).setPlan(plan).record : entity.record;
    current = this.persist(new TaskEntity(current).transition('READY').record);
    await this.emit('TaskPlanned', taskId, { steps: (current.plan || []).length });
    await this.emit('TaskReady', taskId);
    return current;
  }

  /**
   * READY -> EXECUTING. Checks dependencies first (READY -> BLOCKED if any
   * dependency is not COMPLETED). On success, runs verification when a
   * verifier is wired, then completes; on failure goes EXECUTING -> FAILED.
   */
  async execute(taskId: string, options: TaskRunOptions = {}): Promise<TaskRunOutcome> {
    const record = this.require(taskId);
    const entity = new TaskEntity(record);
    if (entity.status !== 'READY') {
      throw new Error(`execute() requires a READY task, got ${entity.status}.`);
    }

    const missing = entity.record.dependencies.filter((depId) => {
      const dep = this.store.get(depId);
      return !dep || dep.status !== 'COMPLETED';
    });
    if (missing.length > 0) {
      this.persist(entity.transition('BLOCKED').record);
      await this.emit('TaskBlocked', taskId, { dependencies: missing });
      return { success: false, blocked: true, error: `Dependencies not completed: ${missing.join(', ')}` };
    }

    await this.start(taskId);
    return this.runExecution(taskId, options);
  }

  /**
   * READY -> EXECUTING without running an executor. For hosts (e.g.
   * AgentRunner in Phase 2) that drive the execution loop themselves and only
   * use the engine to own the lifecycle + records.
   */
  async start(taskId: string): Promise<Task> {
    const record = this.require(taskId);
    const entity = new TaskEntity(record);
    if (entity.status !== 'READY') {
      throw new Error(`start() requires a READY task, got ${entity.status}.`);
    }
    const started = this.persist(entity.transition('EXECUTING').record, {
      executingAt: Date.now(),
      attempts: entity.record.timing.attempts + 1,
      startedAt: entity.record.timing.startedAt || Date.now()
    });
    await this.emit('TaskStarted', taskId, { attempt: started.timing.attempts });
    return started;
  }

  /**
   * Full lifecycle convenience: CREATED -> analyze -> plan -> execute;
   * READY -> execute; PAUSED -> resume -> execute; FAILED -> retry.
   */
  async run(taskId: string, options: TaskRunOptions = {}): Promise<TaskRunOutcome> {
    const record = this.require(taskId);
    switch (record.status) {
      case 'CREATED':
        await this.analyze(taskId);
        await this.plan(taskId);
        return this.execute(taskId, options);
      case 'READY':
        return this.execute(taskId, options);
      case 'PAUSED':
        await this.resume(taskId);
        return this.execute(taskId, options);
      case 'FAILED':
        return this.retry(taskId, options);
      default:
        return { success: false, error: `Task ${taskId} is ${record.status} and cannot be run.` };
    }
  }
  /**
   * EXECUTING -> VERIFYING -> COMPLETED (pass) or VERIFYING -> FAILED (fail).
   * Only meaningful while the task is EXECUTING.
   */
  async verify(taskId: string, options: TaskRunOptions = {}): Promise<TaskRunOutcome> {
    const record = this.require(taskId);
    const entity = new TaskEntity(record);
    if (entity.status !== 'EXECUTING') {
      throw new Error(`verify() requires an EXECUTING task, got ${entity.status}.`);
    }
    return this.runVerification(taskId, options);
  }

  /** -> COMPLETED. Unblocks dependents whose dependencies are now satisfied. */
  async complete(taskId: string, outcome?: TaskOutcome): Promise<Task> {
    const record = this.require(taskId);
    const entity = new TaskEntity(record);
    if (isTerminal(entity.status)) {
      return entity.record;
    }
    // Preserve an outcome already recorded by the executor/verifier.
    const finalOutcome: TaskOutcome = entity.record.outcome || outcome || { status: 'SUCCESS' };
    const completedAt = Date.now();
    const done = new TaskEntity(entity.record)
      .setOutcome(finalOutcome)
      .setProgress(100)
      .transition('COMPLETED')
      .record;
    this.persist(done, { completedAt, durationMs: completedAt - done.timing.createdAt });
    await this.emit('TaskCompleted', taskId, { outcome: finalOutcome });
    this.unblockDependents(taskId);
    return this.store.require(taskId);
  }

  /** Pause an active task (-> PAUSED). Resume with resume(). */
  async pause(taskId: string): Promise<Task> {
    const record = this.require(taskId);
    const entity = new TaskEntity(record);
    if (isTerminal(entity.status)) {
      throw new Error(`Cannot pause a terminal task (${entity.status}).`);
    }
    const paused = this.persist(entity.transition('PAUSED').record);
    await this.emit('TaskPaused', taskId);
    return paused;
  }

  /** PAUSED -> READY. */
  async resume(taskId: string): Promise<Task> {
    const record = this.require(taskId);
    const entity = new TaskEntity(record);
    if (entity.status !== 'PAUSED') {
      throw new Error(`resume() requires a PAUSED task, got ${entity.status}.`);
    }
    const resumed = this.persist(entity.transition('READY').record);
    await this.emit('TaskResumed', taskId);
    return resumed;
  }

  /** Cancel a non-terminal task. */
  async cancel(taskId: string, reason?: string): Promise<Task> {
    const record = this.require(taskId);
    const entity = new TaskEntity(record);
    if (isTerminal(entity.status)) {
      throw new Error(`Cannot cancel a terminal task (${entity.status}).`);
    }
    const cancelledAt = Date.now();
    const cancelled = new TaskEntity(entity.record)
      .setOutcome({ status: 'CANCELLED', summary: reason })
      .transition('CANCELLED')
      .record;
    this.persist(cancelled, { completedAt: cancelledAt, durationMs: cancelledAt - cancelled.timing.createdAt });
    await this.emit('TaskCancelled', taskId, { reason });
    return this.store.require(taskId);
  }

  /**
   * FAILED -> DIAGNOSING -> REPAIRING -> EXECUTING, then re-executes.
   * An optional `repair` handler runs during the REPAIRING phase.
   */
  async retry(taskId: string, options: TaskRunOptions = {}): Promise<TaskRunOutcome> {
    const record = this.require(taskId);
    const entity = new TaskEntity(record);
    if (entity.status !== 'FAILED') {
      throw new Error(`retry() requires a FAILED task, got ${entity.status}.`);
    }
    this.persist(entity.transition('DIAGNOSING').record);
    await this.emit('TaskRetrying', taskId, { stage: 'diagnosing' });
    if (options.repair) {
      try {
        await options.repair(this.store.require(taskId), this);
      } catch (error: any) {
        const failed = this.recordFailure(taskId, 'DIAGNOSING', error?.message || String(error));
        this.persist(new TaskEntity(failed).transition('FAILED').record);
        await this.emit('TaskFailed', taskId, { error: error?.message || String(error), phase: 'DIAGNOSING' });
        return { success: false, failed: true, error: error?.message || String(error) };
      }
    }
    this.persist(new TaskEntity(this.store.require(taskId)).transition('REPAIRING').record);
    const current = this.store.require(taskId);
    const recovered = this.persist(new TaskEntity(current).transition('EXECUTING').record, {
      attempts: current.timing.attempts + 1
    });
    await this.emit('TaskRecovered', taskId, { attempt: recovered.timing.attempts });
    return this.runExecution(taskId, options);
  }

  // ------------------------------------------------------------- recording

  /** Record progress and emit TaskProgress. */
  async recordProgress(taskId: string, percent: number, note?: string): Promise<Task> {
    const entity = new TaskEntity(this.require(taskId));
    const updated = this.persist(entity.setProgress(percent, note).record);
    await this.emit('TaskProgress', taskId, { percent: updated.progress, note });
    return updated;
  }

  /** Record a tool execution. Emits ToolStarted/ToolCompleted/ToolFailed from the status. */
  async recordToolExecution(taskId: string, execution: TaskToolExecutionInput): Promise<ToolExecution> {
    const entity = new TaskEntity(this.require(taskId));
    const updated = this.persist(entity.addToolExecution(execution).record);
    const stored = updated.toolExecutions[updated.toolExecutions.length - 1];
    const eventName: TaskEventName =
      stored.status === 'STARTED' ? 'ToolStarted' : stored.status === 'FAILED' ? 'ToolFailed' : 'ToolCompleted';
    await this.emit(eventName, taskId, { tool: stored.name, ...(stored.error ? { error: stored.error } : {}) });
    return stored;
  }

  /**
   * Resolve a STARTED tool execution to its final state (COMPLETED/FAILED).
   * Computes durationMs from startedAt, persists, and emits the matching
   * ToolCompleted/ToolFailed event.
   */
  async completeToolExecution(
    taskId: string,
    executionId: string,
    patch: { status?: 'COMPLETED' | 'FAILED'; output?: unknown; error?: string; completedAt?: number; durationMs?: number }
  ): Promise<ToolExecution | undefined> {
    const record = this.require(taskId);
    const idx = record.toolExecutions.findIndex((exec) => exec.id === executionId);
    if (idx === -1) return undefined;
    const current = record.toolExecutions[idx];
    const completedAt = patch.completedAt ?? Date.now();
    const updated: ToolExecution = {
      ...current,
      status: patch.status || 'COMPLETED',
      completedAt,
      durationMs: patch.durationMs ?? (current.startedAt ? completedAt - current.startedAt : undefined),
      ...(patch.output !== undefined ? { output: patch.output } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {})
    };
    const toolExecutions = [...record.toolExecutions];
    toolExecutions[idx] = updated;
    this.persist(new TaskEntity(record).with({ toolExecutions }).record);
    const eventName: TaskEventName = updated.status === 'FAILED' ? 'ToolFailed' : 'ToolCompleted';
    await this.emit(eventName, taskId, { tool: updated.name, ...(updated.error ? { error: updated.error } : {}) });
    return updated;
  }

  /** Record an artifact on the task. */
  async recordArtifact(taskId: string, artifact: Omit<TaskArtifact, 'id' | 'createdAt'>): Promise<TaskArtifact> {
    const entity = new TaskEntity(this.require(taskId));
    const stored: TaskArtifact = { ...artifact, id: newId('artifact'), createdAt: Date.now() };
    this.persist(entity.addArtifact(stored).record);
    return stored;
  }

  /** Record a checkpoint reference and emit CheckpointCreated. */
  async recordCheckpoint(taskId: string, checkpoint: { id: string; reason: string }): Promise<Task> {
    const entity = new TaskEntity(this.require(taskId));
    const ref: TaskCheckpointRef = { ...checkpoint, createdAt: Date.now() };
    const updated = this.persist(entity.addCheckpoint(ref).record);
    await this.emit('CheckpointCreated', taskId, { checkpointId: ref.id, reason: ref.reason });
    return updated;
  }

  /** Record a decision. */
  async recordDecision(taskId: string, summary: string, detail?: string): Promise<Task> {
    const entity = new TaskEntity(this.require(taskId));
    const decision: TaskDecision = { id: newId('decision'), at: Date.now(), summary, detail };
    return this.persist(entity.addDecision(decision).record);
  }

  /** Record cost (tokens/usd) on the task. */
  async recordCost(taskId: string, cost: TaskCost): Promise<Task> {
    const entity = new TaskEntity(this.require(taskId));
    return this.persist(entity.recordCost(cost).record);
  }

  /** Record a failure on the task (does not change status). */
  recordFailure(taskId: string, phase: TaskStatus, error: string): Task {
    const entity = new TaskEntity(this.require(taskId));
    const failure = {
      id: newId('failure'),
      at: Date.now(),
      phase,
      error,
      attempts: entity.record.timing.attempts
    };
    return this.persist(entity.addFailure(failure).record);
  }

  /** Record a verification run result on the task. */
  async recordVerification(
    taskId: string,
    kind: TaskVerificationKind,
    status: TaskVerification['status'],
    detail?: string
  ): Promise<TaskVerification> {
    const entity = new TaskEntity(this.require(taskId));
    const verification: TaskVerification = {
      id: newId('verify'),
      kind,
      status,
      startedAt: Date.now(),
      completedAt: status === 'RUNNING' ? undefined : Date.now(),
      detail,
      attempts: entity.record.verification.length + 1
    };
    this.persist(entity.addVerification(verification).record);
    return verification;
  }

  /** Generic event passthrough (e.g. AgentSpawned, LearningCreated, TestPassed). */
  async emitEvent(taskId: string, name: TaskEventName, data?: Record<string, unknown>): Promise<void> {
    await this.emit(name, taskId, data);
  }

  // ------------------------------------------------------------- internals

  /** Run the executor against a task already in EXECUTING state. */
  private async runExecution(taskId: string, options: TaskRunOptions): Promise<TaskRunOutcome> {
    const executor = options.executor || this.executor;
    if (!executor) {
      // No executor wired — the task is purely descriptive; complete immediately.
      await this.complete(taskId);
      return { success: true, completed: true };
    }
    let result: TaskExecutionResult;
    try {
      result = await executor(this.store.require(taskId), this);
    } catch (error: any) {
      return this.fail(taskId, 'EXECUTING', error?.message || String(error));
    }
    if (!result || result.success === false) {
      return this.fail(taskId, 'EXECUTING', result?.error || 'Executor reported failure.');
    }
    const entity = new TaskEntity(this.store.require(taskId));
    const outcome: TaskOutcome = {
      status: 'SUCCESS',
      summary: result.summary,
      result: result.result,
      confidence: result.confidence,
      unresolvedQuestions: result.unresolvedQuestions
    };
    this.persist(entity.setOutcome(outcome).record);
    const verifier = options.verifier || this.verifier;
    if (verifier && !result.skipVerification) {
      return this.runVerification(taskId, options);
    }
    await this.complete(taskId);
    return { success: true, completed: true };
  }

  /** EXECUTING -> VERIFYING; run verifier; VERIFYING -> COMPLETED or FAILED. */
  private async runVerification(taskId: string, options: TaskRunOptions): Promise<TaskRunOutcome> {
    const verifier = options.verifier || this.verifier;
    const entity = new TaskEntity(this.store.require(taskId));
    this.persist(entity.transition('VERIFYING').record, { verifyingAt: Date.now() });
    await this.emit('TaskVerifying', taskId);
    await this.recordVerification(taskId, 'custom', 'RUNNING');
    let result: TaskVerificationResult;
    try {
      result = await verifier!(this.store.require(taskId), this);
    } catch (error: any) {
      result = { passed: false, detail: error?.message || String(error) };
    }
    if (result?.passed) {
      await this.recordVerification(taskId, 'custom', 'PASSED', result.detail);
      await this.emit('TaskVerified', taskId, { detail: result.detail });
      await this.complete(taskId);
      return { success: true, completed: true };
    }
    await this.recordVerification(taskId, 'custom', 'FAILED', result?.detail);
    await this.emit('TaskVerificationFailed', taskId, { detail: result?.detail });
    return this.fail(taskId, 'VERIFYING', result?.detail || 'Verification failed.');
  }

  /**
   * Mark a task FAILED from an execution-phase state (public counterpart to
   * the internal fail path). Records the failure and emits TaskFailed.
   */
  async failTask(taskId: string, error: string, phase: TaskStatus = 'EXECUTING'): Promise<Task> {
    const record = this.require(taskId);
    const entity = new TaskEntity(record);
    if (isTerminal(entity.status)) {
      return entity.record;
    }
    const recorded = this.recordFailure(taskId, phase, error);
    const failed = this.persist(new TaskEntity(recorded).transition('FAILED').record);
    await this.emit('TaskFailed', taskId, { error, phase });
    return failed;
  }

  /** EXECUTING/VERIFYING -> FAILED with a recorded failure. */
  private async fail(taskId: string, phase: TaskStatus, error: string): Promise<TaskRunOutcome> {
    await this.failTask(taskId, error, phase);
    return { success: false, failed: true, error };
  }

  /** Move BLOCKED tasks whose dependencies are all COMPLETED back to READY. */
  private unblockDependents(completedTaskId: string): void {
    for (const task of this.store.listByStatus('BLOCKED')) {
      if (!task.dependencies.includes(completedTaskId)) continue;
      if (task.dependencies.every((depId) => this.store.get(depId)?.status === 'COMPLETED')) {
        this.persist(new TaskEntity(task).transition('READY').record);
        void this.emit('TaskRecovered', task.id, { reason: 'dependencies satisfied' });
      }
    }
  }

  private persist(record: Task, timingPatch?: Partial<Task['timing']>): Task {
    return this.store.update(record.id, timingPatch ? { ...record, timing: { ...record.timing, ...timingPatch } } : record);
  }

  private async emit(name: TaskEventName, taskId: string, data?: Record<string, unknown>): Promise<void> {
    await this.bus.emit({ name, taskId, timestamp: Date.now(), data });
  }
}

/** Default process-wide engine. */
export const taskEngine = new TaskEngine();
