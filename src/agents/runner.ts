import { Message } from '../core/types';
import { ModelProvider, ModelRegistry } from '../core/models';
import { SkillRegistry } from '../core/skills';
import { Memory, MemoryManager } from '../core/memory';
import { McpManager } from '../core/mcp';
import { MockProvider } from './mock-provider';
import { OpenRouterProvider } from './openrouter-provider';
import { NvidiaProvider } from './nvidia-provider';
import { SystemSkill, TimeSkill } from '../skills/system';
import { NotesSkill } from '../skills/notes';
import { ShellSkill } from '../skills/shell';
import { WebFetchSkill, WebSearchSkill } from '../skills/web';
import { SchedulerManager } from '../core/scheduler';
import { SchedulerSkill } from '../skills/scheduler';
import { PlaywrightSkill } from '../skills/playwright';
import { BraveSearchSkill } from '../skills/brave';
import { ApplyPatchSkill } from '../skills/patch';
import { BusinessSkill } from '../skills/business';
import { ProjectManagerSkill } from '../skills/project-manager';
import { AgentsMdSkill } from '../skills/agents-md';
import { thinkingManager } from '../core/thinking';
import { scratchpad } from '../core/scratchpad';
import { taskContext } from '../core/task-context';
import { agentSwarm } from '../core/agent-swarm';
import { TaskMemorySkill } from '../skills/task-memory';
import { backgroundWorker } from '../core/background-worker';
import { dndManager } from '../core/dnd';
import { BackgroundGoalsSkill, DNDSkill } from '../skills/background';
import { customAgentManager } from '../core/custom-agents';
import { CustomAgentsSkill } from '../skills/custom-agents';
import { modelManager } from '../core/model-manager';
import { ModelsSkill } from '../skills/models';
import { GenericOpenAIProvider } from './openai-provider';
import { SerperSkill } from '../skills/serper';
import { MemorySkill } from '../skills/memory';
import { PlanModeSkill } from '../skills/plan-mode';
import { planModeManager } from '../core/plan-mode';
import { DeepResearchSkill } from '../skills/deep-research';
import { SendTelegramSkill } from '../skills/send-telegram';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

const DEBUG_PREFIX = '__DEBUG__';

// Interface to avoid circular dependency import issues
interface IGateway {
  sendResponse(sessionId: string, text: string): Promise<void>;
  sendStreamChunk(sessionId: string, chunk: string): Promise<void>;
  listSessionIds(): string[];
}

export class AgentRunner {
  private gateway: IGateway;
  private baseSystemPrompt: string;
  private memory: MemoryManager;
  private mcpManager: McpManager;
  private scheduler: SchedulerManager;
  private defaultMaxTurns: number = 15;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private heartbeatMs: number = 60000; // Default 1 minute
  private proactiveEnabled: boolean = false;
  private proactiveIdleMs: number = 5 * 60 * 1000;
  private proactiveMinGapMs: number = 10 * 60 * 1000;
  private proactiveLastAt: Map<string, number> = new Map();
  private proactiveInFlight = false;
  private proactiveEveryMs: number = 60 * 1000;
  private proactiveLastTickAt = 0;

