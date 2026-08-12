import { Message, StreamEventPayload } from '../core/types';
import { ModelAttachment, ModelProvider, ModelRegistry } from '../core/models';
import { SkillRegistry } from '../core/skills';
import { Memory, MemoryManager } from '../core/memory';
import { createUnifiedMemory, type UnifiedMemoryCatalog } from '../core/memory-unified/memory-catalog';
import { MemoryConsolidation } from '../core/memory-unified/memory-consolidation';
import { TaskLessonBridge } from '../core/memory-unified/lesson-capture';
import { EpisodicCapture } from '../core/memory-unified/episodic-capture';
import { McpManager } from '../core/mcp';
import { LearningManager } from '../core/learning-manager';
import { MockProvider } from './mock-provider';
import { OpenRouterProvider } from './openrouter-provider';
import { NvidiaProvider } from './nvidia-provider';
import { SystemSkill, TimeSkill } from '../skills/system';
import { NotesSkill } from '../skills/notes';
import { ShellSkill } from '../skills/shell';
import { WebFetchSkill, WebSearchSkill } from '../skills/web';
import { SchedulerManager, type ScheduledJob } from '../core/scheduler';
import { SchedulerSkill } from '../skills/scheduler';
import { PlaywrightSkill } from '../skills/playwright';
import { BraveSearchSkill } from '../skills/brave';
import { ApplyPatchSkill } from '../skills/patch';
import { CheckpointsSkill } from '../skills/checkpoints';
import { checkpointManager } from '../core/checkpoint-manager';
import { BusinessSkill } from '../skills/business';
import { ProjectManagerSkill } from '../skills/project-manager';
import { AgentsMdSkill } from '../skills/agents-md';
import { thinkingManager } from '../core/thinking';
import { scratchpad } from '../core/scratchpad';
import { agentSwarm } from '../core/agent-swarm';
import { agentEngine, agentRegistry, delegationTasksForSession, renderDelegationReports, type Agent, type AgentMemoryPolicy, type SelectResult, type TaskProfile } from '../core/agent';
import { TaskMemorySkill } from '../skills/task-memory';
import { backgroundWorker, type BackgroundGoal } from '../core/background-worker';
import { dndManager } from '../core/dnd';
import { BackgroundGoalsSkill, DNDSkill } from '../skills/background';
import { mainGoalManager } from '../core/main-goal';
import { MainGoalSkill } from '../skills/main-goal';
import { customAgentManager } from '../core/custom-agents';
import { CustomAgentsSkill } from '../skills/custom-agents';
import { modelManager, resolveModelApiKey, isProviderKeyValid } from '../core/model-manager';
import { ModelsSkill } from '../skills/models';
import { GenericOpenAIProvider } from './openai-provider';
import { OpenCodeProvider } from './opencode-provider';
import { SerperSkill } from '../skills/serper';
import { MemorySkill } from '../skills/memory';
import { CodeSearchSkill } from '../skills/code-search';
import { SymbolSkill } from '../skills/symbol';
import { WarmthSkill } from '../skills/warmth';
import { GitSkill } from '../skills/git';
import { CodeReviewSkill } from '../skills/code-review';
import { PlanModeSkill } from '../skills/plan-mode';
import { planModeManager } from '../core/plan-mode';
import { DeepResearchSkill } from '../skills/deep-research';
import { SendTelegramSkill } from '../skills/send-telegram';
import { SendEmailSkill } from '../skills/send-email';
import { WebhookSkill } from '../skills/webhook';
import { agentProfileManager } from '../core/agent-profiles';
import { AgentProfilesSkill } from '../skills/agent-profiles';
import { DelegateAgentSkill } from '../skills/delegate-agent';
import { ExecuteWorkflowSkill } from '../skills/execute-workflow';
import { McpAdminSkill } from '../skills/mcp-admin';
import { PortableSkillsSkill } from '../skills/portable-skills';
import { portableSkillsManager } from '../core/portable-skills';
import { HooksSkill } from '../skills/hooks';
import { SkillMarketplaceManager } from '../core/skill-marketplace';
import { MarketplaceSkill } from '../skills/marketplace';
import { TrustedActionsSkill } from '../skills/trusted-actions';
import { A2AClientSkill } from '../skills/a2a';
import { LearnedSkillsSkill } from '../skills/learned-skills';
import { learnedSkillsManager } from '../core/learned-skills';
import { ReadFileSkill, WriteFileSkill, ListDirectorySkill, GlobSkill } from '../skills/filesystem';
import { ToolsDiagSkill, buildToolReport } from '../skills/tools-diag';
import { DynamicToolManager } from '../core/dynamic-tools';
import { ResilientModelProvider } from '../core/resilient-model';
import { analyticsTracker } from '../core/analytics-tracker';
import { withModelRetry } from '../core/retry-handler';
import { guardrailManager } from '../core/guardrails';
import { costTracker } from '../core/cost-tracker';
import { modelRouter } from '../core/model-router';
import { modelEngine } from '../core/model';
import { chainOfThought } from '../core/chain-of-thought';
import { proactiveEngine } from '../core/proactive-engine';
import { executionStateManager } from '../core/execution-state';
import { hookManager } from '../core/hooks';
import { installTaskEventProjections, taskEngine, taskEventBus, taskMemory } from '../core/task';
import type { TaskCompletionContext, TaskCompletionEvidence, TaskDiagnoser, TaskMissionIteration, TaskToolKind, TaskTurnVerdict, TaskVerifier } from '../core/task';
import { loadHermesConfig } from '../core/config';
import { ApprovalCoordinator, PolicyEngine } from '../core/policy';
import { ContextEngine, matchedTestFiles, runGoalTests, warmOnToolEvents } from '../core/context';
import { ToolEngine, normalizeToolRequest } from '../core/tools';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

const DEBUG_PREFIX = '__DEBUG__';

const MUTATING_TOOL_NAMES = new Set([
  'apply_patch',
  'write_patch',
  'write_file',
  'shell',
  'git',
  'delegate_agent',
  'playwright',
  'notes'
]);

// Interface to avoid circular dependency import issues
interface IGateway {
  sendResponse(sessionId: string, text: string): Promise<void>;
  sendStreamChunk(sessionId: string, chunk: string): Promise<void>;
  sendStreamEvent(sessionId: string, event: StreamEventPayload): Promise<void>;
  sendMedia(sessionId: string, media: { type: 'image' | 'file'; path?: string; url?: string; caption?: string; filename?: string }): Promise<void>;
  listSessionIds(): string[];
  supportsStructuredStreaming?(sessionId: string): boolean;
}

export class AgentRunner {
  private gateway: IGateway;
  private baseSystemPrompt: string;
  private memory: MemoryManager;
  private learning: LearningManager;
  // Phase 14 Move 2: one unified memory view (conversation + learning + task)
  // with event-driven episodic capture; rendered as one context section.
  private unifiedMemory: UnifiedMemoryCatalog;
  private memoryConsolidation: MemoryConsolidation;
  private episodicCapture: EpisodicCapture;
  private taskLessonBridge: TaskLessonBridge;
  private marketplace: SkillMarketplaceManager;
  private mcpManager: McpManager;
  private scheduler: SchedulerManager;
  private dynamicTools: DynamicToolManager;
  private toolEngine: ToolEngine;
  // Phase 5 ASK path: real user approvals instead of silent default outcomes.
  private approvalCoordinator: ApprovalCoordinator;
  private policyEngine: PolicyEngine;
  // Phase 7: budgeted, relevance-based context construction.
  private contextEngine: ContextEngine;
  private readonly repoWarmers = new Map<string, () => void>();
  private readonly lastRetryHint = new Map<string, string>();
  // Keys already warned about (tool-capping) so truncation warnings are logged
  // once per process run instead of on every message.
  private advertisedWarnings = new Set<string>();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private heartbeatMs: number = 60000; // Default 1 minute
  private proactiveEnabled: boolean = false;
  private proactiveIdleMs: number = 5 * 60 * 1000;
  private proactiveMinGapMs: number = 10 * 60 * 1000;
  private proactiveLastAt: Map<string, number> = new Map();
  private proactiveInFlight = false;
  private proactiveEveryMs: number = 60 * 1000;
  private proactiveLastTickAt = 0;

  // Compute advertised-tool caps the same way buildAdvertisedTools does.
  private static getToolLimits(config?: any): { maxNativeTools: number; maxMcpToolsPerServer: number } {
    const agentCfg = config?.agent ?? {};
    return {
      maxNativeTools: Math.max(10, Math.min(300, Math.floor(Number(agentCfg.maxNativeTools) || 60))),
      maxMcpToolsPerServer: Math.max(5, Math.min(200, Math.floor(Number(agentCfg.maxMcpToolsPerServer) || 40)))
    };
  }

  constructor(gateway: IGateway) {
    this.gateway = gateway;
    this.memory = new MemoryManager();
    this.learning = new LearningManager(
      () => this.getModel(),
      this.memory,
      async (sessionId, message) => this.gateway.sendResponse(sessionId, message),
      // Phase 15 Move 2: external research runs inside canonical Tasks.
      taskEngine
    );
    this.marketplace = new SkillMarketplaceManager();
    this.mcpManager = new McpManager();
    this.dynamicTools = new DynamicToolManager(async (prompt) => {
      try {
        const model = this.getModel();
        const response = await model.generate(prompt, 'You resolve unknown tool calls to real tools or answer directly.', []);
        return response?.content || '';
      } catch (error: any) {
        console.error('[AgentRunner] Dynamic tool interpreter failed:', error);
        return '';
      }
    });
    // Phase 5 ASK path: approvals become TaskEvents (every client sees the
    // same state) and are pushed to the session's gateway as stream events.
    this.approvalCoordinator = new ApprovalCoordinator({
      taskEngine,
      bus: taskEventBus,
      timeoutMs: 10 * 60 * 1000,
      onTimeout: 'deny'
    });
    this.policyEngine = new PolicyEngine({
      approvalHandler: (verdict, ctx) => this.approvalCoordinator.requestApproval(verdict, ctx)
    });
    // Move 3: typed event-to-channel projection — the canonical table maps
    // TaskEvents (approvals, repo warmth, recovery) to stream events; the
    // runner no longer hand-wires forwards per event.
    installTaskEventProjections(this.gateway);
    // Phase 7 ContextEngine: budgeted, relevance-based context construction.
    this.contextEngine = new ContextEngine({ config: this.loadConfig()?.agent?.context });

    // Canonical ToolEngine (Phase 4): one consistent tool execution mechanism
    // for native skills, MCP tools and dynamic tools.
    this.toolEngine = new ToolEngine({
      skills: SkillRegistry,
      mcp: this.mcpManager,
      dynamicTools: this.dynamicTools,
      checkpoints: checkpointManager,
      policyEngine: this.policyEngine
    });

    // Step 9 sub-step 2: background goals run as canonical kind-'background'
    // Tasks through AgentEngine.executeTask (worker selection + engine-owned
    // loop); background_goals.json stays authoritative for goal statuses.
    agentEngine.configure({
      getModelById: (id?: string) => this.getModelById(id),
      getDefaultModel: () => this.getModel(),
      listMcpTools: () => this.mcpManager.listTools(),
      toolEngine: this.toolEngine,
      taskEngine,
      // Phase 16 Move 4 (D5): child missions retrieve unified memory through
      // the consolidation layer (dedupe/merge + lifecycle applied, archived/
      // expired excluded) per the child agent's memoryPolicy. AgentEngine
      // never sees how memory is stored.
      retrieveMemory: (query, opts) => this.memoryConsolidation.retrieve(query, opts)
    });

    // Phase 14 Move 2: episodic capture subscribes to terminal TaskEvents and
    // the unified catalog projects conversation/learning/task records over the
    // existing authorities (wrap-first — no second memory store). The context
    // builder renders it as one budgeted memory section.
    this.episodicCapture = new EpisodicCapture(taskEngine, { bus: taskEventBus });
    this.unifiedMemory = createUnifiedMemory({
      memory: this.memory,
      learning: this.learning,
      taskEngine,
      taskMemory,
      capture: this.episodicCapture
    });
    // Phase 14 Move 3: the consolidation/lifecycle layer over the catalog —
    // dedupe/merge near-duplicates, candidate->active promotion from access
    // and success feedback, archive/expiry, durable access stats. The context
    // builder reads THROUGH it (archived/expired excluded).
    this.memoryConsolidation = new MemoryConsolidation(this.unifiedMemory);
    // Phase 14 Move 5: terminal Task outcomes feed the learning pipeline —
    // each completed/failed canonical task queues a self-review whose lesson
    // flows through the existing approval queue into retrievable memory.
    this.taskLessonBridge = new TaskLessonBridge(taskEngine, this.learning, { bus: taskEventBus });

    this.scheduler = new SchedulerManager(async (job) => {
      // Step 9.3 — scheduled jobs run as canonical kind-'scheduled' Tasks
      // through AgentEngine.executeTask (AgentEngine owns WHO, TaskEngine owns
      // HOW); the scheduler keeps owning WHEN (timers, persistence, cancel).
      // Phase 15 Move 2: there is no second execution path — on failure the
      // session is notified, the error is rethrown so the scheduler records
      // it on the job, and the failed canonical Task is the evidence.
      const canonical = await this.runScheduledJobViaEngine(job);
      if (canonical.ok) {
        if (canonical.output) {
          await this.deliverScheduledResult(job, canonical.output);
        }
        return;
      }

      await this.deliverScheduledResult(job, `⚠️ Scheduled job failed: ${canonical.error || 'the canonical task did not complete'}`);
      throw new Error(canonical.error || 'Scheduled job failed through the canonical task');
    });

    // Initialize default components
    ModelRegistry.register(new MockProvider());
    SkillRegistry.register(new SystemSkill());
    SkillRegistry.register(new TimeSkill());
    SkillRegistry.register(new NotesSkill());
    SkillRegistry.register(new ShellSkill());
    SkillRegistry.register(new ReadFileSkill());
    SkillRegistry.register(new WriteFileSkill());
    SkillRegistry.register(new ListDirectorySkill());
    SkillRegistry.register(new GlobSkill());
    SkillRegistry.register(new ToolsDiagSkill({
      listMcpTools: () => this.mcpManager.listTools(),
      buildAdvertised: (sid: string, mcpTools: any[]) => this.buildAdvertisedTools(sid, mcpTools),
      getAliasCoverage: () => this.toolEngine.aliasCoverage(),
      getLimits: () => AgentRunner.getToolLimits(),
      getUsageStats: () => analyticsTracker.getToolUsageStats()
    }));
    SkillRegistry.register(new WebFetchSkill());
    SkillRegistry.register(new WebSearchSkill());
    SkillRegistry.register(new SchedulerSkill(this.scheduler));
    SkillRegistry.register(new PlaywrightSkill());
    SkillRegistry.register(new BraveSearchSkill());
    SkillRegistry.register(new ApplyPatchSkill());
    SkillRegistry.register(new CheckpointsSkill());
    SkillRegistry.register(new BusinessSkill());
    SkillRegistry.register(new DelegateAgentSkill({
      getModelById: (id?: string) => this.getModelById(id),
      getDefaultModel: () => this.getModel(),
      listMcpTools: () => this.mcpManager.listTools(),
      callMcpTool: (name: string, args: any) => this.mcpManager.callTool(name, args),
      toolEngine: this.toolEngine,
      taskEngine
    }));
    SkillRegistry.register(new ExecuteWorkflowSkill({
      listMcpTools: () => this.mcpManager.listTools(),
      callMcpTool: (name: string, args: any) => this.mcpManager.callTool(name, args)
    }));
    SkillRegistry.register(new McpAdminSkill(this.mcpManager));
    SkillRegistry.register(new PortableSkillsSkill());
    SkillRegistry.register(new HooksSkill());
    SkillRegistry.register(new ProjectManagerSkill());
    SkillRegistry.register(new AgentsMdSkill());
    SkillRegistry.register(new TaskMemorySkill());
    SkillRegistry.register(new MainGoalSkill());
    SkillRegistry.register(new BackgroundGoalsSkill());
    SkillRegistry.register(new DNDSkill());
    SkillRegistry.register(new CustomAgentsSkill());
    SkillRegistry.register(new ModelsSkill());
    SkillRegistry.register(new SerperSkill());
    // Phase 14 Move 4: MemorySkill exposes the canonical unified retrieve
    // action over the catalog + consolidation; search/semantic_search now
    // delegate to the same path (legacy MemoryManager fallback when the
    // unified layer is absent).
    SkillRegistry.register(new MemorySkill(this.memory, {
      catalog: this.unifiedMemory,
      consolidation: this.memoryConsolidation
    }));
    SkillRegistry.register(new CodeSearchSkill());
    SkillRegistry.register(new SymbolSkill({ contextEngine: this.contextEngine }));
    SkillRegistry.register(new WarmthSkill({ contextEngine: this.contextEngine }));
    SkillRegistry.register(new GitSkill());
    SkillRegistry.register(new CodeReviewSkill());
    SkillRegistry.register(new PlanModeSkill());
    SkillRegistry.register(new DeepResearchSkill());
    SkillRegistry.register(new SendTelegramSkill());
    SkillRegistry.register(new SendEmailSkill());
    SkillRegistry.register(new WebhookSkill());
    SkillRegistry.register(new AgentProfilesSkill());
    SkillRegistry.register(new MarketplaceSkill(this.marketplace));
    SkillRegistry.register(new TrustedActionsSkill());
    SkillRegistry.register(new A2AClientSkill());
    SkillRegistry.register(new LearnedSkillsSkill());

    // Load marketplace-installed skills (allowlist enforced by marketplace manager)
    for (const skill of this.marketplace.loadEnabledSkills()) {
      SkillRegistry.register(skill);
    }

    const executableSkills = learnedSkillsManager.registerExecutableSkills();
    if (executableSkills.registered || executableSkills.invalid) {
      console.log(`[AgentRunner] Executable learned skills: ${executableSkills.registered} registered, ${executableSkills.invalid} invalid.`);
    }

    // Re-register dynamically-created tools from previous sessions so they
    // remain available across restarts.
    this.dynamicTools.rehydrate();

    // Load custom models
    for (const config of modelManager.listModels()) {
      if (config.enabled) {
        const provider = new GenericOpenAIProvider(
          config.id,
          config.name,
          config.baseUrl,
          resolveModelApiKey(config.provider, config.apiKey),
          config.modelName,
          config.contextWindow,
          config.maxOutputTokens,
          config.level
        );
        ModelRegistry.register(provider);
        console.log(`[AgentRunner] Loaded custom model: ${config.name} (${config.provider})`);
      }
    }

    // Wire up agent swarm executor
    agentSwarm.setExecutor(async (agentId: string, prompt: string) => {
      // Phase 16 Move 3 (AUDIT_7 D1): NO fallback execution path for swarm
      // work. If delegate_agent is unavailable, fail the swarm task loudly
      // instead of running an untracked model.generate (no Task, no
      // ToolEngine, no events, no evidence). The swarm store's runAgent
      // catch marks the task failed with this message, keeping
      // swarm_data.json authoritative for swarm statuses.
      const delegate = SkillRegistry.get('delegate_agent');
      if (!delegate) {
        const error = `[AgentRunner] delegate_agent skill is unavailable — cannot run swarm agent ${agentId} outside the canonical Task lifecycle.`;
        console.error(error);
        throw new Error(error);
      }

      const result = await delegate.execute({
        agentId,
        task: prompt,
        expectedOutput: 'Complete the assigned swarm-agent task and return a concise, evidence-backed result.',
        maxTurns: 6,
        retries: 1,
        reviewCriteria: ['task completed', 'evidence included', 'risks called out'],
        // Step 9: swarm jobs execute as canonical kind-'swarm' child Tasks.
        __kind: 'swarm'
      });
      // Audit 4 (S1): link the canonical child Task ids onto the swarm agent
      // record so swarm_data.json is traceable to the engine-owned execution.
      const canonicalIds = Array.isArray(result?.canonicalTaskIds)
        ? result.canonicalTaskIds.filter((id: unknown): id is string => typeof id === 'string')
        : [];
      if (canonicalIds.length > 0) {
        const swarmAgent = agentSwarm.getAgent(agentId);
        if (swarmAgent) {
          const existing = Array.isArray(swarmAgent.canonicalTaskIds) ? swarmAgent.canonicalTaskIds : [];
          agentSwarm.updateAgent(agentId, { canonicalTaskIds: [...new Set([...existing, ...canonicalIds])] });
        }
      }
      const report = result?.report;
      return report?.finalOutput || report?.summary || JSON.stringify(result);
    });

    // Load config
    let config: any = { model: 'mock' };
    if (fs.existsSync('config.json')) {
      try {
        config = JSON.parse(fs.readFileSync('config.json', 'utf-8'));
      } catch (e) {
        console.error('[AgentRunner] Failed to load config.json', e);
      }
    }

    // Register the configured provider during startup so the runtime and UI
    // agree on the active model before the first user message.
    const configuredProvider = String(config.model || config.llm?.provider || '').trim().toLowerCase();
    if (configuredProvider === 'openrouter' && isProviderKeyValid('openrouter', process.env.OPENROUTER_API_KEY)) {
      const configuredModel = String(config.aiModel || config.llm?.model || process.env.OPENROUTER_MODEL || '').trim();
      if (configuredModel) {
        ModelRegistry.register(new OpenRouterProvider(process.env.OPENROUTER_API_KEY || '', configuredModel));
        ModelRegistry.setCurrentModel('openrouter');
      }
    } else if (configuredProvider === 'nvidia' && isProviderKeyValid('nvidia', process.env.NVIDIA_API_KEY)) {
      const configuredModel = String(config.aiModel || config.llm?.model || process.env.NVIDIA_MODEL || '').trim();
      if (configuredModel) {
        ModelRegistry.register(new NvidiaProvider(process.env.NVIDIA_API_KEY || '', configuredModel, config?.nvidia?.thinking !== false));
        ModelRegistry.setCurrentModel('nvidia');
      }
    } else if (configuredProvider === 'opencode' && process.env.OPENCODE_API_KEY) {
      const configuredModel = String(config.aiModel || config.llm?.model || process.env.OPENCODE_MODEL || '').trim();
      if (configuredModel) {
        ModelRegistry.register(new OpenCodeProvider(process.env.OPENCODE_API_KEY, configuredModel));
        ModelRegistry.setCurrentModel('opencode');
      }
    }
    this.registerCredentialPoolProviders(config);
    this.registerOpenCodeProvider(config);

    if (config.heartbeatInterval) {
      this.heartbeatMs = config.heartbeatInterval;
    }
    if (config.proactive && typeof config.proactive === 'object') {
      if (typeof config.proactive.enabled === 'boolean') this.proactiveEnabled = config.proactive.enabled;
      if (typeof config.proactive.idleMs === 'number') this.proactiveIdleMs = config.proactive.idleMs;
      if (typeof config.proactive.minGapMs === 'number') this.proactiveMinGapMs = config.proactive.minGapMs;
      if (typeof config.proactive.everyMs === 'number') this.proactiveEveryMs = config.proactive.everyMs;
    }

    if (config.mcpServers && config.mcpServers.filesystem && Array.isArray(config.mcpServers.filesystem.args)) {
      const fsArgs = config.mcpServers.filesystem.args;
      const lastArg = fsArgs[fsArgs.length - 1];
      const looksLikeWindowsDrive = typeof lastArg === 'string' && /^[a-zA-Z]:[\\/]/.test(lastArg);
      if (looksLikeWindowsDrive && process.platform !== 'win32') {
        const platformRoot = path.parse(process.cwd()).root || '/';
        if (config.filesystemMode === 'full') {
          fsArgs[fsArgs.length - 1] = platformRoot;
        } else if (config.filesystemMode === 'project') {
          fsArgs[fsArgs.length - 1] = './';
        }
      }
    }

    // Connect MCP Servers (awaited per server so failures are captured and
    // reported visibly instead of being silently fire-and-forget).
    void this.connectMcpServers(config);

    // Load soul
    try {
      const rootSoulPath = path.join(process.cwd(), 'SOUL.md');
      const srcSoulPath = path.join(process.cwd(), 'src', 'soul.md');
      if (fs.existsSync(rootSoulPath)) {
        this.baseSystemPrompt = fs.readFileSync(rootSoulPath, 'utf-8');
      } else {
        this.baseSystemPrompt = fs.readFileSync(srcSoulPath, 'utf-8');
      }
    } catch (e) {
      this.baseSystemPrompt = "You are a helpful AI assistant.";
    }

    this.scheduler.start();
  }

