import { ChannelAdapter, Message } from '../core/types';
import { Client, GatewayIntentBits, Partials, ChannelType } from 'discord.js';

export class DiscordChannel implements ChannelAdapter {
  name = 'discord';
  private client: Client;
  private handler: ((msg: Message) => void) | null = null;
  private isStarted = false;

  constructor(token: string) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages
      ],
      partials: [Partials.Channel]
    });

    this.client.on('messageCreate', (message) => {
      // Ignore bot messages
      if (message.author.bot) return;

      if (this.handler) {
        const msg: Message = {
          id: message.id,
          channel: 'discord',
          senderId: message.author.id,
          content: message.content,
          timestamp: message.createdTimestamp,
          metadata: {
            username: message.author.username,
            channelId: message.channelId,
            guildId: message.guildId
          }
        };
        this.handler(msg);
      }
    });
    
    this.client.on('error', (err) => {
        console.error('[DiscordChannel] Error:', err);
    });
  }

  async start() {
    if (!this.isStarted) {
      console.log('[DiscordChannel] Logging in...');
      try {
        await this.client.login(process.env.DISCORD_BOT_TOKEN);
        console.log(`[DiscordChannel] Logged in as ${this.client.user?.tag}`);
        this.isStarted = true;
      } catch (err) {
        console.error('[DiscordChannel] Failed to login:', err);
      }
    }
  }

  async send(userId: string, text: string) {
    try {
        // userId in our system maps to the user ID, but to reply we usually need the channel ID.
        // For DMs, we can fetch the user and send.
        // For Guild channels, we'd need to track the channelId in the session context.
        // simplified approach: try to find a user and DM, OR if we have context (TODO) reply to channel.
        // For now, let's assume userId is the User ID and we send a DM.
        const user = await this.client.users.fetch(userId);
        if (user) {
            await user.send(text);
        }
    } catch (err) {
      console.error(`[DiscordChannel] Failed to send message to ${userId}:`, err);
    }
  }

  // Overload send to support channel replies if we pass a composite ID or handle it in Gateway
  // For MVP, we'll stick to DMs or need a way to pass channelId back.
  // IMPROVEMENT: In Gateway, the session should store the 'channelId' from metadata.
  
  onMessage(handler: (msg: Message) => void) {
    this.handler = handler;
  }
}
