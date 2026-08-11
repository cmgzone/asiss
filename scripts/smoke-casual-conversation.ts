import assert from 'assert';
import { AgentRunner } from '../src/agents/runner';
import { StreamEventPayload } from '../src/core/types';
import { mainGoalManager } from '../src/core/main-goal';

async function main() {
  const events: StreamEventPayload[] = [];
  const messages: string[] = [];
  const gateway = {
    async sendResponse(_sessionId: string, text: string) { messages.push(text); },
    async sendStreamChunk() {},
    async sendStreamEvent(_sessionId: string, event: StreamEventPayload) { events.push(event); },
    async sendMedia() {},
    listSessionIds() { return []; },
    supportsStructuredStreaming() { return true; }
  };
  const runner = new AgentRunner(gateway);
  const sessionId = `smoke-casual-${Date.now()}`;
  await runner.processMessage(sessionId, {
    id: 'hello', channel: 'test', senderId: 'tester', content: 'hello', timestamp: Date.now(), metadata: {}
  });

  const done = events.find(event => event.type === 'assistant_done');
  assert.equal(done?.finalText, 'Hello! What would you like me to work on?');
  assert.equal(events.some(event => event.type === 'tool_start'), false);
  assert.equal(mainGoalManager.getCurrent(sessionId), undefined);
  assert.equal(messages.length, 0, 'Structured streaming should not duplicate the final response.');
  console.log(JSON.stringify({ directReply: true, toolFree: true, noGoalCreated: true, noDuplicate: true }));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
