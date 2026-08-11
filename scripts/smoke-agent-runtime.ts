import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitu-agent-runtime-'));
  process.chdir(tempDir);
  fs.writeFileSync('SOUL.md', '# Test Soul\nFinish action tasks with tools and verification.\n');
  fs.writeFileSync('AGENTS.md', '# Test Workspace\n');
  fs.writeFileSync('USER.md', '# Test User\n');
  fs.writeFileSync('config.json', JSON.stringify({
    model: 'mock',
    agent: {
      maxTurns: 12,
      autoContinue: { enabled: true, maxBatches: 1, notify: false },
      maxPrematureCompletions: 4
    }
  }, null, 2));

  const { AgentRunner } = await import('../src/agents/runner');
  const { ModelRegistry } = await import('../src/core/models');
  const { buildStableSessionId } = await import('../src/gateway/server');
  assert.strictEqual(
    buildStableSessionId('durable-user', 'web'),
    buildStableSessionId('durable-user', 'web'),
    'the same user/channel receives the same durable session after restart'
  );
  assert.notStrictEqual(
    buildStableSessionId('durable-user', 'web'),
    buildStableSessionId('durable-user', 'telegram'),
    'channels remain isolated'
  );

  const responses: string[] = [];
  const streamChunks: string[] = [];
  const streamEvents: any[] = [];
  const prompts: string[] = [];
  let turns = 0;

  const gateway = {
    sendResponse: async (_sessionId: string, text: string) => { responses.push(text); },
    sendStreamChunk: async (_sessionId: string, chunk: string) => { streamChunks.push(chunk); },
    sendStreamEvent: async (_sessionId: string, event: any) => { streamEvents.push(event); },
    sendMedia: async () => {},
    listSessionIds: () => [],
    supportsStructuredStreaming: () => true
  };

  const fakeModel = {
    id: 'runtime-smoke-model',
    name: 'Runtime Smoke Model',
    generate: async (prompt: string) => {
      prompts.push(prompt);
      turns += 1;
      if (turns === 1) {
        return { content: "I'll inspect and fix that next." };
      }
      if (turns === 2) {
        return {
          content: 'Applying the fix now.',
          toolCalls: [{
            id: 'patch-1',
            name: 'apply_patch',
            arguments: {
              input: '*** Begin Patch\n*** Add File: fixed.txt\n+fixed\n*** End Patch'
            }
          }]
        };
      }
      if (turns === 3) {
        return { content: 'Next I will verify the change.' };
      }
      if (turns === 4) {
        return {
          toolCalls: [{
            id: 'verify-fail',
            name: 'shell',
            arguments: { command: 'node -e "console.error(\'test failed\'); process.exit(1)"' }
          }]
        };
      }
      if (turns === 5) {
        return {
          toolCalls: [{
            id: 'verify-pass',
            name: 'shell',
            arguments: { command: 'node -e "require(\'fs\').accessSync(\'fixed.txt\'); console.log(\'test passed\')"' }
          }]
        };
      }
      return { content: 'Fixed the file and verified it with a passing command.' };
    }
  };

  const runner = new AgentRunner(gateway as any);
  ModelRegistry.register(fakeModel as any);
  assert(ModelRegistry.setCurrentModel(fakeModel.id));

  await runner.processMessage('runtime-session', {
    id: 'message-1',
    channel: 'web',
    senderId: 'runtime-user',
    content: 'Please fix the file and test the result.',
    timestamp: Date.now(),
    metadata: { username: 'Runtime User' }
  });

  assert.strictEqual(turns, 6, 'runtime continues through premature prose, mutation, failed verification, recovery, and success');
  assert(fs.existsSync(path.join(tempDir, 'fixed.txt')), 'the coding tool changed the workspace');
  assert.strictEqual((prompts[0].match(/Please fix the file and test the result\./g) || []).length, 1, 'current request appears once in the prompt');
  assert(!prompts[0].includes('Current User Input:'), 'legacy duplicated current-input block is gone');
  assert(!responses.some(text => text.includes("I'll inspect and fix")), 'premature planning prose is not shown to the user');
  assert(!streamChunks.some(text => text.includes('Fixed the file and verified')), 'model final text is not duplicated through legacy streaming');

  const finalDeltas = streamEvents.filter(event => event.type === 'assistant_delta');
  const finalDone = streamEvents.filter(event => event.type === 'assistant_done');
  assert.strictEqual(finalDeltas.length, 1, 'one structured final delta is emitted');
  assert.strictEqual(finalDone.length, 1, 'one structured completion is emitted');
  assert(String(finalDone[0].finalText).includes('verified'), 'final completion contains verification');

  const { ApplyPatchSkill } = await import('../src/skills/patch');
  const patchSkill = new ApplyPatchSkill();
  fs.writeFileSync('patch-target.txt', 'alpha\nbeta\ngamma\n');
  const updateResult = await patchSkill.execute({
    input: [
      '*** Begin Patch',
      '*** Update File: patch-target.txt',
      '@@',
      ' alpha',
      '-beta',
      '+beta fixed',
      ' gamma',
      '*** End Patch'
    ].join('\n')
  });
  assert.strictEqual(updateResult.summary.failed, 0, 'context-aware update patch succeeds');
  assert.strictEqual(fs.readFileSync('patch-target.txt', 'utf-8'), 'alpha\nbeta fixed\ngamma\n');
  const missingContext = await patchSkill.execute({
    input: '*** Begin Patch\n*** Update File: patch-target.txt\n@@\n-missing\n+replacement\n*** End Patch'
  });
  assert.strictEqual(missingContext.summary.failed, 1, 'missing patch context is reported as a failure');
  const escapedPath = await patchSkill.execute({
    input: '*** Begin Patch\n*** Add File: ../escaped.txt\n+blocked\n*** End Patch'
  });
  assert.strictEqual(escapedPath.summary.failed, 1, 'patches cannot escape the workspace');
  const { ShellSkill } = await import('../src/skills/shell');
  const portableList = await new ShellSkill().execute({
    command: 'ls -la',
    __sessionId: 'runtime-session',
    __workspacePath: tempDir
  });
  assert.strictEqual(portableList.exitCode, 0, 'common ls -la inspection works on the current platform');

  console.log(JSON.stringify({
    success: true,
    tempDir,
    turns,
    structuredFinals: finalDone.length,
    legacyFinalChunks: streamChunks.filter(text => text.includes('Fixed the file and verified')).length,
    responses: responses.length,
    patchUpdateVerified: true,
    portableShellVerified: true
  }, null, 2));
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
