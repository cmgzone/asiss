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
 *   pause / resume / cancel / retry / complete / run / runTurn
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
  TaskToolKind,
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

/** One goal-matched test execution (Phase 11 verify-then-retry evidence). */
export interface TaskTestRun {
  command: string;
  exitCode: number;
  output: string;
  passed: boolean;
}

/**
 * Recovery diagnosis produced by a TaskDiagnoser. The engine records this as
 * verification evidence + events; the host (e.g. AgentRunner) renders it into
 * context so the retry is targeted instead of blind.
 */
export interface TaskDiagnosis {
  /** Files the repository index matched for the goal (Phase 10 hint). */
  matchedFiles?: string[];
  /** Goal-matched test runs and their output (Phase 11 evidence). */
  tests?: TaskTestRun[];
  /** Optional rendered evidence text for the retry context. */
  evidence?: string;
}

/**
 * A diagnoser gathers recovery evidence for an in-mission failure. Hosts wire
 * repository-aware implementations (ContextEngine + test runners); the engine
 * owns what happens with the evidence (records, events, transitions).
 */
export type TaskDiagnoser = (task: Task, engine: TaskEngine) => TaskDiagnosis | Promise<TaskDiagnosis>;

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
  analyze?: TaskAnalyzer;
  plan?: TaskPlanner;
  exec?: TaskExecutor; // spelling kept for backward compat (was `executor` in Phase 1)
  executor?: TaskExecutor;
  verify?: TaskVerifier;
  repair?: TaskRepairer;
  /** Engine-level completion-verdict hook (Phase 12 Move 2). */
  completionVerdict?: TaskCompletionVerdictHook;
}

/**
 * Evidence the host supplies for a completion verdict. The engine asks its
 * completion-verdict hook "is completion allowed?"; the host answers using
 * this evidence. The engine owns the resulting lifecycle transition, so the
 * host never independently terminates a Task outside runTurn.
 */
export interface TaskCompletionEvidence {
  /** True when the mission goal requires tool use at all. */
  toolRequired?: boolean;
  /** Total tool calls executed so far. */
  totalToolCalls?: number;
  /** True when the latest tool batch failed. */
  lastBatchHadFailure?: boolean;
  /** True when the mission goal requires post-mutation verification. */
  verificationRequired?: boolean;
  /** Highest mutation-tool sequence completed. */
  lastMutationSequence?: number;
  /** Highest verification-tool sequence completed. */
  lastVerificationSequence?: number;
  /** Forced-continuation budget already used (host turn state). */
  forcedContinuations?: number;
  /** Maximum premature-completion continuations allowed. */
  maxForcedContinuations?: number;
  /** The model's final draft text (basis for the host's text judgment). */
  finalDraft?: string;
}

/** Context passed to a completion-verdict hook. */
export interface TaskCompletionContext {
  task: Task;
  turn: number;
  evidence: TaskCompletionEvidence;
  /**
   * Engine-owned verification state (Phase 12 Move 3): true when a successful
   * mutation tool remains unverified (no later successful verification tool and
   * no PASSED verification evidence). The host never maintains this as a second
   * mechanism — it asks the engine here.
   */
  pendingVerification?: boolean;
}

/**
 * The host answers the engine's completion question. The engine owns what the
 * answer means for the Task lifecycle; the host only supplies the judgment.
 */
export type TaskCompletionVerdictHook = (context: TaskCompletionContext) => TaskTurnVerdict | Promise<TaskTurnVerdict>;

export interface TaskRunOptions {
  executor?: TaskExecutor;
  verifier?: TaskVerifier;
  repair?: TaskRepairer;
}

// --------------------------------------------------- turn contract (Move 1)

/**
 * One tool executed during a turn, as reported by the host. Used to record
 * tool executions on the canonical Task without the host hand-wiring events.
 */
export interface TaskTurnToolExecution {
  name: string;
  arguments?: Record<string, unknown>;
  success: boolean;
  output?: unknown;
  error?: string;
  durationMs?: number;
  projectId?: string;
  /** Host-computed role (mutation / verification / inspection). */
  kind?: TaskToolKind;
}