  /**
   * Step 9 sub-step 2 — run a background goal as a canonical kind-
   * 'background' Task through AgentEngine.executeTask. Selects a worker via
   * the canonical registry (capability + task-scope 'background'), falls back
   * to an ephemeral Background Worker agent when no store agent qualifies,
   * and links the canonical Task id onto the goal record (background_goals.json
   * stays authoritative for statuses; this is a linkage field only). Returns
   * { ok: false } on any failure so the caller falls back to the legacy
   * mission-loop path.
   */
  private async runBackgroundGoalViaEngine(
    goal: BackgroundGoal,
    task: string,
    progressCallback: (percent: number, note: string) => void
  ): Promise<{ ok: boolean; output?: string; error?: string }> {
    try {
      agentRegistry.refresh();
      const profile: TaskProfile = {
        goal: `${goal.title}. ${goal.description || ''}`,
        kind: 'background'
      };
      let selected = agentEngine.selectForProfile(profile);
      if (!selected) {
        selected = this.ensureAutonomousWorkerAgent(
          'Background Worker',
          'Default autonomous background worker.',
          'You are an autonomous background worker. Complete the goal using tools, verify evidence, and return a concise structured report.'
        );
      }
      progressCallback(20, `Selected worker ${selected.agent.name} for the background goal`);

      const exec = await agentEngine.executeTask({
        agentId: selected.agent.id,
        task,
        kind: 'background',
        sessionId: goal.sessionId,
        maxTurns: 10,
        retries: 0,
        metadata: {
          backgroundGoalId: goal.id,
          backgroundGoalTitle: goal.title,
          source: 'background-worker'
        }
      });

      if (exec.taskId) {
        goal.metadata = { ...(goal.metadata || {}), canonicalTaskId: exec.taskId };
      }
      // A failed child mission must NOT look like a completed goal — ensure
      // terminal canonical evidence, then let the worker's own status/retry
      // authority decide the outcome. There is no second execution path.
      if (!exec.success) {
        const error = exec.error || exec.result?.errorSummary || exec.result?.summary
          || 'Background goal failed through the canonical task';
        await this.failCanonicalTasks(exec.taskIds, error);
        return { ok: false, error };
      }
      const result = exec.result;
      const output = result.finalOutput || result.summary
        || 'Background goal completed through the canonical background task.';
      return { ok: true, output };
    } catch (err: any) {
      console.warn('[AgentRunner] Background goal via AgentEngine failed; worker authority decides the outcome:', err?.message || err);
      return { ok: false, error: err?.message || 'Background goal failed through the canonical task' };
    }
  }

