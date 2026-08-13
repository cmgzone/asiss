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
  // A file whose path matches the mission goal tokens, so the Phase 10
  // goal-aware retry hint has a file to name.
  fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tempDir, 'src/fix-result.ts'), 'export function fixResult() { return true; }\n');
  // A sibling test (node:test, no deps) so Phase 11 can run it after a failure.
  fs.writeFileSync(path.join(tempDir, 'src/fix-result.test.js'),
    "const { test } = require('node:test');\nconst assert = require('node:assert');\ntest('goal-matched test runs', () => { assert.ok(true); });\n");
  fs.writeFileSync('config.json', JSON.stringify({
    model: 'mock',
    agent: {
      maxTurns: 12,
      autoContinue: { enabled: true, maxBatches: 1, notify: false },
      maxPrematureCompletions: 4,
      context: { repository: { enabled: true } }
    },
    modelRouter: {
      enabled: true,
      rules: [],
      levelMap: { simple: 'low', medium: 'medium', complex: 'high' }
    },
    execution: { allowProcessCwd: true }
  }, null, 2));
  // Keep all data-root managers (task store, checkpoints, hooks) hermetic.
  process.env.GITU_DATA_ROOT = path.join(tempDir, 'gitu-data');

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
  const systemPrompts: string[] = [];
  const advertisedTools: any[][] = [];
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
    generate: async (prompt: string, systemPrompt?: string, tools?: any[]) => {
      prompts.push(prompt);
      systemPrompts.push(systemPrompt || '');
      advertisedTools.push(tools || []);
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

  // Phase 16 Move 3b: designate a default AgentProfile (explicitly, via
  // metadata.default) so the host-driven mission resolves it through the same
  // Agent contract AgentEngine children use — assignedAgent on the mission
  // Task, modelPolicy.modelId as the model pin (pinned to the fake model so
  // the existing selection assertions stay intact), persona + instructions in
  // the system prompt. Without a designation the mission is byte-identical.
  const { agentEngine, agentRegistry } = await import('../src/core/agent');
  const defaultMain = agentRegistry.register({
    name: 'Hermes Main',
    role: 'general',
    description: 'Designated default host-driven agent.',
    capabilities: ['general'],
    instructions: 'Follow the mission to completion using tools and verification.',
    modelPolicy: { modelId: fakeModel.id },
    // Phase 16 Move 4 (D4): the ToolPolicy shapes the mission surface — deny
    // one tool the mission never uses; the mission-critical tools stay.
    permissions: { deniedTools: ['web_search'] },
    taskScope: 'mission',
    metadata: { default: true }
  });
  assert.strictEqual(agentEngine.resolveDefaultAgent()!.id, defaultMain.id, 'designated default resolves');

  // Canonical Task (Phase 3): task/tool lifecycle events must be observable
  // through hookManager via the task-hooks bridge (auto-installed on import).
  const { hookManager } = await import('../src/core/hooks');
  const observedHooks: string[] = [];
  const offTaskCreated = hookManager.on('TaskCreated', () => { observedHooks.push('TaskCreated'); });
  const offTaskCompleted = hookManager.on('TaskCompleted', () => { observedHooks.push('TaskCompleted'); });
  const offToolCompleted = hookManager.on('ToolCompleted', () => { observedHooks.push('ToolCompleted'); });
  // Phase 12 D3: the legacy tool-lifecycle hook names must still fire through
  // the bus -> bridge aliases now that the runner emits nothing for tools.
  const offBeforeTool = hookManager.on('before_tool', () => { observedHooks.push('before_tool'); });
  const offAfterTool = hookManager.on('after_tool', () => { observedHooks.push('after_tool'); });
  const offToolError = hookManager.on('tool_error', () => { observedHooks.push('tool_error'); });

  await runner.processMessage('runtime-session', {
    id: 'message-1',
    channel: 'web',
    senderId: 'runtime-user',
    content: 'Please fix the file and test the result.',
    timestamp: Date.now(),
    metadata: { username: 'Runtime User', projectWorkspacePath: tempDir }
  });

  assert.strictEqual(turns, 6, 'runtime continues through premature prose, mutation, failed verification, recovery, and success');
  assert(fs.existsSync(path.join(tempDir, 'fixed.txt')), 'the coding tool changed the workspace');
  assert.strictEqual((prompts[0].match(/Please fix the file and test the result\./g) || []).length, 1, 'current request appears once in the prompt');
  assert(!prompts[0].includes('Current User Input:'), 'legacy duplicated current-input block is gone');
  assert(!responses.some(text => text.includes("I'll inspect and fix")), 'premature planning prose is not shown to the user');
  assert(!streamChunks.some(text => text.includes('Fixed the file and verified')), 'model final text is not duplicated through legacy streaming');

  const finalDeltas = streamEvents.filter(event => event.type === 'assistant_delta');
  const finalDone = streamEvents.filter(event => event.type === 'assistant_done');
  // The resilient-model wrapper streams model prose live, so intermediate
  // turns legitimately emit assistant_delta/done bubbles. The intent of this
  // check is that a structured final completion with the verified result is
  // delivered — not that exactly one event exists.
  if (finalDeltas.length < 1) throw new Error('no structured final delta is emitted');
  if (finalDone.length < 1) throw new Error('no structured completion is emitted');
  assert(String(finalDone[finalDone.length - 1].finalText).includes('verified'), 'final completion contains verification');

  // Canonical Task (Phase 2): the mission must have created a Task, recorded
  // its tool executions, and finalized as COMPLETED without changing behavior.
  const { taskEngine } = await import('../src/core/task');
  const missionTasks = taskEngine.listByStatus('COMPLETED');
  const mission = missionTasks.find((t) => t.sessionId === 'runtime-session');
  assert(mission, 'the mission created a canonical Task');
  assert.strictEqual(mission.outcome?.status, 'SUCCESS', 'mission task completed successfully');
  assert.ok(mission.toolExecutions.length >= 3, `expected >=3 tool executions, got ${mission.toolExecutions.length}`);
  assert.ok(
    mission.toolExecutions.some((exec) => exec.name === 'apply_patch' && exec.status === 'COMPLETED'),
    'apply_patch recorded as completed'
  );
  assert.ok(
    mission.toolExecutions.some((exec) => exec.name === 'shell' && exec.status === 'FAILED'),
    'the failed verification shell command is recorded as failed'
  );
  assert.ok(
    mission.toolExecutions.some((exec) => exec.name === 'shell' && exec.status === 'COMPLETED'),
    'the passing verification shell command is recorded as completed'
  );
  assert.ok(mission.progress === 100, 'completed task has 100% progress');
  // Phase 16 Move 3b: the mission resolved the designated default AgentProfile
  // through the same contract as AgentEngine children — the mission Task is
  // assigned to it, its instructions render in the system prompt, and its
  // modelPolicy pin is honored (still the fake model, so selection is
  // unchanged).
  assert.strictEqual(mission.assignedAgent, defaultMain.id, 'mission task assigned to the designated default agent');
  assert.ok(
    systemPrompts.some((sp) => sp.includes('Follow the mission to completion using tools and verification.')),
    'default agent instructions render in the mission system prompt'
  );
  // Phase 16 Move 4 (D4): the denied tool left the advertised mission surface
  // while the tools the mission actually used stayed.
  assert.ok(
    advertisedTools.length > 0 && advertisedTools.every((list) => !list.some((t) => t.name === 'web_search')),
    'denied tool absent from the advertised mission surface (ToolPolicy)'
  );
  assert.ok(
    advertisedTools.some((list) => list.some((t) => t.name === 'apply_patch') && list.some((t) => t.name === 'shell')),
    'mission-critical tools remain advertised'
  );
  // Move 2 (one execution authority): the recovery the mission performed ran
  // through TaskEngine.diagnose, so the canonical Task carries the recovery
  // evidence — a verification record for the goal-matched test run and a
  // bumped attempt count.
  assert.ok(
    mission.verification.some((v) => v.kind === 'unit'),
    `diagnose recorded verification evidence on the mission task (got ${mission.verification.length})`
  );
  assert.ok(mission.timing.attempts >= 2, `recovery counted attempts (got ${mission.timing.attempts})`);
  assert.strictEqual(typeof mission.timing.durationMs, 'number', 'completed task records duration');
  assert.strictEqual(mission.model, fakeModel.id, 'ModelEngine records the selected provider on the canonical Task');
  // Phase 20 (AUDIT_11): the loop is one connected chain — the mission task
  // carries the goal id, the plan is a real artifact on the task, the goal
  // records the linked task + its outcome evidence, and the plan renders into
  // the mission prompt.
  assert.ok(
    typeof mission.metadata?.goalId === 'string',
    'mission task carries the session goal id (goal -> task linkage)'
  );
  assert.ok(
    Array.isArray(mission.plan) && mission.plan.length > 0,
    `mission task carries a real plan (got ${mission.plan?.length || 0} steps)`
  );
  assert.ok(
    systemPrompts.some((sp) => sp.includes('Mission plan (derived from the goal')),
    'the recorded plan renders into the mission system prompt'
  );
  const { mainGoalManager } = await import('../src/core/main-goal');
  const completedGoal = mainGoalManager.getRecent('runtime-session').find((g) => g.status === 'completed');
  assert.ok(completedGoal, 'the auto-origin goal was completed after the mission');
  assert.ok(
    completedGoal!.linkedTaskIds.includes(mission.id),
    'the goal records the linked mission task'
  );
  const goalOutcome = (completedGoal!.taskOutcomes || []).find((o) => o.taskId === mission.id);
  assert.ok(goalOutcome, 'the goal records the mission task outcome (complete -> goal evidence)');
  assert.strictEqual(goalOutcome!.outcome, 'SUCCESS', 'completed mission records SUCCESS evidence on the goal');
  assert.ok(
    mission.decisions.some((decision) => decision.summary.includes(`ModelEngine selected '${fakeModel.id}'`)),
    'ModelEngine stores its explainable selection decision on the Task'
  );
  const { modelEngine } = await import('../src/core/model');
  const modelPerformance = modelEngine.getPerformance(fakeModel.id);
  assert.ok(modelPerformance.successfulModelCalls >= 6, 'ModelEngine records successful model requests');
  assert.ok(modelPerformance.toolCalls >= 3, 'ModelEngine records outcomes for model-proposed tool calls');

  // The bridge forwarded lifecycle events onto the existing hook bus.
  assert.ok(observedHooks.includes('TaskCreated'), 'hookManager observed TaskCreated via the bridge');
  assert.ok(observedHooks.includes('TaskCompleted'), 'hookManager observed TaskCompleted via the bridge');
  assert.ok(observedHooks.includes('ToolCompleted'), 'hookManager observed ToolCompleted via the bridge');
  // D3: the mission used tools (some failed on purpose), so both the success
  // alias and the failure alias must have been observed — proving the runner's
  // direct emits were safely replaced by the bridge aliases.
  assert.ok(observedHooks.includes('before_tool'), 'before_tool alias observed via the bridge (runner emits nothing)');
  assert.ok(observedHooks.includes('after_tool'), 'after_tool alias observed for tool success');
  assert.ok(observedHooks.includes('tool_error'), 'tool_error alias observed for tool failure');
  offTaskCreated();
  offTaskCompleted();
  offToolCompleted();
  offBeforeTool();
  offAfterTool();
  offToolError();

  // Phase 10: the failed verification tool must have injected a goal-aware
  // retry hint naming the files the index matched for the mission goal.
  const allMemories = (runner as any).memory.getAll('runtime-session') as any[];
  const retryHints = allMemories.filter((m) => m.metadata?.type === 'goal_retry_hint');
  assert.ok(retryHints.length >= 1, 'a goal-aware retry hint was injected on tool failure');
  assert.ok(
    retryHints.some((m) => String(m.content).includes('src/fix-result.ts')),
    'the retry hint names the goal-matched file'
  );
  assert.ok(
    String(retryHints[0].content).includes('Inspect these files and target the retry'),
    'the retry hint tells the model to target the retry at those files'
  );

  // Phase 11: verify-then-retry — the goal-matched test ran and its output
  // was fed back into the context before the retry.
  const verifyOutputs = allMemories.filter((m) => m.metadata?.type === 'goal_verify_output');
  assert.ok(verifyOutputs.length >= 1, 'goal-matched tests were run after the failure');
  assert.ok(String(verifyOutputs[0].content).includes('node --test'), 'verification ran via node --test');
  assert.ok(String(verifyOutputs[0].content).includes('exit 0'), 'the matched test passed');

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
    goalRetryHint: retryHints.length >= 1,
    goalVerification: verifyOutputs.length >= 1,
    success: true,
    tempDir,
    turns,
    structuredFinals: finalDone.length,
    legacyFinalChunks: streamChunks.filter(text => text.includes('Fixed the file and verified')).length,
    responses: responses.length,
    modelEngineIntegrated: true,
    patchUpdateVerified: true,
    portableShellVerified: true
  }, null, 2));
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