/**
 * Host verdict after a turn. The engine owns the lifecycle transition; the
 * host owns the domain judgment about whether the mission needs another turn.
 *
 *   continue — keep executing; the task stays EXECUTING.
 *   verify   — run in-loop verification (EXECUTING -> VERIFYING -> EXECUTING)
 *              via an injected diagnoser; the task returns to EXECUTING.
 *   complete — the mission is done; -> COMPLETED.
 *   fail     — the mission cannot continue; -> FAILED.
 *   blocked  — an external blocker (approval denied, dependency unmet, step
 *              limit) stopped the mission; -> FAILED with a blocked outcome.
 */
export type TaskTurnVerdict =
  | { type: 'continue'; reason?: string }
  | { type: 'verify'; reason?: string }
  | { type: 'complete'; summary?: string; result?: unknown; confidence?: number }
  | { type: 'fail'; error: string }
  | { type: 'blocked'; error: string; reason?: string };

export interface TaskTurnInput {
  /** 1-based turn number. Must increase by exactly one per call. */
  turn: number;
  /** Explicit verdict, or omit it and let the completion-verdict hook answer. */
  verdict?: TaskTurnVerdict;
  /**
   * Completion evidence. Required when `verdict` is omitted: the engine asks
   * its completion-verdict hook (per-call or engine-level) for the verdict.
   */
  evidence?: TaskCompletionEvidence;
  /** Tools executed during this turn (recorded on the Task). */
  tools?: TaskTurnToolExecution[];
  /** Model used for this turn (recorded via assignModel when different). */
  model?: string;
  /** 0-100 progress estimate after this turn. */
  progress?: number;
  /** Optional turn summary note. */
  summary?: string;
}

export type TaskTurnAction = 'continue' | 'verify' | 'complete' | 'failed' | 'blocked';

export interface TaskTurnResult {
  turn: number;
  action: TaskTurnAction;
  task: Task;
  /** Present after a 'verify' verdict: the diagnosis evidence gathered. */
  diagnosis?: TaskDiagnosis;
  /** Verdict reason surfaced to the host (continue/verify verdicts). */
  reason?: string;
  error?: string;
}

export interface TaskTurnRunOptions {
  /** Used by the 'verify' verdict: gathers recovery evidence in-loop. */
  diagnoser?: TaskDiagnoser;
  /**
   * Per-call completion-verdict hook. When `input.verdict` is omitted, the
   * engine asks this hook (falling back to the engine-level hook) for the
   * verdict and owns the resulting lifecycle transition.
   */
  completionVerdict?: TaskCompletionVerdictHook;
}

// ------------------------------------------------------------ mission driver
// Phase 12 Move 4a — the engine owns the mission loop. The host supplies one
// model+tool batch per iteration through `iterate`; the engine walks the turns,
// enforces the budgets, and owns every lifecycle transition. AgentRunner stops
// owning the loop body.

/** Context handed to the host's iterate hook for one mission iteration. */
export interface TaskMissionIterateContext {
  /** Next sequential turn number (1-based). */
  turn: number;
  /** Current task snapshot as the iteration begins. */
  task: Task;
  /** Host-domain completion pressure (number of continue/verify forks so far). */
  forcedContinuations: number;
  /** Engine-owned "a mutation has not been verified" state. */
  verificationPending: boolean;
}

/** One model+tool batch produced by the host loop body. */
export interface TaskMissionIteration {
  /** Model text produced this iteration. */
  content: string;
  /**
   * Tools executed this iteration. Presence marks the iteration as a tool
   * batch (not a completion point) AND records the executions on the Task.
   *
   * Hosts that already recorded their executions (e.g. a tool engine that
   * wrote ToolExecution records itself) set `usedTools` instead and omit
   * `tools` so the recorded executions are not re-recorded.
   */
  tools?: TaskTurnToolExecution[];
  /** True when this iteration ran tool work that the host already recorded. */
  usedTools?: boolean;
  /** Model used this iteration (recorded via assignModel when different). */
  model?: string;
  /** 0-100 progress estimate after this iteration. */
  progress?: number;
  /** Host judgment inputs the completion hook reads. */
  lastBatchHadFailure?: boolean;
  toolRequired?: boolean;
  verificationRequired?: boolean;
}

