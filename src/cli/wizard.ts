import inquirer from 'inquirer';
import fs from 'fs';
import path from 'path';
import { Gateway } from '../gateway/server';
import { ConsoleChannel } from '../channels/console';
import { TelegramChannel } from '../channels/telegram';
import { DiscordChannel } from '../channels/discord';
import { SlackChannel } from '../channels/slack';
import { WhatsAppChannel } from '../channels/whatsapp';
import { WebChannel } from '../channels/web/server';
import { AuthManager } from '../core/auth';
import chalk from 'chalk';
import dotenv from 'dotenv';
import figlet from 'figlet';

// Load existing env to prepopulate defaults
dotenv.config();

async function runWizard() {
  console.clear();
  console.log(chalk.cyan(figlet.textSync('Gitubot', { horizontalLayout: 'full' })));
  console.log(chalk.bold.blue('  The Professional AI Assistant for Developers'));
  console.log(chalk.gray('  --------------------------------------------\n'));

  const answers = await inquirer.prompt<{
    name: string;
    channels: string[];
    model: string;
    aiModel: string;
  }>([
    {
      type: 'input',
      name: 'name',
      message: 'What is your assistant name?',
      default: 'Gitubot'
    },
    {
      type: 'checkbox',
      name: 'channels',
      message: 'Select channels to enable:',
      choices: ['Console (CLI)', 'Web Interface (Chat)', 'WhatsApp', 'Telegram', 'Discord', 'Slack'],
      default: ['Console (CLI)', 'Web Interface (Chat)']
    },
    {
      type: 'select',
      name: 'model',
      message: 'Select primary LLM provider:',
      choices: ['OpenRouter', 'NVIDIA', 'OpenAI', 'Anthropic', 'Local (Ollama)', 'Gemini'],
      default: 'OpenRouter'
    },
    {
      type: 'input',
      name: 'aiModel',
      message: 'Enter specific AI Model ID (optional):',
      default: (answers: any) => {
        if (answers.model === 'OpenRouter') return process.env.OPENROUTER_MODEL || '';
        return '';
      }
    }
  ]);

  // --- Dynamic Prompts for Secrets ---
  const secretPrompts = [];

  if (answers.channels.includes('Telegram')) {
    secretPrompts.push({
      type: 'password',
      name: 'telegramToken',
      message: 'Enter your Telegram Bot Token:',
      mask: '*',
      default: process.env.TELEGRAM_BOT_TOKEN
    });
  }

  if (answers.channels.includes('Discord')) {
    secretPrompts.push({
      type: 'password',
      name: 'discordToken',
      message: 'Enter your Discord Bot Token:',
      mask: '*',
      default: process.env.DISCORD_BOT_TOKEN
    });
  }

  if (answers.channels.includes('Slack')) {
    secretPrompts.push({
      type: 'password',
      name: 'slackBotToken',
      message: 'Enter your Slack Bot Token (xoxb-...):',
      mask: '*',
      default: process.env.SLACK_BOT_TOKEN
    }, {
      type: 'password',
      name: 'slackAppToken',
      message: 'Enter your Slack App Token (xapp-...):',
      mask: '*',
      default: process.env.SLACK_APP_TOKEN
    });
  }

  if (answers.model === 'OpenRouter') {
    secretPrompts.push({
      type: 'password',
      name: 'openrouterKey',
      message: 'Enter your OpenRouter API Key:',
      mask: '*',
      default: process.env.OPENROUTER_API_KEY
    });
  } else if (answers.model === 'NVIDIA') {
    secretPrompts.push({
      type: 'password',
      name: 'nvidiaKey',
      message: 'Enter your NVIDIA API Key (nvapi-...):',
      mask: '*',
      default: process.env.NVIDIA_API_KEY
    });
  } else if (answers.model === 'OpenAI') {
    secretPrompts.push({
      type: 'password',
      name: 'openaiKey',
      message: 'Enter your OpenAI API Key:',
      mask: '*',
      default: process.env.OPENAI_API_KEY
    });
  } else if (answers.model === 'Anthropic') {
    secretPrompts.push({
      type: 'password',
      name: 'anthropicKey',
      message: 'Enter your Anthropic API Key:',
      mask: '*',
      default: process.env.ANTHROPIC_API_KEY
    });
  } else if (answers.model === 'Gemini') {
    secretPrompts.push({
      type: 'password',
      name: 'geminiKey',
      message: 'Enter your Gemini API Key:',
      mask: '*',
      default: process.env.GEMINI_API_KEY
    });
  }

  const secrets = await inquirer.prompt(secretPrompts);

  // --- User Creation Step ---
  console.log(chalk.bold.yellow('\n🔐 User Management Setup'));
  const userAnswers = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'createUser',
      message: 'Do you want to create a new user account?',
      default: true
    }
  ]);

  if (userAnswers.createUser) {
    const userCreds = await inquirer.prompt([
      {
        type: 'input',
        name: 'username',
        message: 'Enter new username:',
        validate: (input) => input.length > 0 ? true : 'Username cannot be empty'
      },
      {
        type: 'password',
        name: 'password',
        message: 'Enter password:',
        mask: '*',
        validate: (input) => input.length > 0 ? true : 'Password cannot be empty'
      }
    ]);

    const auth = new AuthManager();
    if (auth.register(userCreds.username, userCreds.password)) {
      console.log(chalk.green(`✅ User '${userCreds.username}' created successfully.`));
    } else {
      console.log(chalk.red(`❌ User '${userCreds.username}' already exists.`));
    }
  }

  // --- Save Configuration ---
  const config = {
    name: answers.name,
    channels: answers.channels,
    model: answers.model,
    aiModel: answers.aiModel, // Save specific model ID
    createdAt: new Date().toISOString()
  };

  fs.writeFileSync('config.json', JSON.stringify(config, null, 2));
  console.log(chalk.green('\n✅ Configuration saved to config.json'));

  // --- Save Secrets to .env ---
  let envContent = '';
  if (fs.existsSync('.env')) {
    envContent = fs.readFileSync('.env', 'utf-8');
  }

  const updateEnv = (key: string, value: string) => {
    if (!value) return;
    const regex = new RegExp(`^${key}=.*`, 'm');
    if (regex.test(envContent)) {
      envContent = envContent.replace(regex, `${key}=${value}`);
    } else {
      envContent += `\n${key}=${value}`;
    }
  };

  if (secrets.telegramToken) updateEnv('TELEGRAM_BOT_TOKEN', secrets.telegramToken);
  if (secrets.discordToken) updateEnv('DISCORD_BOT_TOKEN', secrets.discordToken);
  if (secrets.slackBotToken) updateEnv('SLACK_BOT_TOKEN', secrets.slackBotToken);
  if (secrets.slackAppToken) updateEnv('SLACK_APP_TOKEN', secrets.slackAppToken);

  if (secrets.openrouterKey) updateEnv('OPENROUTER_API_KEY', secrets.openrouterKey);
  if (answers.model === 'OpenRouter' && answers.aiModel) updateEnv('OPENROUTER_MODEL', answers.aiModel);
  if (secrets.nvidiaKey) updateEnv('NVIDIA_API_KEY', secrets.nvidiaKey);
  if (secrets.openaiKey) updateEnv('OPENAI_API_KEY', secrets.openaiKey);
  if (secrets.anthropicKey) updateEnv('ANTHROPIC_API_KEY', secrets.anthropicKey);
  if (secrets.geminiKey) updateEnv('GEMINI_API_KEY', secrets.geminiKey);

  fs.writeFileSync('.env', envContent.trim());
  console.log(chalk.green('✅ Secrets saved to .env'));

  // --- Start Gateway ---
  const { start } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'start',
      message: 'Do you want to start the Gateway now?',
      default: true
    }
  ]);

  if (start) {
    // Reload env since we just wrote to it
    dotenv.config({ override: true });

    const gateway = new Gateway();
    let webChannel: WebChannel | null = null;

    if (answers.channels.includes('Console (CLI)')) {
      gateway.registerChannel(new ConsoleChannel());
    }

    if (answers.channels.includes('Web Interface (Chat)')) {
      webChannel = new WebChannel(3000);
      gateway.registerChannel(webChannel);
    }

    if (answers.channels.includes('Telegram') && process.env.TELEGRAM_BOT_TOKEN) {
      gateway.registerChannel(new TelegramChannel(process.env.TELEGRAM_BOT_TOKEN));
    } else if (answers.channels.includes('Telegram')) {
      console.warn('[Gitubot] Telegram selected but TELEGRAM_BOT_TOKEN is missing in .env');
    }

    if (answers.channels.includes('Discord') && process.env.DISCORD_BOT_TOKEN) {
      gateway.registerChannel(new DiscordChannel(process.env.DISCORD_BOT_TOKEN));
    } else if (answers.channels.includes('Discord')) {
      console.warn('[Gitubot] Discord selected but DISCORD_BOT_TOKEN is missing in .env');
    }

    if (answers.channels.includes('Slack') && process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
      gateway.registerChannel(new SlackChannel(process.env.SLACK_BOT_TOKEN, process.env.SLACK_APP_TOKEN));
    } else if (answers.channels.includes('Slack')) {
      console.warn('[Gitubot] Slack selected but SLACK_BOT_TOKEN or SLACK_APP_TOKEN is missing in .env');
    }

    if (answers.channels.includes('WhatsApp')) {
      console.log(chalk.yellow('[Gitubot] WhatsApp selected. Scan QR in console (or Web Settings) on first startup.'));
      gateway.registerChannel(new WhatsAppChannel());
    }

    console.log(chalk.cyan(`\n[Gitubot] Initialization sequence started for ${answers.name}...`));
    await gateway.start();
    if (webChannel) {
      console.log(chalk.green('[Gitubot] Web chat URL: http://localhost:3000'));
    }
  }
}

runWizard().catch(console.error);
