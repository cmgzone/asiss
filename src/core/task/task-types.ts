/**
 * Canonical Task model — Hermes Evolution Phase 1.
 *
 * The Task is the single source of truth for all autonomous work. Missions,
 * background goals, swarm jobs, workflow steps, delegations and scheduled work
 * are all expected to map onto this model over the following phases, while the
 * original subsystems keep working.
 *
 * Lifecycle (see task-state.ts):
 *
 *   CREATED -> ANALYZING -> PLANNING -> READY -> EXECUTING -> VERIFYING -> COMPLETED
 *
 * Failure paths:
 *   EXECUTING/VERIFYING -> FAILED -> DIAGNOSING -> REPAIRING -> EXECUTING
 *   READY -> BLOCKED (dependencies not satisfied) -> READY
 *   any active state -> PAUSED -> READY
 *   any non-terminal state -> CANCELLED
 */

export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';

export type TaskStatus =
  | 'CREATED'
  | 'ANALYZING'
  | 'PLANNING'
  | 'READY'
  | 'EXECUTING'
  | 'VERIFYING'
  | 'COMPLETED'
  | 'FAILED'
  | 'DIAGNOSING'
  | 'REPAIRING'
  | 'PAUSED'
  | 'BLOCKED'
  | 'CANCELLED';

/** What kind of work the task represents — maps to existing subsystems. */
export type TaskKind =
  | 'mission'      // an AgentRunner mission (processMessage turn)
  | 'resume'       // task_memory tracking entry (folded from legacy task-context)
  | 'background'   // background-worker goal
  | 'workflow'     // execute-workflow step
  | 'delegation'   // delegate_agent run
  | 'swarm'        // agent-swarm job
  | 'scheduled'    // scheduler job
  | 'subtask'      // child of another task
  | 'custom';

export interface TaskConstraints {
  /** Hard limits the executing agent must respect. */
  maxTurns?: number;
  maxToolCalls?: number;
  timeoutMs?: number;
  maxRetries?: number;
  /** Require human approval before execution (PolicyEngine integration, Phase 5). */
  requiresApproval?: boolean;
  allowedTools?: string[];
  deniedTools?: string[];
  workspacePath?: string;
  tags?: string[];
}

export interface TaskContextData {
  sessionId?: string;
  channel?: string;
  projectId?: string;
  /** Phase 23 — canonical project identity on the task record. */
  projectName?: string;
  workspacePath?: string;
  /** Phase 23 — canonical workspace root (=== workspacePath for bound tasks). */
  workspaceRoot?: string;
  /** The user's original request that produced this task. */
  userGoal?: string;
  input?: string;
  extras?: Record<string, unknown>;
}

export type TaskPlanStepStatus = 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'SKIPPED';

export interface TaskPlanStep {
  id: string;
  title: string;
  description?: string;
  status: TaskPlanStepStatus;
  /** If this step is delegated to a child task. */
  subtaskId?: string;
}

/**
 * Host-computed role of a tool call relative to the mission goal (Phase 12
 * Move 3). The host classifies each execution; the engine keeps the canonical
 * mutation/verification state so "verification is pending" is engine-owned.
 */
export type TaskToolKind = 'mutation' | 'verification' | 'inspection';

export interface ToolExecution {
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
  status: 'STARTED' | 'COMPLETED' | 'FAILED';
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  output?: unknown;
  error?: string;
  /** Host project attribution (D3: legacy before_tool carried projectId). */
  projectId?: string;
  /** Phase 23 — agent attribution for diagnosable tool logs. */
  agentId?: string;
  /** Phase 23 — per-call execution id for diagnosable tool logs. */
  executionId?: string;
  /** Host-computed role (mutation / verification / inspection). */
  kind?: TaskToolKind;
}

export interface TaskArtifact {
  id: string;
  name: string;
  path?: string;
  kind?: string;
  summary?: string;
  createdAt: number;
  data?: unknown;
}

