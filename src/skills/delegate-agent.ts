/**
 * DelegateAgentSkill — Phase 13 Step 3 (migrated).
 *
 * The legacy second execution authority (runChildLoop) is GONE. This skill is
 * now a thin shim over the canonical path:
 *
 *   TaskEngine (parent mission) -> AgentEngine.executeTask -> child Task
 *   (kind 'delegation') driven by TaskEngine.runMission -> ToolEngine +
 *   PolicyEngine (agent permissions live) -> canonical AgentResult.
 *
 * The skill keeps only:
 *   - request parsing + agent resolution (custom/profile/swarm/ephemeral),
 *   - a compatibility shim that books the run in AgentRunManager (task_memory
 *     rendering, reviewPrompt, agent_runs.json consumers),
 *   - result formatting for the main agent.
 *
 * Every loop/tool-dispatch/prompt-building/retry responsibility moved to the
 * engines per docs/hermes/CHILD_LOOP_MIGRATION_MAP.md. No deletion happened
 * until the new owner was verified by `npm run smoke:agent-execution`.
 */
import { agentRunManager, AgentTaskReport, AgentToolCallRecord } from '../core/agent-run-manager';
import { agentProfileManager, AgentProfile } from '../core/agent-profiles';
import { agentSwarm, SwarmAgent } from '../core/agent-swarm';
import { CustomAgentConfig, customAgentManager } from '../core/custom-agents';
import { ModelProvider, Tool } from '../core/models';
import { Skill, SkillRegistry } from '../core/skills';
import { checkpointManager } from '../core/checkpoint-manager';
import { AgentEngine } from '../core/agent/agent-engine';
import { agentRegistry } from '../core/agent/agent-registry';
import { ToolEngine } from '../core/tools';
import { TaskEngine, taskEngine as defaultTaskEngine } from '../core/task';

interface DelegateAgentDeps {
  getModelById: (id?: string) => ModelProvider;
  getDefaultModel: () => ModelProvider;
  listMcpTools: () => Promise<Tool[]>;
  callMcpTool: (name: string, args: any) => Promise<any>;
  /** Canonical ToolEngine (the runner passes its own). Built privately otherwise. */
  toolEngine?: ToolEngine;
  /** Canonical TaskEngine (defaults to the shared singleton). */
  taskEngine?: TaskEngine;
}

type ResolvedAgent = {
  id: string;
  name: string;
  kind: 'custom_agent' | 'agent_profile' | 'swarm_agent';
  /** Canonical (namespaced) agent id used by AgentEngine.executeTask. */
  canonicalId: string;
  persona: string;
  profile?: AgentProfile;
  allowedSkillNames: string[];
};

const EPHEMERAL_TOOLS = [
  'system_info', 'current_time', 'web_search', 'web_fetch', 'brave_search', 'serper_search',
  'shell', 'apply_patch', 'playwright', 'notes', 'memory', 'task_memory', 'checkpoints',
  'code_search', 'git', 'code_review'
];

export class DelegateAgentSkill implements Skill {
  name = 'delegate_agent';
  description = 'Delegate one subtask, or a tasks batch of independent subtasks that runs concurrently, to CustomAgents, AgentProfiles, or swarm agents. Each child runs on a canonical Task (TaskEngine) with ToolEngine + policy enforcement and returns a saved structured report.';
  inputSchema = {
    type: 'object',
    properties: {
      agentId: { type: 'string', description: 'Custom agent, profile, swarm agent, or "auto" for an ephemeral specialist.' },
      name: { type: 'string', description: 'Alternative agent name when agentId is not supplied.' },
      task: { type: 'string', description: 'The delegated task to execute.' },
      expectedOutput: { type: 'string', description: 'What the child agent should produce.' },
      allowedTools: { type: 'array', items: { type: 'string' }, description: 'Optional tool allowlist for this delegation.' },
      maxTurns: { type: 'number', description: 'Maximum child mission turns. Default 6, max 20.' },
      reviewCriteria: { type: 'array', items: { type: 'string' }, description: 'Criteria the main agent should use while reviewing the report.' },
      retries: { type: 'number', description: 'Retries for failed child work. Default 1, max 3.' }
      ,tasks: {
        type: 'array',
        description: 'Independent delegated tasks to run concurrently (max 8). Each item accepts agentId/name, task, expectedOutput, allowedTools, maxTurns, reviewCriteria, and retries.',
        items: {
          type: 'object',
          properties: {
            agentId: { type: 'string' },
            name: { type: 'string' },
            task: { type: 'string' },
            expectedOutput: { type: 'string' },
            allowedTools: { type: 'array', items: { type: 'string' } },
            maxTurns: { type: 'number' },
            reviewCriteria: { type: 'array', items: { type: 'string' } },
            retries: { type: 'number' }
          },
          required: ['task']
        }
      }
    },
    required: []
  };

