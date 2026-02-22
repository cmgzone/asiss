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
  const defaultChannels = ['Web Interface (Chat)'];
  let config: any = { channels: [...defaultChannels] };
  if (fs.existsSync('config.json')) {
    const raw = JSON.parse(fs.readFileSync('config.json', 'utf-8'));
    config = { ...config, ...raw };
  }
  const channels = Array.isArray(config.channels)
    ? config.channels.filter((name: unknown): name is string => typeof name === 'string')
    : [];
  if (channels.length === 0) {
    channels.push(...defaultChannels);
    console.warn('[System] No channels configured; defaulting to Web Interface (Chat).');
  }
  const hasChannel = (name: string) => channels.includes(name);

  // Register Console Channel
  if (hasChannel('Console (CLI)')) {
    gateway.registerChannel(new ConsoleChannel());
  }

  // Register Web Channel
  if (hasChannel('Web Interface (Chat)')) {
      console.log('[System] Web Interface enabled');
      gateway.registerChannel(new WebChannel(3000));
  }

  // Register A2A Channel (Agent-to-Agent)
  const a2aConfig = typeof (config as any).a2a === 'object' ? (config as any).a2a : {};
  const a2aEnabled = Boolean(a2aConfig?.enabled) || hasChannel('A2A');
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
  if (hasChannel('Telegram') || telegramToken) {
      if (telegramToken) {
          console.log('[System] Telegram enabled');
          gateway.registerChannel(new TelegramChannel(telegramToken));
      } else {
          console.warn('[System] Telegram channel enabled but TELEGRAM_BOT_TOKEN is missing in .env');
      }
  }

  // Register Discord Channel
  const discordToken = process.env.DISCORD_BOT_TOKEN;
  if (hasChannel('Discord') || discordToken) {
      if (discordToken) {
          console.log('[System] Discord enabled');
          gateway.registerChannel(new DiscordChannel(discordToken));
      } else {
          console.warn('[System] Discord channel enabled but DISCORD_BOT_TOKEN is missing in .env');
      }
  }

  // Register Slack Channel
  const slackBotToken = process.env.SLACK_BOT_TOKEN;
  const slackAppToken = process.env.SLACK_APP_TOKEN;
  if (hasChannel('Slack') || (slackBotToken && slackAppToken)) {
      if (slackBotToken && slackAppToken) {
          console.log('[System] Slack enabled');
          gateway.registerChannel(new SlackChannel(slackBotToken, slackAppToken));
      } else {
          console.warn('[System] Slack channel enabled but SLACK_BOT_TOKEN or SLACK_APP_TOKEN is missing in .env');
      }
  }

  // Register WhatsApp Channel
  // No token needed, relies on QR scan
  if (hasChannel('WhatsApp')) {
      console.log('[System] WhatsApp enabled (QR scan required on first run)');
      gateway.registerChannel(new WhatsAppChannel());
  }

  await gateway.start();
}

main().catch(console.error);