  constructor(gateway: IGateway) {
    this.gateway = gateway;
    this.memory = new MemoryManager();
    this.mcpManager = new McpManager();
    this.scheduler = new SchedulerManager(async (job) => {
      const scheduledMsg: Message = {
        id: uuidv4(),
        channel: 'scheduler',
        senderId: 'scheduler',
        content: job.prompt,
        timestamp: Date.now()
      };
      await this.processMessage(job.sessionId, scheduledMsg);
    });

    // Initialize default components
    ModelRegistry.register(new MockProvider());
    SkillRegistry.register(new SystemSkill());
    SkillRegistry.register(new TimeSkill());
    SkillRegistry.register(new NotesSkill());
    SkillRegistry.register(new ShellSkill());
    SkillRegistry.register(new WebFetchSkill());
    SkillRegistry.register(new WebSearchSkill());
    SkillRegistry.register(new SchedulerSkill(this.scheduler));
    SkillRegistry.register(new PlaywrightSkill());
    SkillRegistry.register(new BraveSearchSkill());
    SkillRegistry.register(new ApplyPatchSkill());
    SkillRegistry.register(new BusinessSkill());
    SkillRegistry.register(new ProjectManagerSkill());
    SkillRegistry.register(new AgentsMdSkill());
    SkillRegistry.register(new TaskMemorySkill());
    SkillRegistry.register(new BackgroundGoalsSkill());
    SkillRegistry.register(new DNDSkill());
    SkillRegistry.register(new CustomAgentsSkill());
    SkillRegistry.register(new ModelsSkill());
    SkillRegistry.register(new SerperSkill());
    SkillRegistry.register(new MemorySkill(this.memory));
    SkillRegistry.register(new PlanModeSkill());
    SkillRegistry.register(new DeepResearchSkill());
    SkillRegistry.register(new SendTelegramSkill());

    // Load custom models
    for (const config of modelManager.listModels()) {
      if (config.enabled) {
        const provider = new GenericOpenAIProvider(
          config.id,
          config.name,
          config.baseUrl,
          config.apiKey || process.env.OPENAI_API_KEY || '',
          config.modelName
        );
        ModelRegistry.register(provider);
        console.log(`[AgentRunner] Loaded custom model: ${config.name} (${config.provider})`);
      }
    }

    // Wire up agent swarm executor
    agentSwarm.setExecutor(async (agentId: string, prompt: string) => {
      const model = this.getModel();
      const response = await model.generate(prompt, this.baseSystemPrompt);
      return response.content || '';
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

    if (config.heartbeatInterval) {
      this.heartbeatMs = config.heartbeatInterval;
    }
    if (config.proactive && typeof config.proactive === 'object') {
      if (typeof config.proactive.enabled === 'boolean') this.proactiveEnabled = config.proactive.enabled;
      if (typeof config.proactive.idleMs === 'number') this.proactiveIdleMs = config.proactive.idleMs;
      if (typeof config.proactive.minGapMs === 'number') this.proactiveMinGapMs = config.proactive.minGapMs;
      if (typeof config.proactive.everyMs === 'number') this.proactiveEveryMs = config.proactive.everyMs;
    }

    // Connect MCP Servers
    if (config.mcpServers) {
      for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
        this.mcpManager.connect(name, serverConfig as any);
      }
    }

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

  private buildWorkspacePrompt(channel: string) {
    const root = process.cwd();
    const agents = this.readTextFileIfExists(path.join(root, 'AGENTS.md')).trim();
    const user = this.readTextFileIfExists(path.join(root, 'USER.md')).trim();

    const parts: string[] = [];
    if (agents) parts.push(`AGENTS.md:\n${agents}`);
    if (user) parts.push(`USER.md:\n${user}`);

    if (this.isMainSessionChannel(channel)) {
      const memory = this.readTextFileIfExists(path.join(root, 'MEMORY.md')).trim();
      if (memory) parts.push(`MEMORY.md:\n${memory}`);

      const now = new Date();
      const todayKey = this.formatDateKey(now);
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const yesterdayKey = this.formatDateKey(yesterday);
      const todayDaily = this.readTextFileIfExists(path.join(root, 'memory', `${todayKey}.md`)).trim();
      const yesterdayDaily = this.readTextFileIfExists(path.join(root, 'memory', `${yesterdayKey}.md`)).trim();
      if (yesterdayDaily) parts.push(`memory/${yesterdayKey}.md:\n${yesterdayDaily}`);
      if (todayDaily) parts.push(`memory/${todayKey}.md:\n${todayDaily}`);
    }

    if (parts.length === 0) return '';

    // Add task context for auto-resume
    let result = `\n\nWorkspace Context:\n${parts.join('\n\n')}\n`;

    const taskSummary = taskContext.getSummaryPrompt();
    if (taskSummary) {
      result += `\n${taskSummary}`;
    }

    return result;
  }

  private loadConfig(): any {
    let config: any = { model: 'mock' };
    if (fs.existsSync('config.json')) {
      try {
        config = JSON.parse(fs.readFileSync('config.json', 'utf-8'));
      } catch (e) {
        console.error('[AgentRunner] Failed to load config.json', e);
      }
    }
    return config;
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
    const autoCompactEnabled = autoCompactCfg === true
      || (typeof autoCompactCfg === 'object' && autoCompactCfg.enabled !== false);

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

  // Helper to get the current model based on config/env at runtime
  private getModel(): ModelProvider {
    // 1. Check ModelRegistry for a specifically selected model (e.g. from Web UI)
    const currentModelId = ModelRegistry.getCurrentModelId();
    if (currentModelId && currentModelId !== 'mock') {
      const model = ModelRegistry.get(currentModelId);
      if (model) {
        console.log(`[AgentRunner] Using registry-selected model: ${currentModelId}`);
        return model;
      }
    }

    // 2. Fallback to Legacy Provider Logic (from config.json)
    const config = this.loadConfig();
    console.log(`[AgentRunner] Selecting model from config. Config: ${config.model}`);
    const modelKey = String(config.model || '').trim().toLowerCase();

    // Check OpenRouter
    if (modelKey === 'openrouter') {
      if (process.env.OPENROUTER_API_KEY) {
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
        const provider = new OpenRouterProvider(process.env.OPENROUTER_API_KEY, aiModel);
        ModelRegistry.register(provider);
        return provider;
      } else {
        console.warn('[AgentRunner] Config is OpenRouter but OPENROUTER_API_KEY is missing.');
        return {
          id: 'error',
          name: 'Error',
          generate: async () => ({
            content: "⚠️ **Configuration Error**: You selected 'OpenRouter' but no API Key was found. Please go to Settings and enter your OpenRouter API Key."
          })
        };
      }
    }

    if (modelKey === 'nvidia') {
      if (process.env.NVIDIA_API_KEY) {
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
        const provider = new NvidiaProvider(process.env.NVIDIA_API_KEY, aiModel, enableThinking);
        ModelRegistry.register(provider);
        return provider;
      } else {
        console.warn('[AgentRunner] Config is NVIDIA but NVIDIA_API_KEY is missing.');
        return {
          id: 'error',
          name: 'Error',
          generate: async () => ({
            content: "⚠️ **Configuration Error**: You selected 'NVIDIA' but no API Key was found. Please set NVIDIA_API_KEY in .env."
          })
        };
      }
    }

    // Fallback to mock
    console.log('[AgentRunner] No specific model selected, falling back to Mock');
    return ModelRegistry.get('mock')!;
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
    }, this.heartbeatMs);

    // Start background worker with goal executor
    backgroundWorker.setExecutor(async (goal, progressCallback) => {
      progressCallback(10, 'Starting goal execution...');
      const model = this.getModel();
      const prompt = `You are working on a background task autonomously.\n\nGoal: ${goal.title}\n\nDescription: ${goal.description}\n\nTags: ${goal.tags.join(', ') || 'none'}\n\nWork on this goal step by step. When done, provide a summary of what was accomplished.`;
      const response = await model.generate(prompt, this.baseSystemPrompt, []);
      progressCallback(100, 'Goal completed');
      return response.content || 'Task completed';
    });
    backgroundWorker.setOnComplete(async (goal) => {
      await this.gateway.sendResponse(goal.sessionId, `✅ **Background task completed:** ${goal.title}\n\n${goal.result || 'Done'}`);
    });
    backgroundWorker.setOnReport(async (sessionId, message) => {
      await this.gateway.sendResponse(sessionId, message);
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

  async processMessage(sessionId: string, msg: Message) {
    console.log(`[AgentRunner] Processing message for session ${sessionId}`);

    // Track user activity for background worker idle detection
    backgroundWorker.recordActivity(sessionId);

    // Flush any queued DND notifications when user becomes active
    const pendingNotifications = dndManager.flushQueue(sessionId);
    if (pendingNotifications.length > 0) {
      const summary = pendingNotifications.map(n => `• ${n.message}`).join('\n');
      await this.gateway.sendResponse(sessionId, `📬 **${pendingNotifications.length} notifications while you were away:**\n\n${summary}`);
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

    if (await this.handleDeepResearchCommand(sessionId, msg)) {
      return;
    }

    // 1. Add User Message to Memory
    this.memory.add(sessionId, {
      role: 'user',
      content: msg.content,
      timestamp: Date.now(),
      metadata: msg.metadata
    });

    // 2. Fetch Tools (MCP + Native Skills)
    let allTools: any[] = [];

    try {
      const mcpTools = await this.mcpManager.listTools();
      allTools = allTools.concat(mcpTools);
    } catch (e) {
      console.error('[AgentRunner] Failed to list MCP tools:', e);
    }

    const skills = SkillRegistry.getAll();
    skills.forEach(skill => {
      if (skill.inputSchema) {
        allTools.push({
          name: skill.name,
          description: skill.description,
          inputSchema: skill.inputSchema
        });
      }
    });

    // Check for legacy skill triggers
    let context = "";
    if (msg.content.includes('/sys')) {
      const skill = SkillRegistry.get('system_info');
      if (skill) {
        const result = await skill.execute({});
        context += `\n[System Info]: ${JSON.stringify(result)}`;
      }
    }

    // Multi-turn Loop for Tool Execution
    const config = this.loadConfig();
    const agentConfig = config?.agent ?? {};
    const configuredMaxTurnsRaw =
      typeof config?.agent?.maxTurns === "number"
        ? config.agent.maxTurns
        : (typeof config?.maxTurns === "number" ? config.maxTurns : undefined);
    const hasConfiguredMaxTurns = Number.isFinite(configuredMaxTurnsRaw);
    const unlimitedTurns = hasConfiguredMaxTurns && Number(configuredMaxTurnsRaw) <= 0;
    const maxTurns = unlimitedTurns
      ? Number.POSITIVE_INFINITY
      : (hasConfiguredMaxTurns
        ? Math.min(50, Math.max(1, Math.floor(Number(configuredMaxTurnsRaw))))
        : this.defaultMaxTurns);

    const autoContinueCfg = agentConfig.autoContinue;
    const autoContinueEnabled = !unlimitedTurns && (autoContinueCfg === true
      || (typeof autoContinueCfg === "object" && autoContinueCfg.enabled !== false));
    const autoContinueMax = typeof autoContinueCfg === "number"
      ? Math.max(0, Math.floor(autoContinueCfg))
      : (typeof autoContinueCfg?.maxBatches === "number"
        ? Math.max(0, Math.floor(autoContinueCfg.maxBatches))
        : 3);
    const autoContinueNotify = typeof autoContinueCfg?.notify === "boolean"
      ? autoContinueCfg.notify
      : true;

    const initialMemories = this.memory.getAll(sessionId);
    await this.autoCompactSessionIfNeeded(sessionId, config, initialMemories);

    let executedAnyTools = false;
    let stoppedByStepLimit = true;
    let autoContinueCount = 0;
    let continuationBatch = 0;
    for (; ;) {
      stoppedByStepLimit = true;
      for (let i = 0; i < maxTurns; i++) {
        // Smart Context Construction
        const allMemories = this.applyCompactionFilter(this.memory.getAll(sessionId));
        const totalMemories = allMemories.length;
        const recentCount = 10;

        let contextMemories: typeof allMemories = [];

        if (totalMemories <= recentCount + 2) {
          // Short conversation, use everything
          contextMemories = allMemories;
        } else {
          // Long conversation: Pin Goal + Recent
          const firstUserMsg = allMemories.find(m => m.role === "user");
          const recentMemories = allMemories.slice(-recentCount);

          if (firstUserMsg && !recentMemories.includes(firstUserMsg)) {
            contextMemories = [
              firstUserMsg,
              { role: "system", content: `... (Skipped ${totalMemories - recentCount - 1} messages) ...`, timestamp: Date.now() },
              ...recentMemories
            ];
          } else {
            contextMemories = recentMemories;
          }
        }

        // Re-fetch logic for loop i > 0 is handled implicitly because we fetch from memory each time
        // But we must respect the 'current state' if we just added things in previous iterations of THIS loop
        // The `this.memory.get` fetches the latest state including what we just added.
        // However, for the *very first* message (Goal), we want to make sure it's labeled clearly if we are skipping.

        // Truncate function for context
        const truncateForContext = (content: string, maxLen: number = 20000) => {
          if (content.length <= maxLen) return content;
          return content.slice(0, maxLen) + `\n... [Truncated ${content.length - maxLen} chars] ...`;
        };

        const currentHistoryText = contextMemories.map((m, index) => {
          const truncatedContent = truncateForContext(m.content);
          if (m.role === "user") {
            return (index === 0 && totalMemories > recentCount) ? `User (Original Goal): ${truncatedContent}` : `User: ${truncatedContent}`;
          }
          if (m.role === "assistant") return `Assistant: ${truncatedContent}`;
          if (m.role === "system") return `System: ${truncatedContent}`;
          return `System: ${truncatedContent}`;
        }).join('\n');

        // Dynamic Identity Injection
        const agentName = config.name || "Gitu";
        let systemPrompt = this.baseSystemPrompt.replace("{{AGENT_NAME}}", agentName);
        systemPrompt += this.buildWorkspacePrompt(msg.channel);
        systemPrompt += `\n\n${this.buildTimePrompt()}`;

        // User Context Injection
        const lastUserMsg = [...allMemories].reverse().find(m => m.role === "user");
        const username = lastUserMsg?.metadata?.username || msg.metadata?.username || "User";
        systemPrompt += `\n\nYou are speaking with ${username}.`;

        const prompt = `
Previous Conversation:
${currentHistoryText}

${i === 0 && continuationBatch === 0 ? `Current User Input: ${msg.content}` : '(Continuing execution...)'}
${context ? `\nSystem Context: ${context}` : ''}
`;

        // Inject Long-Term Memory (Scratchpad)
        const notesSummary = scratchpad.getSummary();
        if (notesSummary) {
          systemPrompt += `\n\n${notesSummary}`;
        }

        // Apply thinking level enhancement
        const thinkingPrompt = thinkingManager.getThinkingPrompt(sessionId);
        const enhancedSystemPrompt = thinkingPrompt
          ? `${systemPrompt}\n\n[Thinking Mode: ${thinkingPrompt}]`
          : systemPrompt;
        const planPrompt = planModeManager.getPlanPrompt(sessionId);
        const finalSystemPrompt = planPrompt
          ? `${enhancedSystemPrompt}\n\n${planPrompt}`
          : enhancedSystemPrompt;

        // Call Model (Dynamic Selection)
        const currentModel = this.getModel();

        // STREAMING LOGIC
        let response;
        if (currentModel.generateStream) {
          let streamedAnyChunk = false;
          response = await currentModel.generateStream(prompt, finalSystemPrompt, allTools, (chunk) => {
            if (!chunk) return;
            streamedAnyChunk = true;
            void this.gateway.sendStreamChunk(sessionId, chunk);
          });
          if (!streamedAnyChunk && response?.content) {
            await this.gateway.sendResponse(sessionId, response.content);
          }
        } else {
          // Fallback for non-streaming models
          response = await currentModel.generate(prompt, finalSystemPrompt, allTools);
          if (!currentModel.generateStream) {
            await this.gateway.sendResponse(sessionId, response.content || "");
          }
        }

        // Handle Content (Save to Memory)
        if (response.content) {
          this.memory.add(sessionId, {
            role: "assistant",
            content: response.content,
            timestamp: Date.now()
          });
        }

        // Handle Tool Calls
        if (response.toolCalls && response.toolCalls.length > 0) {
          console.log(`[AgentRunner] Executing ${response.toolCalls.length} tools in parallel...`);
          await this.gateway.sendResponse(sessionId, `${DEBUG_PREFIX} 🛠️ Executing ${response.toolCalls.length} tools...`);
          executedAnyTools = true;

          // Map each tool call to a Promise
          const toolPromises = response.toolCalls.map(async (call) => {
            try {
              let output;
              const nativeSkill = SkillRegistry.get(call.name);

              if (nativeSkill) {
                const args = { ...(call.arguments || {}), __sessionId: sessionId };
                if (call.name === "shell") {
                  (args as any).__stream = (chunk: string) => {
                    if (chunk) {
                      void this.gateway.sendStreamChunk(sessionId, chunk);
                    }
                  };
                }
                output = JSON.stringify(await nativeSkill.execute(args));
              } else {
                const result = await this.mcpManager.callTool(call.name, call.arguments);
                output = JSON.stringify(result);
              }

              return {
                success: true,
                call: call,
                output: output
              };
            } catch (err: any) {
              return {
                success: false,
                call: call,
                error: err.message
              };
            }
          });

          // Wait for all tools to finish
          const results = await Promise.all(toolPromises);

          // Process results
          for (const result of results) {
            if (result.success) {
              this.memory.add(sessionId, {
                role: "system",
                content: `Tool '${result.call.name}' Output: ${result.output}`,
                timestamp: Date.now()
              });
            } else {
              this.memory.add(sessionId, {
                role: "system",
                content: `Tool '${result.call.name}' Error: ${result.error}`,
                timestamp: Date.now()
              });
            }
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
                  if (results.length === 0) return "";
                  const labelParts: string[] = [];
                  if (entry?.agentName) labelParts.push(String(entry.agentName));
                  if (entry?.agentId) labelParts.push(String(entry.agentId));
                  const agentLabel = labelParts.join(" • ");
                  return formatAgentResults(agentLabel, results);
                }).filter(Boolean);
                if (sections.length > 0) {
                  messages.push(sections.join("\n\n"));
                }
                continue;
              }

              const results = Array.isArray(payload.results) ? payload.results : [];
              if (results.length === 0) continue;

              const agentId = String(result.call?.arguments?.agentId || payload.agentId || "").trim();
              let agentLabel = "";
              if (agentId) {
                const agent = agentSwarm.getAgent(agentId);
                agentLabel = agent?.name ? `${agent.name} • ${agentId}` : agentId;
              }

              const message = formatAgentResults(agentLabel, results);
              if (message) messages.push(message);
            }
            return messages;
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
            const cwd = process.cwd();
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

          const formatToolResult = (result: any) => {
            if (result.call?.name === "shell") {
              const rendered = formatShellResult(result);
              return `${result.success ? "✅" : "❌"} shell\n${rendered}`;
            }
            if (result.success) {
              return `✅ ${result.call.name}\n${String(result.output)}`;
            }
            return `❌ ${result.call.name}\n${String(result.error || "Unknown error")}`;
          };

          const agentResultMessages = buildAgentResultMessages(results);

          let toolOutputText = results.map((r) => {
            const formatted = formatToolResult(r);
            return ensureClosedCodeFences(formatted);
          }).join("\n\n");

          toolOutputText = ensureClosedCodeFences(toolOutputText);
          await this.gateway.sendResponse(sessionId, `${DEBUG_PREFIX}\n${toolOutputText}`);
          for (const message of agentResultMessages) {
            if (message && message.trim()) {
              await this.gateway.sendResponse(sessionId, message);
            }
          }

          // Continue loop to let model interpret results
        } else {
          const text = (response.content || "").trim();
          if (!text && executedAnyTools) {
            await this.gateway.sendResponse(
              sessionId,
              'Automation paused without a final message. Send "continue" to keep going, or describe the next step you want.'
            );
          }
          stoppedByStepLimit = false;
          break;
        }
      }

      if (!stoppedByStepLimit) {
        break;
      }

      if (autoContinueEnabled && autoContinueCount < autoContinueMax) {
        autoContinueCount += 1;
        continuationBatch += 1;
        if (autoContinueNotify) {
          await this.gateway.sendResponse(
            sessionId,
            `🔁 Auto-continue (${autoContinueCount}/${autoContinueMax})...`
          );
        }
        const updatedMemories = this.memory.getAll(sessionId);
        await this.autoCompactSessionIfNeeded(sessionId, config, updatedMemories);
        continue;
      }

      await this.gateway.sendResponse(
        sessionId,
        `Automation step limit reached (${maxTurns}). Send "continue" to keep going, or increase config.agent.maxTurns in config.json.`
      );
      break;
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
      const lines = jobs.map(j => `${j.enabled ? '✅' : '⏸️'} ${j.id} @ ${new Date(j.runAt).toLocaleString()}${j.intervalMs ? ` every ${Math.round(j.intervalMs / 1000)}s` : ''} :: ${j.prompt}`);
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
      void this.gateway.sendResponse(sessionId, `🎯 **Goal queued:** ${goal.title}\n\nThis will run automatically when you're idle.`);
      return true;
    }

    // /goals - list pending goals
    if (trimmed.toLowerCase() === '/goals') {
      const pending = backgroundWorker.getPendingGoals(sessionId);
      const active = backgroundWorker.getActiveGoals();

      if (pending.length === 0 && active.length === 0) {
        void this.gateway.sendResponse(sessionId, '📋 No background goals. Use `/goal <title> - <description>` to add one.');
        return true;
      }

      let response = '';
      if (active.length > 0) {
        response += '**🟢 Active:**\n';
        response += active.map(g => `• ${g.title} (${g.progress}%)`).join('\n');
        response += '\n\n';
      }
      if (pending.length > 0) {
        response += '**⏳ Pending:**\n';
        response += pending.map(g => `• [${g.priority}] ${g.title}`).join('\n');
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
          const model = this.getModel();
          await this.gateway.sendResponse(sessionId, `💭 *${agent.displayName} is thinking...*`);

          try {
            const response = await model.generate(prompt, agentSystemPrompt, []);
            const agentResponse = response.content || 'I have no response.';

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

    await this.gateway.sendResponse(sessionId, `ðŸ” Deep research started for: **${query}**`);

    const skill = new DeepResearchSkill();
    const data = await skill.execute({ query, maxSources: 5, maxImages: 4, maxFetchChars: 6000 });
    if (data?.error) {
      await this.gateway.sendResponse(sessionId, `âŒ Deep research failed: ${data.error}`);
      return true;
    }

    const sources = Array.isArray(data?.sources) ? data.sources : [];
    const images = Array.isArray(data?.images) ? data.images : [];
    const warnings = Array.isArray(data?.warnings) ? data.warnings : [];

    if (sources.length === 0) {
      await this.gateway.sendResponse(sessionId, 'âŒ Deep research found no sources. Try a different query.');
      return true;
    }

    const truncate = (text: string, max: number) => {
      if (!text) return '';
      if (text.length <= max) return text;
      return text.slice(0, max) + `\n... [Truncated ${text.length - max} chars] ...`;
    };

    const sourceText = sources.map((s: any, i: number) => {
      const idx = i + 1;
      const title = s.title || 'Untitled';
      const url = s.url || '';
      const snippet = s.snippet ? `Snippet: ${s.snippet}` : '';
      const extract = s.content ? `Extract:\n${truncate(String(s.content), 1200)}` : '';
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
      'You are in deep research mode.',
      'Use only the provided sources and images.',
      'Include citations like [1], [2] for factual statements.',
      'Provide sections: Executive Summary, Key Findings, Details, Images, Sources.',
      'In Images, list each image with caption and URL on its own line.',
      'Keep the output clean and readable for chat apps.'
    ].join(' ');

    let systemPrompt = this.baseSystemPrompt;
    systemPrompt += this.buildWorkspacePrompt(msg.channel);
    systemPrompt += `\n\n${this.buildTimePrompt()}`;
    const username = msg.metadata?.username || 'User';
    systemPrompt += `\n\nYou are speaking with ${username}.`;

    const planPrompt = planModeManager.getPlanPrompt(sessionId);
    const finalSystemPrompt = planPrompt ? `${systemPrompt}\n\n${planPrompt}` : systemPrompt;

    const prompt = `${researchInstructions}\n\nTopic: ${query}\n\n${warningText}Sources:\n${sourceText}\n\nImages:\n${imageText}`;

    const currentModel = this.getModel();
    let response: any;
    if (currentModel.generateStream) {
      let streamedAnyChunk = false;
      response = await currentModel.generateStream(prompt, finalSystemPrompt, [], (chunk) => {
        if (!chunk) return;
        streamedAnyChunk = true;
        void this.gateway.sendStreamChunk(sessionId, chunk);
      });
      if (!streamedAnyChunk && response?.content) {
        await this.gateway.sendResponse(sessionId, response.content);
      }
    } else {
      response = await currentModel.generate(prompt, finalSystemPrompt, []);
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
