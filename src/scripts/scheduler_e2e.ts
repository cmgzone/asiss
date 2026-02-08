import { Gateway } from '../gateway/server';
import { ChannelAdapter, Message } from '../core/types';
import { v4 as uuidv4 } from 'uuid';

class DummyChannel implements ChannelAdapter {
  name = 'dummy';
  private handler: ((msg: Message) => void) | null = null;
  public sent: Array<{ userId: string; text: string }> = [];

  start() {}

  send(userId: string, text: string) {
    this.sent.push({ userId, text });
  }

  onMessage(handler: (msg: Message) => void) {
    this.handler = handler;
  }

  emitFromUser(userId: string, content: string) {
    if (!this.handler) throw new Error('No handler');
    this.handler({
      id: uuidv4(),
      channel: this.name,
      senderId: userId,
      content,
      timestamp: Date.now()
    });
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main() {
  const gateway = new Gateway();
  const channel = new DummyChannel();
  gateway.registerChannel(channel);
  await gateway.start();

  const userId = 'u1';
  channel.emitFromUser(userId, '/schedule 1s /jobs');
  await sleep(1500);

  const outputs = channel.sent.map(s => s.text).join('\n---\n');
  if (!outputs.includes('Scheduled:') || !outputs.includes('/jobs') && !outputs.includes('✅')) {
    throw new Error('Expected scheduled output not found:\n' + outputs);
  }

  process.stdout.write('OK\n');
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(String(e?.stack || e) + '\n');
  process.exit(1);
});