export type TaskMissionIterate =
  (ctx: TaskMissionIterateContext) => TaskMissionIteration | Promise<TaskMissionIteration>;

/** Loop budgets the engine enforces while driving a mission. */
export interface TaskMissionBudget {
  /** Max mission iterations (turns). Default 6. */
  maxTurns?: number;
  /** Completion-verdict fork budget (continue/verify). Default 4. */
  maxForcedContinuations?: number;
}

export interface TaskMissionRunOptions extends TaskTurnRunOptions {
  /** Host loop body: one model + tool batch. Required. */
  iterate: TaskMissionIterate;
  /** Budgets the engine owns. */
  budget?: TaskMissionBudget;
  /** Called after each completed turn so the host can stream progress. */
  onTurn?: (result: TaskTurnResult, ctx: TaskMissionIterateContext) => void | Promise<void>;
}

export interface TaskMissionResult {
  task: Task;
  action: TaskTurnAction;
  /** Number of iterations (turns) the engine processed. */
  turns: number;
  /** True when the loop halted because the turn budget was exhausted. */
  stoppedByStepLimit: boolean;
  reason?: string;
  error?: string;
  diagnosis?: TaskDiagnosis;
}

// --------------------------------------------------------------------- engine

export class TaskEngine {
  readonly store: TaskStore;
  readonly bus: TaskEventBus;
  private readonly analyzer?: TaskAnalyzer;
  private readonly planner?: TaskPlanner;
  private readonly executor?: TaskExecutor;
  private readonly verifier?: TaskVerifier;
  private readonly completionVerdict?: TaskCompletionVerdictHook;

