import { Gateway } from './gateway/server';
import { ConsoleChannel } from './channels/console';
import { TelegramChannel } from './channels/telegram';
import { DiscordChannel } from './channels/discord';
import { SlackChannel } from './channels/slack';
import { WhatsAppChannel } from './channels/whatsapp';
import { WebChannel } from './channels/web/server';
import { A2AChannel } from './channels/a2a/server';
import fs from 'fs';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Global Error Handlers for Crash Recovery
process.on('uncaughtException', (err) => {
    console.error('[System] CRITICAL ERROR: Uncaught Exception');
    console.error(err);
    // In production, we might want to restart specific services or exit cleanly
    // For now, we log and keep running if possible, but usually it's safer to restart.
    // However, the user requested "crash recovery", implying we should try to stay up.
    console.error('[System] Attempting to stay alive...');
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[System] ERROR: Unhandled Promise Rejection');
    console.error(reason);
});

async function main() {
  const gateway = new Gateway();
  
  // Load config if exists
  let config = { channels: ['Console (CLI)', 'Web Interface (Chat)'] };
  if (fs.existsSync('config.json')) {
    config = JSON.parse(fs.readFileSync('config.json', 'utf-8'));
  }

  // Register Console Channel
  if (config.channels.includes('Console (CLI)')) {
    gateway.registerChannel(new ConsoleChannel());
  }

  // Register Web Channel
  if (config.channels.includes('Web Interface (Chat)')) {
      gateway.registerChannel(new WebChannel(3000));
  }

  // Register A2A Channel (Agent-to-Agent)
  const a2aConfig = typeof (config as any).a2a === 'object' ? (config as any).a2a : {};
  const a2aEnabled = Boolean(a2aConfig?.enabled) || config.channels.includes('A2A');
  if (a2aEnabled) {
      const authTokenEnv = typeof a2aConfig?.authTokenEnv === 'string' ? a2aConfig.authTokenEnv : 'A2A_AUTH_TOKEN';
      const authToken = process.env[authTokenEnv] || a2aConfig?.authToken;
      gateway.registerChannel(new A2AChannel({
          enabled: true,
          port: typeof a2aConfig?.port === 'number' ? a2aConfig.port : undefined,
          rpcPath: typeof a2aConfig?.rpcPath === 'string' ? a2aConfig.rpcPath : undefined,
          baseUrl: typeof a2aConfig?.baseUrl === 'string' ? a2aConfig.baseUrl : undefined,
          protocolVersion: typeof a2aConfig?.protocolVersion === 'string' ? a2aConfig.protocolVersion : undefined,
          name: typeof a2aConfig?.name === 'string' ? a2aConfig.name : undefined,
          description: typeof a2aConfig?.description === 'string' ? a2aConfig.description : undefined,
          provider: typeof a2aConfig?.provider === 'object' ? a2aConfig.provider : undefined,
          documentationUrl: typeof a2aConfig?.documentationUrl === 'string' ? a2aConfig.documentationUrl : undefined,
          iconUrl: typeof a2aConfig?.iconUrl === 'string' ? a2aConfig.iconUrl : undefined,
          capabilities: typeof a2aConfig?.capabilities === 'object' ? a2aConfig.capabilities : undefined,
          defaultInputModes: Array.isArray(a2aConfig?.defaultInputModes) ? a2aConfig.defaultInputModes : undefined,
          defaultOutputModes: Array.isArray(a2aConfig?.defaultOutputModes) ? a2aConfig.defaultOutputModes : undefined,
          skills: Array.isArray(a2aConfig?.skills) ? a2aConfig.skills : undefined,
          authToken,
          maxHistory: typeof a2aConfig?.maxHistory === 'number' ? a2aConfig.maxHistory : undefined,
          blockingTimeoutMs: typeof a2aConfig?.blockingTimeoutMs === 'number' ? a2aConfig.blockingTimeoutMs : undefined
      }));
  }

  // Register Telegram Channel
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  if (config.channels.includes('Telegram') || telegramToken) {
      if (telegramToken) {
          console.log('[System] Telegram enabled');
          gateway.registerChannel(new TelegramChannel(telegramToken));
      } else {
          console.warn('[System] Telegram channel enabled but TELEGRAM_BOT_TOKEN is missing in .env');
      }
  }

  // Register Discord Channel
  const discordToken = process.env.DISCORD_BOT_TOKEN;
  if (config.channels.includes('Discord') || discordToken) {
      if (discordToken) {
          gateway.registerChannel(new DiscordChannel(discordToken));
      } else {
          console.warn('[System] Discord channel enabled but DISCORD_BOT_TOKEN is missing in .env');
      }
  }

  // Register Slack Channel
  const slackBotToken = process.env.SLACK_BOT_TOKEN;
  const slackAppToken = process.env.SLACK_APP_TOKEN;
  if (config.channels.includes('Slack') || (slackBotToken && slackAppToken)) {
      if (slackBotToken && slackAppToken) {
          gateway.registerChannel(new SlackChannel(slackBotToken, slackAppToken));
      } else {
          console.warn('[System] Slack channel enabled but SLACK_BOT_TOKEN or SLACK_APP_TOKEN is missing in .env');
      }
  }

  // Register WhatsApp Channel
  // No token needed, relies on QR scan
  if (config.channels.includes('WhatsApp')) {
      gateway.registerChannel(new WhatsAppChannel());
  }

  await gateway.start();
}

main().catch(console.error);
