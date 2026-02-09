import { ChannelAdapter, Message, Session } from '../core/types';
import { AgentRunner } from '../agents/runner';
import { elevatedManager } from '../core/elevated';
import { thinkingManager } from '../core/thinking';
import { planModeManager } from '../core/plan-mode';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import { scratchpad } from '../core/scratchpad';

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

    let sessionId = this.findSession(msg.senderId);
    if (!sessionId) {
      sessionId = this.createSession(msg.senderId, msg.channel);
    }

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

          // Update MCP args
          if (config.mcpServers && config.mcpServers.filesystem) {
            const fsArgs = config.mcpServers.filesystem.args;
            if (mode === 'full') {
              fsArgs[fsArgs.length - 1] = 'c:/';
            } else {
              fsArgs[fsArgs.length - 1] = './';
            }
          }

          fs.writeFileSync('config.json', JSON.stringify(config, null, 2));
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

    await this.agentRunner.processMessage(sessionId, msg);
  }

  private findSession(userId: string): string | undefined {
    for (const [id, session] of this.sessions.entries()) {
      if (session.userId === userId) return id;
    }
    return undefined;
  }

  private createSession(userId: string, channel: string): string {
    const id = uuidv4();
    this.sessions.set(id, {
      id,
      userId,
      channel,
      context: []
    });
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
        let state = this.streamFallbackBySessionId.get(sessionId);
        if (!state) {
          state = { buffer: '', timer: null };
          this.streamFallbackBySessionId.set(sessionId, state);
        }
        state.buffer += chunk;
        if (state.buffer.length > 12000) {
          state.buffer = state.buffer.slice(state.buffer.length - 12000);
        }
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

  listSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }
}
