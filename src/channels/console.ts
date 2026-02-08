import { ChannelAdapter, Message } from '../core/types';
import * as readline from 'readline';
import { v4 as uuidv4 } from 'uuid';
import chalk from 'chalk';
import ora from 'ora';
import boxen from 'boxen';

export class ConsoleChannel implements ChannelAdapter {
  name = 'console';
  private handler: ((msg: Message) => void) | null = null;
  private rl: readline.Interface;
  private spinner = ora({
    text: 'Thinking...',
    color: 'cyan'
  });

  constructor() {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false
    });
  }

  start() {
    console.log(chalk.gray('──────────────────────────────────────────────────'));
    console.log(chalk.green('✔ Console Channel Active'));
    console.log(chalk.gray('  Type a message and press Enter to chat.'));
    console.log(chalk.gray('──────────────────────────────────────────────────\n'));
    
    process.stdout.write(chalk.blue('❯ '));

    this.rl.on('line', (input) => {
      if (!input.trim()) {
        process.stdout.write(chalk.blue('❯ '));
        return;
      }
      
      // Start spinner immediately to show responsiveness
      this.spinner.start();

      if (this.handler) {
        const msg: Message = {
          id: uuidv4(),
          channel: 'console',
          senderId: 'local-user',
          content: input,
          timestamp: Date.now()
        };
        this.handler(msg);
      }
    });
  }

  send(userId: string, text: string) {
    if (this.spinner.isSpinning) {
      this.spinner.stop();
    }
    
    // Format the output beautifully using Boxen
    console.log('');
    console.log(boxen(text, {
        title: 'Gitubot 🤖',
        titleAlignment: 'center',
        padding: 1,
        margin: 1,
        borderStyle: 'round',
        borderColor: 'cyan',
        backgroundColor: '#1e1e1e'
    }));
    
    // Reset prompt
    process.stdout.write(chalk.blue('❯ '));
  }

  onMessage(handler: (msg: Message) => void) {
    this.handler = handler;
  }
}
