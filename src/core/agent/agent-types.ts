/**
 * Canonical Agent model — Hermes Evolution Phase 13 (Step 2).
 *
 * The Agent describes WHAT a worker is capable of. It does NOT own the
 * mission lifecycle — TaskEngine does (Phase 12). AgentEngine owns who
 * performs the work; TaskEngine owns what work happens. This phase must
 * not create a second execution authority.
 *
 * Wrap-first strategy: existing stores (custom agents, agent profiles,
 * swarm agents, A2A cards) are ADAPTED into this canonical shape and
 * registered in `AgentRegistry`. Nothing is migrated or deleted while
 * the old system keeps functioning; incompatibilities surface during the
 * wrap.
 */

/** Source of a canonical agent — where its definition came from. */
export type AgentSourceKind =
  | 'custom_agent'
  | 'agent_profile'
  | 'swarm_agent'
  | 'a2a_card'
  | 'registry';

/**
 * Worker role. First-class (enum-ish) so agent selection can match on it
 * instead of free text; factory helpers keep backward compatibility with
 * free-form swarm roles.
 */
export type AgentRole =
  | 'general'
  | 'researcher'
  | 'coder'
  | 'writer'
  | 'analyst'
  | 'planner'
  | 'reviewer'
  | 'architect'
  | 'tester'
  | 'external';

/** Canonical agent lifecycle state (Step 9 of the phase plan). */
export type AgentStatus =
  | 'AVAILABLE'
  | 'ASSIGNED'
  | 'WORKING'
  | 'WAITING'
  | 'COMPLETED'
  | 'RELEASED';

/** Per-agent model rules layered on top of ModelEngine's task-shaped scoring. */
export interface AgentModelPolicy {
  /** Preferred provider/model id (registered in the ModelRegistry). */
  modelId?: string;
  /** Fallback ordered model ids used when the preferred model is unavailable. */
  fallbackModelIds?: string[];
  /** Complexity level preference (low/medium/high) for ModelEngine scoring. */
  desiredLevel?: 'low' | 'medium' | 'high';
}

/** Per-agent permission envelope handed to PolicyEngine (Step 6 wiring). */
export interface AgentPermissions {
  /** Tool names this agent may use (windows down the global registry). */
  allowedTools?: string[];
  /** Tool names always denied for this agent. */
  deniedTools?: string[];
  /** Require human approval for these tool names. */
  requireApprovalFor?: string[];
  /** Workspace paths this agent may touch. */
  allowedWorkspacePaths?: string[];
  /** Hard tool-call budget for tasks assigned to this agent. */
  maxToolCalls?: number;
}

/** Where an agent's episodic/procedural context is scoped (Phase 13 Step 8 target). */
export type AgentMemoryScope = 'none' | 'session' | 'task' | 'agent' | 'global';

/** What kinds of TaskScope this agent is suited for. */
export type AgentTaskScope =
  | 'any'
  | 'mission'
  | 'delegation'
  | 'swarm'
  | 'background'
  | 'scheduled'
  | 'subtask';

// ----------------------------------------------------------------------------
// Phase 16 Move 2 — the extended Agent contract (docs/hermes/AUDIT_7.md §4).
//
// The contract separates three concepts that must never collapse into one
// record:
//
//   Task          = WHAT work needs to happen          (TaskEngine owns it)
//   AgentProfile  = HOW this kind of agent behaves     (Agent + policies)
//   AgentRun      = THIS execution of that agent       (the canonical Task +
//                                                       assignedAgent + the
//                                                       registry status projection)
//
// Move 2 deliberately keeps **Task-as-run**: no distinct AgentRun record, so
// Audit 5's removed run bookkeeping cannot re-materialize. Each policy below
// is declared on the contract now; the wiring that consumes it lands in
// Moves 3-5 (context builder, model/tool/memory policies, handoffs).
// ----------------------------------------------------------------------------

/** Context sources an agent may pull into its mission context. */
export type AgentContextSource =
  | 'task'          // goal / expected output / review criteria
  | 'instructions'  // the agent's own instructions (below)
  | 'repo'          // repository/workspace warmth context
  | 'memory'        // Phase 14 unified-memory retrieval
  | 'history'       // session / prior-turn history
  | 'attempts';     // previous attempt outcomes

