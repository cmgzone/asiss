import { agentRunManager, AgentTaskReport, AgentToolCallRecord } from '../core/agent-run-manager';
import { agentProfileManager, AgentProfile } from '../core/agent-profiles';
import { agentSwarm, SwarmAgent } from '../core/agent-swarm';
import { CustomAgentConfig, customAgentManager } from '../core/custom-agents';
import { ModelProvider, Tool } from '../core/models';
import { Skill, SkillRegistry } from '../core/skills';
import { checkpointManager } from '../core/checkpoint-manager';

interface DelegateAgentDeps {
  getModelById: (id?: string) => ModelProvider;
  getDefaultModel: () => ModelProvider;
  listMcpTools: () => Promise<Tool[]>;
  callMcpTool: (name: string, args: any) => Promise<any>;
}

type ResolvedAgent = {
  id: string;
  name: string;
  kind: 'custom_agent' | 'agent_profile' | 'swarm_agent';
  persona: string;
  modelId?: string;
  profile?: AgentProfile;
  allowedSkillNames: string[];
};

export class DelegateAgentSkill implements Skill {
  name = 'delegate_agent';
  description = 'Delegate one subtask, or a tasks batch of independent subtasks that runs concurrently, to CustomAgents, AgentProfiles, or swarm agents. Each child uses a tool-capable loop and returns a saved structured report.';
  inputSchema = {
    type: 'object',
    properties: {
      agentId: { type: 'string', description: 'Custom agent, profile, swarm agent, or "auto" for an ephemeral specialist.' },
      name: { type: 'string', description: 'Alternative agent name when agentId is not supplied.' },
      task: { type: 'string', description: 'The delegated task to execute.' },
      expectedOutput: { type: 'string', description: 'What the child agent should produce.' },
      allowedTools: { type: 'array', items: { type: 'string' }, description: 'Optional tool allowlist for this delegation.' },
      maxTurns: { type: 'number', description: 'Maximum child loop turns. Default 6, max 20.' },
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

  constructor(private readonly deps: DelegateAgentDeps) {}

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

    const availableTools = await this.getAllowedToolSchemas(resolved, requestAllowedTools);
    const allowedToolNames = availableTools.map(tool => tool.name);

    const run = agentRunManager.createRun({
      sessionId,
      agentId: resolved.id,
      agentName: resolved.name,
      agentKind: resolved.kind,
      task,
      expectedOutput,
      allowedTools: allowedToolNames,
      reviewCriteria,
      maxTurns
    });

    const model = this.selectModel(resolved);
    let lastError = '';
    let lastFailedReport: AgentTaskReport | undefined;
    const maxAttempts = retries + 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      agentRunManager.startAttempt(run.taskId);
      try {
        const report = await this.runChildLoop({
          taskId: run.taskId,
          resolved,
          model,
          task,
          expectedOutput,
          reviewCriteria,
          tools: availableTools,
          maxTurns,
          attempt,
          maxAttempts,
          sessionId,
          workspacePath,
          projectId
        });

        if (report.status === 'failed' && attempt < maxAttempts) {
          lastFailedReport = report;
          lastError = report.errorSummary || report.summary || 'Child agent reported failure.';
          agentRunManager.appendMessage(run.taskId, {
            role: 'system',
            content: `Attempt ${attempt} failed and will be retried: ${lastError}`
          });
          continue;
        }

        agentRunManager.completeRun(run.taskId, report);
        this.recordProfilePerformance(resolved, report.status === 'completed', run.startedAt);
        return this.formatSkillResult(report, sessionId);
      } catch (err: any) {
        lastError = err?.message || String(err);
        if (attempt < maxAttempts) {
          agentRunManager.appendMessage(run.taskId, {
            role: 'system',
            content: `Attempt ${attempt} crashed and will be retried: ${lastError}`
          });
          continue;
        }
      }
    }

    if (lastFailedReport) {
      agentRunManager.completeRun(run.taskId, lastFailedReport);
      this.recordProfilePerformance(resolved, false, run.startedAt);
      return this.formatSkillResult(lastFailedReport, sessionId);
    }

    const failed = agentRunManager.failRun(run.taskId, lastError || 'Delegated agent did not complete.');
    this.recordProfilePerformance(resolved, false, run.startedAt);
    return this.formatSkillResult(failed?.report as AgentTaskReport, sessionId);
  }

