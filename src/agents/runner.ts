import { Message } from '../core/types';
import { ModelProvider, ModelRegistry } from '../core/models';
import { SkillRegistry } from '../core/skills';
import { MemoryManager } from '../core/memory';
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
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

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

  // Helper to get the current model based on config/env at runtime
  private getModel(): ModelProvider {
    // Reload config to get latest model selection
    const config = this.loadConfig();

    console.log(`[AgentRunner] Selecting model. Config: ${config.model}`);
    const modelKey = String(config.model || '').trim().toLowerCase();

    // Check OpenRouter
    if (modelKey === 'openrouter') {
      // Re-check env var in case it was updated
      if (process.env.OPENROUTER_API_KEY) {
        // Prioritize Env Var > Config > Default
        const aiModel = process.env.OPENROUTER_MODEL || config.aiModel || 'google/gemini-2.0-flash-lite-preview-02-05:free';
        console.log(`[AgentRunner] Using OpenRouter with model: ${aiModel}`);
        // Ensure registry has it (idempotent-ish, updates model ID)
        ModelRegistry.register(new OpenRouterProvider(process.env.OPENROUTER_API_KEY, aiModel));
        return ModelRegistry.get('openrouter')!;
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
        const aiModel = config.aiModel || 'moonshotai/kimi-k2.5';
        const enableThinking = typeof config?.nvidia?.thinking === 'boolean' ? config.nvidia.thinking : true;
        console.log(`[AgentRunner] Using NVIDIA with model: ${aiModel}`);
        ModelRegistry.register(new NvidiaProvider(process.env.NVIDIA_API_KEY, aiModel, enableThinking));
        return ModelRegistry.get('nvidia')!;
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
    console.log('[AgentRunner] Using Mock Provider');
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
    const configuredMaxTurnsRaw =
      typeof config?.agent?.maxTurns === 'number'
        ? config.agent.maxTurns
        : (typeof config?.maxTurns === 'number' ? config.maxTurns : undefined);
    const maxTurns = Number.isFinite(configuredMaxTurnsRaw)
      ? Math.min(50, Math.max(1, Math.floor(configuredMaxTurnsRaw)))
      : this.defaultMaxTurns;

    let executedAnyTools = false;
    let stoppedByStepLimit = true;
    for (let i = 0; i < maxTurns; i++) {
      // Smart Context Construction
      const allMemories = this.memory.get(sessionId);
      const totalMemories = allMemories.length;
      const recentCount = 10;

      let contextMemories: typeof allMemories = [];

      if (totalMemories <= recentCount + 2) {
        // Short conversation, use everything
        contextMemories = allMemories;
      } else {
        // Long conversation: Pin Goal + Recent
        const firstUserMsg = allMemories.find(m => m.role === 'user');
        const recentMemories = allMemories.slice(-recentCount);

        if (firstUserMsg && !recentMemories.includes(firstUserMsg)) {
          contextMemories = [
            firstUserMsg,
            { role: 'system', content: `... (Skipped ${totalMemories - recentCount - 1} messages) ...`, timestamp: Date.now() },
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
        if (m.role === 'user') {
          return (index === 0 && totalMemories > recentCount) ? `User (Original Goal): ${truncatedContent}` : `User: ${truncatedContent}`;
        }
        if (m.role === 'assistant') return `Assistant: ${truncatedContent}`;
        if (m.role === 'system') return `System: ${truncatedContent}`;
        return `System: ${truncatedContent}`;
      }).join('\n');

      // Dynamic Identity Injection
      const agentName = config.name || "Gitubot";
      let systemPrompt = this.baseSystemPrompt.replace('{{AGENT_NAME}}', agentName);
      systemPrompt += this.buildWorkspacePrompt(msg.channel);

      // User Context Injection
      const lastUserMsg = [...allMemories].reverse().find(m => m.role === 'user');
      const username = lastUserMsg?.metadata?.username || msg.metadata?.username || 'User';
      systemPrompt += `\n\nYou are speaking with ${username}.`;

      const prompt = `
Previous Conversation:
${currentHistoryText}

${i === 0 ? `Current User Input: ${msg.content}` : '(Continuing execution...)'}
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

      // Call Model (Dynamic Selection)
      const currentModel = this.getModel();

      // STREAMING LOGIC
      let response;
      if (currentModel.generateStream) {
        let streamedAnyChunk = false;
        response = await currentModel.generateStream(prompt, enhancedSystemPrompt, allTools, (chunk) => {
          if (!chunk) return;
          streamedAnyChunk = true;
          void this.gateway.sendStreamChunk(sessionId, chunk);
        });
        if (!streamedAnyChunk && response?.content) {
          await this.gateway.sendResponse(sessionId, response.content);
        }
      } else {
        // Fallback for non-streaming models
        response = await currentModel.generate(prompt, enhancedSystemPrompt, allTools);
        if (!currentModel.generateStream) {
          await this.gateway.sendResponse(sessionId, response.content || '');
        }
      }

      // Handle Content (Save to Memory)
      if (response.content) {
        this.memory.add(sessionId, {
          role: 'assistant',
          content: response.content,
          timestamp: Date.now()
        });
      }

      // Handle Tool Calls
      if (response.toolCalls && response.toolCalls.length > 0) {
        console.log(`[AgentRunner] Executing ${response.toolCalls.length} tools in parallel...`);
        await this.gateway.sendResponse(sessionId, `🛠️ Executing ${response.toolCalls.length} tools...`);
        executedAnyTools = true;

        // Map each tool call to a Promise
        const toolPromises = response.toolCalls.map(async (call) => {
          try {
            let output;
            const nativeSkill = SkillRegistry.get(call.name);

            if (nativeSkill) {
              output = JSON.stringify(await nativeSkill.execute({ ...(call.arguments || {}), __sessionId: sessionId }));
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
              role: 'system',
              content: `Tool '${result.call.name}' Output: ${result.output}`,
              timestamp: Date.now()
            });
          } else {
            this.memory.add(sessionId, {
              role: 'system',
              content: `Tool '${result.call.name}' Error: ${result.error}`,
              timestamp: Date.now()
            });
          }
        }

        const truncate = (value: string, max: number) => {
          if (value.length <= max) return value;
          return value.slice(0, max) + `\n... (truncated ${value.length - max} chars)`;
        };

        const maxPerTool = 1500;
        const maxTotal = 3500;
        let toolOutputText = results.map((r) => {
          if (r.success) return `✅ ${r.call.name}\n${truncate(String(r.output), maxPerTool)}`;
          return `❌ ${r.call.name}\n${truncate(String(r.error || 'Unknown error'), maxPerTool)}`;
        }).join('\n\n');

        toolOutputText = truncate(toolOutputText, maxTotal);
        await this.gateway.sendResponse(sessionId, toolOutputText);

        // Continue loop to let model interpret results
      } else {
        const text = (response.content || '').trim();
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

    if (stoppedByStepLimit) {
      await this.gateway.sendResponse(
        sessionId,
        `Automation step limit reached (${maxTurns}). Send "continue" to keep going, or increase config.agent.maxTurns in config.json.`
      );
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
}