/** Which context sources feed this agent's missions, and the assembly budget. */
export interface AgentContextPolicy {
  /** Enabled sources, in assembly order. Default: ['task', 'instructions']. */
  sources?: AgentContextSource[];
  /** Cap on assembled context characters (overrides executionLimits when set). */
  maxContextChars?: number;
}

/**
 * Unified-memory retrieval + injection policy (Phase 14 layer). Children get
 * NO memory injection today (Audit 7 finding D5); Move 4 wires the catalog
 * retrieval through this policy.
 */
export interface AgentMemoryPolicy {
  /** Records injected into the mission context (0 = none; default 0 for children). */
  injectLimit?: number;
  /** Minimum retrieval score for injected records. */
  minScore?: number;
  /** Minimum importance for injected records. */
  minImportance?: number;
  /** Restrict to these memory types (lesson | episode | ...). */
  types?: string[];
  /** Restrict to these sources (conversation | learning | task). */
  sources?: string[];
}

/**
 * Hard execution budgets — complements permissions.maxToolCalls, which stays
 * the tool-call budget. Feed AgentEngine.executeTask defaults in Move 2 so
 * the policy is not dead contract.
 */
export interface AgentExecutionLimits {
  /** Max model turns for a mission assigned to this agent (default 6). */
  maxTurns?: number;
  /** Max attempts (retries + 1) for delegated work (default 1 retry → 2 attempts). */
  maxAttempts?: number;
  /** Approx max output tokens per mission. */
  maxOutputTokens?: number;
  /** Wall-clock mission timeout in ms. */
  timeoutMs?: number;
  /** Max prompt/context characters the agent may receive (default 24_000). */
  maxContextChars?: number;
}

/** Handoff/delegation rules — declared here, enforced in Phase 16 Move 5. */
export interface AgentHandoffPolicy {
  /** May this agent delegate to other agents? (default true). */
  allowDelegation?: boolean;
  /** Roles this agent may hand off to (empty = any role). */
  allowedRoles?: AgentRole[];
  /** Max handoff-chain depth originating here (default 3). */
  maxDepth?: number;
}

export interface Agent {
  /** Canonical id — namespace-prefixed (`custom:…`, `profile:…`, `swarm:…`) to avoid cross-store collisions. */
  id: string;
  /** Id inside the source store (unprefixed). */
  sourceId?: string;
  /** Where this definition came from (wrap provenance). */
  sourceKind: AgentSourceKind;
  name: string;
  role: AgentRole;
  description?: string;
  /** What the agent can do (normalized capability ids; see agent-capabilities.ts). */
  capabilities: string[];
  /** Tool/skill names advertised to this agent. */
  tools: string[];
  modelPolicy: AgentModelPolicy;
  permissions: AgentPermissions;
  memoryScope: AgentMemoryScope;
  taskScope: AgentTaskScope;
  status: AgentStatus;
  /** Optional system-prompt/persona override. */
  persona?: string;
  /**
   * Explicit operating instructions (Phase 16 Move 2) — concise, imperative
   * rules rendered into the system prompt AFTER persona, so they win any
   * conflict. Distinct from persona (identity/tone) and from learned skills.
   */
  instructions?: string;
  /** Which context sources feed this agent's missions + assembly budget. */
  contextPolicy: AgentContextPolicy;
  /** Unified-memory retrieval + injection policy. */
  memoryPolicy: AgentMemoryPolicy;
  /** Hard execution budgets (turns/attempts/tokens/time/context). */
  executionLimits: AgentExecutionLimits;
  /** Delegation/handoff rules (enforced in Move 5). */
  handoffPolicy: AgentHandoffPolicy;
  /** Stable store reference (profile/other managers use id-or-name). */
  profileId?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** Input accepted by AgentRegistry.register() / AgentEngine.registerAgent(). */
export interface AgentInput {
  id?: string;
  sourceId?: string;
  sourceKind?: AgentSourceKind;
  name: string;
  role?: AgentRole;
  description?: string;
  capabilities?: string[];
  tools?: string[];
  modelPolicy?: AgentModelPolicy;
  permissions?: AgentPermissions;
  memoryScope?: AgentMemoryScope;
  taskScope?: AgentTaskScope;
  persona?: string;
  instructions?: string;
  contextPolicy?: AgentContextPolicy;
  memoryPolicy?: AgentMemoryPolicy;
  executionLimits?: AgentExecutionLimits;
  handoffPolicy?: AgentHandoffPolicy;
  profileId?: string;
  metadata?: Record<string, unknown>;
}