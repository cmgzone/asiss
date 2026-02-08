import { Gateway } from './gateway/server';
import { ChannelAdapter, Message } from './core/types';
import { v4 as uuidv4 } from 'uuid';

class MockChannel implements ChannelAdapter {
  name = 'mock';
  private handler: ((msg: Message) => void) | null = null;

  start() {
    console.log('[MockChannel] Started');
  }

  send(userId: string, text: string) {
    console.log(`[MockChannel] Received reply for ${userId}: ${text}`);
    if (text.includes('received')) {
      console.log('TEST PASSED');
      process.exit(0);
    }
  }

  onMessage(handler: (msg: Message) => void) {
    this.handler = handler;
  }

  simulateMessage(text: string) {
    if (this.handler) {
      this.handler({
        id: uuidv4(),
        channel: 'mock',
        senderId: 'test-user',
        content: text,
        timestamp: Date.now()
      });
    }
  }
}

async function test() {
  const gateway = new Gateway();
  const mockChannel = new MockChannel();
  gateway.registerChannel(mockChannel);
  
  await gateway.start();
  
  console.log('Sending test message...');
  mockChannel.simulateMessage('Hello World');
  
  // Timeout fail
  setTimeout(() => {
    console.log('TEST FAILED: Timeout');
    process.exit(1);
  }, 5000);
}

test().catch(console.error);