  constructor(options: TaskEngineOptions = {}) {
    this.store = options.store || taskStore;
    this.bus = options.bus || taskEventBus;
    this.analyzer = options.analyze;
    this.planner = options.plan;
    this.executor = options.executor;
    this.verifier = options.verify;
    this.completionVerdict = options.completionVerdict;
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
   * Phase 12 Move 1 — the multi-turn execution contract.
   *
   * A per-turn primitive that owns the EXECUTING -> (VERIFYING) -> EXECUTING /
   * COMPLETED transitions across the turns of a long-running autonomous
   * mission. The host supplies each turn's domain outcome (verdict + optional
   * tool evidence / model / progress); the engine owns the lifecycle state
   * machine, records, and events. Unlike `run()`/`runExecution()`, this never
   * hides the mission loop inside an executor: the host keeps driving model
   * and tool work, and the engine keeps deciding what happens next.
   *
   * Turns are sequential: `input.turn` must equal the last completed turn + 1
   * (tracked on `task.timing.turns`). A task that is still in READY is started
   * implicitly; CREATED/PAUSED/FAILED tasks must be brought to EXECUTING via
   * the dedicated lifecycle methods first.
   */
  async runTurn(taskId: string, input: TaskTurnInput, options: TaskTurnRunOptions = {}): Promise<TaskTurnResult> {
    let record = this.require(taskId);
    const entity = new TaskEntity(record);
    if (entity.status === 'READY') {
      await this.start(taskId);
      record = this.store.require(taskId);
    }
    if (record.status !== 'EXECUTING') {
      throw new Error(`runTurn() requires an EXECUTING task, got ${record.status}.`);
    }
    const expectedTurn = (record.timing.turns || 0) + 1;
    if (input.turn !== expectedTurn) {
      throw new Error(`runTurn() turn must be sequential: expected ${expectedTurn}, got ${input.turn}.`);
    }

    // Phase 12 Move 2 — the completion decision lives in the turn contract.
    // The host either supplies an explicit verdict, or the engine asks its
    // completion-verdict hook "is completion allowed?" and the hook answers
    // (continue / verify / complete / fail / blocked). The engine owns the
    // resulting lifecycle transition either way.
    const verdict = input.verdict ?? await this.askCompletionVerdict(taskId, input, options);

    await this.emit('TaskTurnStarted', taskId, {
      turn: input.turn,
      verdict: verdict.type,
      ...(input.summary ? { summary: input.summary } : {})
    });

    // Record this turn's model selection, tool executions, and progress so the
    // canonical Task carries the turn's evidence (single source of truth).
    if (input.model && record.model !== input.model) {
      await this.assignModel(taskId, input.model);
    }
    if (Array.isArray(input.tools)) {
      for (const tool of input.tools) {
        await this.recordToolExecution(taskId, {
          name: tool.name,
          arguments: tool.arguments,
          status: 'STARTED',
          startedAt: Date.now() - (tool.durationMs || 0),
          projectId: tool.projectId,
          kind: tool.kind
        });
      }
      const latest = this.store.require(taskId);
      const lastIdx = latest.toolExecutions.length - 1;
      for (let i = 0; i < input.tools.length; i++) {
        const tool = input.tools[i];
        const executionId = latest.toolExecutions[lastIdx - (input.tools.length - 1 - i)]?.id;
        if (executionId) {
          await this.completeToolExecution(taskId, executionId, {
            status: tool.success ? 'COMPLETED' : 'FAILED',
            ...(tool.output !== undefined ? { output: tool.output } : {}),
            ...(tool.error ? { error: tool.error } : {}),
            ...(tool.durationMs !== undefined ? { durationMs: tool.durationMs } : {})
          });
        }
      }
    }
    if (typeof input.progress === 'number') {
      await this.recordProgress(taskId, input.progress, input.summary);
    }

    // The engine owns the transition; the host owns the judgment (verdict).
    let action: TaskTurnAction;
    let diagnosis: TaskDiagnosis | undefined;
    let error: string | undefined;
    let reason: string | undefined;
    switch (verdict.type) {
      case 'continue':
        this.persistTurn(taskId, input.turn);
        action = 'continue';
        reason = verdict.reason;
        break;
      case 'verify': {
        const outcome = await this.diagnose(taskId, {
          diagnoser: options.diagnoser,
          detail: verdict.reason || input.summary
        });
        diagnosis = outcome.diagnosis;
        this.persistTurn(taskId, input.turn);
        action = 'verify';
        reason = verdict.reason;
        break;
      }
      case 'complete':
        await this.complete(taskId, {
          status: 'SUCCESS',
          summary: verdict.summary || input.summary,
          result: verdict.result,
          confidence: verdict.confidence
        });
        this.persistTurn(taskId, input.turn);
        action = 'complete';
        break;
      case 'fail':
        await this.failTask(taskId, verdict.error, 'EXECUTING');
        this.persist(new TaskEntity(this.store.require(taskId)).setOutcome({ status: 'FAILURE', summary: verdict.error }).record, {
          turns: input.turn
        });
        action = 'failed';
        error = verdict.error;
        break;
      case 'blocked': {
        const failed = await this.failTask(taskId, verdict.error, 'EXECUTING');
        this.persist(new TaskEntity(failed).setOutcome({ status: 'PARTIAL', summary: verdict.reason }).record, {
          turns: input.turn
        });
        action = 'blocked';
        error = verdict.error;
        break;
      }
      default:
        throw new Error(`Unknown turn verdict type.`);
    }

    await this.emit('TaskTurnCompleted', taskId, {
      turn: input.turn,
      verdict: verdict.type,
      action,
      ...(error ? { error } : {})
    });

    return {
      turn: input.turn,
      action,
      task: this.store.require(taskId),
      ...(diagnosis ? { diagnosis } : {}),
      ...(reason ? { reason } : {}),
      ...(error ? { error } : {})
    };
  }

