import { ChannelAdapter, Message } from '../core/types';
import { App, LogLevel } from '@slack/bolt';

export class SlackChannel implements ChannelAdapter {
  name = 'slack';
  private app: App;
  private handler: ((msg: Message) => void) | null = null;
  private isStarted = false;

  constructor(botToken: string, appToken: string) {
    this.app = new App({
      token: botToken,
      appToken: appToken,
      socketMode: true,
      logLevel: LogLevel.WARN
    });

    this.app.message(async ({ message, say }) => {
      // Filter out subtypes like message_deleted, etc. where 'text' might be missing
      if (message.subtype && message.subtype !== 'bot_message') return;
      if ((message as any).bot_id) return; // Ignore bots

      if (this.handler && (message as any).text) {
        const msg: Message = {
          id: (message as any).ts,
          channel: 'slack',
          senderId: (message as any).user, // User ID
          content: (message as any).text,
          timestamp: parseFloat((message as any).ts) * 1000,
          metadata: {
            channelId: message.channel,
            teamId: (message as any).team
          }
        };
        this.handler(msg);
      }
    });
    
    this.app.error(async (error) => {
        console.error('[SlackChannel] Error:', error);
    });
  }

  async start() {
    if (!this.isStarted) {
      console.log('[SlackChannel] Starting Socket Mode...');
      try {
        await this.app.start();
        console.log('[SlackChannel] Connected to Slack!');
        this.isStarted = true;
      } catch (err) {
        console.error('[SlackChannel] Failed to start:', err);
      }
    }
  }

  async send(userId: string, text: string) {
    try {
        // userId here is the Slack User ID.
        // We can publish to a DM with this user.
        await this.app.client.chat.postMessage({
            channel: userId,
            text: text
        });
    } catch (err) {
      console.error(`[SlackChannel] Failed to send message to ${userId}:`, err);
    }
  }

  onMessage(handler: (msg: Message) => void) {
    this.handler = handler;
  }
}
