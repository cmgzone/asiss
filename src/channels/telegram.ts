import { ChannelAdapter, Message } from '../core/types';
import { Telegraf } from 'telegraf';
import { v4 as uuidv4 } from 'uuid';
import { stripShellStreamMarker } from '../core/stream-markers';

export class TelegramChannel implements ChannelAdapter {
  name = 'telegram';
  private bot: Telegraf;
  private handler: ((msg: Message) => void) | null = null;
  private isStarted = false;
  private streamByUserId: Map<
    string,
    {
      buffer: string;
      timer: NodeJS.Timeout | null;
      messageId?: number;
      lastSentText?: string;
    }
  > = new Map();

  constructor(token: string) {
    this.bot = new Telegraf(token);
    
    this.bot.on('text', (ctx) => {
      if (this.handler) {
        // Map Telegram message to our internal Message format
        const chatId = ctx.chat?.id;
        if (chatId === undefined || chatId === null) return;
        const msg: Message = {
          id: ctx.message.message_id.toString(),
          channel: 'telegram',
          senderId: chatId.toString(),
          content: ctx.message.text,
          timestamp: ctx.message.date * 1000,
          metadata: {
            chatId,
            fromId: ctx.from?.id,
            username: ctx.from?.username,
            firstName: ctx.from?.first_name
          }
        };
        this.handler(msg);
      }
    });

    // Handle errors to prevent crash
    this.bot.catch((err) => {
        console.error('[TelegramChannel] Error:', err);
    });
  }

  start() {
    if (!this.isStarted) {
      console.log('[TelegramChannel] Starting polling...');
      void (async () => {
        try {
          await this.bot.telegram.deleteWebhook({ drop_pending_updates: true });
        } catch (e) {
        }
        try {
          const me = await this.bot.telegram.getMe();
          console.log(`[TelegramChannel] Using bot @${me.username} (${me.id})`);
        } catch (e) {
        }
        try {
          await this.bot.launch();
          console.log('[TelegramChannel] Bot launched successfully (streaming enabled)');
        } catch (err) {
          console.error('[TelegramChannel] Failed to launch bot:', err);
        }
      })();
      this.isStarted = true;
      
      // Enable graceful stop
      process.once('SIGINT', () => this.bot.stop('SIGINT'));
      process.once('SIGTERM', () => this.bot.stop('SIGTERM'));
    }
  }

  async send(userId: string, text: string) {
    try {
      const chatId: any = /^\d+$/.test(userId) ? Number(userId) : userId;
      await this.bot.telegram.sendMessage(chatId, text);
    } catch (err) {
      console.error(`[TelegramChannel] Failed to send message to ${userId}:`, err);
    }
  }

  sendStream(userId: string, chunk: string) {
    const cleaned = stripShellStreamMarker(chunk).chunk;
    if (!cleaned) return;
    void this.enqueueStream(userId, cleaned);
  }

  private async enqueueStream(userId: string, chunk: string) {
    if (!chunk) return;
    let state = this.streamByUserId.get(userId);
    if (!state) {
      state = { buffer: '', timer: null };
      this.streamByUserId.set(userId, state);
    }

    state.buffer += chunk;
    if (state.buffer.length > 20000) {
      state.buffer = state.buffer.slice(state.buffer.length - 20000);
    }

    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      void this.flushStream(userId);
    }, 900);
  }

  private normalizeTelegramText(text: string) {
    const trimmed = (text || '').trim();
    if (!trimmed) return '';
    const maxLen = 4096;
    if (trimmed.length <= maxLen) return trimmed;
    const tailLen = 3800;
    return `…\n${trimmed.slice(trimmed.length - tailLen)}`;
  }

  private async flushStream(userId: string) {
    const state = this.streamByUserId.get(userId);
    if (!state) return;
    state.timer = null;

    const text = this.normalizeTelegramText(state.buffer);
    if (!text) return;

    if (state.lastSentText === text) return;

    const chatId: any = /^\d+$/.test(userId) ? Number(userId) : userId;
    try {
      if (state.messageId) {
        await this.bot.telegram.editMessageText(chatId, state.messageId, undefined, text, {
          link_preview_options: { is_disabled: true }
        });
      } else {
        const sent = await this.bot.telegram.sendMessage(chatId, text, {
          link_preview_options: { is_disabled: true }
        });
        state.messageId = sent.message_id;
      }
      state.lastSentText = text;
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (msg.toLowerCase().includes('message is not modified')) {
        state.lastSentText = text;
        return;
      }
      try {
        const sent = await this.bot.telegram.sendMessage(chatId, text, {
          link_preview_options: { is_disabled: true }
        });
        state.messageId = sent.message_id;
        state.lastSentText = text;
      } catch (err) {
        console.error(`[TelegramChannel] Stream flush failed for ${userId}:`, err);
      }
    }
  }

  onMessage(handler: (msg: Message) => void) {
    this.handler = handler;
  }
}