  private readonly deps: DelegateAgentDeps;
  private readonly engine: AgentEngine;
  private readonly toolEngine: ToolEngine;
  private readonly taskEngine: TaskEngine;

  constructor(deps: DelegateAgentDeps) {
    this.deps = deps;
    this.taskEngine = deps.taskEngine || defaultTaskEngine;
    this.toolEngine = deps.toolEngine || new ToolEngine({
      skills: SkillRegistry,
      mcp: {
        callTool: (name: string, args: any) => deps.callMcpTool(name, args),
        getKnownToolNames: () => []
      },
      dynamicTools: {
        resolve: async () => ({ success: false, error: 'Dynamic tools are not available for delegated children.' }),
        normalizeName: () => null
      },
      checkpoints: checkpointManager
    });
    this.engine = new AgentEngine(agentRegistry);
    this.engine.configure({
      getModelById: deps.getModelById,
      getDefaultModel: deps.getDefaultModel,
      listMcpTools: deps.listMcpTools,
      toolEngine: this.toolEngine,
      taskEngine: this.taskEngine
    });
  }

  async execute(params: any): Promise<any> {
    const batch = Array.isArray(params?.tasks) ? params.tasks.slice(0, 8) : [];
    if (batch.length > 0) {
      const results = await Promise.all(batch.map((taskParams: any) => this.executeSingle({
        ...params,
        ...taskParams,
        tasks: undefined
      })));
      return {
        success: results.every(result => result?.success === true),
        parallel: true,
        count: results.length,
        results,
        reviewPrompt: agentRunManager.buildReviewPrompt(this.normalizeString(params?.__sessionId) || undefined),
        _synthesisInstructions: 'Review every parallel child report. Merge non-overlapping findings, verify evidence, and call out any failed child task.'
      };
    }
    return this.executeSingle(params);
  }

  private async executeSingle(params: any): Promise<any> {
    const task = this.normalizeString(params?.task);
    if (!task) return { error: 'task is required' };

    const agentKey = this.normalizeString(params?.agentId || params?.name);
    if (!agentKey) return { error: 'agentId or name is required' };

    // Fresh wrap of the source stores so agent edits and disabled states
    // propagate into the canonical registry before execution.
    agentRegistry.refresh();

    const resolved = this.resolveAgent(agentKey);
    if (!resolved) {
      return {
        error: `Agent not found: ${agentKey}`,
        availableCustomAgents: customAgentManager.listAgents(true).map(a => ({ id: a.id, name: a.name, displayName: a.displayName })),
        availableProfiles: agentProfileManager.list().map(p => ({ id: p.id, name: p.name }))
      };
    }

    const expectedOutput = this.normalizeString(params?.expectedOutput);
    const requestAllowedTools = this.normalizeStringArray(params?.allowedTools);
    const reviewCriteria = this.normalizeStringArray(params?.reviewCriteria);
    const maxTurns = this.clampNumber(params?.maxTurns, 6, 1, 20);
    const retries = this.clampNumber(params?.retries, 1, 0, 3);
    const sessionId = this.normalizeString(params?.__sessionId) || undefined;
    const workspacePath = this.normalizeString(params?.__workspacePath) || undefined;
    const projectId = this.normalizeString(params?.__projectId) || undefined;
    const parentTaskId = this.normalizeString(params?.__taskId) || undefined;

    const run = agentRunManager.createRun({
      sessionId,
      agentId: resolved.id,
      agentName: resolved.name,
      agentKind: resolved.kind,
      task,
      expectedOutput,
      allowedTools: requestAllowedTools.length ? requestAllowedTools : resolved.allowedSkillNames,
      reviewCriteria,
      maxTurns
    });

    agentRunManager.startAttempt(run.taskId);

    const exec = await this.engine.executeTask({
      agentId: resolved.canonicalId,
      task,
      expectedOutput,
      reviewCriteria,
      allowedTools: requestAllowedTools.length ? requestAllowedTools : undefined,
      maxTurns,
      retries,
      parentTaskId,
      sessionId,
      workspacePath,
      projectId
    });

    for (const childTaskId of exec.taskIds) {
      this.bookChildEvidence(run.taskId, childTaskId);
    }

    const report = this.buildReport(run, resolved, exec);
    const completed = agentRunManager.completeRun(run.taskId, report);
    // completeRun normalizes the report with the run's recorded tool calls and
    // metadata — return THAT report so consumers see the full evidence.
    this.recordProfilePerformance(resolved, exec.success, run.startedAt);
    return this.formatSkillResult(completed?.report || report, sessionId);
  }

