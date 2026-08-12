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
  profileId?: string;
  metadata?: Record<string, unknown>;
}