  /**
   * Phase 12 Move 4a — the engine owns the mission loop. The host supplies one
   * model+tool batch per iteration via `iterate`; the engine walks the turns,
   * enforces budgets, and owns every lifecycle transition through runTurn.
   *
   * Loop semantics (single source of truth for the loop shape):
   *   - each requested iteration is processed as the next sequential turn;
   *   - an iteration that used tools keeps the task EXECUTING without a
   *     completion judgment (the engine decides: a tool batch is not a
   *     completion point) — the turn records the tool executions;
   *   - an iteration without tools is a completion candidate: the engine asks
   *     the completion hook (continue / verify / complete / fail / blocked)
   *     and owns the resulting transition;
   *   - continue/verify count as forked continuation points; when
   *     `maxForcedContinuations` is consumed the engine answers `blocked`;
   *   - when the iteration budget (`maxTurns`) is exhausted the mission stops
   *     with `stoppedByStepLimit`, and a blocked verdict surfaces.
   *
   * Never leaves the task in a terminal state it did not own: every transition
   * goes through runTurn's verdict switch.
   */
  async runMission(taskId: string, options: TaskMissionRunOptions): Promise<TaskMissionResult> {
    const record = this.require(taskId);
    const entity = new TaskEntity(record);
    if (entity.status === 'READY') {
      await this.start(taskId);
    }
    const budget = options.budget || {};
    const maxTurns = budget.maxTurns ?? 6;
    const maxForced = budget.maxForcedContinuations ?? 4;
    let forcedContinuations = 0;
    let stoppedByStepLimit = false;

    for (let turn = 1; turn <= maxTurns; turn++) {
      const snapshot = this.store.require(taskId);
      const ctx: TaskMissionIterateContext = {
        turn,
        task: snapshot,
        forcedContinuations,
        verificationPending: this.verificationPending(taskId)
      };
      const iteration = await options.iterate(ctx);
      const usedTools = iteration.usedTools === true
        || (Array.isArray(iteration.tools) && iteration.tools.length > 0);
      const evidence: TaskCompletionEvidence = {
        toolRequired: iteration.toolRequired ?? true,
        totalToolCalls: snapshot.toolExecutions.length,
        lastBatchHadFailure: iteration.lastBatchHadFailure ?? false,
        verificationRequired: iteration.verificationRequired ?? true,
        lastMutationSequence: -1,
        lastVerificationSequence: -1,
        forcedContinuations,
        maxForcedContinuations: maxForced,
        finalDraft: iteration.content || ''
      };

      let verdict: TaskTurnVerdict;
      if (usedTools) {
        // A tool batch is not a completion point. The engine owns this: the
        // iteration keeps working until the model produces a final answer.
        verdict = { type: 'continue', reason: 'Tool batch executed; continuing the mission.' };
      } else {
        verdict = await this.askCompletionVerdict(taskId, { turn, evidence }, options);
      }

      const result = await this.runTurn(taskId, {
        turn,
        verdict,
        evidence,
        // Only re-record when the host handed over executions to be recorded.
        tools: iteration.usedTools === true ? undefined : iteration.tools,
        model: iteration.model,
        ...(typeof iteration.progress === 'number' ? { progress: iteration.progress } : {})
      }, options);

      if (typeof options.onTurn === 'function') {
        await options.onTurn(result, ctx);
      }

      if (result.action === 'continue' || result.action === 'verify') {
        forcedContinuations += 1;
        continue;
      }

      return {
        task: this.store.require(taskId),
        action: result.action,
        turns: turn,
        stoppedByStepLimit: false,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.error ? { error: result.error } : {}),
        ...(result.diagnosis ? { diagnosis: result.diagnosis } : {})
      };
    }

    // The iteration budget ran out without a terminal verdict.
    if (this.store.require(taskId).status === 'EXECUTING') {
      stoppedByStepLimit = true;
      const evidence: TaskCompletionEvidence = {
        toolRequired: true,
        totalToolCalls: this.store.require(taskId).toolExecutions.length,
        lastBatchHadFailure: false,
        verificationRequired: true,
        forcedContinuations,
        maxForcedContinuations: maxForced,
        finalDraft: ''
      };
      const taskNow = this.store.require(taskId);
      const verdict: TaskTurnVerdict = { type: 'blocked', error: 'Automation step limit reached.', reason: 'turn budget exhausted' };
      await this.runTurn(taskId, {
        turn: (taskNow.timing?.turns || 0) + 1,
        verdict,
        evidence
      }, options);
    }

