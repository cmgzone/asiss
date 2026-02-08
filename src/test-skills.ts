import { Gateway } from './gateway/server';
import { ConsoleChannel } from './channels/console';
import { Message } from './core/types';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

async function testSkills() {
  const gateway = new Gateway();
  const mockChannel = new ConsoleChannel();
  
  // We override the start method to simulate input
  mockChannel.start = () => {
    console.log('[MockConsole] Started');
  };
  
  gateway.registerChannel(mockChannel);
  await gateway.start();

  console.log('\n--- Testing System Skill ---');
  // We manually trigger the onMessage handler
  // Accessing private handler via "any" cast for testing or we should expose a test method
  (mockChannel as any).handler({
      id: uuidv4(),
      channel: 'console',
      senderId: 'tester',
      content: 'Can you give me /sys info?',
      timestamp: Date.now()
  });

  setTimeout(() => {
    console.log('\n--- Testing Time Skill ---');
    (mockChannel as any).handler({
        id: uuidv4(),
        channel: 'console',
        senderId: 'tester',
        content: 'What is the /time?',
        timestamp: Date.now()
    });
  }, 1000);

  setTimeout(() => {
    process.exit(0);
  }, 2000);
}

testSkills().catch(console.error);