  // ---------------------------------------------------- canonical-path shim

  /** Mirror each child task's tool executions onto the legacy run record
   *  (task_memory rendering + reviewPrompt + agent_runs.json consumers). */
  private bookChildEvidence(runTaskId: string, childTaskId: string): void {
    const task = this.taskEngine.get(childTaskId);
    if (!task) return;
    for (const execution of task.toolExecutions || []) {
      const record: Omit<AgentToolCallRecord, 'timestamp'> = {
        id: execution.id,
        name: execution.name,
        arguments: execution.arguments || {},
        success: execution.status === 'COMPLETED',
        ...(typeof execution.output === 'string'
          ? { output: execution.output }
          : execution.output !== undefined
            ? { output: JSON.stringify(execution.output) }
            : {}),
        ...(execution.error ? { error: execution.error } : {})
      };
      agentRunManager.recordToolCall(runTaskId, record);
      agentRunManager.appendMessage(runTaskId, {
        role: 'tool',
        toolName: execution.name,
        content: execution.status === 'COMPLETED'
          ? `Tool '${execution.name}' result:\n${record.output || ''}`
          : `Tool '${execution.name}' error:\n${execution.error || 'Unknown error'}`
      });
    }
  }

  /** Map the canonical AgentResult onto the legacy AgentTaskReport shape. */
  private buildReport(
    run: { taskId: string; startedAt?: string },
    resolved: ResolvedAgent,
    exec: { success: boolean; result: { status: string; summary: string; findings: string[]; evidence: string[]; artifacts: Array<{ name: string; path?: string }>; recommendations: string[]; unresolvedQuestions: string[]; errorSummary?: string; finalOutput?: string }; attempts: number }
  ): AgentTaskReport {
    const result = exec.result;
    return {
      taskId: run.taskId,
      agentId: resolved.id,
      status: result.status === 'completed' ? 'completed' : 'failed',
      summary: result.summary,
      workDone: [...result.findings],
      filesChanged: result.artifacts.map(artifact => artifact.path || artifact.name),
      toolCalls: [],
      evidence: [...result.evidence],
      risks: [...result.unresolvedQuestions],
      nextSteps: [...result.recommendations],
      finalOutput: result.finalOutput || result.summary,
      errorSummary: result.errorSummary || (exec.success ? undefined : result.summary),
      attempts: exec.attempts,
      startedAt: run.startedAt,
      completedAt: new Date().toISOString(),
      expectedOutput: undefined,
      reviewCriteria: undefined
    };
  }

  private formatSkillResult(report: AgentTaskReport, sessionId?: string) {
    return {
      success: report.status === 'completed',
      taskId: report.taskId,
      agentId: report.agentId,
      status: report.status,
      report,
      reviewPrompt: agentRunManager.buildReviewPrompt(sessionId),
      _synthesisInstructions: 'Review the AgentTaskReport before answering the user. Verify claims against evidence, include useful child output, and mention failed or risky items clearly.'
    };
  }

  private recordProfilePerformance(agent: ResolvedAgent, success: boolean, startedAt?: string) {
    const profileId = agent.profile?.id;
    if (!profileId) return;
    const started = startedAt ? Date.parse(startedAt) : NaN;
    const durationMs = Number.isFinite(started) ? Math.max(0, Date.now() - started) : 0;
    agentProfileManager.recordPerformance(profileId, success, durationMs, 'delegated_agent_task');
  }

  // ------------------------------------------------------------- resolution