  private async runChildLoop(params: {
    taskId: string;
    resolved: ResolvedAgent;
    model: ModelProvider;
    task: string;
    expectedOutput?: string;
    reviewCriteria: string[];
    tools: Tool[];
    maxTurns: number;
    attempt: number;
    maxAttempts: number;
    sessionId?: string;
    workspacePath?: string;
    projectId?: string;
  }): Promise<AgentTaskReport> {
    const systemPrompt = this.buildChildSystemPrompt(params.resolved, params.tools);
    const userPrompt = this.buildInitialTaskPrompt(params.task, params.expectedOutput, params.reviewCriteria, params.attempt, params.maxAttempts);

    agentRunManager.appendMessage(params.taskId, { role: 'system', content: systemPrompt });
    agentRunManager.appendMessage(params.taskId, { role: 'user', content: userPrompt });

    for (let turn = 1; turn <= params.maxTurns; turn += 1) {
      const prompt = this.buildConversationPrompt(params.taskId);
      const response = await params.model.generate(prompt, systemPrompt, params.tools);

      if (response.content) {
        agentRunManager.appendMessage(params.taskId, { role: 'assistant', content: response.content });
      }

      const toolCalls = response.toolCalls || [];
      if (toolCalls.length > 0) {
        const parallelSafeTools = new Set(['web_search', 'web_fetch', 'brave_search', 'serper_search', 'code_search', 'current_time', 'system_info']);
        const canRunInParallel = toolCalls.length > 1 && toolCalls.every(call => parallelSafeTools.has(call.name));
        const results: Array<{ call: any; result: AgentToolCallRecord }> = [];
        const execute = async (call: any) => ({
          call,
          result: await this.executeAllowedTool(
            params.taskId,
            call.name,
            call.arguments || {},
            params.tools,
            params.sessionId,
            params.workspacePath,
            params.projectId
          )
        });
        if (canRunInParallel) results.push(...await Promise.all(toolCalls.map(execute)));
        else for (const call of toolCalls) results.push(await execute(call));
        for (const { call, result } of results) {
          const toolContent = result.success
            ? `Tool '${call.name}' result:\n${result.output || ''}`
            : `Tool '${call.name}' error:\n${result.error || 'Unknown error'}`;
          agentRunManager.appendMessage(params.taskId, {
            role: 'tool',
            toolName: call.name,
            content: toolContent
          });
        }
        continue;
      }

      if (response.content) {
        const run = agentRunManager.getRun(params.taskId);
        const report = agentRunManager.parseReportFromText(response.content, {
          taskId: params.taskId,
          agentId: params.resolved.id,
          toolCalls: run?.toolCalls || [],
          expectedOutput: params.expectedOutput,
          reviewCriteria: params.reviewCriteria,
          startedAt: run?.startedAt,
          attempts: run?.attempts
        });
        report.taskId = params.taskId;
        report.agentId = params.resolved.id;
        report.toolCalls = run?.toolCalls || [];
        report.expectedOutput = params.expectedOutput;
        report.reviewCriteria = params.reviewCriteria;
        report.attempts = run?.attempts;
        report.startedAt = run?.startedAt;
        return report;
      }
    }

    throw new Error(`Child agent exceeded maxTurns (${params.maxTurns}) without a final report.`);
  }

