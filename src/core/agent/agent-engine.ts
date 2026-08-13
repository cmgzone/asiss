/**
 * AgentEngine — Phase 13 Step 3.
 *
 * TaskEngine owns WHAT WORK HAPPENS. AgentEngine owns WHO DOES THE WORK.
 *
 * Step 3 migrates delegated execution onto TaskEngine's canonical mission
 * driver:
 *
 *   Parent Task -> TaskEngine -> Child Task -> AgentEngine -> Agent
 *                -> ModelEngine-family model call -> ToolEngine
 *
 * `executeTask` is a thin orchestration adapter. It does NOT own:
 *   - the turn loop (runMission owns it; AgentEngine supplies one model+tool
 *     batch per iteration, exactly like AgentRunner does for missions)
 *   - the terminal verdict (the engine asks; the host answers with evidence)
 *   - task state (TaskEngine owns CREATED..COMPLETED/FAILED)
 *   - retries (engine-owned files/failures; each attempt is a new child Task
 *     linked under the parent so attempts are visible as subtasks)
 *
 * Tool calls route through ToolEngine with `agentPermissions` populated from
 * the canonical Agent (Step 6 wiring lands here early because the plumbing
 * exists): every child tool is PolicyEngine-checked. There is no second
 * runChildLoop-style execution authority.
 */

import { AgentRegistry, agentRegistry } from './agent-registry';
import {
  capabilityHintsFromText,
  eligibilityOf,
  hasAllCapabilities,
  sortDeterministic
} from './agent-capabilities';
import {
  agentResultFromTaskReport,
  parseAgentResultFromText,
  taskReportFromAgentResult,
  type AgentResult
} from './agent-result';
import type { Agent, AgentInput } from './agent-types';
import { profileFromTask, type TaskProfile } from './task-profile';
import type { Task, TaskKind, TaskPlanStep } from '../task';
import type { ContextEngine } from '../context';
import { SkillRegistry } from '../skills';
import { ToolEngine } from '../tools';
import { TaskEngine, taskEngine as defaultTaskEngine } from '../task';
import type { RetrieveOptions, RetrievedMemory } from '../memory-unified/memory-catalog';
import type {
  ModelAttachment,
  ModelProvider,
  ModelResponse,
  StreamCallback,
  Tool
} from '../models';

export interface SelectAgentOptions {
  /** Explicit required capabilities (normalized against the catalog). */
  requiredCapabilities?: string[];
  /** Free-text goal — capability hints extracted when required is absent. */
  goalText?: string;
  /** Restrict to this role. */
  role?: string;
  /** Candidate names/ids to exclude. */
  exclude?: string[];
  /** Only agents that can carry out this task scope. */
  taskScope?: string;
}

export interface SelectResult {
  agent: Agent;
  /** True when every required capability is satisfied. */
  selected: boolean;
  /** Capabilities required but missing on the agent. */
  missing: string[];
}

/** Eligibility selection options (Step 4). */
export interface SelectForProfileOptions {
  /** Candidate names/ids to exclude. */
  exclude?: string[];
}

export interface ExecuteTaskOptions {  /** Canonical agent id or name. */
  agentId: string;
  /** The delegated task goal. */
  task: string;
  /** Canonical Task kind for the child task. Default 'delegation' ('swarm', 'background', ...). */
  kind?: TaskKind;
  expectedOutput?: string;
  reviewCriteria?: string[];
  /** Request-level tool allowlist (intersected with the agent's tools). */
  allowedTools?: string[];
  /** Turn budget for the child mission. Default 6, max 20. */
  maxTurns?: number;
  /** Retries after failure. Default 1, max 3. */
  retries?: number;
  /** Parent canonical task id — the child becomes a subtask of it. */
  parentTaskId?: string;
  sessionId?: string;
  workspacePath?: string;
  projectId?: string;
  /** Host linkage metadata merged onto the child Task (e.g. backgroundGoalId). */
  metadata?: Record<string, unknown>;
  /**
   * Phase 20 Move 8 — pre-built canonical plan steps for the child Task
   * (e.g. the background worker's project/milestone/task tree). Passed to
   * taskEngine.plan so /goal and /plan_project goals produce the same plan
   * artifact the mission loop renders. Absent -> the bare plan() path.
   */
  planSteps?: TaskPlanStep[];
}

export interface ExecuteTaskResult {
  success: boolean;
  result: AgentResult;
  /** First child Task id (all attempts are subtasks under parentTaskId). */
  taskId?: string;
  attempts: number;
  taskIds: string[];
  error?: string;
}