  private resolveAgent(idOrName: string): ResolvedAgent | null {
    const custom = customAgentManager.getAgent(idOrName);
    if (custom && custom.enabled !== false) {
      return { ...this.resolveCustomAgent(custom), canonicalId: `custom:${custom.id}` };
    }

    const profile = agentProfileManager.get(idOrName);
    if (profile) {
      return { ...this.resolveProfileAgent(profile), canonicalId: `profile:${profile.id}` };
    }

    const swarm = agentSwarm.getAgent(idOrName) || agentSwarm.getAgentByName(idOrName);
    if (swarm) {
      return { ...this.resolveSwarmAgent(swarm), canonicalId: `swarm:${swarm.id}` };
    }

    const ephemeralName = idOrName.toLowerCase() === 'auto' ? 'Ephemeral Specialist' : idOrName;
    const id = `ephemeral-${ephemeralName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'specialist'}`;
    return {
      id,
      name: ephemeralName,
      kind: 'agent_profile',
      canonicalId: this.ensureEphemeralAgent(ephemeralName),
      persona: `# Ephemeral Specialist: ${ephemeralName}\n\nYou are an isolated temporary sub-agent. Complete only the delegated task, use the minimum necessary tools, verify evidence, and return a structured report.`,
      allowedSkillNames: [...EPHEMERAL_TOOLS]
    };
  }

  private ensureEphemeralAgent(name: string): string {
    const existing = agentRegistry.get(name);
    if (existing) return existing.id;
    const agent = agentRegistry.register({
      name,
      description: `Ephemeral specialist: ${name}`,
      persona: `# Ephemeral Specialist: ${name}\n\nYou are an isolated temporary sub-agent. Complete only the delegated task, use the minimum necessary tools, verify evidence, and return a structured report.`,
      tools: [...EPHEMERAL_TOOLS],
      taskScope: 'delegation',
      role: 'general'
    });
    return agent.id;
  }

  private resolveCustomAgent(agent: CustomAgentConfig): Omit<ResolvedAgent, 'canonicalId'> {
    const profile = agent.profileId ? agentProfileManager.get(agent.profileId) : undefined;
    return {
      id: agent.id,
      name: agent.displayName || agent.name,
      kind: 'custom_agent',
      persona: customAgentManager.buildSystemPrompt(agent),
      profile,
      allowedSkillNames: this.unique([...(agent.skills || []), ...(profile?.allowedSkills || []), ...(profile?.learnedPreferences?.preferredTools || [])])
    };
  }

  private resolveProfileAgent(profile: AgentProfile): Omit<ResolvedAgent, 'canonicalId'> {
    const capability = agentProfileManager.getCapabilitySummary(profile.id);
    return {
      id: profile.id,
      name: profile.name,
      kind: 'agent_profile',
      persona: [
        `# Agent Profile: ${profile.name}`,
        profile.description || 'You are a specialized agent profile.',
        capability ? `Learned capabilities: ${capability}` : '',
        'Stay within this profile and complete the delegated task carefully.'
      ].filter(Boolean).join('\n\n'),
      profile,
      allowedSkillNames: this.unique([...(profile.allowedSkills || []), ...(profile.learnedPreferences?.preferredTools || [])])
    };
  }

  private resolveSwarmAgent(agent: SwarmAgent): Omit<ResolvedAgent, 'canonicalId'> {
    const profile = agent.profileId ? agentProfileManager.get(agent.profileId) : undefined;
    return {
      id: agent.id,
      name: agent.name,
      kind: 'swarm_agent',
      persona: `# Swarm Agent: ${agent.name}\n\nRole: ${agent.role}\nSpecialization: ${agent.specialization}\n\nComplete the delegated task according to this role.`,
      profile,
      allowedSkillNames: this.unique([...(profile?.allowedSkills || []), ...(profile?.learnedPreferences?.preferredTools || [])])
    };
  }

  // -------------------------------------------------------------- helpers

  private normalizeString(value: any): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  private normalizeStringArray(value: any): string[] {
    if (!Array.isArray(value)) return [];
    return value.map(item => this.normalizeString(item)).filter(Boolean);
  }

  private clampNumber(value: any, fallback: number, min: number, max: number): number {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(n)));
  }

  private unique(values: string[]): string[] {
    return [...new Set(values.map(value => this.normalizeString(value)).filter(Boolean))];
  }
}