  private async executeAllowedTool(
    taskId: string,
    name: string,
    args: any,
    tools: Tool[],
    sessionId?: string,
    workspacePath?: string,
    projectId?: string
  ): Promise<AgentToolCallRecord> {
    name = this.normalizeToolName(name);
    args = this.normalizeToolArgs(name, args);
    const allowed = tools.some(tool => tool.name === name);
    if (!allowed) {
      const record = agentRunManager.recordToolCall(taskId, {
        id: `${name}-${Date.now()}`,
        name,
        arguments: args,
        success: false,
        error: `Tool '${name}' is not allowed for this delegated agent.`
      });
      return record as AgentToolCallRecord;
    }

    try {
      const native = SkillRegistry.get(name);
      let output: any;
      if (native) {
        const childSessionId = `${sessionId || 'delegated'}:child:${taskId}`;
        const command = String(args?.command || '');
        if (workspacePath && (name === 'apply_patch' || (name === 'shell' && checkpointManager.shouldCheckpointShell(command)))) {
          checkpointManager.create(workspacePath, `Before delegated ${name}: ${command || 'file patch'}`, childSessionId);
        }
        const runtimeArgs: any = {
          ...(args || {}),
          __sessionId: childSessionId,
          __workspacePath: workspacePath,
          __projectId: projectId
        };
        if (workspacePath && name === 'apply_patch') runtimeArgs.basePath = workspacePath;
        output = await native.execute(runtimeArgs);
        if (output?.error || output?.success === false || Number(output?.summary?.failed || 0) > 0) {
          throw new Error(String(output?.error || `Tool '${name}' reported failure.`));
        }
      } else {
        output = await this.deps.callMcpTool(name, args || {});
      }
      const record = agentRunManager.recordToolCall(taskId, {
        id: `${name}-${Date.now()}`,
        name,
        arguments: args,
        success: true,
        output: this.stringifyToolOutput(output)
      });
      return record as AgentToolCallRecord;
    } catch (err: any) {
      const record = agentRunManager.recordToolCall(taskId, {
        id: `${name}-${Date.now()}`,
        name,
        arguments: args,
        success: false,
        error: err?.message || String(err)
      });
      return record as AgentToolCallRecord;
    }
  }

  private resolveAgent(idOrName: string): ResolvedAgent | null {
    const custom = customAgentManager.getAgent(idOrName);
    if (custom && custom.enabled !== false) return this.resolveCustomAgent(custom);

    const profile = agentProfileManager.get(idOrName);
    if (profile) return this.resolveProfileAgent(profile);

    const swarm = agentSwarm.getAgent(idOrName) || agentSwarm.getAgentByName(idOrName);
    if (swarm) return this.resolveSwarmAgent(swarm);

    const ephemeralName = idOrName.toLowerCase() === 'auto' ? 'Ephemeral Specialist' : idOrName;
    return {
      id: `ephemeral-${ephemeralName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'specialist'}`,
      name: ephemeralName,
      kind: 'agent_profile',
      persona: `# Ephemeral Specialist: ${ephemeralName}\n\nYou are an isolated temporary sub-agent. Complete only the delegated task, use the minimum necessary tools, verify evidence, and return a structured report.`,
      allowedSkillNames: [
        'system_info', 'current_time', 'web_search', 'web_fetch', 'brave_search', 'serper_search',
        'shell', 'apply_patch', 'playwright', 'notes', 'memory', 'task_memory', 'checkpoints',
        'code_search', 'git', 'code_review'
      ]
    };
  }

  private resolveCustomAgent(agent: CustomAgentConfig): ResolvedAgent {
    const profile = agent.profileId ? agentProfileManager.get(agent.profileId) : undefined;
    return {
      id: agent.id,
      name: agent.displayName || agent.name,
      kind: 'custom_agent',
      persona: customAgentManager.buildSystemPrompt(agent),
      modelId: agent.model || profile?.modelId,
      profile,
      allowedSkillNames: this.unique([...(agent.skills || []), ...(profile?.allowedSkills || []), ...(profile?.learnedPreferences?.preferredTools || [])])
    };
  }