  /**
   * Phase 15 Move 2 — ensure a failed engine execution leaves terminal
   * canonical evidence: fail any child Task the engine left non-terminal
   * (the exception path can abort mid-mission). Best-effort.
   */
  private async failCanonicalTasks(taskIds: string[] | undefined, error: string): Promise<void> {
    for (const taskId of taskIds || []) {
      try {
        const task = taskEngine.get(taskId);
        if (!task) continue;
        const status = task.status;
        if (status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED') continue;
        await taskEngine.failTask(taskId, error);
      } catch {
        /* evidence is best-effort */
      }
    }
  }

  /**
   * Phase 15 S1 — run a learned-skill-creation goal as a canonical kind-
   * 'background' Task. The deterministic workflow
   * (LearningManager.executeSkillCreationGoal) executes AS the Task:
   * TaskEngine owns the lifecycle + evidence, the goal record links via
   * canonicalTaskId, and background_goals.json stays authoritative for goal
   * statuses. Returns { ok: false } (having failed the Task for evidence) so
   * the caller can rethrow and let the worker's retry/status authority decide.
   */
  private async runSkillCreationGoalViaEngine(goal: BackgroundGoal): Promise<{ ok: boolean; output?: string; error?: string }> {
    let taskId: string | undefined;
    try {
      const task = await taskEngine.create({
        goal: `Create learned skill: ${goal.title}`,
        kind: 'background',
        sessionId: goal.sessionId,
        metadata: { source: 'skill-creation', backgroundGoalId: goal.id }
      });
      taskId = task.id;
      goal.metadata = { ...(goal.metadata || {}), canonicalTaskId: task.id };
      await taskEngine.analyze(task.id);
      await taskEngine.plan(task.id);
      await taskEngine.start(task.id);
      const result = await this.learning.executeSkillCreationGoal(goal);
      await taskEngine.complete(task.id, {
        status: 'SUCCESS',
        summary: result,
        result: { summary: result, status: 'completed', finalOutput: result }
      });
      return { ok: true, output: result };
    } catch (err: any) {
      const message = err?.message || 'Skill creation failed';
      if (taskId) {
        try { await taskEngine.failTask(taskId, message); } catch { /* evidence is best-effort */ }
      }
      return { ok: false, error: message };
    }
  }

  /** Register (once) an ephemeral autonomous worker agent with the full native tool surface. */
  private ensureAutonomousWorkerAgent(name: string, description: string, persona: string): SelectResult {
    const existing = agentRegistry.get(name);
    if (existing) return { agent: existing, selected: true, missing: [] };
    const tools = SkillRegistry.getAll()
      .filter(s => Boolean(s.inputSchema) && s.name !== 'delegate_agent')
      .map(s => s.name);
    const agent = agentRegistry.register({
      name,
      description,
      persona,
      capabilities: ['planning', 'coding', 'web-research', 'data-analysis', 'testing', 'reviewing', 'writing'],
      tools,
      taskScope: 'any',
      role: 'general'
    });
    return { agent, selected: true, missing: [] };
  }

  /**
   * Step 9.3 — run a scheduled job as a canonical kind-'scheduled' Task through
   * AgentEngine.executeTask. Selects a worker via the canonical registry
   * (capability hints from the prompt + task-scope 'scheduled'), falls back to
   * an ephemeral Scheduled Worker agent, and links the canonical Task id onto
   * the job metadata (scheduler.json stays authoritative for schedule state).
   * Returns { ok: false } on any failure so the caller falls back to the
   * legacy mission-loop path.
   */
  private async runScheduledJobViaEngine(job: ScheduledJob): Promise<{ ok: boolean; output?: string; error?: string }> {
    try {
      agentRegistry.refresh();
      const profile: TaskProfile = { goal: job.prompt, kind: 'scheduled' };
      let selected = agentEngine.selectForProfile(profile);
      if (!selected) {
        selected = this.ensureAutonomousWorkerAgent(
          'Scheduled Worker',
          'Default autonomous scheduled worker.',
          'You are an autonomous scheduled worker. Complete the scheduled task using tools, verify evidence, and return a concise structured report.'
        );
      }

      const exec = await agentEngine.executeTask({
        agentId: selected.agent.id,
        task: job.prompt,
        kind: 'scheduled',
        sessionId: job.sessionId,
        maxTurns: 6,
        retries: 0,
        metadata: {
          schedulerJobId: job.id,
          schedulerJobType: job.type,
          source: 'scheduler'
        }
      });

      // A failed child mission must NOT be delivered as success — ensure
      // terminal canonical evidence and let the scheduler record the failure.
      if (!exec.success) {
        const error = exec.error || exec.result?.errorSummary || exec.result?.summary
          || 'Scheduled job failed through the canonical task';
        await this.failCanonicalTasks(exec.taskIds, error);
        return { ok: false, error };
      }
      const result = exec.result;
      const output = result.finalOutput || result.summary || '';
      if (!output) return { ok: false, error: 'Scheduled job produced no output' };
      return { ok: true, output };
    } catch (err: any) {
      console.warn('[AgentRunner] Scheduled job via AgentEngine failed; scheduler records the failure:', err?.message || err);
      return { ok: false, error: err?.message || 'Scheduled job failed through the canonical task' };
    }
  }

  /** Deliver a completed scheduled job's result back into its session. */
  private async deliverScheduledResult(job: ScheduledJob, output: string): Promise<void> {
    try {
      await this.gateway.sendResponse(job.sessionId, output);
    } catch (err: any) {
      console.warn('[AgentRunner] Delivering scheduled job result failed:', err?.message || err);
    }
  }

  // Connect each configured MCP server, awaiting every result so connection
  // failures are logged and surfaced (console + mcp_status hook) rather than
  // silently ignored. Servers connect in parallel (allSettled) so one slow or
  // hung server cannot block the others. Non-blocking: runs in the background.
  private async connectMcpServers(config: any): Promise<void> {
    const servers = config?.mcpServers;
    if (!servers || typeof servers !== 'object') return;
    await Promise.allSettled(
      Object.entries(servers).map(async ([name, serverConfig]) => {
        try {
          const result = await this.mcpManager.connect(name, serverConfig as any);
          if (result?.success) {
            console.log(`[AgentRunner] MCP server connected: ${name}`);
            void hookManager.emit('mcp_status', { server: name, connected: true });
          } else {
            const reason = result?.error || 'unknown error';
            console.error(`[AgentRunner] MCP server '${name}' FAILED to connect: ${reason}`);
            console.error(`[AgentRunner] Hint: check 'mcpServers.${name}' in config.json (command/args/transport) and that the server package is installed. Tools from this server will be unavailable.`);
            void hookManager.emit('mcp_status', { server: name, connected: false, error: reason });
          }
        } catch (error: any) {
          const reason = error?.message || String(error);
          console.error(`[AgentRunner] MCP server '${name}' threw during connect: ${reason}`);
          void hookManager.emit('mcp_status', { server: name, connected: false, error: reason });
        }
      })
    );
  }

  private isMainSessionChannel(channel: string) {
    const c = String(channel || '').toLowerCase();
    return c === 'console' || c === 'web';
  }

  private readTextFileIfExists(filePath: string) {
    try {
      if (!fs.existsSync(filePath)) return '';
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      return '';
    }
  }

  private getValidWorkspacePath(value: unknown): string | undefined {
    const workspacePath = typeof value === 'string' ? value.trim() : '';
    if (!workspacePath) return undefined;
    try {
      return fs.existsSync(workspacePath) && fs.statSync(workspacePath).isDirectory()
        ? workspacePath
        : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Builds the repository-aware diagnoser the engine runs for the mission's
   * verification authority (Phase 12 Move 3). The host only wires the
   * ContextEngine + verify-then-retry evidence; the engine owns what the
   * evidence means (records, events, EXECUTING -> VERIFYING -> EXECUTING).
   * Used by both failure recovery (injectGoalRetryHint) and the turn
   * contract's `verify` verdict.
   */
  private buildMissionDiagnoser(goal: string, workspacePathValue: unknown, workspaceFallback?: string): TaskDiagnoser {
    return async (task) => {
      const taskWorkspace = this.getValidWorkspacePath(task.context?.workspacePath) || workspaceFallback || '';
      const taskGoal = task.goal || goal;
      const workspace = taskWorkspace || this.getValidWorkspacePath(workspacePathValue) || '';
      if (!workspace) return {};
      return this.goalTestEvidence(workspace, taskGoal);
    };
  }

  /**
   * Phase 17 Move 2 — the completion verification gate's verifier: the
   * goal-matched tests must PASS before the mission completes. Fail-open when
   * there is nothing to gate on (no workspace / no goal-matched tests / the
   * verifier itself cannot run) — the engine decides pass -> COMPLETED,
   * fail -> repair-until-budget -> FAILED.
   */
  private buildMissionVerifier(goal: string, workspacePathValue: unknown, workspaceFallback?: string): TaskVerifier {
    return async (task) => {
      const taskWorkspace = this.getValidWorkspacePath(task.context?.workspacePath) || workspaceFallback || '';
      const taskGoal = task.goal || goal;
      const workspace = taskWorkspace || this.getValidWorkspacePath(workspacePathValue) || '';
      if (!workspace) return { passed: true, detail: 'No workspace — completion trusted.' };
      try {
        const evidence = await this.goalTestEvidence(workspace, taskGoal);
        const tests = evidence.tests || [];
        if (tests.length === 0) {
          return { passed: true, detail: `No goal-matched tests for '${taskGoal.slice(0, 80)}' — completion trusted.` };
        }
        const failed = tests.filter(t => !t.passed);
        return {
          passed: failed.length === 0,
          detail: evidence.evidence || tests.map(t => `\`${t.command}\` exit ${t.exitCode}`).join('; ')
        };
      } catch (error: any) {
        return { passed: true, detail: `Verifier failed to run: ${error?.message || String(error)} — completion trusted.` };
      }
    };
  }

  /**
   * Phase 17 Move 2 — shared goal-matched-test evidence, used by BOTH the
   * failure diagnoser (verify-then-retry) and the completion verifier gate.
   * One authority for what "the goal's tests" means.
   */
  private async goalTestEvidence(
    workspace: string,
    goal: string
  ): Promise<{ matchedFiles: string[]; tests?: any[]; evidence?: string }> {
    const contextCfg = this.loadConfig()?.agent?.context || {};
    const verifyCfg = contextCfg.repository?.verifyOnFailure || {};
    const files = this.contextEngine.relevantFiles(workspace, goal, 8);
    const matchedFiles = (files || []).map((f: any) => f.path || String(f)).slice(0, 8);
    if (contextCfg.repository?.enabled !== true || verifyCfg.enabled === false) return { matchedFiles };
    const index = this.contextEngine.indexRepository(workspace);
    if (!index) return { matchedFiles };
    const testFiles = matchedTestFiles(index, goal, files);
    if (!testFiles.length) return { matchedFiles };
    const run = await runGoalTests(workspace, testFiles, {
      timeoutMs: verifyCfg.timeoutMs,
      maxOutputChars: verifyCfg.maxOutputChars
    });
    if (!run.ran) return { matchedFiles };
    return {
      matchedFiles,
      tests: [{
        command: run.command || '',
        exitCode: run.exitCode ?? -1,
        output: String(run.output || ''),
        passed: run.exitCode === 0
      }],
      evidence: `Goal-matched verification ran \`${run.command}\` (exit ${run.exitCode}):\n${run.output}`
    };
  }

  /**
   * Phase 10 + 11 recovery (Move 2 — one execution authority): when a tool
   * call fails, TaskEngine.diagnose() gathers the recovery evidence — the
   * goal-matched files (Phase 10) and the goal-matched test runs with output
   * (Phase 11) — via the engine's canonical EXECUTING -> VERIFYING ->
   * EXECUTING path, recording TaskVerification evidence and emitting
   * TaskRetrying/TaskVerifying/TestPassed/TestFailed/TaskRecovered. This host
   * only wires the repository diagnoser (ContextEngine + verify-then-retry)
   * and renders the engine's diagnosis into context; it no longer defines
   * recovery semantics. Gated by the repository section config; deduped per
   * session; advisory only — never throws into the failure path.
   */
  private async injectGoalRetryHint(sessionId: string, goal: string, workspacePathValue: unknown, taskId?: string): Promise<void> {
    if (!goal) return;
    try {
      const contextCfg = this.loadConfig()?.agent?.context || {};
      if (contextCfg.repository?.enabled !== true) return;
      const workspace = this.getValidWorkspacePath(workspacePathValue);
      if (!workspace) return;
      let diagnosis: { matchedFiles?: string[]; tests?: any[]; evidence?: string } = {};
      if (taskId) {
        const result = await taskEngine.diagnose(taskId, {
          detail: `tool failure for goal '${goal.slice(0, 120)}'`,
          diagnoser: this.buildMissionDiagnoser(goal, workspacePathValue, workspace)
        });
        diagnosis = result.diagnosis;
      } else {
        // No canonical task (non-mission contexts): fall back to the direct
        // evidence path without engine records.
        const files = this.contextEngine.relevantFiles(workspace, goal, 8);
        diagnosis = { matchedFiles: (files || []).map((f: any) => f.path || String(f)).slice(0, 8) };
      }

      const matched = diagnosis.matchedFiles || [];
      if (matched.length > 0) {
        const hint =
          `A tool call failed. Files the repository index matched for the goal '${goal.slice(0, 120)}':\n` +
          matched.map((p: string) => `- ${p}`).join('\n') +
          '\nInspect these files and target the retry at them instead of repeating the failed approach.';
        if (this.lastRetryHint.get(sessionId) !== hint) {
          this.lastRetryHint.set(sessionId, hint);
          this.memory.add(sessionId, {
            role: 'system',
            content: hint,
            timestamp: Date.now(),
            metadata: { type: 'goal_retry_hint' }
          });
        }
      }
      const evidence = diagnosis.evidence || (diagnosis.tests && diagnosis.tests[0]?.output
        ? `Goal-matched verification ran (exit ${diagnosis.tests[0].exitCode}):\n${diagnosis.tests[0].output}`
        : '');
      if (evidence) {
        this.memory.add(sessionId, {
          role: 'system',
          content: evidence,
          timestamp: Date.now(),
          metadata: { type: 'goal_verify_output' }
        });
      }
    } catch {
      // Advisory only.
    }
  }

  private buildProjectPrompt(metadata: any): string {
    const projectId = typeof metadata?.projectId === 'string' ? metadata.projectId.trim() : '';
    if (!projectId) return '';

    const name = typeof metadata?.projectName === 'string' && metadata.projectName.trim()
      ? metadata.projectName.trim()
      : projectId;
    const description = typeof metadata?.projectDescription === 'string' ? metadata.projectDescription.trim() : '';
    const workspacePath = typeof metadata?.projectWorkspacePath === 'string' ? metadata.projectWorkspacePath.trim() : '';
    const workspaceExists = Boolean(metadata?.projectWorkspaceExists);

    const lines = [
      'Active project context:',
      `- Project ID: ${projectId}`,
      `- Project name: ${name}`,
      description ? `- Project description: ${description}` : '',
      workspacePath ? `- Local workspace folder: ${workspacePath}` : '- Local workspace folder: not attached',
      workspacePath ? `- Workspace folder exists: ${workspaceExists ? 'yes' : 'no'}` : '',
      'Treat this chat as scoped to this project. Prefer project-specific history, decisions, files, tasks, and workspace paths when answering or using tools.'
    ].filter(Boolean);

    return `\n\n${lines.join('\n')}\n`;
  }

  private stableStringify(value: any): string {
    if (value === null || typeof value !== 'object') {
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      return `[${value.map(item => this.stableStringify(item)).join(',')}]`;
    }
    const keys = Object.keys(value).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${this.stableStringify(value[key])}`).join(',')}}`;
  }

  private buildToolBatchSignature(toolCalls: any[]): string {
    return (toolCalls || [])
      .map(call => `${String(call?.name || 'tool')}:${this.stableStringify(call?.arguments || {})}`)
      .sort()
      .join('|');
  }

  private buildConversationalProgressUpdate(content: string, toolCalls: any[], recovering: boolean, hasUnverifiedChanges: boolean): string {
    // Prefer the model's own narration for this turn (streamed live to the
    // chat) so progress updates stay dynamic and task-specific. Templates are
    // only a fallback for turns where the model produced no usable text.
    const narrated = String(content || '').trim().replace(/\s+/g, ' ');
    if (narrated) {
      return narrated.length > 200 ? `${narrated.slice(0, 200).trimEnd()}…` : narrated;
    }
    if (recovering) {
      return "I hit a problem with the last step, so I'm switching approaches now. I'll keep working and verify the recovery before I finish.";
    }

    const names = (toolCalls || []).map(call => String(call?.name || '').toLowerCase());
    if (names.some(name => name.includes('delegate') || name.includes('agent'))) {
      return "I've split the independent parts of this task so they can run in parallel. I'll bring the results together and verify the final outcome.";
    }
    if (names.some(name => name.includes('patch'))) {
      return "I found the relevant code, and I'm applying the change now. Once it's in place, I'll run the checks and correct anything that still fails.";
    }
    if (names.some(name => name.includes('playwright'))) {
      return "I'm opening the page and checking the real behavior now. I'll use what I find to finish the change and verify it from the user's side.";
    }
    if (names.some(name => name.includes('search') || name.includes('research') || name.includes('brave') || name.includes('serper'))) {
      return "I'm checking the relevant sources now so the answer is based on current evidence. I'll review the results before I give you the conclusion.";
    }
    if (names.some(name => name.includes('shell'))) {
      return hasUnverifiedChanges
        ? "The change is ready, so I'm running the checks now. I'll review any failure and keep working until the result is verified."
        : "I'm inspecting the project and checking the current behavior first. That will give me the evidence I need to make the right change.";
    }
    const tools = this.describeToolBatch(toolCalls);
    return `I'm running ${tools} now and checking the result before the next step.`;
  }

  private describeToolBatch(toolCalls: any[]): string {
    const names = (toolCalls || [])
      .map(call => String(call?.name || '').trim())
      .filter(Boolean);
    if (names.length === 0) return 'tools';
    const uniq = [...new Set(names)].map(n => n.replace(/_/g, ' '));
    const pretty = (t: string) => (/ /.test(t) ? t : `the ${t} tool`);
    if (uniq.length === 1) return pretty(uniq[0]);
    if (uniq.length === 2) return `${pretty(uniq[0])} and ${pretty(uniq[1])}`;
    return `${uniq.slice(0, -1).map(pretty).join(', ')}, and ${pretty(uniq[uniq.length - 1])}`;
  }

  private normalizeToolCall(call: any): void {
    if (!call || typeof call !== 'object') return;
    // Delegate to the canonical ToolEngine name resolution (Phase 4): registered
    // names pass through, MCP-style prefixes are stripped, playwright/browser
    // aliases fold onto the native skill, and other hallucinated names are
    // alias-resolved. The call object is mutated in place so downstream
    // budget/media/disabled-tool logic sees the canonical name.
    const normalized = normalizeToolRequest(
      { name: String(call.name || '').trim(), arguments: call.arguments },
      SkillRegistry,
      (name: string) => this.dynamicTools.normalizeName(name)
    );
    if (normalized.name) call.name = normalized.name;
    call.arguments = normalized.arguments;
  }

  private requiresToolExecution(text: string): boolean {
    return /\b(fix|debug|implement|build|create|code|edit|modify|update|add|remove|rename|move|install|configure|deploy|run|test|verify|inspect|audit|refactor|write\s+(?:a\s+)?(?:file|code|script|test))\b/i.test(String(text || ''));
  }

  private looksLikeProgressOnly(text: string): boolean {
    const value = String(text || '').trim();
    if (!value) return true;
    const hasSubstantiveResult = value.length >= 400
      && /(?:^|\n)\s*(?:#{1,4}\s+|[-*]\s+|\d+\.\s+)|\b(?:executive summary|findings|sources|result|completed|implemented|verified)\b/i.test(value);
    if (hasSubstantiveResult) return false;
    const opening = value.slice(0, 320);
    return /\b(i(?:'ll| will| am going to)|let me|next i(?:'ll| will)|i need to|i should now|i can now|we(?:'ll| will) now|proceeding to|starting (?:with|by)|continue by)\b/i.test(opening)
      || /(?:^|\n)\s*(?:next|now|then)\s*[:,-]/i.test(opening);
  }

  /**
   * Phase 12 Move 2 + 3 — the completion/verification judgment (host domain
   * knowledge). Answers the engine's "is completion allowed?" question from the
   * evidence the mission loop supplies plus the engine-owned verification
   * state. The engine owns the lifecycle transition; this only supplies the
   * verdict, never terminates a Task directly. When the goal requires
   * verification and a mutation is still unverified, the answer is `verify` so
   * the engine's in-loop diagnose authority runs.
   */
  private completionVerdict(evidence: TaskCompletionEvidence, pendingVerification?: boolean): TaskTurnVerdict {
    const withinBudget = (evidence.forcedContinuations ?? 0) < (evidence.maxForcedContinuations ?? 4);
    const verifyPending = pendingVerification
      ?? (!!evidence.verificationRequired && (evidence.lastMutationSequence ?? -1) > (evidence.lastVerificationSequence ?? -1));
    if (withinBudget) {
      if (evidence.toolRequired && (evidence.totalToolCalls ?? 0) === 0) {
        return { type: 'continue', reason: 'The action task has not used any tools yet.' };
      }
      if (evidence.lastBatchHadFailure) {
        return { type: 'continue', reason: 'The latest tool batch failed and needs a recovery attempt.' };
      }
      if (evidence.verificationRequired && verifyPending) {
        return { type: 'verify', reason: 'Changes were made but no later verification has run.' };
      }
      if (this.looksLikeProgressOnly(evidence.finalDraft || '')) {
        return { type: 'continue', reason: 'The draft only promises future work instead of completing it.' };
      }
    }
    const blocked = evidence.lastBatchHadFailure
      || (evidence.toolRequired && (evidence.totalToolCalls ?? 0) === 0)
      || (evidence.verificationRequired && verifyPending);
    if (blocked) {
      return {
        type: 'blocked',
        error: 'Required tool work or verification did not succeed.',
        reason: evidence.lastBatchHadFailure ? 'tool work failed' : 'required tool work or verification is missing'
      };
    }
    return { type: 'complete', summary: (evidence.finalDraft || '').trim() || undefined };
  }

  /** Bound form the engine's completion-verdict hook expects (Phase 12 Move 2/3). */
  private readonly completionVerdictHook = async (context: TaskCompletionContext): Promise<TaskTurnVerdict> =>
    this.completionVerdict(context.evidence, context.pendingVerification);

  private isMutationToolCall(call: any): boolean {
    const name = String(call?.name || '').toLowerCase();
    if (name === 'apply_patch') return true;
    if (name === 'shell') {
      const command = String(call?.arguments?.command || '');
      return /(?:^|[;&|]\s*)(?:set-content|add-content|remove-item|move-item|copy-item|new-item|mkdir|del|erase|rm|mv|cp|touch|git\s+(?:add|commit|merge|rebase|checkout|switch)|npm\s+install|pnpm\s+install|yarn\s+add)\b|(?:>>?|\|\s*tee\b)/i.test(command);
    }
    return ['project_manager', 'background_goals', 'memory', 'notes', 'models', 'scheduler'].includes(name);
  }

  private isVerificationToolCall(call: any): boolean {
    const name = String(call?.name || '').toLowerCase();
    if (name !== 'shell') return false;
    const command = String(call?.arguments?.command || '');
    return /\b(test|tests|build|lint|typecheck|check|verify|pytest|jest|vitest|mocha|tsc|cargo\s+test|go\s+test|dotnet\s+test|git\s+(?:diff|status))\b/i.test(command);
  }

  private selectRelevantMemories(memories: Memory[], query: string, limit: number): Memory[] {
    const tokens = new Set(
      String(query || '')
        .toLowerCase()
        .match(/[a-z0-9_]{3,}/g)
        ?.filter(token => !['this', 'that', 'with', 'from', 'have', 'will', 'your', 'please'].includes(token)) || []
    );
    if (tokens.size === 0) return [];
    return memories
      .map((memory, index) => {
        const haystack = memory.content.toLowerCase();
        let score = 0;
        for (const token of tokens) {
          if (haystack.includes(token)) score += 1;
        }
        return { memory, index, score };
      })
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score || b.index - a.index)
      .slice(0, limit)
      .sort((a, b) => a.index - b.index)
      .map(item => item.memory);
  }

  private async deliverFinalResponse(
    sessionId: string,
    draft: string,
    runId: string,
    messageId: string,
    completed: boolean = true,
    reasoning?: string
  ) {
    const finalText = executionStateManager.prepareAssistantResponse(sessionId, draft, { final: completed });
    if (!finalText.trim()) return;
    if (this.gateway.supportsStructuredStreaming?.(sessionId)) {
      await this.gateway.sendStreamEvent(sessionId, { type: 'assistant_start', runId, messageId });
      await this.gateway.sendStreamEvent(sessionId, { type: 'assistant_delta', runId, messageId, text: finalText });
      await this.gateway.sendStreamEvent(sessionId, { type: 'assistant_done', runId, messageId, finalText, reasoning, ok: completed });
      return;
    }
    await this.gateway.sendResponse(sessionId, finalText);
  }

  private buildTimePrompt() {
    const now = new Date();
    const iso = now.toISOString();
    const local = now.toLocaleString();
    const dateLabel = new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    }).format(now);
    const offsetMinutes = now.getTimezoneOffset();
    const abs = Math.abs(offsetMinutes);
    const offsetHours = String(Math.floor(abs / 60)).padStart(2, '0');
    const offsetMins = String(abs % 60).padStart(2, '0');
    const sign = offsetMinutes <= 0 ? '+' : '-';
    const utcOffset = `UTC${sign}${offsetHours}:${offsetMins}`;
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local';
    return [
      'Current date/time (authoritative):',
      `- Today: ${dateLabel}`,
      `- Local: ${local}`,
      `- ISO: ${iso}`,
      `- Timezone: ${timeZone} (${utcOffset})`
    ].join('\n');
  }

  private formatDateKey(d: Date) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  private buildWorkspacePrompt(channel: string, sessionId?: string, query = '', memoryPolicy?: AgentMemoryPolicy) {
    const root = process.cwd();
    const agents = this.readTextFileIfExists(path.join(root, 'AGENTS.md')).trim();
    const user = this.readTextFileIfExists(path.join(root, 'USER.md')).trim();

    const parts: string[] = [];
    if (agents) parts.push(`AGENTS.md:\n${agents}`);
    if (user) parts.push(`USER.md:\n${user}`);

    if (this.isMainSessionChannel(channel)) {
      const memory = this.readTextFileIfExists(path.join(root, 'MEMORY.md')).trim();
      if (memory) parts.push(`MEMORY.md:\n${memory}`);
      const learning = this.readTextFileIfExists(path.join(root, 'LEARNING.md')).trim();
      if (learning) parts.push(`LEARNING.md:\n${learning}`);

      const now = new Date();
      const todayKey = this.formatDateKey(now);
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const yesterdayKey = this.formatDateKey(yesterday);
      const todayDaily = this.readTextFileIfExists(path.join(root, 'memory', `${todayKey}.md`)).trim();
      const yesterdayDaily = this.readTextFileIfExists(path.join(root, 'memory', `${yesterdayKey}.md`)).trim();
      if (yesterdayDaily) parts.push(`memory/${yesterdayKey}.md:\n${yesterdayDaily}`);
      if (todayDaily) parts.push(`memory/${todayKey}.md:\n${todayDaily}`);
    }

    let result = parts.length > 0
      ? `\n\nWorkspace Context:\n${parts.join('\n\n')}\n`
      : '';

    const mainGoalPrompt = mainGoalManager.getPrompt(sessionId);
    if (mainGoalPrompt) {
      result += `\n\n${mainGoalPrompt}\n`;
    }

    const learnedRules = this.learning.getPromptLessons(sessionId);
    if (learnedRules) {
      result += `\n${learnedRules}\n`;
    }

    const learnedSkills = this.learning.getLearnedSkillsPrompt(sessionId || '', query);
    if (learnedSkills) {
      result += `\n${learnedSkills}\n`;
    }

    const portableSkills = portableSkillsManager.getCatalogPrompt();
    if (portableSkills) {
      result += `\n${portableSkills}\n`;
    }

    const projectSummary = backgroundWorker.getProjectSummaryPrompt(sessionId);
    if (projectSummary) {
      result += `\n${projectSummary}\n`;
    }

    const strategyScores = backgroundWorker.getStrategyScoreSummary(sessionId);
    if (strategyScores) {
      result += `\n${strategyScores}\n`;
    }

    // Audit 5: review prompt renders from the canonical delegated child Tasks
    // (delegation/swarm/background/scheduled) instead of the removed
    // agent_runs.json bookkeeping store.
    const delegationReports = renderDelegationReports(delegationTasksForSession(taskEngine.list(), sessionId));
    if (delegationReports) {
      result += `\n${delegationReports}\n`;
    }

    // Phase 12 D2: the current-task resume summary comes from the canonical
    // Task system (TaskMemory) instead of the legacy current_task.json.
    const taskSummary = taskMemory.summaryPrompt(sessionId || '');
    if (taskSummary) {
      result += `\n${taskSummary}`;
    }

    // Phase 14 Move 2/3: one unified memory section (working + recent episodes +
    // proven rules) read through the consolidation layer (deduped, merged,
    // archived/expired excluded). The per-store ad-hoc blocks above stay until
    // each is proven covered — see docs/hermes/MEMORY_AUDIT.md Move 2.
    const unifiedMemory = this.buildUnifiedMemoryContext(sessionId, memoryPolicy);
    if (unifiedMemory) {
      result += `\n${unifiedMemory}\n`;
    }

    if (!result.trim()) return '';
    return result;
  }

  /**
   * Phase 14 Move 2/3 — the unified memory section for the mission prompt:
   * working memory (current task), recent episodic outcomes (event-driven
   * capture), and proven procedural rules (confidence-scored), read through
   * the consolidation layer (dedupe/merge + lifecycle applied, archived and
   * expired excluded). Budgeted to the smallest useful context; advisory —
   * never throws into the prompt.
   */
  private buildUnifiedMemoryContext(sessionId?: string, policy?: AgentMemoryPolicy): string {
    try {
      const records = this.memoryConsolidation.consolidate(sessionId)
        .filter(r => r.lifecycle !== 'archived' && r.lifecycle !== 'expired')
        // Phase 16 Move 4: the designated default agent's memoryPolicy filters
        // the mission's unified-memory section (types / sources / minImportance).
        .filter(r => !policy?.types?.length || policy.types.includes(r.type as any))
        .filter(r => !policy?.sources?.length || policy.sources.includes(r.source as any))
        .filter(r => (policy?.minImportance ?? 0) <= r.importance);
      const working = records.filter(r => r.type === 'working').slice(0, 1);
      const episodes = records.filter(r => r.type === 'episodic').slice(0, 3);
      const rules = records.filter(r => r.type === 'procedural').slice(0, 3);
      if (!working.length && !episodes.length && !rules.length) return '';
      const lines = ['Memory context (unified):'];
      for (const w of working) lines.push(`- Working: ${this.compactLine(w.content)}`);
      for (const e of episodes) lines.push(`- Episode: ${this.compactLine(e.content)}`);
      for (const r of rules) lines.push(`- Rule (${Math.round(r.confidence * 100)}% confidence): ${this.compactLine(r.content)}`);
      return lines.join('\n');
    } catch {
      return '';
    }
  }

  private compactLine(text: string): string {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  private loadConfig(): any {
    // Architecture review Move 1: typed, validated config. Engine sections
    // (policy, agent.context, agent knobs, checkpoints) are validated at load;
    // a typo is logged loudly and the invalid key stripped instead of silently
    // changing behavior. Other sections pass through untouched.
    return loadHermesConfig();
  }

  // Build the tool list advertised to the model. Bounded per provider and
  // deduplicated by name so a huge MCP surface (or a registry with many
  // learned skills) cannot blow the context window, and so native skills are
  // never shadowed by same-named MCP tools.
  //
  // Limits (config.agent): maxNativeTools (default 60, floor 10) and
  // maxMcpToolsPerServer (default 40, floor 5). Floors prevent an accidental
  // tiny cap from crippling the agent. Conflict resolution: native skills win;
  // the first MCP server that advertises a name claims it for the rest.
  // Truncation warnings are logged at most once per key (see advertisedWarnings).
  private buildAdvertisedTools(sessionId: string, mcpTools: any[], config?: any): any[] {
    const limits = AgentRunner.getToolLimits(config ?? this.loadConfig());
    const maxNative = limits.maxNativeTools;
    const maxMcpPerServer = limits.maxMcpToolsPerServer;

    const byName = new Map<string, any>();

    // Native skills first so they own name conflicts.
    let nativeCount = 0;
    const skills = SkillRegistry.getAll().filter(skill => {
      const learnedSessionId = (skill as any).learnedSessionId;
      return !learnedSessionId || learnedSessionId === sessionId;
    });
    const nativeTotal = skills.filter(s => Boolean(s.inputSchema)).length;
    for (const skill of skills) {
      if (!skill.inputSchema) continue;
      if (nativeCount >= maxNative) break;
      nativeCount += 1;
      byName.set(skill.name, {
        name: skill.name,
        description: skill.description,
        inputSchema: skill.inputSchema,
        source: 'native'
      });
    }
    if (nativeTotal > maxNative) {
      const key = `native:${maxNative}`;
      if (!this.advertisedWarnings.has(key)) {
        this.advertisedWarnings.add(key);
        console.warn(`[AgentRunner] Advertised native tools capped at ${maxNative} (${nativeTotal} available).`);
      }
    }

    // MCP tools: skip names already claimed by native skills; cap per server.
    // Truncation warnings only fire when the cap (not a name conflict) dropped tools.
    const perServer = new Map<string, number>();
    const truncatedServers = new Set<string>();
    for (const tool of mcpTools || []) {
      const name = String(tool?.name || '').trim();
      if (!name) continue;
      if (byName.has(name)) continue; // native skill wins the conflict
      const server = String(tool?.source || 'mcp');
      const used = perServer.get(server) || 0;
      if (used >= maxMcpPerServer) {
        truncatedServers.add(server);
        continue;
      }
      perServer.set(server, used + 1);
      byName.set(name, {
        name,
        description: String(tool?.description || ''),
        inputSchema: tool?.inputSchema,
        source: server
      });
    }
    for (const server of truncatedServers) {
      const key = `mcp:${server}:${maxMcpPerServer}`;
      if (this.advertisedWarnings.has(key)) continue;
      this.advertisedWarnings.add(key);
      const listed = (mcpTools || []).filter((t: any) => String(t?.source || 'mcp') === server).length;
      console.warn(`[AgentRunner] MCP server '${server}' advertised ${listed} tools, capped at ${maxMcpPerServer}.`);
    }

    return Array.from(byName.values());
  }

  private isCompactionMemory(memory: Memory): boolean {
    return memory.role === 'system' && memory.metadata?.type === 'compaction';
  }

  private getLatestCompaction(memories: Memory[]): Memory | null {
    for (let i = memories.length - 1; i >= 0; i--) {
      if (this.isCompactionMemory(memories[i])) return memories[i];
    }
    return null;
  }

  private applyCompactionFilter(memories: Memory[]): Memory[] {
    const latest = this.getLatestCompaction(memories);
    if (!latest) return memories;
    const upto = typeof latest.metadata?.uptoTimestamp === 'number'
      ? latest.metadata.uptoTimestamp
      : latest.timestamp;
    const filtered = memories.filter((m) => m.timestamp > upto && m !== latest);
    return [latest, ...filtered];
  }

  private async autoCompactSessionIfNeeded(sessionId: string, config: any, memories: Memory[]): Promise<boolean> {
    const agentConfig = config?.agent ?? {};
    const autoCompactCfg = agentConfig.autoCompact;
    const autoCompactEnabled = autoCompactCfg !== false
      && !(typeof autoCompactCfg === 'object' && autoCompactCfg.enabled === false);

    if (!autoCompactEnabled) return false;

    const minMessages = typeof autoCompactCfg?.minMessages === 'number' ? autoCompactCfg.minMessages : 80;
    const keepLast = typeof autoCompactCfg?.keepLast === 'number' ? autoCompactCfg.keepLast : 20;
    const minNewMessages = typeof autoCompactCfg?.minNewMessages === 'number' ? autoCompactCfg.minNewMessages : 30;
    const maxChars = typeof autoCompactCfg?.maxChars === 'number' ? autoCompactCfg.maxChars : 18000;
    const perMessageMaxChars = typeof autoCompactCfg?.perMessageMaxChars === 'number' ? autoCompactCfg.perMessageMaxChars : 1200;

    if (memories.length < minMessages) return false;

    const latestCompaction = this.getLatestCompaction(memories);
    const lastUpto = typeof latestCompaction?.metadata?.uptoTimestamp === 'number'
      ? latestCompaction.metadata.uptoTimestamp
      : (latestCompaction?.timestamp || 0);

    const cutoffIndex = Math.max(0, memories.length - keepLast);
    const candidates = memories.slice(0, cutoffIndex).filter((m) => {
      if (this.isCompactionMemory(m)) return false;
      return m.timestamp > lastUpto;
    });

    if (candidates.length < minNewMessages) return false;

    const lastTimestamp = candidates[candidates.length - 1].timestamp;

    const truncate = (value: string, max: number) => {
      if (value.length <= max) return value;
      return value.slice(0, max) + `\n... (truncated ${value.length - max} chars)`;
    };

    let body = '';
    for (const msg of candidates) {
      const role = msg.role === 'user' ? 'User' : msg.role === 'assistant' ? 'Assistant' : 'System';
      const line = `${role}: ${truncate(msg.content, perMessageMaxChars)}\n`;
      if (body.length + line.length > maxChars) break;
      body += line;
    }

    if (!body.trim()) return false;

    const summaryPrompt = [
      'Summarize the conversation history below for future context.',
      'Focus on: user goal, key decisions, constraints, actions taken (including tool results), and open tasks.',
      'Write 6-12 bullet points, concise and factual. Do not invent anything.',
      '',
      'Conversation:',
      body
    ].join('\n');

    try {
      const model = this.getModel();
      const summaryResp = await model.generate(summaryPrompt, 'You are a summarization assistant.', []);
      const summary = (summaryResp.content || '').trim();
      if (!summary) return false;

      this.memory.add(sessionId, {
        role: 'system',
        content: `Compacted summary (auto):\n${summary}`,
        timestamp: Date.now(),
        metadata: {
          type: 'compaction',
          uptoTimestamp: lastTimestamp,
          messageCount: candidates.length,
          createdAt: Date.now()
        }
      });
      return true;
    } catch (e) {
      console.error('[AgentRunner] Auto-compact failed:', e);
      return false;
    }
  }

  private registerCredentialPoolProviders(config: any): void {
    const resilience = config?.modelResilience || {};
    if (resilience.enabled === false) return;

    const openRouterKeys = this.readCredentialPool('OPENROUTER_API_KEYS', process.env.OPENROUTER_API_KEY)
      .filter(key => isProviderKeyValid('openrouter', key));
    const openRouterModels = this.uniqueStrings([
      config?.aiModel,
      config?.llm?.model,
      ...(Array.isArray(resilience.openRouterModels) ? resilience.openRouterModels : []),
      ...this.splitList(process.env.OPENROUTER_FALLBACK_MODELS)
    ]);
    let openRouterIndex = 0;
    for (const key of openRouterKeys) {
      for (const modelName of openRouterModels) {
        if (key === process.env.OPENROUTER_API_KEY && modelName === String(config?.aiModel || config?.llm?.model || '')) continue;
        openRouterIndex += 1;
        ModelRegistry.register(new OpenRouterProvider(key, modelName, `openrouter_pool_${openRouterIndex}`));
      }
    }

    const nvidiaKeys = this.readCredentialPool('NVIDIA_API_KEYS', process.env.NVIDIA_API_KEY)
      .filter(key => isProviderKeyValid('nvidia', key));
    const nvidiaModels = this.uniqueStrings([
      ...(Array.isArray(resilience.nvidiaModels) ? resilience.nvidiaModels : []),
      ...this.splitList(process.env.NVIDIA_FALLBACK_MODELS)
    ]);
    let nvidiaIndex = 0;
    for (const key of nvidiaKeys) {
      for (const modelName of nvidiaModels) {
        nvidiaIndex += 1;
        ModelRegistry.register(new NvidiaProvider(key, modelName, config?.nvidia?.thinking !== false, `nvidia_pool_${nvidiaIndex}`));
      }
    }
  }

  private readCredentialPool(envName: string, primary?: string): string[] {
    return this.uniqueStrings([primary, ...this.splitList(process.env[envName])]);
  }

  private splitList(value: unknown): string[] {
    return typeof value === 'string'
      ? value.split(/[\r\n,;]+/).map(item => item.trim()).filter(Boolean)
      : [];
  }

  private uniqueStrings(values: unknown[]): string[] {
    return Array.from(new Set(values.map(value => String(value || '').trim()).filter(Boolean)));
  }

  private registerOpenCodeProvider(config: any): void {
    const apiKey = process.env.OPENCODE_API_KEY;
    if (!apiKey) return;
    const model = String(process.env.OPENCODE_MODEL || config?.opencode?.model || '').trim();
    if (!model) {
      console.warn('[AgentRunner] OPENCODE_API_KEY is set but no OpenCode model is configured (set OPENCODE_MODEL or config.opencode.model). OpenCode Zen will not be registered as a fallback.');
      return;
    }
    const provider = new OpenCodeProvider(apiKey, model);
    ModelRegistry.register(provider);
    console.log(`[AgentRunner] Loaded OpenCode Zen provider (fallback) with model: ${model}`);

    // Optional additional Zen models (OPENCODE_FALLBACK_MODELS) give real
    // redundancy when the primary is rate-limited or cooling down. Each gets a
    // distinct provider id so the resilient wrapper treats them independently.
    const altModels = this.splitList(process.env.OPENCODE_FALLBACK_MODELS);
    let altIndex = 1;
    for (const altModel of altModels) {
      if (altModel === model) continue;
      const alt = new OpenCodeProvider(apiKey, altModel);
      alt.id = `opencode_alt_${altIndex}`;
      alt.name = `OpenCode Zen (${altModel})`;
      ModelRegistry.register(alt);
      altIndex += 1;
      console.log(`[AgentRunner] Loaded OpenCode Zen fallback model: ${altModel}`);
    }
  }

  setOpenCodeModel(modelName: string): boolean {
    const provider = ModelRegistry.get('opencode') as OpenCodeProvider | undefined;
    if (!provider || !(provider instanceof OpenCodeProvider)) return false;
    provider.setModel(modelName);
    return true;
  }


  private withModelFallback(primary: ModelProvider): ModelProvider {
    const config = this.loadConfig();
    const resilience = config?.modelResilience || {};
    if (resilience.enabled === false || primary.id === 'mock' || primary.id === 'error' || primary.id.startsWith('resilient:')) {
      return primary;
    }
    const configuredIds = Array.isArray(resilience.fallbackModelIds)
      ? resilience.fallbackModelIds.map((id: unknown) => String(id || '').trim()).filter(Boolean)
      : [];
    const configured = configuredIds
      .map((id: string) => ModelRegistry.get(id))
      .filter((provider: ModelProvider | undefined): provider is ModelProvider => Boolean(provider));
    const discovered = resilience.includeAllEnabledModels === false
      ? []
      : ModelRegistry.getAll();
    return new ResilientModelProvider(primary, [...configured, ...discovered], resilience);
  }

  // Helper to get the current model based on config/env at runtime
  private getModel(): ModelProvider {
    // 1. Check ModelRegistry for a specifically selected model (e.g. from Web UI)
    const currentModelId = ModelRegistry.getCurrentModelId();
    if (currentModelId && currentModelId !== 'mock') {
      const model = ModelRegistry.get(currentModelId);
      if (model) {
        console.log(`[AgentRunner] Using registry-selected model: ${currentModelId}`);
        return this.withModelFallback(model);
      }
    }

    // 2. Fallback to Legacy Provider Logic (from config.json)
    const config = this.loadConfig();
    console.log(`[AgentRunner] Selecting model from config. Config: ${config.model}`);
    const modelKey = String(config.model || '').trim().toLowerCase();

    // Check OpenRouter
    if (modelKey === 'openrouter') {
      if (isProviderKeyValid('openrouter', process.env.OPENROUTER_API_KEY)) {
        const aiModel = String(config.aiModel || process.env.OPENROUTER_MODEL || '').trim();
        if (!aiModel) {
          console.warn('[AgentRunner] OpenRouter selected but no model id is configured.');
          return {
            id: 'error',
            name: 'Error',
            generate: async () => ({
              content: "Configuration Error: OpenRouter selected but no model id is set. Set config.aiModel or OPENROUTER_MODEL."
            })
          };
        }
        console.log(`[AgentRunner] Using OpenRouter legacy config: ${aiModel}`);
        const provider = new OpenRouterProvider(process.env.OPENROUTER_API_KEY || '', aiModel);
        ModelRegistry.register(provider);
        return this.withModelFallback(provider);
      } else {
        console.warn('[AgentRunner] Config is OpenRouter but OPENROUTER_API_KEY is missing or invalid.');
        return {
          id: 'error',
          name: 'Error',
          generate: async () => ({
            content: "⚠️ **Configuration Error**: You selected 'OpenRouter' but no valid API Key was found. Please go to Settings and enter your OpenRouter API Key (starts with sk-or-v1-)."
          })
        };
      }
    }

    if (modelKey === 'nvidia') {
      if (isProviderKeyValid('nvidia', process.env.NVIDIA_API_KEY)) {
        const aiModel = String(config.aiModel || '').trim();
        if (!aiModel) {
          console.warn('[AgentRunner] NVIDIA selected but no model id is configured.');
          return {
            id: 'error',
            name: 'Error',
            generate: async () => ({
              content: "Configuration Error: NVIDIA selected but no model id is set. Set config.aiModel in config.json."
            })
          };
        }
        const enableThinking = typeof config?.nvidia?.thinking === 'boolean' ? config.nvidia.thinking : true;
        console.log(`[AgentRunner] Using NVIDIA legacy config: ${aiModel}`);
        const provider = new NvidiaProvider(process.env.NVIDIA_API_KEY || '', aiModel, enableThinking);
        ModelRegistry.register(provider);
        return this.withModelFallback(provider);
      } else {
        console.warn('[AgentRunner] Config is NVIDIA but NVIDIA_API_KEY is missing or invalid.');
        return {
          id: 'error',
          name: 'Error',
          generate: async () => ({
            content: "⚠️ **Configuration Error**: You selected 'NVIDIA' but no valid API Key was found. Please set NVIDIA_API_KEY (starts with nvapi-) in Settings or .env."
          })
        };
      }
    }

    if (modelKey === 'opencode') {
      if (process.env.OPENCODE_API_KEY) {
        const aiModel = String(config.aiModel || process.env.OPENCODE_MODEL || '').trim();
        if (!aiModel) {
          console.warn('[AgentRunner] OpenCode selected but no model id is configured.');
          return {
            id: 'error',
            name: 'Error',
            generate: async () => ({
              content: "Configuration Error: OpenCode selected but no model id is set. Set config.aiModel or OPENCODE_MODEL."
            })
          };
        }
        console.log(`[AgentRunner] Using OpenCode Zen legacy config: ${aiModel}`);
        const provider = new OpenCodeProvider(process.env.OPENCODE_API_KEY, aiModel);
        ModelRegistry.register(provider);
        return this.withModelFallback(provider);
      } else {
        console.warn('[AgentRunner] Config is OpenCode but OPENCODE_API_KEY is missing.');
        return {
          id: 'error',
          name: 'Error',
          generate: async () => ({
            content: "⚠️ **Configuration Error**: You selected 'OpenCode' but no API Key was found. Please set OPENCODE_API_KEY in .env."
          })
        };
      }
    }

    // Fallback to mock
    console.log('[AgentRunner] No specific model selected, falling back to Mock');
    return ModelRegistry.get('mock')!;
  }

  private getModelById(modelId?: string): ModelProvider {
    if (modelId) {
      const provider = ModelRegistry.get(modelId);
      if (provider) return this.withModelFallback(provider);
    }
    return this.getModel();
  }

  startLoop() {
    console.log(`[AgentRunner] Heartbeat loop started (Interval: ${this.heartbeatMs}ms).`);

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    this.heartbeatInterval = setInterval(async () => {
      const now = new Date();
      const timeString = now.toLocaleTimeString();
      console.log(`[Heartbeat] ❤️ Thump at ${timeString}`);

      if (now.getMinutes() === 0) {
        console.log('[Heartbeat] ⏰ It is the top of the hour!');
      }
      await this.proactiveTick();
      try {
        await this.learning.tick();
      } catch (e) {
        console.error('[Learning] Tick failed:', e);
      }
    }, this.heartbeatMs);

    // Start background worker with goal executor
    backgroundWorker.setExecutor(async (goal, progressCallback) => {
      progressCallback(10, 'Starting goal execution...');

      if (goal.metadata?.kind === 'learned-skill-creation') {
        progressCallback(35, 'Validating the learned workflow...');
        // Phase 15 S1: the skill-creation workflow runs as a canonical
        // kind-'background' Task (TaskEngine owns lifecycle + evidence, the
        // goal record links via canonicalTaskId). On failure the Task is
        // failed for evidence and the error rethrown so the worker's own
        // status/retry authority decides the goal outcome.
        const canonical = await this.runSkillCreationGoalViaEngine(goal);
        if (canonical.ok) {
          progressCallback(100, 'Learned skill created and activated');
          return canonical.output || '';
        }
        throw new Error(canonical.error || 'Skill creation failed');
      }

      const project = goal.projectId ? backgroundWorker.getProject(goal.projectId) : undefined;
      const dependencyLines = goal.dependencies.length > 0
        ? goal.dependencies.map(depId => {
          const dep = backgroundWorker.getGoal(depId);
          return dep ? `${dep.title} [${dep.id.slice(0, 8)}]: ${dep.status}` : `${depId}: missing`;
        })
        : [];
      const projectMemory = project
        ? [
          project.memory.notes.length > 0 ? `Project notes: ${project.memory.notes.slice(-3).join(' | ')}` : '',
          project.memory.filesTouched.length > 0 ? `Project files touched: ${project.memory.filesTouched.slice(-10).join(', ')}` : '',
          project.memory.decisions.length > 0 ? `Project decisions: ${project.memory.decisions.slice(-5).join(' | ')}` : ''
        ].filter(Boolean)
        : [];
      const content = [
          'Background goal execution request.',
          '',
          `Goal: ${goal.title}`,
          '',
          `Description: ${goal.description}`,
          '',
          `Goal ID: ${goal.id}`,
          goal.projectId ? `Project: ${project?.title || goal.projectId} (${goal.projectId})` : '',
          goal.milestoneId ? `Milestone ID: ${goal.milestoneId}` : '',
          goal.parentId ? `Parent goal ID: ${goal.parentId}` : '',
          `Attempt: ${goal.attempts + 1}/${goal.maxRetries + 1}`,
          goal.error ? `Previous error: ${goal.error}` : '',
          goal.checkpoint?.note ? `Last checkpoint: ${goal.checkpoint.note}` : '',
          dependencyLines.length > 0 ? `Dependencies:\n${dependencyLines.map(line => `- ${line}`).join('\n')}` : '',
          projectMemory.length > 0 ? projectMemory.join('\n') : '',
          '',
          `Tags: ${goal.tags.join(', ') || 'none'}`,
          '',
          'Use available tools when needed. If you change files or make project decisions, record them with the background_goals goal_memory or project_memory action. If this is a retry, use the previous error and checkpoint to recover instead of repeating the same failed approach. Finish with a concise summary of what was accomplished.'
        ].filter(Boolean).join('\n');
      // Step 9 sub-step 2 + Phase 15 Move 2: the goal runs as a canonical
      // kind-'background' Task through AgentEngine.executeTask;
      // background_goals.json stays the authority for statuses (the worker
      // drives every transition). Failures are NOT re-dispatched through a
      // second loop — the failed canonical Task is the evidence and the
      // worker's own retry/status authority decides the outcome.
      const canonical = await this.runBackgroundGoalViaEngine(goal, content, progressCallback);
      if (canonical.ok) {
        progressCallback(100, 'Goal completed through canonical background task');
        return canonical.output || '';
      }

      throw new Error(canonical.error || 'Background goal failed through the canonical task');
    });

// Wire analytics for background goals
    backgroundWorker.setOnComplete(async (goal) => {
      const duration = goal.completedAt && goal.startedAt ? goal.completedAt - goal.startedAt : undefined;
      const summary = this.summarizeBackgroundReport(goal.result || goal.error || 'Done');
      const status = goal.status === 'completed' ? 'completed' as const : 'failed' as const;
      executionStateManager.recordBackgroundUpdate(goal.sessionId, `${goal.title}: ${summary}`, status);

      if (goal.status === 'completed') {
        analyticsTracker.recordGoalComplete(goal.sessionId, goal.title, duration);
      } else {
        analyticsTracker.recordGoalFailed(goal.sessionId, goal.title);
      }
      if (!goal.tags.includes('learning')) {
        await this.sendManagedProgressUpdate(goal.sessionId, { final: goal.status !== 'in-progress' });
      }
    });
    backgroundWorker.setOnReport(async (sessionId, message) => {
      const summarized = this.summarizeBackgroundReport(message);
      // Skip trivial periodic status reports (pure counts/status lines)
      const countOnlyPattern = /^(Background status update:)\s*(Active:\s*\d+,\s*Pending:\s*\d+)$/;
      if (countOnlyPattern.test(summarized.trim())) return;
      executionStateManager.recordBackgroundUpdate(sessionId, summarized, 'in_progress');
      await this.sendManagedResponse(sessionId, summarized, { final: false });
    });
    backgroundWorker.setAutoGoalGenerator(async (sessionId) => {
      const config = this.loadConfig();
      const autoCfg = config?.backgroundWorker?.autoGenerate || {};
      const maxGoalsPerRun = typeof autoCfg.maxGoalsPerRun === 'number' ? autoCfg.maxGoalsPerRun : 2;
      const recentMessages = typeof autoCfg.recentMessages === 'number' ? autoCfg.recentMessages : 12;

      const memories = this.memory.get(sessionId) || [];
      const recent = memories.filter(m => m.role === 'user' || m.role === 'assistant').slice(-recentMessages);
      if (recent.length === 0) return [];

      const userText = recent.filter(m => m.role === 'user').map(m => m.content).join('\n');
      const hasActionSignal = /\b(please|can you|could you|need to|todo|task|fix|create|build|deploy|research|write|summarize|review|update|add|remove|enable|disable)\b/i.test(userText);
      if (!hasActionSignal) return [];

      const history = recent.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n');

      const systemPrompt = [
        'You are a goal extraction assistant.',
        'Only propose goals that are explicitly requested by the user in the conversation.',
        'Do not invent new tasks or add speculative work.',
        'If nothing is clearly requested, respond with NO_GOALS.'
      ].join(' ');

      const prompt = [
        'Extract up to the requested number of background goals.',
        `Return JSON only in the format: {"goals":[{"title":"","description":"","priority":"normal","estimatedMinutes":30,"tags":["auto"]}]}`,
        `Max goals: ${maxGoalsPerRun}.`,
        'Keep titles under 80 chars and descriptions under 400 chars.',
        '',
        'Conversation:',
        history
      ].join('\n');

      const model = this.getModel();
      const response = await model.generate(prompt, systemPrompt, []);
      const text = (response.content || '').trim();
      if (!text || /NO_GOALS/i.test(text)) return [];

      const parseJson = (raw: string) => {
        try {
          return JSON.parse(raw);
        } catch {
          const start = raw.indexOf('{');
          const end = raw.lastIndexOf('}');
          if (start >= 0 && end > start) {
            try {
              return JSON.parse(raw.slice(start, end + 1));
            } catch {
              return null;
            }
          }
          return null;
        }
      };

      const payload = parseJson(text);
      const goals = Array.isArray(payload?.goals) ? payload.goals : [];
      const normalizePriority = (value: unknown) => {
        const v = String(value || '').toLowerCase();
        return v === 'low' || v === 'normal' || v === 'high' || v === 'urgent' ? v : undefined;
      };
      const clip = (value: string, max: number) => value.length > max ? value.slice(0, max).trim() : value.trim();

      return goals.slice(0, maxGoalsPerRun).map((g: any) => ({
        title: clip(String(g?.title || ''), 80),
        description: clip(String(g?.description || ''), 400),
        priority: normalizePriority(g?.priority),
        estimatedMinutes: typeof g?.estimatedMinutes === 'number' ? g.estimatedMinutes : undefined,
        tags: Array.isArray(g?.tags) ? g.tags : undefined
      })).filter((g: any) => g.title && g.description);
    });
    backgroundWorker.start();
  }

  stopLoop() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
      console.log('[AgentRunner] Heartbeat loop stopped.');
    }
  }

  private isContinuationRequest(text: string): boolean {
    const normalized = String(text || '').trim().toLowerCase();
    return normalized === 'continue'
      || normalized === 'resume'
      || normalized === 'go on'
      || normalized === 'keep going'
      || normalized === 'carry on'
      || normalized.startsWith('continue ')
      || normalized.startsWith('resume ');
  }

  private async sendManagedResponse(
    sessionId: string,
    text: string,
    options: { final?: boolean; fallbackNow?: string; fallbackNext?: string } = {}
  ) {
    const finalText = executionStateManager.prepareAssistantResponse(sessionId, text, options);
    if (!finalText || !finalText.trim()) return;
    await this.gateway.sendResponse(sessionId, finalText);
  }

  private async sendManagedProgressUpdate(
    sessionId: string,
    options: { final?: boolean; fallbackNow?: string; fallbackNext?: string } = {}
  ) {
    const summary = executionStateManager.buildConciseContinuation(sessionId, options);
    if (!summary || !summary.trim()) return;
    await this.sendManagedResponse(sessionId, summary, options);
  }

  private summarizeBackgroundReport(message: string): string {
    const cleaned = String(message || '').replace(/\s+/g, ' ').trim();
    if (!cleaned) return 'Background work is still in progress.';
    if (cleaned.length <= 220) return cleaned;
    return cleaned.slice(0, 217).trimEnd() + '...';
  }

  private async tryHandleCasualConversation(sessionId: string, msg: Message, isBackgroundMessage: boolean): Promise<boolean> {
    if (isBackgroundMessage) return false;
    const text = String(msg.content || '').trim();
    const normalized = text.toLowerCase().replace(/[!?.]+$/g, '').trim();
    let response = '';
    if (/^(?:hi|hello|hey|hiya|howdy|good morning|good afternoon|good evening)(?:\s+gitu)?$/.test(normalized)) {
      response = 'Hello! What would you like me to work on?';
    } else if (/^(?:thanks|thank you|thank you very much|thx)$/.test(normalized)) {
      response = "You're welcome.";
    } else if (/^(?:ok|okay|got it|understood|cool)$/.test(normalized)) {
      response = 'Ready when you are.';
    } else if (/^(?:how are you|how is it going|are you ready)$/.test(normalized)) {
      response = "I'm ready. What would you like me to work on?";
    } else if (/^(?:who are you|what are you|what can you do)$/.test(normalized)) {
      response = 'I’m Gitu, your local autonomous workspace agent. I can inspect and edit real projects, run and verify commands, research, automate workflows, use reusable skills, and delegate independent work to isolated specialist agents.';
    }
    if (!response) return false;

    this.memory.add(sessionId, {
      role: 'user', content: text, timestamp: Date.now(),
      metadata: { ...(msg.metadata || {}), casualConversation: true }
    });
    this.memory.add(sessionId, {
      role: 'assistant', content: response, timestamp: Date.now(),
      metadata: { final: true, completed: true, casualConversation: true }
    });
    analyticsTracker.recordMessage(sessionId);
    await this.deliverFinalResponse(sessionId, response, uuidv4(), uuidv4(), true);
    return true;
  }

  // Canonical Task (Phase 2): create a Task for a mission and advance it to
  // EXECUTING. The engine owns the lifecycle + records; AgentRunner keeps
  // executing as before. Never throws — the mission continues even if the
  // task layer fails.
  private async beginMissionTask(input: {
    sessionId: string;
    channel: string;
    content: string;
    projectId?: string;
    workspacePath?: string;
    config: any;
    background: boolean;
    /** Phase 16 Move 3b — the designated default AgentProfile, when resolved. */
    defaultAgent?: Agent;
  }): Promise<string | null> {
    try {
      const agentCfg = input.config?.agent || {};
      const maxTurns = Number.isFinite(Number(agentCfg.maxTurns)) ? Math.max(1, Math.floor(Number(agentCfg.maxTurns))) : undefined;
      // Phase 16 Move 4 (D4): the default agent's permission tool-call budget
      // applies when the host config does not set one explicitly.
      const configMaxToolCalls = Number.isFinite(Number(agentCfg.maxToolCalls)) ? Math.max(4, Math.floor(Number(agentCfg.maxToolCalls))) : undefined;
      const maxToolCalls = configMaxToolCalls ?? input.defaultAgent?.permissions?.maxToolCalls;
      const task = await taskEngine.create({
        goal: String(input.content).slice(0, 2_000),
        kind: 'mission',
        priority: input.background ? 'low' : 'normal',
        assignedAgent: input.defaultAgent?.id,
        sessionId: input.sessionId,
        context: {
          sessionId: input.sessionId,
          channel: input.channel,
          userGoal: String(input.content).slice(0, 2_000),
          projectId: input.projectId,
          workspacePath: input.workspacePath,
          input: String(input.content)
        },
        constraints: { maxTurns, maxToolCalls, workspacePath: input.workspacePath },
        metadata: { source: 'agent-runner', background: input.background }
      });
      await taskEngine.analyze(task.id);
      await taskEngine.plan(task.id);
      await taskEngine.start(task.id);
      return task.id;
    } catch (error: any) {
      console.warn('[TaskEngine] begin mission task failed (continuing without task):', error?.message || error);
      return null;
    }
  }

  async processMessage(sessionId: string, msg: Message) {
    // Phase 5 ASK path: a user (or another client) answered a pending approval.
    // Resolve it and unblock the waiting tool call without entering the loop.
    if (typeof msg.metadata?.approvalId === 'string') {
      const approved = msg.metadata?.allowed === true;
      const resolved = await this.approvalCoordinator.resolveApproval(
        msg.metadata.approvalId,
        approved,
        { userId: typeof msg.metadata?.userId === 'string' ? msg.metadata.userId : msg.senderId }
      );
      console.log(`[AgentRunner] ${resolved ? `Approval ${msg.metadata.approvalId} resolved: ${approved ? 'allowed' : 'denied'}` : `Approval ${msg.metadata.approvalId} not found (already resolved)`}`);
      return;
    }
    // Repository warmth: the Web UI asked for an on-demand index refresh.
    if (msg.metadata?.repoRefresh === true) {
      const workspace = this.getValidWorkspacePath(msg.metadata?.projectWorkspacePath);
      if (!workspace) {
        void this.gateway.sendResponse(sessionId, 'No attached workspace to refresh.');
        return;
      }
      const refreshed = this.contextEngine.refreshRepository(workspace, {
        force: true,
        sessionId,
        taskId: typeof msg.metadata?.taskId === 'string' ? msg.metadata.taskId : undefined
      });
      const warmth = this.contextEngine.indexWarmth(workspace);
      void this.gateway.sendStreamEvent(sessionId, {
        type: 'repository_refreshed',
        runId: 'repo-index',
        messageId: 'repo-index',
        root: workspace,
        fileCount: Number(warmth?.fileCount || 0),
        filesReParsed: Number(warmth?.filesReParsed || 0),
        symbolsRefreshed: Number(warmth?.symbolsRefreshed || 0),
        timestamp: Date.now()
      });
      void this.gateway.sendResponse(sessionId, refreshed
        ? `Repository index refreshed: ${warmth?.fileCount || 0} files, ${warmth?.symbolsRefreshed || 0} symbols re-parsed.`
        : 'Repository index is already up to date.');
      return;
    }
    console.log(`[AgentRunner] Processing message for session ${sessionId}`);
    const isBackgroundMessage = msg.channel === 'background' || Boolean(msg.metadata?.backgroundGoalId);

    // Track user activity for background worker idle detection
    if (!isBackgroundMessage) {
      backgroundWorker.recordActivity(sessionId);
      this.learning.recordActivity(sessionId);
    }

    // Flush any queued DND notifications when user becomes active
    const pendingNotifications = isBackgroundMessage ? [] : dndManager.flushQueue(sessionId);
    if (pendingNotifications.length > 0) {
      const summary = pendingNotifications.map(n => `• ${n.message}`).join('\n');
      await this.gateway.sendResponse(sessionId, `📬 **${pendingNotifications.length} notifications while you were away:**\n\n${summary}`);
    }

    if (this.handleMainGoalCommand(sessionId, msg.content)) {
      return;
    }

    if (this.handleScheduleCommand(sessionId, msg.content)) {
      return;
    }

    // Handle background goal commands
    if (this.handleBackgroundGoalCommand(sessionId, msg.content)) {
      return;
    }

    // Handle custom agent commands
    if (await this.handleCustomAgentCommand(sessionId, msg)) {
      return;
    }

    // Handle model commands
    if (this.handleModelCommand(sessionId, msg.content)) {
      return;
    }

    // Handle human-approved learning actions
    if (await this.handleLearningCommand(sessionId, msg.content)) {
      return;
    }

    if (await this.handleDeepResearchCommand(sessionId, msg)) {
      return;
    }

    // 0. Guardrails — Input Validation
    const inputCheck = guardrailManager.validateInput(msg.content);
    if (!inputCheck.allowed) {
      await this.gateway.sendResponse(sessionId, `⚠️ **Input blocked**: ${inputCheck.reason}`);
      return;
    }

    if (await this.tryHandleCasualConversation(sessionId, msg, isBackgroundMessage)) {
      return;
    }

    if (!isBackgroundMessage) {
      mainGoalManager.observeUserMessage(sessionId, msg);
    }

    const missionMarker = uuidv4();

// 1. Add User Message to Memory
    this.memory.add(sessionId, {
      role: 'user',
      content: msg.content,
      timestamp: Date.now(),
      metadata: { ...(msg.metadata || {}), __missionMarker: missionMarker }
    });

    // Track message for analytics
    if (!isBackgroundMessage) {
      analyticsTracker.recordMessage(sessionId);
    }

    // Initialize mission execution state (anti-repetition)
    if (!isBackgroundMessage) {
      executionStateManager.beginMission(sessionId, msg.content);
    }

    // Multi-turn Loop for Tool Execution
    const config = this.loadConfig();

    // Canonical Task (Phase 2): every mission belongs to a Task. The engine
    // owns the lifecycle + records while AgentRunner keeps executing.
    // Phase 16 Move 3b: resolve the designated default AgentProfile once per
    // mission so host-driven missions share the Agent contract surface with
    // AgentEngine children — assignedAgent on the Task, modelPolicy pin,
    // persona + instructions in the prompt. No designated default -> the
    // mission is byte-identical to before (zero behavior change).
    const defaultAgent = agentEngine.resolveDefaultAgent();
    const missionTaskId = await this.beginMissionTask({
      sessionId,
      channel: msg.channel,
      content: msg.content,
      projectId: typeof msg.metadata?.projectId === 'string' ? msg.metadata.projectId.trim() : undefined,
      workspacePath: this.getValidWorkspacePath(msg.metadata?.projectWorkspacePath),
      config,
      background: isBackgroundMessage,
      defaultAgent
    });
    // Phase 12 Move 4c: never fall back to a runner-owned mission loop. If a
    // canonical Task cannot be created, surface the infrastructure failure
    // instead of executing an untracked mission independently.
    if (!missionTaskId) {
      const failureText = 'I could not start the canonical task for this request, so no autonomous work was run.';
      this.memory.add(sessionId, {
        role: 'assistant', content: failureText, timestamp: Date.now(),
        metadata: { final: true, completed: false, taskInitializationFailed: true }
      });
      await this.deliverFinalResponse(sessionId, failureText, uuidv4(), uuidv4(), false);
      return;
    }

    // 2. Fetch Tools (MCP + Native Skills), capped and deduplicated so the
    //    advertised list stays bounded and name conflicts resolve predictably
    //    (native skills win over MCP tools with the same name).
    let mcpTools: any[] = [];
    try {
      mcpTools = await this.mcpManager.listTools();
    } catch (e) {
      console.error('[AgentRunner] Failed to list MCP tools:', e);
    }
    const allTools = this.buildAdvertisedTools(sessionId, mcpTools, config);

    // Phase 16 Move 4 (D4): the designated default agent's ToolPolicy shapes
    // the mission's advertised tool surface — deniedTools are always removed;
    // an explicit allowedTools list (or the agent's declared tools) intersects
    // the surface. No declared restriction -> surface unchanged (default), so
    // production behavior is untouched without a designated default.
    let missionToolSurface = allTools;
    if (defaultAgent) {
      const perms = defaultAgent.permissions || {};
      const deniedTools = new Set((perms.deniedTools || []).map((t: string) => t.toLowerCase()));
      const allowedTools = new Set((perms.allowedTools || []).map((t: string) => t.toLowerCase()));
      const advertisedTools = new Set((defaultAgent.tools || []).map((t: string) => t.toLowerCase()));
      const restrictSurface = allowedTools.size > 0 || advertisedTools.size > 0;
      missionToolSurface = allTools.filter((tool: any) => {
        const name = String(tool?.name || '').toLowerCase();
        if (deniedTools.has(name)) return false;
        if (!restrictSurface) return true;
        return allowedTools.size > 0 ? allowedTools.has(name) : advertisedTools.has(name);
      });
    }

    // Check for legacy skill triggers
    let context = "";
    if (msg.content.includes('/sys')) {
      const skill = SkillRegistry.get('system_info');
      if (skill) {
        const result = await skill.execute({});
        context += `\n[System Info]: ${JSON.stringify(result)}`;
      }
    }

    const agentConfig = config?.agent ?? {};
    const unlimitedTools = Boolean(agentConfig.unlimitedTools);
    const configuredMaxTurns =
      typeof config?.agent?.maxTurns === "number"
        ? config.agent.maxTurns
        : (typeof config?.maxTurns === "number" ? config.maxTurns : undefined);
    const hasTurnLimit = Number.isFinite(configuredMaxTurns) && Number(configuredMaxTurns) > 0;
    const maxTurns = unlimitedTools
      ? Number.MAX_SAFE_INTEGER
      : (hasTurnLimit
        ? Math.max(1, Math.floor(Number(configuredMaxTurns)))
        : 24);

    const autoContinueCfg = agentConfig.autoContinue;
    const autoContinueEnabled = autoContinueCfg !== false
      && !(typeof autoContinueCfg === "object" && autoContinueCfg.enabled === false);
    const autoContinueMax = typeof autoContinueCfg === "number"
      ? Math.max(0, Math.floor(autoContinueCfg))
      : (typeof autoContinueCfg?.maxBatches === "number"
        ? Math.max(0, Math.floor(autoContinueCfg.maxBatches))
        : 2);
    const autoContinueNotify = typeof autoContinueCfg?.notify === "boolean"
      ? autoContinueCfg.notify
      : false;
    const repetitionGuardCfg = typeof agentConfig.repetitionGuard === 'object'
      ? agentConfig.repetitionGuard
      : {};
    const maxRepeatedToolBatchesRaw =
      typeof repetitionGuardCfg.maxRepeatedToolBatches === 'number'
        ? repetitionGuardCfg.maxRepeatedToolBatches
        : (typeof agentConfig.maxRepeatedToolBatches === 'number' ? agentConfig.maxRepeatedToolBatches : undefined);
    const maxRepeatedToolBatches = Number.isFinite(maxRepeatedToolBatchesRaw)
      ? Math.max(2, Math.floor(Number(maxRepeatedToolBatchesRaw)))
      : 3;
    const maxExplorationBatchesRaw =
      typeof repetitionGuardCfg.maxExplorationBatches === 'number'
        ? repetitionGuardCfg.maxExplorationBatches
        : (typeof agentConfig.maxExplorationBatches === 'number' ? agentConfig.maxExplorationBatches : undefined);
    const maxExplorationBatches = Number.isFinite(maxExplorationBatchesRaw)
      ? Math.max(2, Math.floor(Number(maxExplorationBatchesRaw)))
      : 6;
    const toolBatchCounts = new Map<string, number>();
    const missionDisabledTools = new Set<string>();
    const singleUseTools = new Set(['notes']);
    const toolUsageCounts = new Map<string, number>();
    const maxToolCalls = unlimitedTools
      ? Number.MAX_SAFE_INTEGER
      : (typeof agentConfig.maxToolCalls === 'number'
        ? Math.max(4, Math.floor(agentConfig.maxToolCalls))
        : 12);
    let forceFinalAnswer = false;
    let suppressedToolRequests = 0;
    const toolRequired = this.requiresToolExecution(msg.content);
    const verificationRequired = /\b(fix|debug|implement|build|code|edit|modify|refactor|test|verify)\b/i.test(msg.content);
    const maxForcedContinuations = unlimitedTools
      ? Number.MAX_SAFE_INTEGER
      : (typeof agentConfig.maxPrematureCompletions === 'number'
        ? Math.max(1, Math.floor(agentConfig.maxPrematureCompletions))
        : 3);
    let totalToolCalls = 0;
    let lastBatchHadFailure = false;
    let lastToolError = '';
    let repeatedFailureRecoveries = 0;
    let explorationBatches = 0;
    // Phase 12 Move 3 — verification-pending state is engine-owned
    let missionVerificationPending = false;

    const initialMemories = this.memory.getAll(sessionId);
    await this.autoCompactSessionIfNeeded(sessionId, config, initialMemories);

    let continuationBatch = 0;
    const missionTurnBudget = unlimitedTools
      ? Number.MAX_SAFE_INTEGER
      : Math.min(Number.MAX_SAFE_INTEGER, maxTurns * (1 + (autoContinueEnabled ? autoContinueMax : 0)));
    let iterationPresentation: {
      text: string;
      runId: string;
      messageId: string;
      reasoning?: string;
      metadata?: Record<string, unknown>;
      completionCandidate?: boolean;
      markBlockedAlready?: boolean;
      sanitize?: boolean;
      recordLearning?: boolean;
    } | undefined;
    try {
      const missionResult = await taskEngine.runMission(missionTaskId, {
        budget: { maxTurns: missionTurnBudget, maxForcedContinuations },
        completionVerdict: this.completionVerdictHook,
        diagnoser: this.buildMissionDiagnoser(msg.content, msg.metadata?.projectWorkspacePath),
        // Phase 17 Move 2 — the terminal verification gate: a completion point
        // that answers 'verify' runs the goal-matched tests; pass -> complete,
        // fail -> repair until the turn budget exhausts -> FAILED.
        verifier: this.buildMissionVerifier(msg.content, msg.metadata?.projectWorkspacePath),
        iterate: async ({ turn }): Promise<TaskMissionIteration> => {
        const i = turn - 1;
        iterationPresentation = undefined;
        // Smart Context Construction
        const allMemories = this.applyCompactionFilter(this.memory.getAll(sessionId));
        const totalMemories = allMemories.length;
        const missionStartIndex = allMemories.findIndex(memory => memory.metadata?.__missionMarker === missionMarker);
        const safeMissionStart = missionStartIndex >= 0 ? missionStartIndex : Math.max(0, totalMemories - 1);
        const priorMemories = allMemories.slice(0, safeMissionStart);
        const fullMissionMemories = allMemories.slice(safeMissionStart);
        const missionMemories: Memory[] = fullMissionMemories.length > 24
          ? [
              fullMissionMemories[0],
              {
                role: 'system',
                content: `... (${fullMissionMemories.length - 24} earlier mission events summarized by durable execution state) ...`,
                timestamp: Date.now()
              },
              ...fullMissionMemories.slice(-23)
            ]
          : fullMissionMemories;
        const recentPrior = priorMemories.slice(-6);
        const relevantPrior = this.selectRelevantMemories(priorMemories.slice(-250), msg.content, 4);
        const contextMemories = [...new Set([...relevantPrior, ...recentPrior, ...missionMemories])];

        // Re-fetch logic for loop i > 0 is handled implicitly because we fetch from memory each time
        // But we must respect the 'current state' if we just added things in previous iterations of THIS loop
        // The `this.memory.get` fetches the latest state including what we just added.
        // However, for the *very first* message (Goal), we want to make sure it's labeled clearly if we are skipping.

        // Phase 7 ContextEngine: the engine owns the history renderer (same
        // labels + truncation as before) so budgets/relevance can be added
        // later without changing prompt output. The history + mission prompt
        // assembly itself is engine-owned too (Phase 12 D1): the sources are
        // handed to buildMissionPrompt below.

        // Dynamic Identity Injection
        const agentName = config.name || "Gitu";
        let baseSystemPrompt = this.baseSystemPrompt.replace("{{AGENT_NAME}}", agentName);
        // Phase 16 Move 3b: a designated default AgentProfile renders its
        // persona + instructions into the mission system prompt — the same
        // contract AgentEngine children use (persona first, instructions
        // last so they win conflicts). Inert without a designated default.
        if (defaultAgent) {
          const agentBlock = [
            defaultAgent.persona || `You are ${defaultAgent.name}, a ${defaultAgent.role}.`,
            ...(defaultAgent.instructions ? [defaultAgent.instructions] : [])
          ].filter(Boolean).join('\n\n');
          if (agentBlock) baseSystemPrompt = `${baseSystemPrompt}\n\n${agentBlock}`;
        }
        const workspacePrompt = this.buildWorkspacePrompt(msg.channel, sessionId, msg.content, defaultAgent?.memoryPolicy);
        const timePrompt = this.buildTimePrompt();

        // User Context Injection
        const lastUserMsg = [...allMemories].reverse().find(m => m.role === "user");
        const username = lastUserMsg?.metadata?.username || msg.metadata?.username || "User";
        const userLine = `You are speaking with ${username}.`;
        const projectPrompt = this.buildProjectPrompt(msg.metadata);

        // Phase 7 opt-in: surface the files most relevant to the goal from the
        // attached workspace (indexed on demand). Off by default.
        let repositorySection = '';
        const contextCfg = this.loadConfig()?.agent?.context || {};
        if (contextCfg.repository?.enabled === true) {
          const repoWorkspace = this.getValidWorkspacePath(msg.metadata?.projectWorkspacePath);
          if (repoWorkspace) {
            try {
              // Phase 9: warm the index on demand so per-goal hints and the
              // symbol skill never read a stale index during the mission.
              // Telemetry attributes the refresh to this session + task.
              this.contextEngine.refreshRepository(repoWorkspace, {
                sessionId,
                taskId: missionTaskId || undefined
              });
              // Event-driven warming: refresh as soon as a mutating tool
              // completes instead of waiting for the next turn.
              if (!this.repoWarmers.has(sessionId)) {
                try {
                  this.repoWarmers.set(sessionId, warmOnToolEvents(
                    taskEventBus,
                    repoWorkspace,
                    this.contextEngine,
                    { sessionId, taskId: missionTaskId || undefined }
                  ));
                } catch (warmError: any) {
                  console.warn('[ContextEngine] event-warming not attached:', warmError?.message || warmError);
                }
              }
              repositorySection = this.contextEngine.repositorySection(repoWorkspace, msg.content);
            } catch (contextError: any) {
              console.warn('[ContextEngine] repository section failed:', contextError?.message || contextError);
            }
          }
        }

        // Phase 12 D1: the mission prompt assembly is a ContextEngine call —
        // byte-identical default output (same drop-in discipline as
        // renderHistory) while the same sources flow through build() so the
        // budgeted, sectioned pipeline participates. The host still owns the
        // pre-rendered workspace/time/user/project blocks (they read host
        // state); the engine owns the assembly + history + repository text.
        const missionPrompt = await this.contextEngine.buildMissionPrompt({
          baseSystemPrompt,
          workspacePrompt,
          timePrompt,
          userLine,
          projectPrompt,
          repositorySection: repositorySection || undefined,
          notes: scratchpad.getSummary() || undefined,
          history: contextMemories.map((m) => ({
            role: m.role,
            content: m.content,
            missionMarker: m.metadata?.__missionMarker === missionMarker
          })),
          missionInstruction: i === 0 && continuationBatch === 0
            ? 'Begin the current mission from the user message above.'
            : 'Continue the current mission from the latest tool results above.',
          systemContext: context || undefined,
          goal: msg.content
        });
        let systemPrompt = missionPrompt.systemPrompt;
        const prompt = missionPrompt.prompt;

        // Apply thinking level enhancement
        const thinkingPrompt = thinkingManager.getThinkingPrompt(sessionId);
        const enhancedSystemPrompt = thinkingPrompt
          ? `${systemPrompt}\n\n[Thinking Mode: ${thinkingPrompt}]`
          : systemPrompt;
        const planPrompt = planModeManager.getPlanPrompt(sessionId);
        let finalSystemPrompt = planPrompt
          ? `${enhancedSystemPrompt}\n\n${planPrompt}`
          : enhancedSystemPrompt;

        finalSystemPrompt += [
          '',
          'Execution contract:',
          '- Work autonomously until the current mission is actually complete or a concrete external blocker makes progress impossible.',
          '- Never present a plan, promise, or future action as the final answer. Use the available tools now.',
          '- Do not ask the user to say "continue" for work you can complete in this run.',
          '- Do not repeat prior plans, explanations, or summaries. Continue from recorded tool results.',
          '- On a turn where you call tools, put a short user-facing progress update in response content: 1-3 natural first-person sentences explaining what you found or are doing next. Do not reveal hidden reasoning or chain-of-thought.',
          '- Respect tool dependencies: inspect before editing and verify after changing files or state.',
          `- Runtime platform: ${process.platform}. ${process.platform === 'win32' ? 'The shell uses PowerShell; use PowerShell commands and Windows paths.' : 'Use commands appropriate for this platform.'}`,
          '- Use multiple delegate_agent calls or its tasks batch for genuinely independent subtasks; they run concurrently.',
          '- Use execute_workflow when several dependent existing-tool calls can be expressed as one validated sequence with explicit inputs and outputs.',
          toolRequired
            ? '- This is an action task. You must use tools and gather verification evidence before giving the final answer.'
            : '- If the request only needs an answer, respond directly once you have enough evidence.'
        ].join('\n');

        // Inject anti-repetition continuation prompt for turns > 0
        if (i > 0 || continuationBatch > 0) {
          const continuationPrompt = executionStateManager.buildContinuationPrompt(
            sessionId,
            { continuation: true, finalTurn: false }
          );
          if (continuationPrompt) {
            finalSystemPrompt = `${finalSystemPrompt}\n\n${continuationPrompt}`;
          }
        }
        if (forceFinalAnswer) {
          finalSystemPrompt += '\n\nFINAL RESPONSE REQUIRED: Tool execution is closed for this task. Return the complete user-facing result now using evidence already in context. Do not emit a tool call, do not promise future work, and do not repeat a progress update.';
        }

        // Stream model output live to structured-streaming channels (web):
        // lazily open a message bubble on the first chunk, append everything
        // after. Tool-turn text is finalized as a completed bubble once the
        // tool batch is known, and final answers are finalized by
        // deliverFinalResponse (its assistant_start resets the bubble, so the
        // buffered final text can never duplicate the streamed text). Non-
        // streaming channels still receive the buffered response at the end.
        const attachments: ModelAttachment[] = Array.isArray(msg.metadata?.attachments)
          ? msg.metadata.attachments.slice(0, 4).filter((item: any) =>
              item?.type === 'image'
              && typeof item?.dataUrl === 'string'
              && /^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(item.dataUrl)
            )
          : [];
        const modelTools = forceFinalAnswer
          ? []
          : missionToolSurface.filter(tool => !missionDisabledTools.has(String(tool?.name || '')));

        // Phase 6 ModelEngine: score providers against the canonical Task
        // (capability, observed reliability/tool success, context fit, latency
        // and cost). Explicit ModelRouter rules remain hard user overrides.
        // Phase 16 Move 3b: the designated default agent's modelPolicy pin is
        // layered UNDER the router override (router wins; the agent pin is the
        // width for host-driven missions — complementary, per Audit 7 D3).
        const missionTask = missionTaskId ? taskEngine.get(missionTaskId) : undefined;
        const routerPin = modelRouter.explicitModelIdFor(msg.content);
        const agentPin = defaultAgent?.modelPolicy?.modelId;
        const selection = modelRouter.hasProviders()
          ? modelEngine.select({
              goal: msg.content,
              task: missionTask,
              contextText: `${prompt}\n${finalSystemPrompt}`,
              requiresTools: modelTools.length > 0,
              attachmentCount: attachments.length,
              desiredLevel: modelRouter.desiredLevelFor(msg.content) || undefined
            }, ModelRegistry.getAll(), { pinnedProviderId: routerPin || agentPin || undefined })
          : null;
        const currentModel = selection ? this.getModelById(selection.provider.id) : this.getModel();
        if (missionTaskId && selection && missionTask?.model !== selection.provider.id) {
          try {
            await taskEngine.assignModel(missionTaskId, selection.provider.id);
            await taskEngine.recordDecision(
              missionTaskId,
              `ModelEngine selected '${selection.provider.id}' (${selection.score.score}/100).`,
              JSON.stringify({ profile: selection.profile, score: selection.score, pinned: selection.pinned })
            );
          } catch { /* model selection telemetry must not interrupt a mission */ }
        }
        const turnRunId = uuidv4();
        const turnMessageId = uuidv4();
        let response;
        let turnReasoning: string | undefined;
        let fullStreamContent = '';
        let liveStreamed = false;
        const modelStartedAt = Date.now();
        try {
        if (currentModel.generateStream) {
          response = await withModelRetry(() => currentModel.generateStream!(prompt, finalSystemPrompt, modelTools, (chunk) => {
            if (!chunk) return;
            fullStreamContent += chunk;
            if (this.gateway.supportsStructuredStreaming?.(sessionId)) {
              if (!liveStreamed) {
                liveStreamed = true;
                void this.gateway.sendStreamEvent(sessionId, { type: 'assistant_start', runId: turnRunId, messageId: turnMessageId });
              }
              void this.gateway.sendStreamEvent(sessionId, { type: 'assistant_delta', runId: turnRunId, messageId: turnMessageId, text: chunk });
            }
          }, attachments), 'StreamGenerate');
          if (fullStreamContent.trim() && !response?.content) {
            response.content = fullStreamContent;
          }
        } else {
          response = await withModelRetry(
            () => currentModel.generate(prompt, finalSystemPrompt, modelTools, attachments),
            'Generate'
          );
        }
        const actualProviderId = typeof (currentModel as any).getLastUsedProviderId === 'function'
          ? (currentModel as any).getLastUsedProviderId() || selection?.provider.id || currentModel.id
          : selection?.provider.id || currentModel.id;
        modelEngine.recordModelOutcome(actualProviderId, { success: true, latencyMs: Date.now() - modelStartedAt });
        } catch (modelError) {
          modelEngine.recordModelOutcome(selection?.provider.id || currentModel.id, { success: false, latencyMs: Date.now() - modelStartedAt });
          throw modelError;
        }
        turnReasoning = (response as any)?.reasoning;

        // Track cost
        try {
          const modelName = (currentModel as any).modelName || (currentModel as any).model || 'unknown';
          const usage = response?.usage;
          if (usage && Number.isFinite(Number(usage.promptTokens))) {
            costTracker.record(
              modelName,
              sessionId,
              Number(usage.promptTokens) || 0,
              Number(usage.completionTokens) || 0,
              Number(usage.cacheReadTokens) || 0,
              Number(usage.cacheWriteTokens) || 0
            );
            if (missionTaskId) {
              try {
                await taskEngine.recordCost(missionTaskId, {
                  model: modelName,
                  tokensIn: Number(usage.promptTokens) || 0,
                  tokensOut: Number(usage.completionTokens) || 0
                });
              } catch { /* ignore task cost tracking errors */ }
            }
          } else {
            costTracker.recordFromText(modelName, sessionId, prompt, response.content || '');
          }
        } catch { /* ignore cost tracking errors */ }

        // Handle Tool Calls
        if (response.toolCalls && response.toolCalls.length > 0) {
          if (liveStreamed && fullStreamContent.trim()) {
            void this.gateway.sendStreamEvent(sessionId, {
              type: 'assistant_done',
              runId: turnRunId,
              messageId: turnMessageId,
              finalText: fullStreamContent.trim(),
              ok: true,
              progress: true
            });
          }
          for (const call of response.toolCalls) this.normalizeToolCall(call);
          const disabledRequests = response.toolCalls.filter(call => missionDisabledTools.has(String(call?.name || '')));
          if (forceFinalAnswer || disabledRequests.length > 0) {
            forceFinalAnswer = true;
            suppressedToolRequests += 1;
            if (suppressedToolRequests >= 2) {
              const candidate = String(response.content || '').trim();
              const finalText = candidate && !this.looksLikeProgressOnly(candidate)
                ? candidate
                : 'I stopped additional tool calls because the task reached its safety budget. The completed tool results have been preserved, but the model did not provide a reliable final summary.';
              iterationPresentation = {
                text: finalText,
                runId: turnRunId,
                messageId: turnMessageId,
                metadata: { final: true, completed: Boolean(candidate), toolBudgetStopped: true }
              };
              return {
                content: finalText,
                verdict: candidate
                  ? { type: 'complete', summary: finalText }
                  : { type: 'fail', error: 'Tool budget reached before a reliable final answer.' },
                totalToolCalls,
                lastBatchHadFailure,
                toolRequired,
                verificationRequired
              };
            }
            this.memory.add(sessionId, {
              role: 'system',
              content: 'A tool call was suppressed because that tool has already completed its allowed work for this task. Produce the complete final answer now using the collected evidence. Do not call another tool and do not describe future work.',
              timestamp: Date.now(),
              metadata: { type: 'mission_tool_budget' }
            });
            return {
              content: String(response.content || ''),
              verdict: { type: 'continue', reason: 'Tool call suppressed by the mission safety budget.' },
              totalToolCalls,
              lastBatchHadFailure,
              toolRequired,
              verificationRequired
            };
          }
          if (!unlimitedTools) {
            const defaultToolCaps: Record<string, number> = {
              notes: 1,
              shell: 8,
              web_fetch: 8,
              web_search: 3,
              code_search: 8,
              git: 8,
              code_review: 3,
              apply_patch: 6,
              playwright: 6,
              delegate_agent: 6
            };
            const capConfig = typeof repetitionGuardCfg.toolCaps === 'object' ? repetitionGuardCfg.toolCaps : {};
            let exceededTool = '';
            for (const call of response.toolCalls) {
              const name = String(call?.name || 'tool');
              const nextCount = (toolUsageCounts.get(name) || 0) + 1;
              const cap = Number.isFinite(Number(capConfig[name]))
                ? Math.max(1, Math.floor(Number(capConfig[name])))
                : (defaultToolCaps[name] || 6);
              if (nextCount > cap) exceededTool = name;
            }
            if (exceededTool) {
              missionDisabledTools.add(exceededTool);
              forceFinalAnswer = true;
              this.memory.add(sessionId, {
                role: 'system',
                content: `Tool '${exceededTool}' reached its per-task call limit. It is now disabled. Produce the complete final answer using the results already collected; do not perform more inspection or describe future work.`,
                timestamp: Date.now(),
                metadata: { type: 'mission_tool_budget' }
              });
              return {
                content: String(response.content || ''),
                verdict: { type: 'continue', reason: `Tool '${exceededTool}' reached its per-task limit.` },
                totalToolCalls,
                lastBatchHadFailure,
                toolRequired,
                verificationRequired
              };
            }
          }
          for (const call of response.toolCalls) {
            const name = String(call?.name || 'tool');
            toolUsageCounts.set(name, (toolUsageCounts.get(name) || 0) + 1);
          }
          const toolBatchSignature = this.buildToolBatchSignature(response.toolCalls);
          const repeatedBatchCount = (toolBatchCounts.get(toolBatchSignature) || 0) + 1;
          toolBatchCounts.set(toolBatchSignature, repeatedBatchCount);
          if (repeatedBatchCount >= maxRepeatedToolBatches) {
            const toolNames = response.toolCalls.map(c => c.name).join(', ');
            const reason = `Repeated the same tool batch ${repeatedBatchCount} times: ${toolNames}.`;
            if (lastBatchHadFailure && repeatedFailureRecoveries < 1) {
              repeatedFailureRecoveries += 1;
              this.memory.add(sessionId, {
                role: 'system',
                content: [
                  `Runtime recovery: ${reason}`,
                  lastToolError ? `Last error: ${lastToolError}` : '',
                  `Do not call the same failed command again. Use a different approach appropriate for ${process.platform}.`,
                  'Continue autonomously and verify the alternative.'
                ].filter(Boolean).join('\n'),
                timestamp: Date.now(),
                metadata: { type: 'repetition_recovery' }
              });
              return {
                content: String(response.content || ''),
                verdict: { type: 'continue', reason },
                totalToolCalls,
                lastBatchHadFailure,
                toolRequired,
                verificationRequired
              };
            }
            if (!lastBatchHadFailure) {
              forceFinalAnswer = true;
              for (const call of response.toolCalls) missionDisabledTools.add(String(call.name || ''));
              this.memory.add(sessionId, {
                role: 'system',
                content: `The same successful tool action was requested ${repeatedBatchCount} times. It has been suppressed. Use the evidence already collected and produce the complete final answer now with no more tool calls.`,
                timestamp: Date.now(),
                metadata: { type: 'repetition_recovery' }
              });
              return {
                content: String(response.content || ''),
                verdict: { type: 'continue', reason },
                totalToolCalls,
                lastBatchHadFailure,
                toolRequired,
                verificationRequired
              };
            }
            executionStateManager.markBlocked(sessionId, reason);
            const blockedText = [
              `I stopped the task because the same failed tool action was repeated ${repeatedBatchCount} times.`,
              lastToolError ? `Last error: ${lastToolError}` : '',
              'The loop was stopped instead of showing or executing the same action again.'
            ].filter(Boolean).join('\n\n');
            iterationPresentation = {
              text: blockedText,
              runId: turnRunId,
              messageId: turnMessageId,
              metadata: { final: true, completed: false, blocked: true },
              markBlockedAlready: true
            };
            return {
              content: blockedText,
              verdict: { type: 'blocked', error: reason, reason },
              totalToolCalls,
              lastBatchHadFailure,
              toolRequired,
              verificationRequired
            };
          }

          const batchMutates = response.toolCalls.some(call => MUTATING_TOOL_NAMES.has(String(call?.name || '')));
          if (batchMutates) {
            explorationBatches = 0;
          } else {
            explorationBatches += 1;
            if (explorationBatches >= maxExplorationBatches) {
              const explorationReason = `Ran ${explorationBatches} consecutive read-only tool batches (${response.toolCalls.map(c => c.name).join(', ')}) without making any changes.`;
              if (lastBatchHadFailure && repeatedFailureRecoveries < 1) {
                repeatedFailureRecoveries += 1;
                this.memory.add(sessionId, {
                  role: 'system',
                  content: [
                    `Runtime recovery: ${explorationReason}`,
                    lastToolError ? `Last error: ${lastToolError}` : '',
                    `Do not repeat the same inspection again. Use a different approach appropriate for ${process.platform}.`,
                    'Continue autonomously and verify the alternative.'
                  ].filter(Boolean).join('\n'),
                  timestamp: Date.now(),
                  metadata: { type: 'repetition_recovery' }
                });
                return {
                  content: String(response.content || ''),
                  verdict: { type: 'continue', reason: explorationReason },
                  totalToolCalls,
                  lastBatchHadFailure,
                  toolRequired,
                  verificationRequired
                };
              }
              forceFinalAnswer = true;
              for (const call of response.toolCalls) missionDisabledTools.add(String(call.name || ''));
              this.memory.add(sessionId, {
                role: 'system',
                content: `${explorationReason} It has been suppressed. Use the evidence already collected and produce the complete final answer now with no more tool calls.`,
                timestamp: Date.now(),
                metadata: { type: 'repetition_recovery' }
              });
              return {
                content: String(response.content || ''),
                verdict: { type: 'continue', reason: explorationReason },
                totalToolCalls,
                lastBatchHadFailure,
                toolRequired,
                verificationRequired
              };
            }
          }

          const batchMessageId = `${turnMessageId}:tool:${continuationBatch}:${i}`;
          const progressUpdate = this.buildConversationalProgressUpdate(
            response.content || '',
            response.toolCalls,
            lastBatchHadFailure,
            missionVerificationPending
          );
          await this.gateway.sendStreamEvent(sessionId, {
            type: 'assistant_update',
            runId: turnRunId,
            messageId: `${missionMarker}:progress`,
            text: progressUpdate
          });

          const parallelDelegation = response.toolCalls.length > 1
            && response.toolCalls.every(call => call.name === 'delegate_agent');
          console.log(`[AgentRunner] Executing ${response.toolCalls.length} tools ${parallelDelegation ? 'in parallel' : 'in dependency order'}...`);
          await this.gateway.sendResponse(sessionId, `${DEBUG_PREFIX} 🛠️ Executing ${response.toolCalls.length} tools...`);
          // Emit structured tool_start event
          void this.gateway.sendStreamEvent(sessionId, {
            type: 'tool_start', runId: turnRunId, messageId: batchMessageId,
            name: response.toolCalls.map(c => c.name).join(', ')
          });

          // Track tool execution state
          executionStateManager.markToolExecutionStarted(
            sessionId,
            `Executing ${response.toolCalls.length} tools: ${response.toolCalls.map(c => c.name).join(', ')}`
          );

          // Tool outcomes are recorded per-call inside executeToolCall (via the
          // ToolEngine -> TaskEngine) so usage counts are exact: calls = ok + err.

          // Phase 12 D3: the tool lifecycle is bus-only. ToolEngine records
          // through TaskEngine, whose ToolStarted/ToolCompleted/ToolFailed
          // events reach hookManager (canonical names + legacy aliases) via
          // the task-hooks bridge. Nothing is emitted here.
          const executeToolCall = async (call: any) => {
            try {
              const projectWorkspacePath = this.getValidWorkspacePath(msg.metadata?.projectWorkspacePath);
              const projectId = typeof msg.metadata?.projectId === 'string'
                ? msg.metadata.projectId.trim()
                : '';
              // Canonical ToolEngine (Phase 4): normalize -> validate -> authorize
              // -> execute (native skill / MCP / dynamic) -> record on the mission
              // Task (STARTED/COMPLETED/FAILED + checkpoints + telemetry). Never
              // throws for tool failures — it returns a normalized ToolResult.
              const result = await this.toolEngine.execute(
                { name: call.name, arguments: call.arguments || {} },
                {
                  sessionId,
                  taskId: missionTaskId || undefined,
                  projectId: projectId || undefined,
                  workspacePath: projectWorkspacePath,
                  config: this.loadConfig(),
                  stream: (chunk: string) => {
                    if (chunk) void this.gateway.sendStreamChunk(sessionId, chunk);
                  }
                }
              );
              const modelForToolOutcome = typeof (currentModel as any).getLastUsedProviderId === 'function'
                ? (currentModel as any).getLastUsedProviderId() || selection?.provider.id || currentModel.id
                : selection?.provider.id || currentModel.id;
              modelEngine.recordToolOutcome(modelForToolOutcome, result.success);
              // Host-level session memory for semantic fallback / dynamic resolution.
              if (result.fallback && result.fallback.resolved !== result.fallback.requested) {
                this.memory.add(sessionId, {
                  role: 'system',
                  content: `Skill '${result.fallback.resolved}' dynamically replaced a failed call to '${result.fallback.requested}' and succeeded. Prefer '${result.fallback.resolved}' for similar requests in this session.`,
                  timestamp: Date.now(),
                  metadata: { type: 'skill_fallback' }
                });
              }
              if (result.dynamic && result.dynamic.resolved !== result.dynamic.requested) {
                this.memory.add(sessionId, {
                  role: 'system',
                  content: `Tool '${result.dynamic.requested}' was dynamically resolved to '${result.dynamic.resolved}' and succeeded. Prefer '${result.dynamic.resolved}' for similar requests in this session.`,
                  timestamp: Date.now(),
                  metadata: { type: 'skill_fallback' }
                });
              }
              if (!result.success) {
                await this.injectGoalRetryHint(sessionId, msg.content, msg.metadata?.projectWorkspacePath, missionTaskId || undefined);
                return {
                  success: false,
                  call: call,
                  error: result.error
                };
              }
              return {
                success: true,
                call: call,
                output: result.output
              };
            } catch (err: any) {
              await this.injectGoalRetryHint(sessionId, msg.content, msg.metadata?.projectWorkspacePath, missionTaskId || undefined);
              return {
                success: false,
                call: call,
                error: err.message
              };
            }
          };

          // Independent child agents are safe and useful to run concurrently.
          // Other tools stay in model-declared order so edits finish before
          // builds/tests and dependent commands cannot race each other.
          const results: any[] = parallelDelegation
            ? await Promise.all(response.toolCalls.map(executeToolCall))
            : [];
          if (!parallelDelegation) {
            for (const call of response.toolCalls) {
              results.push(await executeToolCall(call));
            }
          }

          for (const result of results) {
            const toolName = result.call?.name || 'unknown';
            if (result.success) {
              console.log(`[Tool] ${toolName} ok`);
            } else {
              console.log(`[Tool] ${toolName} FAILED: ${String(result.error || 'Unknown error')}`);
            }
          }

          totalToolCalls += response.toolCalls.length;
          lastBatchHadFailure = results.some(result => !result.success);
          lastToolError = results
            .filter(result => !result.success)
            .map(result => `${result.call?.name || 'tool'}: ${String(result.error || 'Unknown error')}`)
            .join(' | ');
          for (const result of results) {
            // Phase 12 Move 3 — annotate the recorded execution with the tool's
            // role so the engine owns mutation/verification state. The
            // per-turn sequence counters survive only as a task-less fallback.
            const kind: TaskToolKind = result.success && this.isMutationToolCall(result.call)
              ? 'mutation'
              : result.success && this.isVerificationToolCall(result.call)
                ? 'verification'
                : 'inspection';
            if (kind !== 'inspection' && result.executionId) {
              try {
                await taskEngine.recordToolKind(missionTaskId, result.executionId, kind);
              } catch { /* tool annotation is advisory; engine state stays authoritative */ }
            }
          }
          // Phase 12 Move 3 — the engine-owned pending state.
          missionVerificationPending = taskEngine.verificationPending(missionTaskId);
          try {
            const batchPct = Math.min(90, 10 + Math.round((totalToolCalls / Math.max(1, maxToolCalls)) * 80));
            await taskEngine.recordProgress(missionTaskId, batchPct, `Tool batch complete (${results.length} tool${results.length === 1 ? '' : 's'})`);
          } catch { /* ignore task progress errors */ }

          for (const result of results) {
            const isSingleUseWrite = singleUseTools.has(String(result.call?.name || ''))
              && String(result.call?.arguments?.action || '').toLowerCase() !== 'read_notes';
            if (result.success && isSingleUseWrite) {
              missionDisabledTools.add(String(result.call.name));
              this.memory.add(sessionId, {
                role: 'system',
                content: `Tool '${result.call.name}' has completed its one allowed write for this task. Do not call it again; continue with the task and produce the final result.`,
                timestamp: Date.now(),
                metadata: { type: 'mission_tool_budget' }
              });
            }
          }
          if (totalToolCalls >= maxToolCalls && !forceFinalAnswer) {
            forceFinalAnswer = true;
            this.memory.add(sessionId, {
              role: 'system',
              content: `The task tool budget (${maxToolCalls}) has been reached. No more tools are available. Produce the best complete final answer now from the evidence already collected. Do not describe future work.`,
              timestamp: Date.now(),
              metadata: { type: 'mission_tool_budget' }
            });
          }

          // Process results
          for (const result of results) {
            if (result.success) {
              // Clean up tool output for memory while preserving full report content.
              let outputForMemory = String(result.output);
              try {
                const parsed = JSON.parse(outputForMemory);
                if (parsed && typeof parsed === 'object') {
                  delete parsed._synthesisInstructions;
                  outputForMemory = JSON.stringify(parsed);
                }
              } catch { /* not JSON, keep as is */ }

              this.memory.add(sessionId, {
                role: "system",
                content: `Tool '${result.call.name}' Output: ${outputForMemory}`,
                timestamp: Date.now()
              });
            } else {
              const errorMsg = String(result.error || 'Unknown error');
              this.memory.add(sessionId, {
                role: "system",
                content: `Tool '${result.call.name}' Error: ${errorMsg}`,
                timestamp: Date.now()
              });
            }
          }

          // Record tool execution events for anti-repetition state
          executionStateManager.recordEvents(
            sessionId,
            results.map(r => ({
              kind: 'tool' as const,
              label: r.call.name,
              summary: r.success
                ? `${r.call.name} completed`
                : `${r.call.name} failed: ${String(r.error || 'unknown')}`,
              status: r.success ? 'completed' as const : 'failed' as const
            })),
            results.some(r => !r.success) ? undefined : undefined
          );

          // Emit structured tool_done events for each tool result
          for (const result of results) {
            void this.gateway.sendStreamEvent(sessionId, {
              type: 'tool_done',
              runId: turnRunId,
              messageId: batchMessageId,
              toolCallId: result.call.name,
              name: result.call.name,
              output: result.success ? String(result.output).slice(0, 3000) : undefined,
              status: result.success ? 'completed' : 'failed',
              error: result.success ? undefined : String(result.error || '')
            });
          }

          const normalizeOutput = (value: any) => {
            if (value === null || value === undefined) return "";
            return String(value).replace(/\r\n/g, "\n").trimEnd();
          };

          const parseJson = (value: string) => {
            try {
              return JSON.parse(value);
            } catch {
              return null;
            }
          };

          const ensureClosedCodeFences = (value: string) => {
            const matches = value.match(/```/g);
            if (matches && matches.length % 2 === 1) {
              return value + "\n```";
            }
            return value;
          };

          const formatAgentResults = (agentLabel: string, results: any[]) => {
            if (!Array.isArray(results) || results.length === 0) return "";
            const label = agentLabel ? ` (${agentLabel})` : "";
            const blocks = results.map((r: any) => {
              const status = r?.success === false ? "failed" : "success";
              const taskId = r?.taskId ? `Task ${r.taskId}` : "Task";
              const output = normalizeOutput(r?.output);
              if (output) {
                return `${taskId} (${status}):\n${output}`;
              }
              return `${taskId} (${status}): _No output_`;
            });
            return [`🧠 Agent results${label}:`, ...blocks].join("\n\n");
          };

          const formatAgentReports = (agentLabel: string, reports: any[]) => {
            if (!Array.isArray(reports) || reports.length === 0) return "";
            const label = agentLabel ? ` (${agentLabel})` : "";
            const blocks = reports.map((report: any) => {
              const status = normalizeOutput(report?.status || "unknown");
              const taskId = normalizeOutput(report?.taskId || "task");
              const summary = normalizeOutput(report?.summary);
              const finalOutput = normalizeOutput(report?.finalOutput);
              const risks = Array.isArray(report?.risks) && report.risks.length
                ? `Risks: ${report.risks.map((r: any) => normalizeOutput(r)).filter(Boolean).join("; ")}`
                : "";
              const evidence = Array.isArray(report?.evidence) && report.evidence.length
                ? `Evidence: ${report.evidence.map((e: any) => normalizeOutput(e)).filter(Boolean).join("; ")}`
                : "";
              return [
                `Task ${taskId} (${status})`,
                summary,
                finalOutput,
                evidence,
                risks
              ].filter(Boolean).join("\n");
            });
            return [`Agent reports${label}:`, ...blocks].join("\n\n");
          };

          const buildAgentResultMessages = (toolResults: any[]) => {
            const messages: string[] = [];
            for (const result of toolResults) {
              if (!result?.success) continue;
              if (result.call?.name !== "project_manager") continue;
              const payload = parseJson(String(result.output));
              if (!payload) continue;

              const resultsByAgent = Array.isArray(payload.resultsByAgent) ? payload.resultsByAgent : null;
              if (resultsByAgent && resultsByAgent.length > 0) {
                const sections = resultsByAgent.map((entry: any) => {
                  const results = Array.isArray(entry?.results) ? entry.results : [];
                  const reports = Array.isArray(entry?.reports) ? entry.reports : [];
                  if (results.length === 0 && reports.length === 0) return "";
                  const labelParts: string[] = [];
                  if (entry?.agentName) labelParts.push(String(entry.agentName));
                  if (entry?.agentId) labelParts.push(String(entry.agentId));
                  const agentLabel = labelParts.join(" | ");
                  return [
                    formatAgentReports(agentLabel, reports),
                    formatAgentResults(agentLabel, results)
                  ].filter(Boolean).join("\n\n");
                }).filter(Boolean);
                if (sections.length > 0) {
                  messages.push(sections.join("\n\n"));
                }
                continue;
              }

              const results = Array.isArray(payload.results) ? payload.results : [];
              const reports = Array.isArray(payload.reports) ? payload.reports : [];
              if (results.length === 0 && reports.length === 0) continue;

              const agentId = String(result.call?.arguments?.agentId || payload.agentId || "").trim();
              let agentLabel = "";
              if (agentId) {
                const agent = agentSwarm.getAgent(agentId);
                agentLabel = agent?.name ? `${agent.name} | ${agentId}` : agentId;
              }

              const message = [
                formatAgentReports(agentLabel, reports),
                formatAgentResults(agentLabel, results)
              ].filter(Boolean).join("\n\n");
              if (message) messages.push(message);
            }
            return messages;
          };

          const buildMediaRequests = (toolResults: any[]) => {
            const media: { type: 'image' | 'file'; path?: string; url?: string; caption?: string }[] = [];
            for (const result of toolResults) {
              if (!result?.success) continue;
              if (result.call?.name !== "playwright") continue;
              const payload = parseJson(String(result.output));
              if (!payload) continue;
              const filePath = typeof payload.filePath === "string" ? payload.filePath : "";
              if (!filePath) continue;
              const url = typeof payload.url === "string" ? payload.url : "";
              const captionLines = ["📸 Screenshot"];
              if (url) captionLines.push(url);
              const caption = captionLines.join("\n");
              if (fs.existsSync(filePath)) {
                media.push({ type: "image", path: filePath, url, caption });
              } else if (url) {
                media.push({ type: "image", url, caption });
              }
            }
            return media;
          };

          const formatShellResult = (result: any) => {
            const args = result.call?.arguments || {};
            const command = typeof args.command === "string" ? args.command : "";
            const outputObj = result.success ? parseJson(String(result.output)) : null;
            if (!outputObj) {
              const raw = normalizeOutput(result.output);
              return raw || "_No output_";
            }

            const streamed = Boolean(outputObj?.streamed);
            const stdout = normalizeOutput(outputObj?.stdout);
            const stderr = normalizeOutput(outputObj?.stderr);
            const errorText = normalizeOutput(outputObj?.error || result.error);
            const exitCode = outputObj?.exitCode;
            const elevated = outputObj?.elevated;
            const cwd = normalizeOutput(outputObj?.cwd) || process.cwd();

            const metaParts: string[] = [];
            if (typeof exitCode !== "undefined") metaParts.push(`exit: ${exitCode}`);
            if (elevated) metaParts.push(`elevated: ${elevated}`);
            const meta = metaParts.length ? `_${metaParts.join(" | ")}_` : "";

            if (streamed) {
              const commandLabel = command ? `\`${command}\`` : "command";
              const summaryLines = [`Shell stream complete for ${commandLabel}.`];
              if (errorText) summaryLines.push(`Error: ${errorText}`);
              if (meta) summaryLines.push(meta);
              return summaryLines.join("\n");
            }

            const prompt = process.platform === "win32" ? "PS>" : "$";
            const lines = ["```shell"];
            if (cwd) {
              lines.push(`# cwd: ${cwd}`);
            }
            lines.push(`${prompt} ${command || "(command unavailable)"}`);
            if (stdout) {
              lines.push(stdout);
            }
            if (stderr) {
              if (stdout) lines.push("");
              lines.push("# stderr");
              lines.push(stderr);
            }
            if (errorText && errorText !== stderr) {
              if (stdout || stderr) lines.push("");
              lines.push("# error");
              lines.push(errorText);
            }
            if (!stdout && !stderr && !errorText) {
              lines.push("# (no output)");
            }
            lines.push("```");

            return [lines.join("\n"), meta].filter(Boolean).join("\n");
          };

          const SEARCH_TOOL_NAMES = ['serper_search', 'brave_search', 'web_search', 'deep_research'];

          const formatSearchResultCompact = (result: any) => {
            try {
              const payload = parseJson(String(result.output));
              if (!payload) return String(result.output);

              // Remove internal synthesis instructions from display
              delete payload._synthesisInstructions;

              // Build compact summary
              const items = payload.results || payload.sources || [];
              const count = items.length;
              const query = payload.query || '';
              const titles = items.map((r: any) => r.title || r.url || '').filter(Boolean);

              let summary = `Found ${count} results`;
              if (query) summary += ` for "${query}"`;
              if (titles.length > 0) summary += `:\n${titles.map((t: string) => `  • ${t}`).join('\n')}`;
              if (payload.answerBox?.answer) summary += `\nDirect answer: ${String(payload.answerBox.answer)}`;
              return summary;
            } catch {
              return String(result.output);
            }
          };

          const formatToolResult = (result: any) => {
            if (result.call?.name === "shell") {
              const rendered = formatShellResult(result);
              return `${result.success ? "✅" : "❌"} shell\n${rendered}`;
            }
            // Compact display for search tools — don't dump raw JSON to user
            if (result.success && SEARCH_TOOL_NAMES.includes(result.call?.name)) {
              const compact = formatSearchResultCompact(result);
              return `✅ ${result.call.name}\n${compact}`;
            }
            if (result.success) {
              return `✅ ${result.call.name}\n${String(result.output)}`;
            }
            return `❌ ${result.call.name}\n${String(result.error || "Unknown error")}`;
          };

          const mediaRequests = buildMediaRequests(results);

          let toolOutputText = results.map((r) => {
            const formatted = formatToolResult(r);
            return ensureClosedCodeFences(formatted);
          }).join("\n\n");

          toolOutputText = ensureClosedCodeFences(toolOutputText);
          await this.gateway.sendResponse(sessionId, `${DEBUG_PREFIX}\n${toolOutputText}`);
          for (const media of mediaRequests) {
            await this.gateway.sendMedia(sessionId, media);
          }
          // After search tools, inject a synthesis instruction into memory 
          // to ensure the model writes a proper response on the next iteration
          const hasSearchResults = results.some(r => r.success && SEARCH_TOOL_NAMES.includes(r.call?.name));
          if (hasSearchResults) {
            this.memory.add(sessionId, {
              role: "system",
              content: "Search candidates were received above. For research or news, fetch the strongest sources, then write a complete answer using only claims supported by the fetched readable text. Cite the exact URLs. Never fill evidence gaps with plausible model names, dates, metrics, quotations, or events. If the available sources are weak or incomplete, say so explicitly.",
              timestamp: Date.now()
            });
          }


          // A host-recorded tool batch advances through the engine as a
          // non-completion turn; TaskEngine owns the continuation decision.
          return {
            content: String(response.content || ''),
            usedTools: true,
            totalToolCalls,
            lastBatchHadFailure,
            toolRequired,
            verificationRequired
          };
        } else {
          const text = (response.content || "").trim();

          // Phase 12 Move 2 — the completion decision moves into the engine's
          // turn contract. The host supplies the evidence; the engine asks its
          // completion-verdict hook "is completion allowed?" and owns the
          // resulting lifecycle transition (continue / verify / complete /
          // fail / blocked). The runner no longer computes completionBlocked.
          iterationPresentation = {
            text,
            runId: turnRunId,
            messageId: turnMessageId,
            reasoning: turnReasoning,
            completionCandidate: true,
            sanitize: true,
            recordLearning: true
          };
          return {
            content: text,
            totalToolCalls,
            lastBatchHadFailure,
            toolRequired,
            verificationRequired
          };
              // Phase 12 Move 3 — the engine runs its in-loop diagnose authority
              // Phase 12 Move 3 — render the engine's canonical verification
        }
      },
        onTurn: async (turnResult, turnContext) => {
          const presentation = iterationPresentation;
          if ((turnResult.action === 'continue' || turnResult.action === 'verify') && presentation?.completionCandidate) {
            const checkParts = [
              `Runtime completion check: ${turnResult.reason || 'The mission is not yet complete.'}`
            ];
            if (turnResult.action === 'verify' && turnResult.diagnosis) {
              const diagnosis = turnResult.diagnosis;
              checkParts.push(`Verification evidence: ${
                Array.isArray(diagnosis.matchedFiles) && diagnosis.matchedFiles.length > 0
                  ? `goal-matched files: ${diagnosis.matchedFiles.join(', ')}`
                  : 'no goal-matched files'
              }${diagnosis.evidence ? `\n${diagnosis.evidence}` : ''}`);
            }
            checkParts.push(
              'Continue autonomously now. Use the next required tool, recover from the error, or run verification.',
              'Do not repeat the draft and do not ask the user to continue.'
            );
            this.memory.add(sessionId, {
              role: 'system',
              content: checkParts.join('\n'),
              timestamp: Date.now(),
              metadata: { type: 'runtime_completion_check' }
            });
          }

          if (turnResult.action !== 'continue' && turnResult.action !== 'verify') {
            const completed = turnResult.action === 'complete';
            const finalDraft = presentation?.text || (completed
              ? 'The task completed, but the model returned no final summary.'
              : 'I could not complete the task because the required tool work or verification did not succeed.');
            if (!completed && !presentation?.markBlockedAlready) {
              executionStateManager.markBlocked(sessionId, finalDraft);
            }
            const sanitized = presentation?.sanitize ? guardrailManager.sanitizeOutput(finalDraft) : undefined;
            const cleanContent = sanitized?.sanitized || finalDraft;
            this.memory.add(sessionId, {
              role: 'assistant',
              content: cleanContent,
              timestamp: Date.now(),
              metadata: presentation?.metadata || { final: true, completed, reasoning: presentation?.reasoning }
            });
            await this.deliverFinalResponse(
              sessionId,
              cleanContent,
              presentation?.runId || uuidv4(),
              presentation?.messageId || uuidv4(),
              completed,
              presentation?.reasoning
            );
            if (presentation?.recordLearning && !isBackgroundMessage) {
              void this.learning.recordInteraction(sessionId, msg.content, cleanContent);
            }
            const currentGoal = mainGoalManager.getCurrent(sessionId);
            if (completed && currentGoal?.origin === 'auto') {
              mainGoalManager.completeGoal(sessionId, 'Completed by the autonomous execution loop.');
            }
            return;
          }

          if (turnContext.turn < missionTurnBudget && turnContext.turn % maxTurns === 0) {
            continuationBatch += 1;
            if (autoContinueNotify) {
              await this.sendManagedProgressUpdate(sessionId, {
                fallbackNow: `Auto-continue ${continuationBatch}/${autoContinueMax}.`,
                fallbackNext: 'Continue executing the next tool batch.'
              });
            }
            await this.autoCompactSessionIfNeeded(sessionId, config, this.memory.getAll(sessionId));
          }
        }
      });

      if (missionResult.stoppedByStepLimit) {
        await this.sendManagedProgressUpdate(sessionId, {
          fallbackNow: `Automation step limit reached (${maxTurns} turns).`,
          fallbackNext: 'Send "continue" to keep going, or increase/remove config.agent.maxTurns in config.json.'
        });
      }
    } catch (error: any) {
      const errorText = `The mission stopped because the execution driver failed: ${error?.message || String(error)}`;
      try {
        const currentTask = taskEngine.get(missionTaskId);
        if (currentTask?.status === 'EXECUTING') {
          await taskEngine.runTurn(missionTaskId, {
            turn: (currentTask.timing.turns || 0) + 1,
            verdict: { type: 'fail', error: errorText }
          });
        }
      } catch (taskError: any) {
        console.warn('[TaskEngine] could not record mission-driver failure:', taskError?.message || taskError);
      }
      this.memory.add(sessionId, {
        role: 'assistant', content: errorText, timestamp: Date.now(),
        metadata: { final: true, completed: false, missionDriverFailed: true }
      });
      await this.deliverFinalResponse(sessionId, errorText, uuidv4(), uuidv4(), false);
    }
  }

  private async proactiveTick() {
    if (!this.proactiveEnabled) return;
    const now = Date.now();
    if (now - this.proactiveLastTickAt < this.proactiveEveryMs) return;
    this.proactiveLastTickAt = now;
    if (this.proactiveInFlight) return;
    this.proactiveInFlight = true;
    try {
      const sessionIds = this.gateway.listSessionIds();
      for (const sessionId of sessionIds) {
        const memories = this.memory.get(sessionId);
        if (memories.length === 0) continue;
        const lastUser = [...memories].reverse().find(m => m.role === 'user');
        if (!lastUser) continue;
        if (now - lastUser.timestamp < this.proactiveIdleMs) continue;
        const lastProactiveAt = this.proactiveLastAt.get(sessionId) || 0;
        if (now - lastProactiveAt < this.proactiveMinGapMs) continue;
        const recent = memories.slice(-12).map(m => {
          if (m.role === 'user') return `User: ${m.content}`;
          if (m.role === 'assistant') return `Assistant: ${m.content}`;
          return `System: ${m.content}`;
        }).join('\n');

        const prompt = `You are a proactive assistant. Decide whether to send a short helpful check-in message.\n\nRules:\n- If there is nothing helpful to say, respond with exactly: NO_MESSAGE\n- Otherwise respond with 1-2 sentences, plain text.\n- Do not mention internal tools or code.\n\nRecent conversation:\n${recent}\n`;

        const model = this.getModel();
        const resp = await model.generate(prompt, this.baseSystemPrompt, []);
        const text = (resp.content || '').trim();
        if (!text || text === 'NO_MESSAGE') continue;
        await this.gateway.sendResponse(sessionId, text);
        this.proactiveLastAt.set(sessionId, now);
      }
    } catch (e) {
    } finally {
      this.proactiveInFlight = false;
    }
  }

  private handleMainGoalCommand(sessionId: string, text: string): boolean {
    const trimmed = (text || '').trim();
    const lower = trimmed.toLowerCase();
    if (lower !== '/main goal' && !lower.startsWith('/main goal ')) {
      return false;
    }

    const formatGoal = (goal: any) => {
      if (!goal) return 'No active main goal.';
      const lines = [
        `ID: ${goal.id}`,
        `Title: ${goal.title}`,
        `Objective: ${goal.objective}`,
        `Status: ${goal.status}`,
        `Origin: ${goal.origin}`,
        goal.latestUserRequest ? `Latest user request: ${goal.latestUserRequest}` : '',
        goal.linkedProjectId ? `Linked project: ${goal.linkedProjectId}` : '',
        goal.constraints?.length ? `Constraints: ${goal.constraints.slice(-8).join(' | ')}` : '',
        goal.acceptanceCriteria?.length ? `Done means: ${goal.acceptanceCriteria.slice(-8).join(' | ')}` : '',
        goal.notes?.length ? `Notes: ${goal.notes.slice(-8).join(' | ')}` : ''
      ].filter(Boolean);
      return lines.join('\n');
    };

    if (lower === '/main goal' || lower === '/main goal show' || lower === '/main goal status') {
      void this.gateway.sendResponse(sessionId, formatGoal(mainGoalManager.getCurrent(sessionId)));
      return true;
    }

    if (lower === '/main goal help') {
      void this.gateway.sendResponse(sessionId, [
        'Main goal commands:',
        '/main goal',
        '/main goal set <title> - <objective>',
        '/main goal note <note>',
        '/main goal constraint <constraint>',
        '/main goal acceptance <criterion>',
        '/main goal done [note]',
        '/main goal clear [note]'
      ].join('\n'));
      return true;
    }

    if (lower.startsWith('/main goal set ')) {
      const rest = trimmed.slice('/main goal set '.length).trim();
      const dash = rest.indexOf(' - ');
      const title = dash > 0 ? rest.slice(0, dash).trim() : rest;
      const objective = dash > 0 ? rest.slice(dash + 3).trim() : rest;
      if (!title) {
        void this.gateway.sendResponse(sessionId, 'Usage: /main goal set <title> - <objective>');
        return true;
      }
      const goal = mainGoalManager.setGoal(sessionId, {
        title,
        objective,
        origin: 'manual',
        confidence: 1
      });
      void this.gateway.sendResponse(sessionId, `Main goal set: ${goal.title}\nID: ${goal.id}`);
      return true;
    }

    if (lower.startsWith('/main goal note ')) {
      const note = trimmed.slice('/main goal note '.length).trim();
      const ok = mainGoalManager.addNote(sessionId, note);
      void this.gateway.sendResponse(sessionId, ok ? 'Main goal note added.' : 'No active main goal.');
      return true;
    }

    if (lower.startsWith('/main goal constraint ')) {
      const constraint = trimmed.slice('/main goal constraint '.length).trim();
      const ok = mainGoalManager.addConstraint(sessionId, constraint);
      void this.gateway.sendResponse(sessionId, ok ? 'Main goal constraint added.' : 'No active main goal.');
      return true;
    }

    if (lower.startsWith('/main goal acceptance ')) {
      const criterion = trimmed.slice('/main goal acceptance '.length).trim();
      const ok = mainGoalManager.addAcceptanceCriterion(sessionId, criterion);
      void this.gateway.sendResponse(sessionId, ok ? 'Main goal acceptance criterion added.' : 'No active main goal.');
      return true;
    }

    if (lower === '/main goal done' || lower.startsWith('/main goal done ')) {
      const note = trimmed.length > '/main goal done'.length
        ? trimmed.slice('/main goal done'.length).trim()
        : undefined;
      const ok = mainGoalManager.completeGoal(sessionId, note);
      void this.gateway.sendResponse(sessionId, ok ? 'Main goal marked done.' : 'No active main goal.');
      return true;
    }

    if (lower === '/main goal complete' || lower.startsWith('/main goal complete ')) {
      const note = trimmed.length > '/main goal complete'.length
        ? trimmed.slice('/main goal complete'.length).trim()
        : undefined;
      const ok = mainGoalManager.completeGoal(sessionId, note);
      void this.gateway.sendResponse(sessionId, ok ? 'Main goal marked done.' : 'No active main goal.');
      return true;
    }

    if (lower === '/main goal clear' || lower.startsWith('/main goal clear ')) {
      const note = trimmed.length > '/main goal clear'.length
        ? trimmed.slice('/main goal clear'.length).trim()
        : undefined;
      const ok = mainGoalManager.clearGoal(sessionId, note);
      void this.gateway.sendResponse(sessionId, ok ? 'Main goal cleared.' : 'No active main goal.');
      return true;
    }

    void this.gateway.sendResponse(sessionId, 'Usage: /main goal help');
    return true;
  }

  private handleScheduleCommand(sessionId: string, text: string) {
    const trimmed = (text || '').trim();
    const parseDurationMs = (token: string) => {
      const m = /^(\d+)\s*([smhd])$/i.exec(token.trim());
      if (!m) return null;
      const n = Number(m[1]);
      const unit = m[2].toLowerCase();
      if (!Number.isFinite(n) || n <= 0) return null;
      if (unit === 's') return n * 1000;
      if (unit === 'm') return n * 60 * 1000;
      if (unit === 'h') return n * 60 * 60 * 1000;
      if (unit === 'd') return n * 24 * 60 * 60 * 1000;
      return null;
    };

    if (trimmed.toLowerCase().startsWith('/schedule ')) {
      const rest = trimmed.slice(10).trim();
      const firstSpace = rest.indexOf(' ');
      if (firstSpace <= 0) {
        void this.gateway.sendResponse(sessionId, `Usage: /schedule <10m|2h|ISO> <task>`);
        return true;
      }
      const whenToken = rest.slice(0, firstSpace).trim();
      const message = rest.slice(firstSpace + 1).trim();
      if (!message) {
        void this.gateway.sendResponse(sessionId, `Usage: /schedule <10m|2h|ISO> <task>`);
        return true;
      }
      const delayMs = parseDurationMs(whenToken);
      const runAtIso = delayMs === null ? whenToken : undefined;
      let runAt: number | undefined;
      if (runAtIso) {
        const t = Date.parse(runAtIso);
        if (!Number.isNaN(t)) runAt = t;
      }
      const job = this.scheduler.create({ sessionId, prompt: message, delayMs: delayMs === null ? undefined : delayMs, runAt });
      void this.gateway.sendResponse(sessionId, `Scheduled: ${job.id} at ${new Date(job.runAt).toLocaleString()}`);
      return true;
    }

    if (trimmed.toLowerCase().startsWith('/every ')) {
      const rest = trimmed.slice(7).trim();
      const firstSpace = rest.indexOf(' ');
      if (firstSpace <= 0) {
        void this.gateway.sendResponse(sessionId, `Usage: /every <10m|2h> <task>`);
        return true;
      }
      const intervalToken = rest.slice(0, firstSpace).trim();
      const message = rest.slice(firstSpace + 1).trim();
      const intervalMs = parseDurationMs(intervalToken);
      if (!intervalMs || !message) {
        void this.gateway.sendResponse(sessionId, `Usage: /every <10m|2h> <task>`);
        return true;
      }
      const job = this.scheduler.create({ sessionId, prompt: message, delayMs: intervalMs, intervalMs });
      void this.gateway.sendResponse(sessionId, `Scheduled recurring: ${job.id} every ${intervalToken}`);
      return true;
    }

    if (trimmed.toLowerCase().startsWith('/jobs')) {
      const jobs = this.scheduler.list({ sessionId });
      if (jobs.length === 0) {
        void this.gateway.sendResponse(sessionId, 'No scheduled jobs.');
        return true;
      }
      const lines = jobs.map(j => {
        const skipped = j.skippedRuns || 0;
        const skipInfo = skipped > 0
          ? ` ⏭️ ${skipped} skipped run${skipped === 1 ? '' : 's'}${j.lastSkippedAt ? ` (last ${new Date(j.lastSkippedAt).toLocaleString()})` : ''}`
          : '';
        return `${j.enabled ? '✅' : '⏸️'} ${j.id} @ ${new Date(j.runAt).toLocaleString()}${j.intervalMs ? ` every ${Math.round(j.intervalMs / 1000)}s` : ''} :: ${j.prompt}${skipInfo}`;
      });
      void this.gateway.sendResponse(sessionId, lines.join('\n'));
      return true;
    }

    if (trimmed.toLowerCase().startsWith('/cancel ')) {
      const id = trimmed.slice(8).trim();
      if (!id) {
        void this.gateway.sendResponse(sessionId, `Usage: /cancel <jobId>`);
        return true;
      }
      const ok = this.scheduler.cancel(id);
      void this.gateway.sendResponse(sessionId, ok ? `Cancelled: ${id}` : `Not found: ${id}`);
      return true;
    }

    return false;
  }

  private handleBackgroundGoalCommand(sessionId: string, text: string): boolean {
    const trimmed = (text || '').trim();

    const resolveGoal = (rawId: string) => {
      const id = rawId.trim();
      if (!id) return { error: 'Missing goal id.' };
      const candidates = backgroundWorker.getGoals(sessionId);
      const direct = backgroundWorker.getGoal(id);
      if (direct && direct.sessionId === sessionId) return { goal: direct };
      const matches = candidates.filter(goal => goal.id.startsWith(id));
      if (matches.length === 0) return { error: `No goal matches "${id}".` };
      if (matches.length > 1) return { error: `Multiple goals match "${id}". Use a longer id prefix.` };
      return { goal: matches[0] };
    };

    const formatGoal = (goal: any) => {
      const blocked = goal.blockedReason ? `\nBlocked: ${goal.blockedReason}` : '';
      const deps = Array.isArray(goal.dependencies) && goal.dependencies.length > 0
        ? `\nDependencies: ${goal.dependencies.join(', ')}`
        : '';
      const checkpoint = goal.checkpoint?.note ? `\nCheckpoint: ${goal.checkpoint.note}` : '';
      return [
        `ID: ${goal.id}`,
        `Title: ${goal.title}`,
        `Status: ${goal.status}`,
        `Priority: ${goal.priority}`,
        `Progress: ${goal.progress}%`,
        `Attempts: ${goal.attempts || 0}/${(goal.maxRetries || 0) + 1}`,
        `Description: ${goal.description}${deps}${blocked}${checkpoint}`
      ].join('\n');
    };

    const resolveProject = (rawId: string) => {
      const id = rawId.trim();
      if (!id) return { error: 'Missing project id.' };
      const direct = backgroundWorker.getProject(id);
      if (direct && direct.sessionId === sessionId) return { project: direct };
      const matches = backgroundWorker.getProjects(sessionId).filter(project => project.id.startsWith(id));
      if (matches.length === 0) return { error: `No project matches "${id}".` };
      if (matches.length > 1) return { error: `Multiple projects match "${id}". Use a longer id prefix.` };
      return { project: matches[0] };
    };

    const formatProject = (project: any) => {
      const goals = backgroundWorker.getProjectGoals(project.id);
      const completed = goals.filter(g => g.status === 'completed').length;
      const active = goals.filter(g => g.status === 'in-progress').length;
      const pending = goals.filter(g => g.status === 'pending').length;
      const blocked = goals.filter(g => g.blockedReason || g.status === 'failed' || g.status === 'cancelled').length;
      const milestoneLines = project.milestoneIds.map((id: string) => {
        const milestone = project.milestones[id];
        return milestone ? `- ${milestone.title}: ${milestone.status} (${milestone.goalIds.length} goals)` : '';
      }).filter(Boolean);
      const memoryLines = [
        project.memory?.notes?.length ? `Latest note: ${project.memory.notes[project.memory.notes.length - 1]}` : '',
        project.memory?.filesTouched?.length ? `Files: ${project.memory.filesTouched.slice(-8).join(', ')}` : '',
        project.memory?.decisions?.length ? `Decisions: ${project.memory.decisions.slice(-5).join('; ')}` : ''
      ].filter(Boolean);
      return [
        `ID: ${project.id}`,
        `Title: ${project.title}`,
        `Status: ${project.status}`,
        `Goals: ${completed}/${goals.length} completed, ${active} active, ${pending} pending, ${blocked} blocked`,
        `Description: ${project.description}`,
        milestoneLines.length > 0 ? `Milestones:\n${milestoneLines.join('\n')}` : '',
        memoryLines.length > 0 ? `Memory:\n${memoryLines.join('\n')}` : ''
      ].filter(Boolean).join('\n');
    };

    if (trimmed.toLowerCase() === '/projects') {
      const projects = backgroundWorker.getProjects(sessionId);
      if (projects.length === 0) {
        void this.gateway.sendResponse(sessionId, 'No background projects. Use `/project plan <title> - <description>` to create one.');
        return true;
      }
      const response = projects.slice(0, 12).map(project => {
        const goals = backgroundWorker.getProjectGoals(project.id);
        const completed = goals.filter(g => g.status === 'completed').length;
        return `- ${project.id.slice(0, 8)} [${project.status}] ${project.title} (${completed}/${goals.length} goals)`;
      }).join('\n');
      void this.gateway.sendResponse(sessionId, response);
      return true;
    }

    if (trimmed.toLowerCase().startsWith('/project plan ')) {
      const rest = trimmed.slice('/project plan '.length).trim();
      const dashIndex = rest.indexOf(' - ');
      const title = dashIndex > 0 ? rest.slice(0, dashIndex).trim() : rest;
      const description = dashIndex > 0 ? rest.slice(dashIndex + 3).trim() : rest;
      if (!title) {
        void this.gateway.sendResponse(sessionId, 'Usage: /project plan <title> - <description>');
        return true;
      }
      const result = backgroundWorker.planProject({ title, description, sessionId });
      if (!mainGoalManager.getCurrent(sessionId)) {
        mainGoalManager.setGoal(sessionId, {
          title,
          objective: description,
          origin: 'manual',
          confidence: 1
        });
      }
      mainGoalManager.linkProject(sessionId, result.project.id);
      void this.gateway.sendResponse(
        sessionId,
        result.reused
          ? `Project already exists, reusing: ${result.project.title}\nID: ${result.project.id}\nGoals: ${result.goals.length}`
          : `Project planned: ${result.project.title}\nID: ${result.project.id}\nMilestones: ${result.project.milestoneIds.length}\nGoals: ${result.goals.length}`
      );
      return true;
    }

    if (trimmed.toLowerCase().startsWith('/project show ')) {
      const resolved = resolveProject(trimmed.slice('/project show '.length));
      if (resolved.error || !resolved.project) {
        void this.gateway.sendResponse(sessionId, resolved.error || 'Project not found.');
        return true;
      }
      void this.gateway.sendResponse(sessionId, formatProject(resolved.project));
      return true;
    }

    if (trimmed.toLowerCase().startsWith('/project memory ')) {
      const rest = trimmed.slice('/project memory '.length).trim();
      const dash = rest.indexOf(' - ');
      if (dash <= 0) {
        void this.gateway.sendResponse(sessionId, 'Usage: /project memory <id> - <note>');
        return true;
      }
      const rawId = rest.slice(0, dash).trim();
      const note = rest.slice(dash + 3).trim();
      const resolved = resolveProject(rawId);
      if (resolved.error || !resolved.project) {
        void this.gateway.sendResponse(sessionId, resolved.error || 'Project not found.');
        return true;
      }
      const ok = backgroundWorker.recordProjectMemory(resolved.project.id, { note });
      void this.gateway.sendResponse(sessionId, ok ? `Project memory recorded: ${resolved.project.title}` : 'Project not found.');
      return true;
    }

    if (trimmed.toLowerCase().startsWith('/goal cancel ')) {
      const resolved = resolveGoal(trimmed.slice('/goal cancel '.length));
      if (resolved.error || !resolved.goal) {
        void this.gateway.sendResponse(sessionId, resolved.error || 'Goal not found.');
        return true;
      }
      const ok = backgroundWorker.cancelGoal(resolved.goal.id);
      void this.gateway.sendResponse(sessionId, ok ? `Goal cancelled: ${resolved.goal.title}` : 'Goal not found.');
      return true;
    }

    if (trimmed.toLowerCase().startsWith('/goal done ') || trimmed.toLowerCase().startsWith('/goal complete ')) {
      const prefix = trimmed.toLowerCase().startsWith('/goal done ') ? '/goal done ' : '/goal complete ';
      const rest = trimmed.slice(prefix.length).trim();
      const dash = rest.indexOf(' - ');
      const rawId = dash >= 0 ? rest.slice(0, dash).trim() : rest;
      const note = dash >= 0 ? rest.slice(dash + 3).trim() : undefined;
      const resolved = resolveGoal(rawId);
      if (resolved.error || !resolved.goal) {
        void this.gateway.sendResponse(sessionId, resolved.error || 'Goal not found.');
        return true;
      }
      const ok = backgroundWorker.completeGoal(resolved.goal.id, note || 'Marked done by user');
      void this.gateway.sendResponse(sessionId, ok ? `Goal marked done: ${resolved.goal.title}` : 'Goal not found.');
      return true;
    }

    if (trimmed.toLowerCase().startsWith('/goal show ')) {
      const resolved = resolveGoal(trimmed.slice('/goal show '.length));
      if (resolved.error || !resolved.goal) {
        void this.gateway.sendResponse(sessionId, resolved.error || 'Goal not found.');
        return true;
      }
      void this.gateway.sendResponse(sessionId, formatGoal(resolved.goal));
      return true;
    }

    if (trimmed.toLowerCase().startsWith('/goal checkpoint ')) {
      const rest = trimmed.slice('/goal checkpoint '.length).trim();
      const dash = rest.indexOf(' - ');
      if (dash <= 0) {
        void this.gateway.sendResponse(sessionId, 'Usage: /goal checkpoint <id> - <note>');
        return true;
      }
      const rawId = rest.slice(0, dash).trim();
      const note = rest.slice(dash + 3).trim();
      const resolved = resolveGoal(rawId);
      if (resolved.error || !resolved.goal) {
        void this.gateway.sendResponse(sessionId, resolved.error || 'Goal not found.');
        return true;
      }
      const ok = backgroundWorker.checkpointGoal(resolved.goal.id, note);
      void this.gateway.sendResponse(sessionId, ok ? `Checkpoint saved for: ${resolved.goal.title}` : 'Goal not found.');
      return true;
    }

    if (trimmed.toLowerCase().startsWith('/goal memory ')) {
      const rest = trimmed.slice('/goal memory '.length).trim();
      const dash = rest.indexOf(' - ');
      if (dash <= 0) {
        void this.gateway.sendResponse(sessionId, 'Usage: /goal memory <id> - <note>');
        return true;
      }
      const rawId = rest.slice(0, dash).trim();
      const note = rest.slice(dash + 3).trim();
      const resolved = resolveGoal(rawId);
      if (resolved.error || !resolved.goal) {
        void this.gateway.sendResponse(sessionId, resolved.error || 'Goal not found.');
        return true;
      }
      const ok = backgroundWorker.recordGoalMemory(resolved.goal.id, { note });
      void this.gateway.sendResponse(sessionId, ok ? `Goal memory recorded: ${resolved.goal.title}` : 'Goal not found.');
      return true;
    }

    if (trimmed.toLowerCase().startsWith('/goal score ')) {
      const rest = trimmed.slice('/goal score '.length).trim();
      const parts = rest.split(/\s+/);
      const rawId = parts.shift() || '';
      const rawScore = parts.shift() || '';
      const note = parts.join(' ').trim();
      const score = Number(rawScore);
      if (!rawId || !Number.isFinite(score)) {
        void this.gateway.sendResponse(sessionId, 'Usage: /goal score <id> <0-1> [note]');
        return true;
      }
      const resolved = resolveGoal(rawId);
      if (resolved.error || !resolved.goal) {
        void this.gateway.sendResponse(sessionId, resolved.error || 'Goal not found.');
        return true;
      }
      const ok = backgroundWorker.scoreGoal(resolved.goal.id, score, note);
      void this.gateway.sendResponse(sessionId, ok ? `Goal scored: ${resolved.goal.title}` : 'Goal not found.');
      return true;
    }

    // /goal <title> - <description>
    if (trimmed.toLowerCase().startsWith('/goal ')) {
      const rest = trimmed.slice(6).trim();
      const dashIndex = rest.indexOf(' - ');
      let title: string;
      let description: string;

      if (dashIndex > 0) {
        title = rest.slice(0, dashIndex).trim();
        description = rest.slice(dashIndex + 3).trim();
      } else {
        title = rest;
        description = rest;
      }

      if (!title) {
        void this.gateway.sendResponse(sessionId, 'Usage: /goal <title> - <description>');
        return true;
      }

      const goal = backgroundWorker.addGoal({
        title,
        description,
        sessionId,
        priority: 'normal'
      });
      if (!mainGoalManager.getCurrent(sessionId)) {
        mainGoalManager.setGoal(sessionId, {
          title,
          objective: description,
          origin: 'manual',
          confidence: 0.9
        });
      }
      mainGoalManager.linkBackgroundGoal(sessionId, goal.id);
      const duplicate = goal.duplicateCount > 0 && goal.lastDuplicateAt && Date.now() - goal.lastDuplicateAt < 5000;
      void this.gateway.sendResponse(
        sessionId,
        duplicate
          ? `Goal already exists, reusing: ${goal.title}\nID: ${goal.id}`
          : `Goal queued: ${goal.title}\nID: ${goal.id}\n\nThis will run automatically when you're idle.`
      );
      return true;
    }

    // /goals - list pending goals
    if (trimmed.toLowerCase() === '/goals') {
      const pending = backgroundWorker.getPendingGoals(sessionId);
      const active = backgroundWorker.getActiveGoals(sessionId);

      if (pending.length === 0 && active.length === 0) {
        void this.gateway.sendResponse(sessionId, '📋 No background goals. Use `/goal <title> - <description>` to add one.');
        return true;
      }

      let response = '';
      if (active.length > 0) {
        response += '**Active:**\n';
        response += active.map(g => `- ${g.id.slice(0, 8)} ${g.title} (${g.progress}%, attempt ${g.attempts}/${g.maxRetries + 1})`).join('\n');
        response += '\n\n';
      }
      if (pending.length > 0) {
        response += '**Pending:**\n';
        response += pending.map(g => {
          const blocked = g.blockedReason ? ` - ${g.blockedReason}` : '';
          return `- ${g.id.slice(0, 8)} [${g.priority}] ${g.title}${blocked}`;
        }).join('\n');
      }

      void this.gateway.sendResponse(sessionId, response);
      return true;
    }

    // /dnd - check DND status
    if (trimmed.toLowerCase() === '/dnd') {
      const status = dndManager.getStatus();
      const inDnd = status.inQuietHours ? '🔕 **Quiet Hours Active**' : '🔔 **Available**';
      const pending = status.pendingCount > 0 ? `\n📬 ${status.pendingCount} notifications queued` : '';
      const config = status.config.enabled
        ? `\nQuiet hours: ${status.config.quietHoursStart}:00 - ${status.config.quietHoursEnd}:00`
        : '\nQuiet hours: Disabled';
      void this.gateway.sendResponse(sessionId, `${inDnd}${config}${pending}`);
      return true;
    }

    return false;
  }

  private async handleCustomAgentCommand(sessionId: string, msg: Message): Promise<boolean> {
    const trimmed = (msg.content || '').trim();

    // /agent create <name> - <persona>
    if (trimmed.toLowerCase().startsWith('/agent create ')) {
      const rest = trimmed.slice(14).trim();
      const dashIndex = rest.indexOf(' - ');
      let name: string;
      let persona: string;

      if (dashIndex > 0) {
        name = rest.slice(0, dashIndex).trim();
        persona = rest.slice(dashIndex + 3).trim();
      } else {
        void this.gateway.sendResponse(sessionId, 'Usage: /agent create <name> - <persona description>');
        return true;
      }

      const agent = customAgentManager.createAgent({
        name,
        displayName: name,
        persona
      });
      void this.gateway.sendResponse(sessionId, `🤖 **Agent Created:** ${agent.displayName}\n\nID: \`${agent.id}\`\nPersona: ${persona.slice(0, 100)}...`);
      return true;
    }

    // /agent template <name>
    if (trimmed.toLowerCase().startsWith('/agent template ')) {
      const templateName = trimmed.slice(16).trim();
      const agent = customAgentManager.createFromTemplate(templateName);
      if (!agent) {
        const templates = customAgentManager.getTemplates();
        void this.gateway.sendResponse(sessionId, `❌ Template not found: ${templateName}\n\nAvailable templates:\n${templates.map(t => `• ${t}`).join('\n')}`);
        return true;
      }
      void this.gateway.sendResponse(sessionId, `🤖 **Agent Created from Template:** ${agent.displayName}\n\nID: \`${agent.id}\`\nSkills: ${agent.skills.join(', ') || 'none'}`);
      return true;
    }

    // /agents - list all agents
    if (trimmed.toLowerCase() === '/agents') {
      const agents = customAgentManager.listAgents();
      if (agents.length === 0) {
        void this.gateway.sendResponse(sessionId, '📋 No custom agents yet.\n\nCreate one with:\n• `/agent create <name> - <persona>`\n• `/agent template researcher`');
        return true;
      }

      const lines = agents.map(a => `• **${a.displayName}** (\`${a.name}\`) - ${a.description || 'No description'}`);
      void this.gateway.sendResponse(sessionId, `🤖 **Custom Agents (${agents.length}):**\n\n${lines.join('\n')}`);
      return true;
    }

    // /agent templates - list available templates
    if (trimmed.toLowerCase() === '/agent templates') {
      const templates = customAgentManager.getTemplates();
      const details = templates.map(name => {
        const t = customAgentManager.getTemplate(name);
        return `• **${t?.displayName || name}** (\`${name}\`) - ${t?.description || ''}`;
      });
      void this.gateway.sendResponse(sessionId, `📋 **Agent Templates:**\n\n${details.join('\n')}\n\nUse: \`/agent template <name>\` to create one`);
      return true;
    }

    // /agent delete <name>
    if (trimmed.toLowerCase().startsWith('/agent delete ')) {
      const name = trimmed.slice(14).trim();
      const success = customAgentManager.deleteAgent(name);
      void this.gateway.sendResponse(sessionId, success ? `✅ Deleted agent: ${name}` : `❌ Agent not found: ${name}`);
      return true;
    }

    // @AgentName <message> - Talk to a specific agent
    if (trimmed.startsWith('@')) {
      const spaceIndex = trimmed.indexOf(' ');
      if (spaceIndex > 1) {
        const agentName = trimmed.slice(1, spaceIndex);
        const userMessage = trimmed.slice(spaceIndex + 1).trim();

        const agent = customAgentManager.getAgent(agentName);
        if (agent) {
          // Build agent-specific prompt
          const agentSystemPrompt = customAgentManager.buildSystemPrompt(agent);

          // Get conversation history for this agent
          const history = customAgentManager.getConversation(sessionId, agent.id);
          const historyText = history.slice(-10).map(m =>
            m.role === 'user' ? `User: ${m.content}` : `${agent.displayName}: ${m.content}`
          ).join('\n');

          const prompt = historyText
            ? `Previous conversation:\n${historyText}\n\nUser: ${userMessage}`
            : `User: ${userMessage}`;

          // Store user message
          customAgentManager.addMessage(sessionId, agent.id, 'user', userMessage);

          // Generate response
          const profile = agent.profileId ? agentProfileManager.get(agent.profileId) : undefined;
          const model = this.getModelById(agent.model || profile?.modelId);
          await this.gateway.sendResponse(sessionId, `💭 *${agent.displayName} is thinking...*`);

          try {
            const delegate = SkillRegistry.get('delegate_agent');
            let agentResponse = '';
            if (delegate) {
              const result = await delegate.execute({
                agentId: agent.id,
                task: prompt,
                expectedOutput: 'Answer the user directly while following the custom agent persona.',
                allowedTools: agent.skills,
                maxTurns: 6,
                retries: 1,
                reviewCriteria: ['answered the user', 'used evidence when tools were called'],
                __sessionId: sessionId
              });
              agentResponse = result?.report?.finalOutput || result?.report?.summary || JSON.stringify(result);
            } else {
              const response = await model.generate(prompt, agentSystemPrompt, []);
              agentResponse = response.content || 'I have no response.';
            }

            // Store agent response
            customAgentManager.addMessage(sessionId, agent.id, 'agent', agentResponse);

            await this.gateway.sendResponse(sessionId, `**${agent.displayName}:**\n\n${agentResponse}`);
          } catch (err: any) {
            await this.gateway.sendResponse(sessionId, `❌ ${agent.displayName} encountered an error: ${err.message}`);
          }
          return true;
        }
      }
    }

    return false;
  }

  private handleModelCommand(sessionId: string, text: string): boolean {
    const trimmed = (text || '').trim();

    // /tools — diagnostic report of exactly what the model can call next turn
    if (trimmed.toLowerCase() === '/tools') {
      void this.handleToolsCommand(sessionId);
      return true;
    }

    // /models
    if (trimmed.toLowerCase() === '/models') {
      const models = ModelRegistry.getAll();
      const current = ModelRegistry.getCurrentModelId();

      let response = '**🤖 Available Models:**\n\n';
      response += models.map(m => {
        const isCurrent = m.id === current ? '✅' : '  ';
        return `${isCurrent} **${m.name}** (\`${m.id}\`)`;
      }).join('\n');

      response += '\n\n**Usage:**\n`/model use <id>` - Switch model\n`/model add <name> <base_url> <key> <model_name>` - Add new model';

      void this.gateway.sendResponse(sessionId, response);
      return true;
    }

    // /model use <id>
    if (trimmed.toLowerCase().startsWith('/model use ')) {
      const id = trimmed.slice(11).trim();
      if (ModelRegistry.setCurrentModel(id)) {
        void this.gateway.sendResponse(sessionId, `✅ Switched to model: **${id}**`);
      } else {
        void this.gateway.sendResponse(sessionId, `❌ Model not found: **${id}**\nUse \`/models\` to see available models.`);
      }
      return true;
    }

    // /model add <name> <provider> <url> <key> <model>
    // Simplified: /model add openai gpt-4o sk-key... 
    // Or: /model add ollama llama3 http://localhost:11434 
    if (trimmed.toLowerCase().startsWith('/model add ')) {
      // This is complex to parse via chat, better to rely on the ModelsSkill tool use
      // But let's support a simple version for Ollama:
      // /model add ollama <name> <model_id> [url]
      const parts = trimmed.split(' ');
      if (parts.length >= 4 && parts[2] === 'ollama') {
        const name = parts[3];
        const modelId = parts[4] || name;
        const url = parts[5] || 'http://localhost:11434/v1';

        const config = {
          id: name.toLowerCase(),
          name,
          provider: 'ollama' as const,
          modelName: modelId,
          baseUrl: url,
          apiKey: 'ollama'
        };

        if (modelManager.addModel(config)) {
          const provider = new GenericOpenAIProvider(config.id, config.name, config.baseUrl, config.apiKey || '', config.modelName);
          ModelRegistry.register(provider);
          void this.gateway.sendResponse(sessionId, `✅ Added Ollama model: **${name}** (${modelId})`);
        } else {
          void this.gateway.sendResponse(sessionId, `❌ Model **${name}** already exists.`);
        }
        return true;
      }

      void this.gateway.sendResponse(sessionId, 'To add models, please use:\n`/model add ollama <name> <model_id> [url]`\n\nFor OpenAI/others, ask me: "Add a new OpenAI model named gpt-4o..."');
      return true;
    }

    return false;
  }

  // /tools implementation: fetch MCP tools, build the exact next-turn report.
  private async handleToolsCommand(sessionId: string): Promise<void> {
    try {
      const config = this.loadConfig();
      let mcpTools: any[] = [];
      let mcpListError = '';
      try {
        mcpTools = await this.mcpManager.listTools();
      } catch (error: any) {
        mcpListError = error?.message || String(error);
        mcpTools = [];
      }
      const { report } = buildToolReport(
        {
          listMcpTools: () => Promise.resolve(mcpTools),
          buildAdvertised: (sid: string, tools: any[]) => this.buildAdvertisedTools(sid, tools, config),
          getAliasCoverage: () => this.toolEngine.aliasCoverage(),
          getLimits: () => AgentRunner.getToolLimits(config),
          getUsageStats: () => analyticsTracker.getToolUsageStats()
        },
        sessionId,
        mcpTools,
        mcpListError || undefined
      );
      await this.gateway.sendResponse(sessionId, report);
    } catch (error: any) {
      console.error('[AgentRunner] /tools failed:', error);
      await this.gateway.sendResponse(sessionId, `❌ Tool diagnostics failed: ${error?.message || String(error)}`);
    }
  }

  private async handleLearningCommand(sessionId: string, text: string): Promise<boolean> {
    const trimmed = (text || '').trim();
    const lowered = trimmed.toLowerCase();

    const formatAction = (action: any, verbose = false) => {
      const shortId = String(action.id || '').slice(0, 8);
      const created = action.createdAt ? new Date(action.createdAt).toLocaleString() : 'unknown time';
      const kind = action.type === 'auto_update'
        ? `update ${action.target || 'file'}`
        : 'queue background goal';
      const title = action.entryTitle || 'Learning action';
      const confidence = typeof action.confidence === 'number' ? `${Math.round(action.confidence * 100)}%` : 'n/a';
      const lines = [
        `ID: ${shortId}`,
        `Status: ${action.status || 'pending'}`,
        `Type: ${kind}`,
        `From: ${title}`,
        `Score: ${action.successCount || 0} success / ${action.failureCount || 0} failure (${confidence} confidence)`,
        `Created: ${created}`
      ];

      if (action.type === 'auto_update' && Array.isArray(action.lines)) {
        lines.push(`Target: ${action.target} / ${action.sectionTitle}`);
        lines.push('Lines:');
        action.lines.forEach((line: string) => lines.push(`- ${line}`));
      } else if (action.goal) {
        lines.push(`Goal: ${action.goal.title}`);
        if (verbose) {
          lines.push('Description:');
          lines.push(action.goal.description);
        }
      }

      if (verbose && action.summary) {
        lines.push('Summary:');
        lines.push(action.summary);
      }

      if (verbose && Array.isArray(action.feedback) && action.feedback.length > 0) {
        lines.push('Feedback:');
        action.feedback.slice(-5).forEach((item: any) => {
          const at = item.createdAt ? new Date(item.createdAt).toLocaleString() : 'unknown time';
          lines.push(`- ${item.outcome} at ${at}${item.note ? `: ${item.note}` : ''}`);
        });
      }

      return lines.join('\n');
    };

    const resolveAction = (rawId: string, includeResolved = false) => {
      const id = rawId.trim();
      if (!id) return { error: 'Missing learning action id.' };
      const pending = this.learning.listPendingLearningActions(sessionId, includeResolved);
      const matches = pending.filter(action => action.id === id || action.id.startsWith(id));
      if (matches.length === 0) return { error: `No pending learning action matches "${id}".` };
      if (matches.length > 1) return { error: `Multiple learning actions match "${id}". Use a longer id prefix.` };
      return { action: matches[0] };
    };

    if (lowered === '/lessons' || lowered === '/learning pending') {
      const pending = this.learning.listPendingLearningActions(sessionId);
      if (pending.length === 0) {
        await this.gateway.sendResponse(sessionId, 'No pending learning actions.');
        return true;
      }

      const blocks = pending.slice(0, 20).map(action => formatAction(action));
      const more = pending.length > 20 ? `\n\n...and ${pending.length - 20} more.` : '';
      await this.gateway.sendResponse(
        sessionId,
        `Pending learning actions (${pending.length}):\n\n${blocks.join('\n\n')}${more}\n\nUse /lesson approve <id>, /lesson reject <id>, or /lesson show <id>.`
      );
      return true;
    }

    if (lowered === '/lesson help' || lowered === '/lessons help') {
      await this.gateway.sendResponse(
        sessionId,
        [
          'Learning approval commands:',
          '- /lessons',
          '- /lesson show <id>',
          '- /lesson approve <id|all>',
          '- /lesson reject <id|all>',
          '- /lesson success <id> [note]',
          '- /lesson fail <id> [note]',
          '- /lesson stats',
          '- /training status',
          '- /training export'
        ].join('\n')
      );
      return true;
    }

    if (lowered.startsWith('/lesson show ')) {
      const resolved = resolveAction(trimmed.slice('/lesson show '.length));
      if (resolved.error || !resolved.action) {
        await this.gateway.sendResponse(sessionId, resolved.error || 'Learning action not found.');
        return true;
      }
      await this.gateway.sendResponse(sessionId, formatAction(resolved.action, true));
      return true;
    }

    if (lowered.startsWith('/lesson approve ')) {
      const id = trimmed.slice('/lesson approve '.length).trim();
      const pending = this.learning.listPendingLearningActions(sessionId);
      if (id.toLowerCase() === 'all') {
        if (pending.length === 0) {
          await this.gateway.sendResponse(sessionId, 'No pending learning actions to approve.');
          return true;
        }
        const results = pending.map(action => this.learning.approvePendingLearningAction(action.id, sessionId));
        await this.gateway.sendResponse(sessionId, results.map(r => `${r.success ? 'OK' : 'ERR'} ${r.message}`).join('\n'));
        return true;
      }

      const resolved = resolveAction(id);
      if (resolved.error || !resolved.action) {
        await this.gateway.sendResponse(sessionId, resolved.error || 'Learning action not found.');
        return true;
      }
      const result = this.learning.approvePendingLearningAction(resolved.action.id, sessionId);
      await this.gateway.sendResponse(sessionId, result.message);
      return true;
    }

    if (lowered.startsWith('/lesson reject ')) {
      const id = trimmed.slice('/lesson reject '.length).trim();
      const pending = this.learning.listPendingLearningActions(sessionId);
      if (id.toLowerCase() === 'all') {
        if (pending.length === 0) {
          await this.gateway.sendResponse(sessionId, 'No pending learning actions to reject.');
          return true;
        }
        const results = pending.map(action => this.learning.rejectPendingLearningAction(action.id, sessionId));
        await this.gateway.sendResponse(sessionId, results.map(r => `${r.success ? 'OK' : 'ERR'} ${r.message}`).join('\n'));
        return true;
      }

      const resolved = resolveAction(id);
      if (resolved.error || !resolved.action) {
        await this.gateway.sendResponse(sessionId, resolved.error || 'Learning action not found.');
        return true;
      }
      const result = this.learning.rejectPendingLearningAction(resolved.action.id, sessionId);
      await this.gateway.sendResponse(sessionId, result.message);
      return true;
    }

    if (lowered === '/lesson stats' || lowered === '/learning stats') {
      const actions = this.learning.listPendingLearningActions(sessionId, true)
        .filter(action => action.status === 'applied')
        .sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
      if (actions.length === 0) {
        await this.gateway.sendResponse(sessionId, 'No approved learning actions have feedback yet.');
        return true;
      }
      const blocks = actions.slice(0, 20).map(action => formatAction(action));
      const more = actions.length > 20 ? `\n\n...and ${actions.length - 20} more.` : '';
      await this.gateway.sendResponse(sessionId, `Learning scores (${actions.length} approved):\n\n${blocks.join('\n\n')}${more}`);
      return true;
    }

    const feedbackMatch = /^\/lesson\s+(success|succeed|worked|fail|failed|failure)\s+(\S+)(?:\s+([\s\S]+))?$/i.exec(trimmed);
    if (feedbackMatch) {
      const outcome = /^(success|succeed|worked)$/i.test(feedbackMatch[1]) ? 'success' : 'failure';
      const id = feedbackMatch[2];
      const note = feedbackMatch[3]?.trim();
      const resolved = resolveAction(id, true);
      if (resolved.error || !resolved.action) {
        await this.gateway.sendResponse(sessionId, resolved.error || 'Learning action not found.');
        return true;
      }
      const result = this.learning.recordLearningFeedback(resolved.action.id, outcome, note, sessionId);
      await this.gateway.sendResponse(sessionId, result.message);
      return true;
    }

    const feedbackLongMatch = /^\/lesson\s+feedback\s+(\S+)\s+(success|failure|fail|worked)(?:\s+([\s\S]+))?$/i.exec(trimmed);
    if (feedbackLongMatch) {
      const id = feedbackLongMatch[1];
      const outcome = /^(success|worked)$/i.test(feedbackLongMatch[2]) ? 'success' : 'failure';
      const note = feedbackLongMatch[3]?.trim();
      const resolved = resolveAction(id, true);
      if (resolved.error || !resolved.action) {
        await this.gateway.sendResponse(sessionId, resolved.error || 'Learning action not found.');
        return true;
      }
      const result = this.learning.recordLearningFeedback(resolved.action.id, outcome, note, sessionId);
      await this.gateway.sendResponse(sessionId, result.message);
      return true;
    }

    if (lowered === '/training status' || lowered === '/self training status') {
      const status = this.learning.getSelfTrainingStatus(sessionId);
      const lines = [
        `Self-training: ${status.enabled ? 'enabled' : 'disabled'}`,
        `Applied lessons: ${status.applied}`,
        `Training candidates: ${status.candidates}`,
        `Minimum confidence: ${Math.round(status.minConfidence * 100)}%`,
        `Minimum successes: ${status.minSuccesses}`,
        `Max prompt lessons: ${status.maxPromptLessons}`,
        `Export path: ${status.exportPath}`
      ];
      if (status.promptPreview) {
        lines.push('');
        lines.push(status.promptPreview);
      }
      await this.gateway.sendResponse(sessionId, lines.join('\n'));
      return true;
    }

    if (lowered === '/training export' || lowered === '/self training export') {
      const result = this.learning.exportSelfTrainingExamples(sessionId);
      await this.gateway.sendResponse(
        sessionId,
        result.success
          ? `${result.message}\n${result.path}`
          : result.message
      );
      return true;
    }

    return false;
  }

  private async handleDeepResearchCommand(sessionId: string, msg: Message): Promise<boolean> {
    const trimmed = (msg.content || '').trim();
    let query = '';
    const slashMatch = /^\/(deep|research)\s+([\s\S]+)$/i.exec(trimmed);
    if (slashMatch) {
      query = slashMatch[2].trim();
    } else {
      const patterns: RegExp[] = [
        /^do\s+(?:a\s+)?deep\s+research(?:\s*(?:on|about|into))?\s*[:\-]?\s+([\s\S]+)$/i,
        /^deep\s+research(?:\s*(?:on|about|into))?\s*[:\-]?\s+([\s\S]+)$/i,
        /^deep\s+dive(?:\s*(?:on|about|into))?\s*[:\-]?\s+([\s\S]+)$/i,
        /^research\s+report(?:\s*(?:on|about|into))?\s*[:\-]?\s+([\s\S]+)$/i,
        /^please\s+do\s+(?:a\s+)?deep\s+research(?:\s*(?:on|about|into))?\s*[:\-]?\s+([\s\S]+)$/i
      ];
      for (const pattern of patterns) {
        const m = pattern.exec(trimmed);
        if (m && m[1]) {
          query = m[1].trim();
          break;
        }
      }
    }

    if (!query) return false;
    if (!query) {
      await this.gateway.sendResponse(sessionId, 'Usage: /deep <topic> or /research <topic>');
      return true;
    }

    // Save user message to memory for continuity
    this.memory.add(sessionId, {
      role: 'user',
      content: msg.content,
      timestamp: Date.now(),
      metadata: msg.metadata
    });

    await this.gateway.sendResponse(sessionId, `Deep research started for: **${query}**`);

    const skill = new DeepResearchSkill();
    const data = await skill.execute({ query, maxSources: 6, maxImages: 4, maxFetchChars: 8000 });
    if (data?.error) {
      await this.gateway.sendResponse(sessionId, `Deep research failed: ${data.error}`);
      return true;
    }

    const sources = Array.isArray(data?.sources) ? data.sources : [];
    const images = Array.isArray(data?.images) ? data.images : [];
    const warnings = Array.isArray(data?.warnings) ? data.warnings : [];

    if (sources.length === 0) {
      await this.gateway.sendResponse(sessionId, 'Deep research found no sources. Try a different query.');
      return true;
    }

    const sourceText = sources.map((s: any, i: number) => {
      const idx = i + 1;
      const title = s.title || 'Untitled';
      const url = s.url || '';
      const snippet = s.snippet ? `Snippet: ${s.snippet}` : '';
      const extract = s.content ? `Extract:\n${String(s.content)}` : '';
      return `[${idx}] ${title}\nURL: ${url}${snippet ? `\n${snippet}` : ''}${extract ? `\n${extract}` : ''}`;
    }).join('\n\n');

    const imageText = images.length > 0
      ? images.map((img: any, i: number) => {
        const idx = i + 1;
        const title = img.title || 'Image';
        const url = img.url || '';
        const source = img.source || img.link || '';
        return `[IMG${idx}] ${title}\nURL: ${url}${source ? `\nSource: ${source}` : ''}`;
      }).join('\n\n')
      : 'None';

    const warningText = warnings.length > 0
      ? `Warnings:\n- ${warnings.join('\n- ')}\n\n`
      : '';

    const researchInstructions = [
      'You are producing a PROFESSIONAL RESEARCH REPORT. This is NOT a link dump.',
      '',
      'STRICT FORMAT REQUIREMENTS:',
      '## 📋 Executive Summary',
      'Write a 3-5 sentence overview of the key findings about the topic.',
      '',
      '## 🔍 Key Findings',
      'List 4-8 specific, data-driven findings. Each should include concrete facts, numbers, or statistics from the sources.',
      'Cite sources inline like [1], [2].',
      '',
      '## 📊 Detailed Analysis',
      'Write 3-5 paragraphs analyzing the topic in depth. Cross-reference multiple sources.',
      'Include specific quotes, data points, comparisons, and expert opinions when available.',
      'Organize by sub-topics if appropriate.',
      '',
      '## 💡 Recommendations / Takeaways',
      'Provide 3-5 actionable recommendations or key takeaways based on the research.',
      '',
      '## 🖼️ Relevant Images',
      'If images were found, display each with a descriptive caption.',
      '',
      '## 📚 Sources',
      'List all sources numbered [1] through [N] with title and URL.',
      '',
      'RULES:',
      '- Use ONLY information from the provided sources. Do not fabricate data.',
      '- Every factual claim MUST have a source citation [N].',
      '- Write in a professional, analytical tone.',
      '- Use markdown formatting for readability (bold key terms, bullet points, etc.).',
      '- The report should be comprehensive — at least 500 words.',
      '- NEVER just list links. Always synthesize and analyze.'
    ].join('\n');

    let systemPrompt = this.baseSystemPrompt;
    systemPrompt += this.buildWorkspacePrompt(msg.channel, sessionId, msg.content);
    systemPrompt += `\n\n${this.buildTimePrompt()}`;
    const username = msg.metadata?.username || 'User';
    systemPrompt += `\n\nYou are speaking with ${username}.`;

    const planPrompt = planModeManager.getPlanPrompt(sessionId);
    const finalSystemPrompt = planPrompt ? `${systemPrompt}\n\n${planPrompt}` : systemPrompt;

    const prompt = `${researchInstructions}\n\nTopic: ${query}\n\n${warningText}Sources:\n${sourceText}\n\nImages:\n${imageText}`;

    const currentModel = this.getModel();
    const reportRunId = uuidv4();
    const reportMessageId = uuidv4();
    let response: any;
    void this.gateway.sendStreamEvent(sessionId, {
      type: 'assistant_start', runId: reportRunId, messageId: reportMessageId
    });
    if (currentModel.generateStream) {
      let streamedAnyChunk = false;
      let fullStreamContent = '';
      response = await currentModel.generateStream(prompt, finalSystemPrompt, [], (chunk) => {
        if (!chunk) return;
        streamedAnyChunk = true;
        fullStreamContent += chunk;
        void this.gateway.sendStreamChunk(sessionId, chunk);
        void this.gateway.sendStreamEvent(sessionId, {
          type: 'assistant_delta', runId: reportRunId, messageId: reportMessageId, text: chunk
        });
      });
      void this.gateway.sendStreamEvent(sessionId, {
        type: 'assistant_done',
        runId: reportRunId,
        messageId: reportMessageId,
        finalText: streamedAnyChunk ? fullStreamContent : response?.content || ''
      });
      if (!streamedAnyChunk && response?.content) {
        await this.gateway.sendResponse(sessionId, response.content);
      }
    } else {
      response = await currentModel.generate(prompt, finalSystemPrompt, []);
      void this.gateway.sendStreamEvent(sessionId, {
        type: 'assistant_done', runId: reportRunId, messageId: reportMessageId, finalText: response?.content || ''
      });
      await this.gateway.sendResponse(sessionId, response?.content || '');
    }

    if (response?.content) {
      this.memory.add(sessionId, {
        role: 'assistant',
        content: response.content,
        timestamp: Date.now()
      });
    }

    return true;
  }
}