/** Runtime wiring for AgentEngine (model access + canonical engines). */
export interface AgentEngineRuntime {
  getModelById: (id?: string) => ModelProvider;
  getDefaultModel: () => ModelProvider;
  listMcpTools: () => Promise<Tool[]>;
  toolEngine: ToolEngine;
  taskEngine?: TaskEngine;
  /**
   * Phase 16 Move 4 (D5) — unified-memory retrieval for child missions. The
   * host wires the Phase 14 consolidation layer; AgentEngine only asks per the
   * agent's memoryPolicy (injectLimit / minScore / minImportance / types /
   * sources). AgentEngine has no knowledge of how memory is stored — policy
   * decides, the memory system executes.
   */
  retrieveMemory?: (query: string, opts: RetrieveOptions) => RetrievedMemory[] | Promise<RetrievedMemory[]>;
  /**
   * Phase 18 Move 4 (G3) — repository context for child missions. When the
   * agent's contextPolicy includes 'repo' and the runtime wires a
   * ContextEngine, the child system prompt renders the warmed, goal-matched
   * repository section — the AUDIT_7 D2 deferred source is now live.
   */
  contextEngine?: ContextEngine;
}

export class AgentEngine {
  private runtime?: AgentEngineRuntime;

  constructor(private registry: AgentRegistry = agentRegistry) {}

  /** Configure runtime access (model + tool/task engines). */
  configure(runtime: AgentEngineRuntime): void {
    this.runtime = runtime;
  }

  registerAgent(input: AgentInput, sourceId?: string): Agent {
    return this.registry.register(input, sourceId);
  }

  getAgent(idOrName: string): Agent | undefined {
    return this.registry.get(idOrName);
  }

  listAgents(): Agent[] {
    return this.registry.list();
  }

  refresh(): void {
    this.registry.refresh();
  }

  /** Eligibility report for one agent against required capabilities. */
  eligible(agent: Agent, requiredCapabilities?: string[]): SelectResult {
    const need = requiredCapabilities || [];
    const have = new Set(agent.capabilities.map(c => c.toLowerCase()));
    const missing = need.filter(c => !have.has(c.toLowerCase()));
    return { agent, selected: missing.length === 0, missing };
  }

  /** All agents that satisfy the required capabilities (capability-only). */
  candidates(options: SelectAgentOptions = {}): SelectResult[] {
    const required = options.requiredCapabilities?.length
      ? options.requiredCapabilities
      : capabilityHintsFromText(options.goalText || '');

    const excludeSet = new Set((options.exclude || []).map(s => s.toLowerCase()));

    return this.registry
      .list()
      .filter(a => a.status !== 'RELEASED')
      .filter(a => !options.role || a.role === options.role)
      .filter(a => !options.taskScope || a.taskScope === options.taskScope ||
        a.taskScope === 'any')
      .filter(a => !excludeSet.has(a.id.toLowerCase()) && !excludeSet.has(a.name.toLowerCase()))
      .map(a => this.eligible(a, required))
      .sort((a, b) => {
        const coverageA = a.agent.capabilities.length;
        const coverageB = b.agent.capabilities.length;
        if (coverageB !== coverageA) return coverageB - coverageA;
        return a.agent.name.localeCompare(b.agent.name);
      });
  }

  /** Select the best eligible agent for a task (capability-first). */
  selectAgent(options: SelectAgentOptions = {}): SelectResult | null {
    const first = this.candidates(options).find(r => r.selected);
    return first || null;
  }

  /**
   * Phase 16 Move 3b — the designated default agent for host-driven missions.
   *
   * Returns the first AVAILABLE agent explicitly designated `default: true`
   * in metadata (deterministic: registry order). Designation-only by design:
   * wrapped store agents (custom/profile/swarm) never become the mission's
   * agent implicitly — the mission loop's behavior is byte-identical until
   * someone registers a default. The mission loop then shares the SAME
   * contract surface as AgentEngine children: `assignedAgent` on the mission
   * Task, `modelPolicy.modelId` as the model pin, persona + instructions in
   * the system prompt. Tool/context/memory policies follow in Move 4.
   */
  resolveDefaultAgent(): Agent | undefined {
    return this.registry.list().find(
      (a) => a.status === 'AVAILABLE' && a.metadata?.default === true
    );
  }

  // ----------------------------------------------------- TaskProfile (Step 4)
  // Eligibility, not performance: "who CAN do this job?" Capability + role +
  // task-scope + tool grants + permission/workspace filters. NO performance
  // ranking — "who is BEST" is a later phase with measurement infrastructure.

