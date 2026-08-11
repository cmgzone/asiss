import assert from 'assert';
import { ModelProvider } from '../src/core/models';
import { modelResilienceManager, ResilientModelProvider } from '../src/core/resilient-model';

async function main() {
  modelResilienceManager.reset();
  let primaryCalls = 0;
  let fallbackCalls = 0;

  const primary: ModelProvider = {
    id: 'smoke-primary',
    name: 'Smoke Primary',
    async generate() {
      primaryCalls += 1;
      const error: any = new Error('Rate limit exceeded');
      error.status = 429;
      throw error;
    }
  };
  const fallback: ModelProvider = {
    id: 'smoke-fallback',
    name: 'Smoke Fallback',
    async generate() {
      fallbackCalls += 1;
      return { content: 'fallback worked' };
    },
    async generateStream(_prompt, _system, _tools, onChunk) {
      fallbackCalls += 1;
      onChunk?.('stream fallback worked');
      return { content: 'stream fallback worked' };
    }
  };

  const resilient = new ResilientModelProvider(primary, [fallback], { cooldownMs: 60_000 });
  const first = await resilient.generate('hello');
  assert.equal(first.content, 'fallback worked');
  assert.equal(primaryCalls, 1);
  assert.equal(fallbackCalls, 1);

  const second = await resilient.generate('again');
  assert.equal(second.content, 'fallback worked');
  assert.equal(primaryCalls, 1, 'cooling provider should be skipped');
  assert.equal(fallbackCalls, 2);

  const chunks: string[] = [];
  const streamed = await resilient.generateStream('stream', undefined, [], chunk => chunks.push(chunk));
  assert.equal(streamed.content, 'stream fallback worked');
  assert.equal(chunks.join(''), 'stream fallback worked');

  const health = modelResilienceManager.list();
  assert.equal(health.find(item => item.id === primary.id)?.failures, 1);
  assert.ok((health.find(item => item.id === fallback.id)?.successes || 0) >= 3);

  console.log(JSON.stringify({
    rateLimitFailover: true,
    cooldownSkip: true,
    streamingFallback: true,
    healthTracking: true
  }));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