/** Input accepted when recording a tool execution on a task. */
export interface TaskToolExecutionInput {
  name: string;
  arguments?: Record<string, unknown>;
  status?: 'STARTED' | 'COMPLETED' | 'FAILED';
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  output?: unknown;
  error?: string;
  /** Host project attribution (D3: legacy before_tool carried projectId). */
  projectId?: string;
  /** Phase 23 — agent attribution for diagnosable tool logs. */
  agentId?: string;
  /** Phase 23 — per-call execution id for diagnosable tool logs. */
  executionId?: string;
  /** Host-computed role (mutation / verification / inspection). */
  kind?: TaskToolKind;
}

/** Reference to a workspace snapshot created by checkpoint-manager. */
export interface TaskCheckpointRef {
  id: string;
  reason: string;
  createdAt: number;
}

export type TaskVerificationKind =
  | 'typecheck'
  | 'lint'
  | 'unit'
  | 'integration'
  | 'build'
  | 'runtime'
  | 'security'
  | 'criteria'
  | 'custom';

export type TaskVerificationStatus = 'RUNNING' | 'PASSED' | 'FAILED' | 'SKIPPED';

export interface TaskVerification {
  id: string;
  kind: TaskVerificationKind;
  status: TaskVerificationStatus;
  startedAt: number;
  completedAt?: number;
  detail?: string;
  attempts: number;
}

export interface TaskFailure {
  id: string;
  at: number;
  /** The status the task was in when it failed. */
  phase: TaskStatus;
  error: string;
  attempts: number;
  recovery?: 'retry' | 'repair' | 'cancelled';
}

export interface TaskDecision {
  id: string;
  at: number;
  summary: string;
  detail?: string;
}

export interface TaskCost {
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  usd?: number;
  breakdown?: Record<string, number>;
}

export interface TaskTiming {
  createdAt: number;
  lastActivityAt: number;
  analyzingAt?: number;
  planningAt?: number;
  startedAt?: number;
  executingAt?: number;
  verifyingAt?: number;
  completedAt?: number;
  /** Milliseconds between creation and terminal state. */
  durationMs?: number;
  attempts: number;
  /** Completed turns under the multi-turn execution contract (Phase 12). */
  turns?: number;
}

export type TaskOutcomeStatus = 'SUCCESS' | 'FAILURE' | 'PARTIAL' | 'CANCELLED';

export interface TaskOutcome {
  status: TaskOutcomeStatus;
  summary?: string;
  result?: unknown;
  confidence?: number;
  unresolvedQuestions?: string[];
}

export interface Task {
  id: string;
  parentId?: string;
  /** Root task id; for root tasks rootId === id. */
  rootId: string;
  goal: string;
  description?: string;
  kind: TaskKind;
  status: TaskStatus;
  priority: TaskPriority;
  constraints: TaskConstraints;
  context: TaskContextData;
  plan?: TaskPlanStep[];
  /** Child task ids (delegated/derived work). */
  subtasks: string[];
  /** Task ids that must be COMPLETED before this task may execute. */
  dependencies: string[];
  assignedAgent?: string;
  model?: string;
  toolExecutions: ToolExecution[];
  artifacts: TaskArtifact[];
  checkpoints: TaskCheckpointRef[];
  verification: TaskVerification[];
  cost: TaskCost;
  timing: TaskTiming;
  failures: TaskFailure[];
  decisions: TaskDecision[];
  outcome?: TaskOutcome;
  /** 0-100 progress estimate. */
  progress: number;
  progressNotes: string[];
  sessionId?: string;
  metadata?: Record<string, unknown>;
  /** Bumped on every mutation (change tracking / optimistic concurrency). */
  version: number;
}

/** Input accepted by TaskEngine.create() / createTask(). */
export interface TaskInput {
  goal: string;
  description?: string;
  kind?: TaskKind;
  priority?: TaskPriority;
  parentId?: string;
  constraints?: Partial<TaskConstraints>;
  context?: Partial<TaskContextData>;
  dependencies?: string[];
  assignedAgent?: string;
  model?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}