  /** Profile-driven eligibility: every candidate passing the filters. */
  candidatesForProfile(profile: TaskProfile, options: SelectForProfileOptions = {}): SelectResult[] {
    const required = profile.requiredCapabilities?.length
      ? profile.requiredCapabilities
      : capabilityHintsFromText(profile.goal || '');

    const excludeSet = new Set((options.exclude || []).map(s => s.toLowerCase()));
    const requiredTools = (profile.requiredTools || []).filter(Boolean);
    const requiredToolNames = new Set(requiredTools.map(t => t.toLowerCase()));

    const scopeMatches = (agent: Agent): boolean => {
      if (!profile.kind || profile.kind === 'any') return true;
      if (agent.taskScope === 'any') return true;
      return agent.taskScope === profile.kind;
    };
    const roleMatches = (agent: Agent): boolean =>
      !profile.preferredRole || agent.role === profile.preferredRole;
    const toolsAndPermissionsMatch = (agent: Agent): boolean => {
      if (!requiredToolNames.size) return true;
      const denied = new Set((agent.permissions?.deniedTools || []).map(t => t.toLowerCase()));
      if (requiredTools.some(t => denied.has(t.toLowerCase()))) return false;
      const allowed = new Set((agent.permissions?.allowedTools || []).map(t => t.toLowerCase()));
      if (allowed.size && requiredTools.some(t => !allowed.has(t.toLowerCase()))) return false;
      const granted = new Set(agent.tools.map(t => t.toLowerCase()));
      return requiredTools.every(t => granted.has(t.toLowerCase()));
    };
    const workspaceMatches = (agent: Agent): boolean => {
      if (!profile.workspace) return true;
      const grants = (agent.permissions?.allowedWorkspacePaths || [])
        .map(p => p.replace(/\\/g, '/').toLowerCase());
      if (!grants.length) return true;
      const target = profile.workspace.replace(/\\/g, '/').toLowerCase();
      return grants.some(grant => target.startsWith(grant));
    };

    return this.registry
      .list()
      .filter(a => a.status !== 'RELEASED')
      .filter(a => !excludeSet.has(a.id.toLowerCase()) && !excludeSet.has(a.name.toLowerCase()))
      .filter(a => scopeMatches(a) && roleMatches(a) && toolsAndPermissionsMatch(a) && workspaceMatches(a))
      .map(a => this.eligible(a, required))
      .sort((x, y) => {
        const coverageA = x.agent.capabilities.length;
        const coverageB = y.agent.capabilities.length;
        if (coverageB !== coverageA) return coverageB - coverageA;
        return x.agent.name.localeCompare(y.agent.name);
      });
  }

  /** Best eligible agent for a TaskProfile (null when nobody can do it). */
  selectForProfile(profile: TaskProfile, options: SelectForProfileOptions = {}): SelectResult | null {
    return this.candidatesForProfile(profile, options).find(r => r.selected) || null;
  }

  /** Adapt + select for an existing canonical Task. */
  selectForTask(task: Task, options: SelectForProfileOptions = {}): SelectResult | null {
    return this.selectForProfile(profileFromTask(task), options);
  }

  /** Convenience over taskEngine.get(taskId); null when the task is unknown. */
  selectForTaskId(taskId: string, options: SelectForProfileOptions = {}): SelectResult | null {
    const task = this.runtime?.taskEngine?.get(taskId);
    if (!task) return null;
    return this.selectForTask(task, options);
  }

  /** Assign a task to an agent — lifecycle state only, no execution. */
  assignAgent(agentId: string, taskId: string | null): Agent | undefined {
    const agent = this.registry.get(agentId);
    if (!agent || agent.status === 'RELEASED') return undefined;
    agent.status = taskId ? 'ASSIGNED' : 'AVAILABLE';
    agent.metadata = {
      ...agent.metadata,
      assignedTaskId: taskId || undefined
    };
    return agent;
  }

  /** Release an agent back to AVAILABLE. */
  releaseAgent(agentId: string): Agent | undefined {
    const agent = this.registry.get(agentId);
    if (!agent) return undefined;
    agent.status = 'AVAILABLE';
    delete agent.metadata.assignedTaskId;
    return agent;
  }

