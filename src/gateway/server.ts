import { ChannelAdapter, Message, Session, MediaPayload, StreamEventPayload } from '../core/types';
import { AgentRunner } from '../agents/runner';
import { elevatedManager } from '../core/elevated';
import { thinkingManager } from '../core/thinking';
import { planModeManager } from '../core/plan-mode';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { scratchpad } from '../core/scratchpad';
import { stripShellStreamMarker } from '../core/stream-markers';

export const buildStableSessionId = (userId: string, channel: string): string => {
  const digest = crypto
    .createHash('sha256')
    .update(`${channel}:${userId}`)
    .digest('hex')
    .slice(0, 24);
  return `session_${digest}`;
};

export class Gateway {
  private channels: Map<string, ChannelAdapter> = new Map();
  private sessions: Map<string, Session> = new Map();
  private agentRunner: AgentRunner;
  private streamFallbackBySessionId: Map<
    string,
    { buffer: string; timer: NodeJS.Timeout | null }
  > = new Map();

  constructor() {
    this.agentRunner = new AgentRunner(this);
  }

  registerChannel(channel: ChannelAdapter) {
    this.channels.set(channel.name, channel);
    channel.onMessage((msg) => this.handleMessage(msg));
    console.log(`[Gateway] Registered channel: ${channel.name}`);
  }

  async start() {
    console.log('[Gateway] Starting control plane...');
    for (const channel of this.channels.values()) {
      channel.start();
    }
    this.agentRunner.startLoop();
  }

  private async handleMessage(msg: Message) {
    console.log(`[Gateway] Received from ${msg.channel}: ${msg.content}`);

    let sessionId = this.findSession(msg.senderId, msg.channel);
    if (!sessionId) {
      sessionId = this.createSession(msg.senderId, msg.channel);
    }

    // API requests (OpenAI-compat/batch/connector/editor) mint a fresh session per
    // call; tear it down on every exit path (including the directive early
    // returns below) so the sessions map cannot grow unbounded.
    const isEphemeralApiSession = Boolean(msg.metadata?.api);
    try {
    // Initialize elevated session state
    elevatedManager.initSession(sessionId, msg.senderId, msg.channel);

    // Check for elevated directive
    const directive = elevatedManager.parseDirective(msg.content);
    if (directive) {
      if (directive.isQuery) {
        // Query current level
        const status = elevatedManager.getStatusString(sessionId);
        await this.sendResponse(sessionId, `Current elevated status: ${status}`);
        return;
      } else {
        // Set level
        const result = elevatedManager.setLevel(sessionId, directive.level, msg.senderId, msg.channel);
        await this.sendResponse(sessionId, result.message);
        return;
      }
    }

    // Check for /fs command
    if (msg.content.startsWith('/fs ')) {
      const mode = msg.content.substring(4).trim().toLowerCase();
      if (mode === 'project' || mode === 'full') {
        try {
          let config: any = {};
          if (fs.existsSync('config.json')) {
            config = JSON.parse(fs.readFileSync('config.json', 'utf-8'));
          }

          config.filesystemMode = mode;

          // Update MCP args (guard against an empty args array)
          if (config.mcpServers && config.mcpServers.filesystem) {
            const fsArgs = config.mcpServers.filesystem.args;
            if (Array.isArray(fsArgs) && fsArgs.length > 0) {
              if (mode === 'full') {
                const platformRoot = path.parse(process.cwd()).root || '/';
                fsArgs[fsArgs.length - 1] = platformRoot;
              } else {
                fsArgs[fsArgs.length - 1] = './';
              }
            }
          }

          // Atomic write so a crash mid-save cannot corrupt config.json
          const tmpPath = 'config.json.tmp';
          fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2));
          fs.renameSync(tmpPath, 'config.json');
          await this.sendResponse(sessionId, `✅ Filesystem mode set to **${mode}**.\n\n⚠️ **Restart Required**: Please restart the application to apply changes.`);
        } catch (e: any) {
          await this.sendResponse(sessionId, `❌ Failed to update config: ${e.message}`);
        }
      } else {
        await this.sendResponse(sessionId, `Usage: /fs [project|full]`);
      }
      return;
    }

    // Scratchpad Commands
    if (msg.content.startsWith('/remember ')) {
      const rest = msg.content.substring(10).trim();
      const eqIndex = rest.indexOf('=');
      if (eqIndex > 0) {
        const key = rest.substring(0, eqIndex).trim();
        const value = rest.substring(eqIndex + 1).trim();
        scratchpad.set(key, value);
        await this.sendResponse(sessionId, `✅ Remembered: **${key}** = "${value}"`);
      } else {
        await this.sendResponse(sessionId, `Usage: /remember <key> = <value>`);
      }
      return;
    }

    if (msg.content.startsWith('/recall ')) {
      const key = msg.content.substring(8).trim();
      const value = scratchpad.get(key);
      if (value) {
        await this.sendResponse(sessionId, `📝 **${key}**: ${value}`);
      } else {
        await this.sendResponse(sessionId, `❌ No note found for "${key}"`);
      }
      return;
    }

    if (msg.content.startsWith('/forget ')) {
      const key = msg.content.substring(8).trim();
      if (scratchpad.delete(key)) {
        await this.sendResponse(sessionId, `🗑️ Forgot: **${key}**`);
      } else {
        await this.sendResponse(sessionId, `❌ No note found for "${key}"`);
      }
      return;
    }