  private resolveProfileAgent(profile: AgentProfile): ResolvedAgent {
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
      modelId: profile.modelId,
      profile,
      allowedSkillNames: this.unique([...(profile.allowedSkills || []), ...(profile.learnedPreferences?.preferredTools || [])])
    };
  }

  private resolveSwarmAgent(agent: SwarmAgent): ResolvedAgent {
    const profile = agent.profileId ? agentProfileManager.get(agent.profileId) : undefined;
    return {
      id: agent.id,
      name: agent.name,
      kind: 'swarm_agent',
      persona: `# Swarm Agent: ${agent.name}\n\nRole: ${agent.role}\nSpecialization: ${agent.specialization}\n\nComplete the delegated task according to this role.`,
      modelId: agent.modelId || profile?.modelId,
      profile,
      allowedSkillNames: this.unique([...(profile?.allowedSkills || []), ...(profile?.learnedPreferences?.preferredTools || [])])
    };
  }

  private async getAllowedToolSchemas(agent: ResolvedAgent, requested: string[]): Promise<Tool[]> {
    const baseAllowed = new Set(agent.allowedSkillNames.map(name => name.trim()).filter(Boolean));
    const requestedSet = new Set(requested.map(name => name.trim()).filter(Boolean));
    const finalAllowed = new Set<string>();

    for (const name of baseAllowed) {
      if (name === this.name) continue;
      if (requestedSet.size === 0 || requestedSet.has(name)) finalAllowed.add(name);
    }

    const nativeTools = SkillRegistry.getAll()
      .filter(skill => finalAllowed.has(skill.name))
      .map(skill => ({
        name: skill.name,
        description: skill.description,
        inputSchema: skill.inputSchema || { type: 'object', properties: {} }
      }));

    const mcpTools = (await this.deps.listMcpTools())
      .filter(tool => finalAllowed.has(tool.name))
      .map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema
      }));

    const byName = new Map<string, Tool>();
    for (const tool of [...nativeTools, ...mcpTools]) byName.set(tool.name, tool);
    return [...byName.values()];
  }

  private normalizeToolName(name: string): string {
    const original = String(name || '').trim();
    if (!original) return original;
    if (SkillRegistry.get(original)) return original;
    const lower = original.toLowerCase().replace(/^mcp_/, '').replace(/_+/g, '_');
    const isPlaywrightAlias = /^playwright(_[a-z0-9_]+)?$/.test(lower)
      || /^browser(_[a-z0-9_]+)?$/.test(lower);
    if (!isPlaywrightAlias) return original;
    return 'playwright';
  }

  private normalizeToolArgs(name: string, args: any): any {
    if (name !== 'playwright') return args;
    const out = (args && typeof args === 'object') ? { ...args } : {};
    if (!out.action) {
      const suffix = String(name).toLowerCase().replace(/^(playwright|browser)_?/, '');
      let action = 'extract_text';
      if (/screenshot|shot/.test(suffix)) action = 'screenshot';
      else if (/navigate|goto|open|visit|go_/.test(suffix)) action = 'extract_text';
      else if (/snapshot|scrape|extract|text|content|get_/.test(suffix)) action = 'extract_text';
      out.action = action;
    }
    if (!out.url) {
      out.url = out.link || out.href || out.page || out.target || out.website || '';
    }
    return out;
  }

  private selectModel(agent: ResolvedAgent): ModelProvider {
    if (agent.modelId) return this.deps.getModelById(agent.modelId);
    return this.deps.getDefaultModel();
  }

  private buildChildSystemPrompt(agent: ResolvedAgent, tools: Tool[]): string {
    const toolList = tools.length
      ? tools.map(tool => `- ${tool.name}: ${tool.description || 'No description'}`).join('\n')
      : '- No tools allowed for this delegation.';

    return [
      agent.persona,
      '',
      'You are running as a delegated child agent. Use only the tools provided in this call.',
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
      '  "toolCalls": [],',
      '  "evidence": ["commands, outputs, sources, files, or observations supporting the result"],',
      '  "risks": ["remaining risk or empty"],',
      '  "nextSteps": ["recommended follow-up or empty"],',
      '  "finalOutput": "the child agent final answer or artifact summary"',
      '}'
    ].join('\n');
  }

  private buildInitialTaskPrompt(task: string, expectedOutput: string | undefined, reviewCriteria: string[], attempt: number, maxAttempts: number): string {
    const lines = [
      `Delegated task: ${task}`,
      expectedOutput ? `Expected output: ${expectedOutput}` : '',
      reviewCriteria.length ? `Review criteria: ${reviewCriteria.join('; ')}` : '',
      `Attempt ${attempt} of ${maxAttempts}.`
    ].filter(Boolean);
    return lines.join('\n');
  }

  private buildConversationPrompt(taskId: string): string {
    const run = agentRunManager.getRun(taskId);
    if (!run) return '';
    return run.messages.map((msg) => {
      if (msg.role === 'tool') return `Tool (${msg.toolName || 'unknown'}): ${msg.content}`;
      const role = msg.role === 'assistant' ? 'Assistant' : msg.role === 'user' ? 'User' : 'System';
      return `${role}: ${msg.content}`;
    }).join('\n\n');
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

  private stringifyToolOutput(output: any): string {
    if (typeof output === 'string') return output;
    try {
      return JSON.stringify(output);
    } catch {
      return String(output);
    }
  }
}
