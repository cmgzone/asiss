import { ChannelAdapter, Message, MediaPayload } from '../core/types';
import { Telegraf } from 'telegraf';
import { v4 as uuidv4 } from 'uuid';
import { stripShellStreamMarker } from '../core/stream-markers';
import fs from 'fs';

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
    const chatId: any = /^\d+$/.test(userId) ? Number(userId) : userId;

    // Send typing action
    try {
      await this.bot.telegram.sendChatAction(chatId, 'typing');
    } catch { }

    const maxLen = 4096;
    try {
      if (text.length <= maxLen) {
        await this.bot.telegram.sendMessage(chatId, text, { parse_mode: undefined }); // 'Markdown' can be flaky if chars aren't perfect
      } else {
        // Split long messages
        const chunks = this.splitMessage(text, maxLen);
        for (const chunk of chunks) {
          await this.bot.telegram.sendMessage(chatId, chunk);
        }
      }
    } catch (err: any) {
      console.error(`[TelegramChannel] Failed to send message to ${userId}:`, err);
      // Fallback: try sending without markdown if it failed
      try {
        if (text.length <= maxLen) {
          await this.bot.telegram.sendMessage(chatId, text);
        }
      } catch (e) {
        console.error('[TelegramChannel] Fallback failed:', e);
      }
    }
  }

  private splitMessage(text: string, maxLen: number): string[] {
    const chunks: string[] = [];
    let current = '';
    const lines = text.split('\n');

    for (const line of lines) {
      if ((current.length + line.length + 1) > maxLen) {
        if (current) chunks.push(current);
        current = line;
        // If a single line is too long, force split it
        while (current.length > maxLen) {
          chunks.push(current.slice(0, maxLen));
          current = current.slice(maxLen);
        }
      } else {
        current = current ? `${current}\n${line}` : line;
      }
    }
    if (current) chunks.push(current);
    return chunks;
  }

  async sendMedia(userId: string, media: MediaPayload) {
    const chatId: any = /^\d+$/.test(userId) ? Number(userId) : userId;
    const caption = media.caption ? media.caption.slice(0, 1000) : undefined;
    try {
      if (media.type === 'image') {
        if (media.path && fs.existsSync(media.path)) {
          await this.bot.telegram.sendPhoto(chatId, { source: media.path }, { caption });
          return;
        }
        if (media.url) {
          await this.bot.telegram.sendPhoto(chatId, media.url, { caption });
          return;
        }
      }
      if (media.type === 'file') {
        if (media.path && fs.existsSync(media.path)) {
          await this.bot.telegram.sendDocument(chatId, { source: media.path }, { caption });
          return;
        }
        if (media.url) {
          await this.bot.telegram.sendDocument(chatId, media.url, { caption });
          return;
        }
      }
      if (caption) {
        await this.send(userId, caption);
      }
    } catch (err) {
      console.error(`[TelegramChannel] Failed to send media to ${userId}:`, err);
      if (caption) {
        await this.send(userId, caption);
      }
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

  private async flushStream(userId: string) {
    const state = this.streamByUserId.get(userId);
    if (!state) return;
    state.timer = null;

    if (!state.buffer) return;

    const chatId: any = /^\d+$/.test(userId) ? Number(userId) : userId;
    const MAX_MSG_LEN = 4000; // Leave margin for safety

    try {
      // If buffer fits in one message, just edit/send it
      if (state.buffer.length <= MAX_MSG_LEN) {
        if (state.lastSentText === state.buffer) return;

        if (state.messageId) {
          await this.bot.telegram.editMessageText(chatId, state.messageId, undefined, state.buffer, {
            link_preview_options: { is_disabled: true }
          });
        } else {
          try {
            const sent = await this.bot.telegram.sendMessage(chatId, state.buffer, {
              link_preview_options: { is_disabled: true }
            });
            state.messageId = sent.message_id;
          } catch (e) {
            // Retry without options if failed
            const sent = await this.bot.telegram.sendMessage(chatId, state.buffer);
            state.messageId = sent.message_id;
          }
        }
        state.lastSentText = state.buffer;
      } else {
        // Buffer overflow!
        // 1. Finalize the current message with the first N chars
        const chunk = state.buffer.slice(0, MAX_MSG_LEN);
        const remainder = state.buffer.slice(MAX_MSG_LEN);

        if (state.messageId) {
          await this.bot.telegram.editMessageText(chatId, state.messageId, undefined, chunk, {
            link_preview_options: { is_disabled: true }
          });
        } else {
          const sent = await this.bot.telegram.sendMessage(chatId, chunk, {
            link_preview_options: { is_disabled: true }
          });
          // We don't save this ID because we are done with it instantly
        }

        // 2. Start a new message for the remainder
        // We effectively "reset" the stream state for the new tail
        state.buffer = remainder;
        state.lastSentText = '';
        state.messageId = undefined; // Force a new send next time (or immediately)

        // Recursively flush the remainder (it might trigger another send immediately)
        // Check recursion depth/stack? 
        // Just calling flushStream again is safe since we updated state.buffer
        // But to avoid async recursion issues, let's just trigger it via timer or direct call
        // Direct call:
        await this.flushStream(userId);
      }
    } catch (e: any) {
      console.error(`[TelegramChannel] Stream flush failed for ${userId}:`, e);
      // Logic to recover: maybe reset buffer or messageId if "message not found"
      const msg = String(e?.message || e);
      if (msg.includes('message is not modified')) {
        state.lastSentText = state.buffer;
      } else {
        // If error is critical, maybe force new message next time
        state.messageId = undefined;
      }
    }
  }

  onMessage(handler: (msg: Message) => void) {
    this.handler = handler;
  }
}
