import { ChannelAdapter, Message } from '../core/types';
import * as readline from 'readline';
import { v4 as uuidv4 } from 'uuid';
import chalk from 'chalk';
import ora from 'ora';
import { marked } from 'marked';
import TerminalRenderer from 'marked-terminal';
import { stripShellStreamMarker } from '../core/stream-markers';

// Setup marked with terminal renderer
marked.setOptions({
  renderer: new TerminalRenderer() as any
});

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

    // Format the output using marked (Markdown -> Terminal)
    console.log('');
    console.log(marked(text));

    // Reset prompt
    process.stdout.write(chalk.blue('❯ '));
  }

  // Handle streaming chunks
  sendStream(userId: string, chunk: string) {
    const cleaned = stripShellStreamMarker(chunk).chunk;
    if (!cleaned) return;
    if (this.spinner.isSpinning) {
      this.spinner.stop();
      process.stdout.write('\n'); // Move to new line after spinner
    }

    // Direct write for streaming effect (no markdown processing on partial chunks usually, 
    // but specific terminal renderers might handle it. For now, raw text stream is better than nothing)
    // Ideally we would buffer and render markdown incrementally, but that's complex.
    // Simple approach: just print the chunk.
    process.stdout.write(cleaned);
  }

  onMessage(handler: (msg: Message) => void) {
    this.handler = handler;
  }
}