    if (msg.content.trim() === '/notes') {
      const notes = scratchpad.list();
      const keys = Object.keys(notes);
      if (keys.length === 0) {
        await this.sendResponse(sessionId, `📒 No notes saved yet. Use /remember <key> = <value>`);
      } else {
        let response = '📒 **Your Notes:**\n';
        for (const key of keys) {
          response += `- **${key}**: ${notes[key]}\n`;
        }
        await this.sendResponse(sessionId, response);
      }
      return;
    }

    // Check for thinking/verbose/reasoning directive
    const thinkingResult = thinkingManager.handleDirective(sessionId, msg.content);
    if (thinkingResult.handled) {
      await this.sendResponse(sessionId, thinkingResult.message || 'OK');
      return;
    }
    const planResult = planModeManager.handleDirective(sessionId, msg.content);
    if (planResult.handled) {
      await this.sendResponse(sessionId, planResult.message || 'OK');
      return;
    }

    try {
      await this.agentRunner.processMessage(sessionId, msg);
    } catch (error: any) {
      const status = Number(error?.status || error?.code || 0);
      const cleanDetail = String(error?.message || '').trim().replace(/\s+/g, ' ');
      const strippedDetail = cleanDetail
        .replace(/^All configured model providers failed\.\s*/i, '')
        .replace(/^all configured model providers failed\.\s*/i, 'All model providers failed: ');
      const hasDetail = strippedDetail.length > 2;
      let errorText: string;
      if (status === 429) {
        errorText = 'The AI provider has reached its current rate limit. Switch to another configured model or try again after the quota resets.';
      } else if (hasDetail) {
        errorText = `I ran into a problem while working on that request: ${strippedDetail.length > 280 ? `${strippedDetail.slice(0, 280).trimEnd()}…` : strippedDetail}`;
      } else {
        errorText = 'I hit an unexpected error while working on that request. The task stopped safely instead of leaving the interface waiting.';
      }
      console.error('[Gateway] Agent request failed:', error);
      if (this.supportsStructuredStreaming(sessionId)) {
        await this.sendStreamEvent(sessionId, {
          type: 'assistant_error',
          runId: `error-${Date.now()}`,
          messageId: `error-${Date.now()}`,
          error: errorText,
          text: errorText,
          status: 'failed'
        });
      } else {
        await this.sendResponse(sessionId, errorText);
      }
    }
    } finally {
      if (isEphemeralApiSession) {
        this.sessions.delete(sessionId);
      }
    }
  }

  private findSession(userId: string, channel: string): string | undefined {
    for (const [id, session] of this.sessions.entries()) {
      if (session.userId === userId && session.channel === channel) return id;
    }
    return undefined;
  }

  private createSession(userId: string, channel: string): string {
    // Session IDs must survive process restarts or the durable memory rows become
    // unreachable on every launch. Channel + sender is stable for console,
    // messaging users, and project-scoped web chats.
    const id = buildStableSessionId(userId, channel);
    this.sessions.set(id, {
      id,
      userId,
      channel,
      context: []
    });
    // Hard cap: evict the oldest session if the map ever grows too large.
    if (this.sessions.size > 2000) {
      const oldest = this.sessions.keys().next().value;
      if (oldest) this.sessions.delete(oldest);
    }
    console.log(`[Gateway] Created new session ${id} for user ${userId}`);
    return id;
  }

  async sendResponse(sessionId: string, text: string) {
    const session = this.sessions.get(sessionId);
    if (session) {
      const channel = this.channels.get(session.channel);
      if (channel) {
        channel.send(session.userId, text);
      }
    }
  }

  async sendMedia(sessionId: string, media: MediaPayload) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const channel = this.channels.get(session.channel);
    if (channel?.sendMedia) {
      channel.sendMedia(session.userId, media);
      return;
    }

    const caption = media.caption ? media.caption.trim() : '';
    if (media.url) {
      await this.sendResponse(sessionId, caption ? `${caption}\n${media.url}` : media.url);
      return;
    }
    if (media.path) {
      await this.sendResponse(sessionId, caption ? `${caption}\n${media.path}` : media.path);
    } else if (caption) {
      await this.sendResponse(sessionId, caption);
    }
  }

  // New method for streaming
  async sendStreamChunk(sessionId: string, chunk: string) {
    const session = this.sessions.get(sessionId);
    if (session) {
      const channel = this.channels.get(session.channel);
      if (channel && channel.sendStream) {
        channel.sendStream(session.userId, chunk);
        return;
      }
      if (channel && chunk) {
        const cleaned = stripShellStreamMarker(chunk).chunk;
        if (!cleaned) return;
        let state = this.streamFallbackBySessionId.get(sessionId);
        if (!state) {
          state = { buffer: '', timer: null };
          this.streamFallbackBySessionId.set(sessionId, state);
        }
        state.buffer += cleaned;
        if (state.timer) clearTimeout(state.timer);
        state.timer = setTimeout(() => {
          const text = state?.buffer || '';
          if (text.trim()) {
            void this.sendResponse(sessionId, text);
          }
          if (state) {
            state.buffer = '';
            state.timer = null;
          }
        }, 1000);
      }
    }
  }

  async sendStreamEvent(sessionId: string, event: StreamEventPayload) {
    const session = this.sessions.get(sessionId);
    if (session) {
      const channel = this.channels.get(session.channel);
      if (channel && channel.sendStreamEvent) {
        channel.sendStreamEvent(session.userId, event);
      }
    }
  }

  supportsStructuredStreaming(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    return Boolean(this.channels.get(session.channel)?.sendStreamEvent);
  }

  listSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }
}
