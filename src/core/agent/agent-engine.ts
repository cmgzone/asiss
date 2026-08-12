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
import { SkillRegistry } from '../skills';
import { ToolEngine } from '../tools';
import { TaskEngine, taskEngine as defaultTaskEngine } from '../task';
import type { ModelProvider, Tool } from '../models';

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

export interface ExecuteTaskOptions {  /** Canonical agent id or name. */
  agentId: string;
  /** The delegated task goal. */
  task: string;
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

    const maxTurns = Math.min(20, Math.max(1, options.maxTurns || 6));
    const maxAttempts = Math.min(3, Math.max(1, (options.retries ?? 1) + 1));
    const requested = new Set((options.allowedTools || []).map(t => t.trim()).filter(Boolean));
    const finalTools = (agent.tools || [])
      .filter(t => requested.size === 0 || requested.has(t))
      .filter(t => t !== 'delegate_agent');

    const taskEngine = runtime.taskEngine || defaultTaskEngine;
    const allToolSchemas = await this.advertisedToolSchemas(runtime, finalTools);

    const taskIds: string[] = [];
    let lastResult: AgentResult | undefined;
    const startedAt = new Date().toISOString();

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const childTask = await taskEngine.create({
        goal: options.task,
        kind: 'delegation',
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
        await taskEngine.plan(childTask.id);

        const mission = await this.runChildMission(runtime, taskEngine, childTask.id, agent, {
          ...options,
          maxTurns,
          allowedTools: finalTools,
          allToolSchemas,
          attempt,
          maxAttempts,
          startedAt
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

  private buildChildSystemPrompt(agent: Agent, tools: Tool[]): string {
    const toolList = tools.length
      ? tools.map(tool => `- ${tool.name}: ${tool.description || 'No description'}`).join('\n')
      : '- No tools allowed for this delegation.';

    return [
      agent.persona || `You are ${agent.name}, a ${agent.role}.`,
      '',
      'You are running as a delegated child agent on a canonical Task. Use only the tools provided in this call.',
      'Do not ask the user questions. If blocked, describe the blocker in the final report.',
      '',
      'Allowed tools:',
      toolList,
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
    maxAttempts: number
  ): string {
    return [
      `Delegated task: ${task}`,
      expectedOutput ? `Expected output: ${expectedOutput}` : '',
      reviewCriteria?.length ? `Review criteria: ${reviewCriteria.join('; ')}` : '',
      `Attempt ${attempt} of ${maxAttempts}.`
    ].filter(Boolean).join('\n');
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
    }
  ): Promise<{ success: boolean; result: AgentResult }> {
    const systemPrompt = this.buildChildSystemPrompt(agent, params.allToolSchemas);
    const initialUser = this.buildChildTaskPrompt(
      params.task,
      params.expectedOutput,
      params.reviewCriteria,
      params.attempt,
      params.maxAttempts
    );
    const history: Array<{ role: string; content: string }> = [
      { role: 'user', content: initialUser }
    ];

    const runtimeModel = agent.modelPolicy?.modelId
      ? runtime.getModelById(agent.modelPolicy.modelId)
      : runtime.getDefaultModel();
    const model = runtimeModel;

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
    return { success: false, result };
  }
}

export { hasAllCapabilities, sortDeterministic, eligibilityOf };

/** Singleton over the global registry (matches existing manager conventions). */
export const agentEngine = new AgentEngine();