    return {
      task: this.store.require(taskId),
      action: 'blocked',
      turns: maxTurns,
      stoppedByStepLimit,
      reason: 'Automation step limit reached.',
      error: 'Automation step limit reached.'
    };
  }

  /**
   * Asks the host "is completion allowed?" (Phase 12 Move 2). Used when the
   * host omits the explicit verdict and instead supplies completion evidence.
   * Records the host's answer as a decision so the canonical Task carries the
   * completion-verdict evidence — the decision the runner used to make inline
   * as `completionBlocked`.
   */
  private async askCompletionVerdict(taskId: string, input: TaskTurnInput, options: TaskTurnRunOptions): Promise<TaskTurnVerdict> {
    const hook = options.completionVerdict || this.completionVerdict;
    if (!hook) {
      throw new Error('runTurn() requires either a `verdict` or a completionVerdict hook.');
    }
    const verdict = await hook({
      task: this.require(taskId),
      turn: input.turn,
      evidence: input.evidence || {},
      pendingVerification: this.verificationPending(taskId)
    });
    const detail = 'reason' in verdict
      ? verdict.reason
      : ('error' in verdict ? verdict.error : undefined);
    await this.recordDecision(
      taskId,
      `completion verdict: ${verdict.type}`,
      detail || 'no reason given'
    );
    return verdict;
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

  /**
   * In-mission recovery (Move 2, one execution authority): EXECUTING ->
   * VERIFYING -> EXECUTING. Runs the injected diagnoser to gather recovery
   * evidence (goal-matched files + test runs), records every result as a
   * TaskVerification with TestStarted/TestPassed/TestFailed and
   * TaskVerified/TaskVerificationFailed events, and returns the task to
   * EXECUTING so the host's retry continues — recovery semantics live here,
   * not in the host's loop. Never throws: a diagnoser failure is recorded and
   * recovery continues. No-op on terminal tasks.
   */
  async diagnose(
    taskId: string,
    options: { diagnoser?: TaskDiagnoser; detail?: string } = {}
  ): Promise<{ task: Task; diagnosis: TaskDiagnosis }> {
    const record = this.require(taskId);
    const entity = new TaskEntity(record);
    if (isTerminal(entity.status)) return { task: record, diagnosis: {} };

    this.persist(entity.transition('VERIFYING').record, { verifyingAt: Date.now() });
    await this.emit('TaskVerifying', taskId);
    await this.emit('TaskRetrying', taskId, { stage: 'diagnosing', detail: options.detail });

    let diagnosis: TaskDiagnosis = {};
    if (options.diagnoser) {
      try {
        diagnosis = (await options.diagnoser(this.store.require(taskId), this)) || {};
      } catch (error: any) {
        this.recordFailure(taskId, 'VERIFYING', `Diagnosis failed: ${error?.message || String(error)}`);
        diagnosis = { evidence: `Diagnosis failed: ${error?.message || String(error)}` };
      }
    }

    const tests = Array.isArray(diagnosis.tests) ? diagnosis.tests : [];
    for (const test of tests) {
      await this.emit('TestStarted', taskId, { command: test.command });
      await this.recordVerification(taskId, 'unit', test.passed ? 'PASSED' : 'FAILED', `${test.command} (exit ${test.exitCode})`);
      await this.emit(test.passed ? 'TestPassed' : 'TestFailed', taskId, { command: test.command, exitCode: test.exitCode });
      await this.emit(test.passed ? 'TaskVerified' : 'TaskVerificationFailed', taskId, { command: test.command, exitCode: test.exitCode });
    }
    if (diagnosis.matchedFiles && diagnosis.matchedFiles.length > 0 && !diagnosis.evidence) {
      diagnosis.evidence = `Goal-matched files: ${diagnosis.matchedFiles.join(', ')}`;
    }

    // Return to EXECUTING: the mission retry continues with the evidence.
    const current = this.store.require(taskId);
    const recovered = this.persist(new TaskEntity(current).transition('EXECUTING').record, {
      attempts: current.timing.attempts + 1
    });
    await this.emit('TaskRecovered', taskId, {
      attempt: recovered.timing.attempts,
      detail: options.detail,
      evidence: diagnosis.evidence
    });
    return { task: recovered, diagnosis };
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
    await this.emit(eventName, taskId, {
      tool: stored.name,
      arguments: stored.arguments || {},
      ...(stored.projectId ? { projectId: stored.projectId } : {}),
      ...(stored.output !== undefined ? { output: stored.output } : {}),
      ...(stored.durationMs !== undefined ? { durationMs: stored.durationMs } : {}),
      ...(stored.error ? { error: stored.error } : {})
    });
    return stored;
  }

  /**
   * Annotate an already-recorded tool execution with its host-computed role
   * (Phase 12 Move 3). Idempotent. Existing STARTED/COMPLETED/FAILED records
   * are tagged after the batch, so the canonical Task carries the mutation /
   * verification state that `verificationPending` reads.
   */
  async recordToolKind(taskId: string, executionId: string, kind: TaskToolKind): Promise<ToolExecution | undefined> {
    const record = this.require(taskId);
    const idx = record.toolExecutions.findIndex((ex) => ex.id === executionId);
    if (idx === -1) return undefined;
    const toolExecutions = [...record.toolExecutions];
    toolExecutions[idx] = { ...toolExecutions[idx], kind };
    this.persist(new TaskEntity(record).with({ toolExecutions }).record);
    return toolExecutions[idx];
  }

  /**
   * Engine-owned "verification is pending" state (Phase 12 Move 3). True when a
   * successful mutation tool has no later successful verification tool and no
   * PASSED verification evidence. This is the single mechanism the host's
   * completion hook asks; the host does not maintain its own counter state.
   */
  verificationPending(taskId: string): boolean {
    const task = this.require(taskId);
    const mutationAt = task.toolExecutions
      .filter((ex) => ex.kind === 'mutation' && ex.status === 'COMPLETED')
      .reduce((max, ex) => Math.max(max, ex.startedAt || 0), -1);
    if (mutationAt < 0) return false;
    const verifiedToolLater = task.toolExecutions.some(
      (ex) => ex.kind === 'verification' && ex.status === 'COMPLETED' && (ex.startedAt || 0) >= mutationAt
    );
    if (verifiedToolLater) return false;
    const passedEvidenceLater = (task.verification || []).some(
      (v) => v.status === 'PASSED' && (v.completedAt ?? v.startedAt) >= mutationAt
    );
    if (passedEvidenceLater) return false;
    return true;
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
    await this.emit(eventName, taskId, {
      tool: updated.name,
      arguments: updated.arguments || {},
      ...(updated.projectId ? { projectId: updated.projectId } : {}),
      ...(updated.output !== undefined ? { output: updated.output } : {}),
      ...(updated.durationMs !== undefined ? { durationMs: updated.durationMs } : {}),
      ...(updated.error ? { error: updated.error } : {})
    });
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

  /**
   * Attach the model selected for this task. Phase 6 keeps the choice on the
   * canonical Task so later telemetry/evaluation can relate outcome to model.
   */
  async assignModel(taskId: string, model: string): Promise<Task> {
    const entity = new TaskEntity(this.require(taskId));
    return this.persist(entity.with({ model }).record);
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

  /** Record the last completed turn number on the task. */
  private persistTurn(taskId: string, turn: number): Task {
    const record = this.store.require(taskId);
    return this.persist(record, { turns: turn });
  }

  private async emit(name: TaskEventName, taskId: string, data?: Record<string, unknown>): Promise<void> {
    // Self-contained event data: taskId + sessionId let subscribers (telemetry,
    // recovery, the hooks bridge) attribute events without querying the store.
    const record = this.store.get(taskId);
    const payload: Record<string, unknown> = { ...(data || {}), taskId };
    if (record?.sessionId) payload.sessionId = record.sessionId;
    await this.bus.emit({ name, taskId, timestamp: Date.now(), data: payload });
  }
}

/** Default process-wide engine. */
export const taskEngine = new TaskEngine();