  /**
   * Execute a delegated task through TaskEngine as canonical child Tasks
   * (Step 3). Each attempt is its own child Task under `parentTaskId`; the
   * loop, verdicts, and state transitions are engine-owned via runMission.
   * Tool calls go through ToolEngine with agent permissions enforced by
   * PolicyEngine. This is the only permitted delegation execution path —
   * runChildLoop-style second authorities are banned.
   */
  async executeTask(options: ExecuteTaskOptions): Promise<ExecuteTaskResult> {
    if (!this.runtime) {
      throw new Error('AgentEngine is not configured: call configure() with model/tool/task access first.');
    }
    const runtime = this.runtime;

    const agent = this.registry.get(options.agentId);
    if (!agent) {
      return {
        success: false,
        attempts: 0,
        taskIds: [],
        result: {
          agentId: options.agentId,
          status: 'failed',
          summary: `Agent not found: ${options.agentId}`,
          findings: [],
          evidence: [],
          artifacts: [],
          recommendations: [],
          unresolvedQuestions: []
        },
        error: `Agent not found: ${options.agentId}`
      };
    }
    if (agent.status === 'RELEASED') {
      return {
        success: false,
        attempts: 0,
        taskIds: [],
        result: {
          agentId: agent.id,
          agentName: agent.name,
          status: 'failed',
          summary: `Agent is disabled: ${agent.name}`,
          findings: [],
          evidence: [],
          artifacts: [],
          recommendations: [],
          unresolvedQuestions: []
        },
        error: `Agent is disabled: ${agent.name}`
      };
    }

    // Phase 16 Move 5 — handoffPolicy enforcement: a delegating agent can
    // only hand off to allowed roles within maxDepth. executeTask is the ONLY
    // delegation entry point, so every origin (delegation/swarm/background/
    // scheduled) is covered here. The delegator is the parent Task's
    // assignedAgent; refusal fails clearly with the policy reason and never
    // creates a child Task.
    const handoffBlocked = this.enforceHandoffPolicy(options.parentTaskId, agent);
    if (handoffBlocked) {
      return {
        success: false,
        attempts: 0,
        taskIds: [],
        result: {
          agentId: agent.id,
          agentName: agent.name,
          status: 'failed',
          summary: handoffBlocked,
          findings: [],
          evidence: [],
          artifacts: [],
          recommendations: [],
          unresolvedQuestions: [],
          errorSummary: handoffBlocked
        },
        error: handoffBlocked
      };
    }

    // Phase 16 Move 2 — the agent's executionLimits feed the mission budgets
    // when the caller does not override them, so the contract is not dead.
    const limits = agent.executionLimits || {};
    const maxTurns = Math.min(20, Math.max(1, options.maxTurns || limits.maxTurns || 6));
    const retries = options.retries ?? (limits.maxAttempts ? limits.maxAttempts - 1 : 1);
    const maxAttempts = Math.min(3, Math.max(1, retries + 1));
    const requested = new Set((options.allowedTools || []).map(t => t.trim()).filter(Boolean));
    const finalTools = (agent.tools || [])
      .filter(t => requested.size === 0 || requested.has(t))
      .filter(t => t !== 'delegate_agent');

    const taskEngine = runtime.taskEngine || defaultTaskEngine;
    const allToolSchemas = await this.advertisedToolSchemas(runtime, finalTools);

    const taskIds: string[] = [];
    // Phase 16 Move 4 — prior failed attempt outcomes, fed to later attempts
    // when the agent's contextPolicy includes 'attempts'.
    const priorOutcomes: Array<{ attempt: number; summary: string }> = [];
    let lastResult: AgentResult | undefined;
    const startedAt = new Date().toISOString();

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const childTask = await taskEngine.create({
        goal: options.task,
        kind: options.kind || 'delegation',
        parentId: options.parentTaskId,
        constraints: {
          maxTurns,
          allowedTools: finalTools.length ? finalTools : undefined
        },
        context: {
          sessionId: options.sessionId,
          workspacePath: options.workspacePath,
          projectId: options.projectId
        },
        assignedAgent: agent.id,
        model: agent.modelPolicy?.modelId,
        sessionId: options.sessionId,
        metadata: {
          ...(options.metadata || {}),
          delegatedAgentId: agent.id,
          delegatedAgentName: agent.name,
          expectedOutput: options.expectedOutput,
          reviewCriteria: options.reviewCriteria,
          attempt,
          maxAttempts
        }
      });
      taskIds.push(childTask.id);

      this.assignAgent(agent.id, childTask.id);

      try {
        // CREATED -> ANALYZING -> PLANNING -> READY so runMission can auto-start
        // (runMission only auto-starts READY tasks; create() leaves CREATED).
        await taskEngine.analyze(childTask.id);
        // Phase 20 Move 8: the host's plan steps (background worker project /
        // milestone / task tree) become the child Task's canonical plan —
        // never a bare plan() when steps are provided, so the child mission
        // renders the same plan artifact as the mission loop.
        await taskEngine.plan(childTask.id, options.planSteps);

        const mission = await this.runChildMission(runtime, taskEngine, childTask.id, agent, {
          ...options,
          maxTurns,
          allowedTools: finalTools,
          allToolSchemas,
          attempt,
          maxAttempts,
          startedAt,
          priorOutcomes
        });

        lastResult = mission.result;
        if (mission.success) {
          this.releaseAgent(agent.id);
          return {
            success: true,
            result: mission.result,
            taskId: childTask.id,
            attempts: attempt,
            taskIds
          };
        }
        // Record this attempt's outcome so the next attempt's context can
        // carry it (the 'attempts' contextPolicy source).
        const failedTask = taskEngine.get(childTask.id);
        const failedOutcome = failedTask?.outcome as any;
        priorOutcomes.push({
          attempt,
          summary: failedOutcome?.result?.summary || failedOutcome?.summary || mission.result.summary || 'failed'
        });
      } catch (err: any) {
        lastResult = {
          taskId: taskIds[taskIds.length - 1],
          agentId: agent.id,
          agentName: agent.name,
          status: 'failed',
          summary: `Child execution crashed: ${err?.message || String(err)}`,
          findings: [],
          evidence: [],
          artifacts: [],
          recommendations: [],
          unresolvedQuestions: [],
          errorSummary: err?.message || String(err),
          startedAt
        };
      }

      if (attempt < maxAttempts) {
        continue;
      }
    }

