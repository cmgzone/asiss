import { Gateway } from './gateway/server';
import { ConsoleChannel } from './channels/console';
import { TelegramChannel } from './channels/telegram';
import { DiscordChannel } from './channels/discord';
import { SlackChannel } from './channels/slack';
import { WhatsAppChannel } from './channels/whatsapp';
import { WebChannel } from './channels/web/server';
import fs from 'fs';
import dotenv from 'dotenv';
import path from 'path';

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
