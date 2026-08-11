import assert from 'assert';
import { ModelProvider } from '../src/core/models';
import { ModelEngine, buildModelTaskProfile } from '../src/core/model';
import { costTracker } from '../src/core/cost-tracker';

const provider = (id: string, level: 'low' | 'medium' | 'high' | 'max', contextWindow?: number): ModelProvider => ({
  id,
  name: id,
  level,
  ...(contextWindow ? { contextWindow } : {}),
  async generate() { return { content: id }; }
} as ModelProvider);

async function main() {
  const engine = new ModelEngine({ filePath: '' });

  const simple = engine.select({ goal: 'What is a cache?' }, [provider('low', 'low'), provider('high', 'high')]);
  assert.equal(simple?.provider.id, 'low', 'simple work favors the capability-matched model');

  for (let i = 0; i < 7; i++) engine.recordModelOutcome('unreliable-high', { success: false, latencyMs: 900 });
  for (let i = 0; i < 7; i++) engine.recordModelOutcome('reliable-max', { success: true, latencyMs: 400 });
  const resilient = engine.select({ goal: 'Implement a secure migration with tests.' }, [
    provider('unreliable-high', 'high'), provider('reliable-max', 'max')
  ]);
  assert.equal(resilient?.provider.id, 'reliable-max', 'measured reliability can outweigh a small capability/cost preference');

  for (let i = 0; i < 8; i++) engine.recordToolOutcome('tool-good', true);
  for (let i = 0; i < 8; i++) engine.recordToolOutcome('tool-bad', false);
  const tools = engine.select({ goal: 'Use tools to inspect and repair this project.', requiresTools: true }, [
    provider('tool-bad', 'medium'), provider('tool-good', 'medium')
  ]);
  assert.equal(tools?.provider.id, 'tool-good', 'tool-call outcomes influence tool-using tasks');

  const longContext = 'x'.repeat(8_000);
  const context = engine.select({ goal: 'Explain the repository.', contextText: longContext }, [
    provider('short-context', 'medium', 1_000), provider('long-context', 'medium', 16_000)
  ]);
  assert.equal(context?.provider.id, 'long-context', 'context fit avoids a too-small context window');

  const pinned = engine.select({ goal: 'Hello' }, [provider('pinned-high', 'high'), provider('low-2', 'low')], {
    pinnedProviderId: 'pinned-high'
  });
  assert.equal(pinned?.provider.id, 'pinned-high', 'explicit model-router rules remain hard overrides');
  assert.equal(pinned?.pinned, true);

  const profile = buildModelTaskProfile({ goal: 'Create a migration plan', contextText: longContext, requiresTools: true });
  assert.equal(profile.complexity, 'complex');
  assert.ok(profile.contextTokens >= 2_000);

  console.log(JSON.stringify({
    capabilityFit: true,
    reliabilityScoring: true,
    toolUseScoring: true,
    contextFit: true,
    explicitOverrides: true,
    taskProfiles: true
  }));
}

main().then(() => {
  // ModelEngine's production default uses CostTracker, whose persistence timer
  // is appropriate for the app but would otherwise keep this standalone smoke
  // process alive after its assertions have finished.
  costTracker.stop();
}).catch(error => {
  costTracker.stop();
  console.error(error);
  process.exitCode = 1;
});