    this.releaseAgent(agent.id);
    return {
      success: false,
      result: lastResult!,
      taskId: taskIds[0],
      attempts: maxAttempts,
      taskIds,
      error: lastResult?.errorSummary || lastResult?.summary
    };
  }

  // ------------------------------------------------------------ internals

  private async advertisedToolSchemas(
    runtime: AgentEngineRuntime,
    toolNames: string[]
  ): Promise<Tool[]> {
    const byName = new Map<string, Tool>();
    for (const name of toolNames) {
      const skill = SkillRegistry.get(name);
      if (skill) {
        byName.set(name, {
          name: skill.name,
          description: skill.description,
          inputSchema: skill.inputSchema || { type: 'object', properties: {} }
        });
        continue;
      }
    }
    const mcpTools = await runtime.listMcpTools();
    for (const t of mcpTools) {
      if (toolNames.includes(t.name) && !byName.has(t.name)) byName.set(t.name, t);
    }
    return Array.from(byName.values());
  }

  private buildChildSystemPrompt(agent: Agent, tools: Tool[], memorySection: string, repoSection = '', planSection = ''): string {
    const toolList = tools.length
      ? tools.map(tool => `- ${tool.name}: ${tool.description || 'No description'}`).join('\n')
      : '- No tools allowed for this delegation.';

    return [
      agent.persona || `You are ${agent.name}, a ${agent.role}.`,
      ...(agent.instructions ? ['', agent.instructions] : []),
      '',
      'You are running as a delegated child agent on a canonical Task. Use only the tools provided in this call.',
      'Do not ask the user questions. If blocked, describe the blocker in the final report.',
      '',
      'Allowed tools:',
      toolList,
      ...(memorySection ? ['', memorySection] : []),
      ...(repoSection ? ['', repoSection] : []),
      ...(planSection ? ['', planSection] : []),
      '',
      'When finished, respond with one JSON object and no extra prose:',
      '{',
      '  "taskId": "<provided task id>",',
      '  "agentId": "<your agent id>",',
      '  "status": "completed | failed",',
      '  "summary": "brief result summary",',
      '  "workDone": ["specific work item"],',
      '  "filesChanged": ["path if any"],',
      '  "evidence": ["commands, outputs, sources, files, or observations supporting the result"],',
      '  "risks": ["remaining risk or empty"],',
      '  "nextSteps": ["recommended follow-up or empty"],',
      '  "finalOutput": "the child agent final answer or artifact summary"',
      '}'
    ].join('\n');
  }

  private buildChildTaskPrompt(
    task: string,
    expectedOutput: string | undefined,
    reviewCriteria: string[] | undefined,
    attempt: number,
    maxAttempts: number,
    priorOutcomes: Array<{ attempt: number; summary: string }> = []
  ): string {
    return [
      `Delegated task: ${task}`,
      expectedOutput ? `Expected output: ${expectedOutput}` : '',
      reviewCriteria?.length ? `Review criteria: ${reviewCriteria.join('; ')}` : '',
      `Attempt ${attempt} of ${maxAttempts}.`,
      ...(priorOutcomes.length ? ['Previous attempts:'] : []),
      ...priorOutcomes.map(p => `- Attempt ${p.attempt}: ${p.summary}`)
    ].filter(Boolean).join('\n');
  }

  /**
   * Phase 20 Move 8 — render the child Task's recorded plan with live
   * statuses, the same numbered artifact the mission loop renders (Phase 20
   * Move 3/7). The background worker's project/milestone/task tree lands on
   * the canonical Task via executeTask.planSteps, so /goal and /plan_project
   * goals walk the same guide in child missions. Never throws — plan context
   * is advisory.
   */
  private buildChildPlanSection(taskEngine: TaskEngine, taskId: string): string {
    try {
      const plan = taskEngine.get(taskId)?.plan;
      if (!Array.isArray(plan) || plan.length === 0) return '';
      return '\n\nMission plan (from the project/milestone plan tree; complete these steps before answering):\n'
        + plan.map((step, idx) => `${idx + 1}. [${step.status || 'PENDING'}] ${step.title}${step.description ? ' — ' + step.description : ''}`).join('\n');
    } catch {
      return '';
    }
  }

  /**
   * Phase 18 Move 4 (G3) — the child's repository context per the agent's
   * contextPolicy 'repo' source: warm (throttled) then render the
   * goal-matched repository section through the runtime's ContextEngine —
   * the same section the mission loop renders. Never throws — repo context
   * is advisory.
   */
  private buildChildRepoSection(
    runtime: AgentEngineRuntime,
    workspace: string | undefined,
    goal: string,
    taskId: string,
    sessionId?: string
  ): string {
    try {
      if (!workspace || !runtime.contextEngine) return '';
      const engine = runtime.contextEngine;
      engine.refreshRepository(workspace, { sessionId, taskId });
      return engine.repositorySection(workspace, goal);
    } catch {
      return '';
    }
  }

  /** Render the child turn context: prior assistant content + tool results. */
  private buildChildConversation(history: Array<{ role: string; content: string }>): string {
    if (!history.length) return '';
    return history.map((msg) => {
      if (msg.role === 'tool') return `Tool result: ${msg.content}`;
      if (msg.role === 'assistant') return `Assistant: ${msg.content}`;
      return `${msg.role === 'user' ? 'User' : 'System'}: ${msg.content}`;
    }).join('\n\n');
  }

  /**
   * One engine-owned child mission. Supplies a single model+tool batch per
   * iteration (engine maps it through runTurn); tool calls execute via
   * ToolEngine with `agentPermissions` so PolicyEngine enforces the
   * agent's tool surface; each iteration's model decision is returned as
   * iteration evidence, never as a direct state mutation.
   */
  private async runChildMission(
    runtime: AgentEngineRuntime,
    taskEngine: TaskEngine,
    childTaskId: string,
    agent: Agent,
    params: ExecuteTaskOptions & {
      maxTurns: number;
      maxAttempts: number;
      allToolSchemas: Tool[];
      attempt: number;
      startedAt: string;
      priorOutcomes: Array<{ attempt: number; summary: string }>;
    }
  ): Promise<{ success: boolean; result: AgentResult }> {
    // Phase 16 Move 4 (D2/D5) + Phase 18 Move 4 (G3) — the child context
    // assembles from the agent's contextPolicy sources: task/instructions/
    // history are structural (the task contract + loop contract — always
    // rendered), 'memory' gates the unified-memory section (memoryPolicy
    // drives retrieval), 'attempts' gates prior-attempt outcome lines, and
    // 'repo' (deferred in AUDIT_7 D2) now renders the warmed, goal-matched
    // repository section when the runtime wires a ContextEngine.
    const sources = new Set<string>(agent.contextPolicy?.sources || ['task', 'instructions', 'history']);
    const memorySection = sources.has('memory') && (agent.memoryPolicy?.injectLimit || 0) > 0 && runtime.retrieveMemory
      ? await this.buildChildMemorySection(runtime, agent, params.task, params.sessionId)
      : '';
    const repoSection = sources.has('repo') && runtime.contextEngine
      ? this.buildChildRepoSection(runtime, params.workspacePath, params.task, childTaskId, params.sessionId)
      : '';
    const planSection = this.buildChildPlanSection(taskEngine, childTaskId);
    const systemPrompt = this.buildChildSystemPrompt(agent, params.allToolSchemas, memorySection, repoSection, planSection);
    const priorOutcomes = sources.has('attempts') ? params.priorOutcomes : [];
    const initialUser = this.buildChildTaskPrompt(
      params.task,
      params.expectedOutput,
      params.reviewCriteria,
      params.attempt,
      params.maxAttempts,
      priorOutcomes
    );
    const history: Array<{ role: string; content: string }> = [
      { role: 'user', content: initialUser }
    ];

    // Step 7 — agent-width ModelPolicy: the pinned model plus declared
    // fallbackModelIds (in order) drive the child mission; the pin overrides
    // any default routing for this agent's width of work.
    const model = this.resolveMissionModel(runtime, agent);

    const missionResult = await taskEngine.runMission(childTaskId, {
      budget: { maxTurns: params.maxTurns },
      iterate: async ({ turn }) => {
        const prompt = this.buildChildConversation(history);
        const response = await model.generate(prompt, systemPrompt, params.allToolSchemas);

        if (response.content) {
          history.push({ role: 'assistant', content: response.content });
        }

        const toolCalls = response.toolCalls || [];
        if (toolCalls.length > 0) {
          let failedBatch = false;
          for (const call of toolCalls) {
            const toolResult = await runtime.toolEngine.execute(
              { name: call.name, arguments: call.arguments || {} },
              {
                sessionId: params.sessionId,
                taskId: childTaskId,
                projectId: params.projectId,
                workspacePath: params.workspacePath,
                config: {},
                agentPermissions: params.allowedTools
              }
            );
            if (!toolResult.success) failedBatch = true;
            history.push({
              role: 'tool',
              content: toolResult.success
                ? `Tool '${call.name}' result:\n${toolResult.output || ''}`
                : `Tool '${call.name}' error:\n${toolResult.error || (toolResult.denied ? 'DENIED by policy' : 'Unknown error')}`
            });
          }
          return {
            content: '',
            usedTools: true,
            model: agent.modelPolicy?.modelId,
            progress: Math.min(95, Math.round((turn / params.maxTurns) * 100)),
            lastBatchHadFailure: failedBatch
          };
        }

        const result = parseAgentResultFromText(response.content || '', {
          taskId: childTaskId,
          agentId: agent.id,
          agentName: agent.name
        });
        const report = taskReportFromAgentResult({
          ...result,
          startedAt: params.startedAt
        });

        if (result.status === 'completed') {
          return {
            content: response.content || '',
            verdict: { type: 'complete', summary: result.summary, result: report },
            model: agent.modelPolicy?.modelId,
            progress: 100
          };
        }
        return {
          content: response.content || '',
          verdict: { type: 'fail', error: result.errorSummary || result.summary },
          model: agent.modelPolicy?.modelId
        };
      }
    });

    if (missionResult.action === 'complete') {
      const task = taskEngine.get(childTaskId);
      const outcome = task?.outcome;
      const stored = outcome?.result as any;
      const result = stored
        ? agentResultFromTaskReport(stored)
        : {
            taskId: childTaskId,
            agentId: agent.id,
            agentName: agent.name,
            status: 'completed' as const,
            summary: 'Completed.',
            findings: [],
            evidence: [],
            artifacts: [],
            recommendations: [],
            unresolvedQuestions: [],
            startedAt: params.startedAt
          };
      await this.recordResultArtifact(taskEngine, childTaskId, result);
      return { success: true, result };
    }

    const task = taskEngine.get(childTaskId);
    const outcome = task?.outcome;
    const stored = outcome?.result as any;
    const result: AgentResult = stored && stored.summary
      ? {
          taskId: childTaskId,
          agentId: agent.id,
          agentName: agent.name,
          status: 'failed',
          summary: stored.summary || '',
          findings: Array.isArray(stored.workDone) ? stored.workDone : [],
          evidence: Array.isArray(stored.evidence) ? stored.evidence : [],
          artifacts: Array.isArray(stored.filesChanged)
            ? stored.filesChanged.map((f: string) => ({ name: f }))
            : [],
          recommendations: Array.isArray(stored.nextSteps) ? stored.nextSteps : [],
          unresolvedQuestions: Array.isArray(stored.risks) ? stored.risks : [],
          errorSummary: stored.errorSummary || missionResult.reason || String(missionResult.error || 'Failed.'),
          startedAt: params.startedAt
        }
      : {
          taskId: childTaskId,
          agentId: agent.id,
          agentName: agent.name,
          status: 'failed',
          summary: missionResult.reason || String(missionResult.error || 'Child did not complete.'),
          findings: [],
          evidence: [],
          artifacts: [],
          recommendations: [],
          unresolvedQuestions: [],
          errorSummary: missionResult.reason || String(missionResult.error || ''),
          startedAt: params.startedAt
        };
    await this.recordResultArtifact(taskEngine, childTaskId, result);
    return { success: false, result };
  }

  // ------------------------------------------------------------ internals

  /**
   * Phase 16 Move 5 — handoffPolicy enforcement (AgentHandoffPolicy).
   *
   * Walks the parent chain of a new delegation and answers whether the target
   * agent may be delegated to:
   *   - the immediate delegator (the parent Task's assignedAgent) must allow
   *     delegation and, when allowedRoles is set, the target's role must be in
   *     it;
   *   - every ancestor delegator's maxDepth bounds the handoff chain
   *     originating from it (depth 1 = its direct delegation, 2 = its
   *     grandchild, ...).
   * Returns a refusal message or null (allowed). Host-driven delegations
   * (no parent, or no agent on the chain) are unrestricted. Never throws.
   */
  private enforceHandoffPolicy(parentTaskId: string | undefined, target: Agent): string | null {
    if (!parentTaskId) return null;
    const taskEngine = this.runtime?.taskEngine || defaultTaskEngine;
    const chain: Array<{ agent: Agent; depthBelow: number }> = [];
    let current: Task | undefined = taskEngine.get(parentTaskId);
    while (current) {
      if (current.assignedAgent) {
        const delegator = this.registry.get(current.assignedAgent);
        if (delegator && delegator.status !== 'RELEASED') {
          chain.push({ agent: delegator, depthBelow: chain.length + 1 });
        }
      }
      current = current.parentId ? taskEngine.get(current.parentId) : undefined;
    }
    if (chain.length === 0) return null;

    const immediate = chain[0];
    const immediatePolicy = immediate.agent.handoffPolicy || {};
    if (immediatePolicy.allowDelegation === false) {
      return `Agent '${immediate.agent.name}' does not allow delegation (handoffPolicy.allowDelegation = false).`;
    }
    if (
      immediatePolicy.allowedRoles
      && immediatePolicy.allowedRoles.length > 0
      && !immediatePolicy.allowedRoles.includes(target.role)
    ) {
      return `Agent '${immediate.agent.name}' may only hand off to roles [${immediatePolicy.allowedRoles.join(', ')}], not '${target.role}' (${target.name}).`;
    }
    for (const link of chain) {
      const maxDepth = link.agent.handoffPolicy?.maxDepth;
      if (maxDepth != null && link.depthBelow > maxDepth) {
        return `Handoff chain exceeds ${link.agent.name}'s maxDepth (${maxDepth}) — this delegation sits at depth ${link.depthBelow}.`;
      }
    }
    return null;
  }

  /**
   * Phase 16 Move 4 (D5) — render the child's unified-memory section per the
   * agent's memoryPolicy. Retrieval goes through the runtime-provided
   * retrieveMemory (the host's consolidation layer); AgentEngine only maps
   * policy -> retrieve options and renders the hits. Never throws — memory is
   * advisory context.
   */
  private async buildChildMemorySection(
    runtime: AgentEngineRuntime,
    agent: Agent,
    task: string,
    sessionId?: string
  ): Promise<string> {
    try {
      const policy = agent.memoryPolicy || {};
      const limit = Math.max(1, Math.floor(policy.injectLimit || 3));
      const records = await runtime.retrieveMemory!(task, {
        sessionId,
        source: policy.sources && policy.sources.length > 0 ? (policy.sources[0] as any) : undefined,
        types: policy.types as any,
        limit,
        minImportance: policy.minImportance as any
      });
      const hits = (Array.isArray(records) ? records : [])
        .filter(r => (policy.minScore ?? 0) <= (r.score || 0))
        .slice(0, limit);
      if (hits.length === 0) return '';
      const label = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
      const lines = ['Memory context (unified):'];
      for (const r of hits) {
        const confidence = r.type === 'procedural' && r.confidence != null
          ? ` (${Math.round(r.confidence * 100)}% confidence)`
          : '';
        lines.push(`- ${label(r.type)}${confidence}: ${this.compactLine(r.content)}`);
      }
      return lines.join('\n');
    } catch {
      return '';
    }
  }

  private compactLine(text: string): string {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  /**
   * Step 7 — resolve the model for a child mission from the agent's
   * ModelPolicy: the pinned modelId first, then the declared fallbackModelIds
   * in order, then the runtime default. Unknown ids are skipped (the runtime
   * getModelById may already fall back host-side); the returned provider is
   * the pin when no fallbacks are declared.
   */
  private resolveMissionModel(runtime: AgentEngineRuntime, agent: Agent): ModelProvider {
    const policy = agent.modelPolicy || {};
    let primary: ModelProvider;
    try {
      primary = policy.modelId ? runtime.getModelById(policy.modelId) : runtime.getDefaultModel();
    } catch {
      primary = runtime.getDefaultModel();
    }
    const fallbacks: ModelProvider[] = [];
    for (const id of policy.fallbackModelIds || []) {
      if (id === policy.modelId) continue;
      try {
        const provider = runtime.getModelById(id);
        if (provider && provider.id !== primary.id && !fallbacks.some(f => f.id === provider.id)) {
          fallbacks.push(provider);
        }
      } catch {
        // Unknown fallback id: skip it.
      }
    }
    return fallbacks.length > 0 ? new AgentModelFallback(primary, fallbacks) : primary;
  }

  /** Step 8 — the canonical AgentResult is registered as a task artifact. */
  private async recordResultArtifact(taskEngine: TaskEngine, taskId: string, result: AgentResult): Promise<void> {
    try {
      await taskEngine.recordArtifact(taskId, {
        name: 'agent-result',
        kind: 'agent-result',
        summary: result.summary,
        data: result
      });
    } catch (err: any) {
      console.warn('[AgentEngine] record agent-result artifact failed:', err?.message || err);
    }
  }
}

/**
 * Step 7 — agent-width model fallback chain. Tries the pinned model, then the
 * declared fallbackModelIds in order; any provider error falls through to the
 * next candidate. Minimal by design: cooldowns/health live in
 * ResilientModelProvider (main mission path); this only honors the
 * AgentModelPolicy contract for child missions without creating a new
 * authority.
 */
class AgentModelFallback implements ModelProvider {
  readonly id: string;
  readonly name: string;

  constructor(private readonly primary: ModelProvider, private readonly fallbacks: ModelProvider[]) {
    this.id = primary.id;
    this.name = `${primary.name} with agent-model fallback`;
  }

  async generate(prompt: string, systemPrompt?: string, tools?: Tool[], attachments?: ModelAttachment[]): Promise<ModelResponse> {
    const chain = [this.primary, ...this.fallbacks];
    const failures: string[] = [];
    for (const provider of chain) {
      try {
        return await provider.generate(prompt, systemPrompt, tools, attachments);
      } catch (error: any) {
        failures.push(`${provider.name}: ${String(error?.message || error).slice(0, 300)}`);
      }
    }
    throw new Error(`All agent models failed for the child mission. ${failures.join(' | ')}`);
  }

  async generateStream(prompt: string, systemPrompt?: string, tools?: Tool[], onChunk?: StreamCallback, attachments?: ModelAttachment[]): Promise<ModelResponse> {
    const chain = [this.primary, ...this.fallbacks];
    const failures: string[] = [];
    for (const provider of chain) {
      try {
        if (provider.generateStream) {
          return await provider.generateStream(prompt, systemPrompt, tools, onChunk, attachments);
        }
        const buffered: string[] = [];
        const result = await provider.generate(prompt, systemPrompt, tools, attachments);
        if (onChunk && result.content) {
          for (let offset = 0; offset < result.content.length; offset += 160) {
            onChunk(result.content.slice(offset, offset + 160));
          }
        }
        return result;
      } catch (error: any) {
        failures.push(`${provider.name}: ${String(error?.message || error).slice(0, 300)}`);
      }
    }
    throw new Error(`All agent models failed for the child mission. ${failures.join(' | ')}`);
  }
}

export { hasAllCapabilities, sortDeterministic, eligibilityOf };

/** Singleton over the global registry (matches existing manager conventions). */
export const agentEngine = new AgentEngine();