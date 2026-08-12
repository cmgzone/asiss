/**
 * Phase 12 — terminal-path regression smokes (pre-Move 4c).
 *
 * Locks the user-visible behavior of the two former engine-bypassing mission terminals in
 * AgentRunner.processMessage (documented in
 * docs/hermes/TERMINAL_PATHS_AUDIT.md):
 *
 *   1. suppressed-tool-budget stop (runner.ts ~2170-2196)
 *   2. repeated-tool-batch stop      (runner.ts ~2239-2286)
 *
 * Both are driven through the real AgentRunner + global taskEngine with a stub
 * model and a hermetic temp workspace, and assert the same facts the audit
 * records: memory entries, delivered stream events, final Task state, and the
 * engine-owned turn events that now carry the terminal lifecycle transition.
 *
 * Run: npm run smoke:terminal-paths
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitu-terminal-paths-'));
  process.chdir(tempDir);
  fs.writeFileSync('SOUL.md', '# Test Soul\nFinish action tasks with tools.\n');
  fs.writeFileSync('AGENTS.md', '# Test Workspace\n');
  fs.writeFileSync('USER.md', '# Test User\n');

  // Keep all data-root managers (task store, checkpoints, hooks) hermetic.
  process.env.GITU_DATA_ROOT = path.join(tempDir, 'gitu-data');

  const { AgentRunner } = await import('../src/agents/runner');
  const { SkillRegistry } = await import('../src/core/skills');
  const { taskEngine, taskEventBus } = await import('../src/core/task');
  const { executionStateManager } = await import('../src/core/execution-state');

  const writeConfig = (agent: Record<string, unknown>) => {
    fs.writeFileSync(path.join(tempDir, 'config.json'), JSON.stringify({ agent }, null, 2));
  };

  const makeGateway = (events: any[]) => ({
    async sendResponse() {},
    async sendStreamChunk() {},
    async sendMedia() {},
    async sendStreamEvent(_sessionId: string, event: any) { events.push(event); },
    listSessionIds() { return []; },
    supportsStructuredStreaming() { return true; }
  });

  const makeRunner = (events: any[], model: any) => {
    const runner = new AgentRunner(makeGateway(events) as any);
    (runner as any).getModel = () => model;
    (runner as any).getModelById = () => model;
    return runner;
  };

  const missionTask = (sessionId: string) =>
    taskEngine.list().find((t: any) => t.sessionId === sessionId && t.kind === 'mission');

  const assistantFinalNotes = (runner: any, sessionId: string) =>
    (runner as any).memory.getAll(sessionId).filter((m: any) => m.role === 'assistant' && m.metadata?.final === true);

  let passed = 0;
  const total = 2;

  // ------------------------------------------------------------------
  // 1. Suppressed-tool-budget stop
  // ------------------------------------------------------------------
  {
    // maxToolCalls=4 => after 4 executed batches the global tool budget push
    // sets forceFinalAnswer (~2497); the stub keeps requesting tools, so the
    // suppression branch (2170) counts 2 and fires the terminal (~2182).
    writeConfig({ maxToolCalls: 4, maxTurns: 12, maxRepeatedToolBatches: 6, repetitionGuard: { maxRepeatedToolBatches: 6, maxExplorationBatches: 12 } });
    const events: any[] = [];
    const busEvents: any[] = [];
    const off1 = taskEventBus.on('TaskTurnStarted', (event) => { busEvents.push(event); });
    const off2 = taskEventBus.on('TaskTurnCompleted', (event) => { busEvents.push(event); });
    const finalReport = [
      '# Final report',
      'The workspace state is now fully summarized. This is the complete answer to the request.',
      '',
      '## Findings',
      '- Finding one: the harness drove the loop deterministically.',
      '- Finding two: the tool budget was exhausted without a fallback path.',
      '',
      'No further tool work is required. The result is final and verified by inspection of the outputs above.',
      ' '.repeat(200)
    ].join('\n');
    let modelTurn = 0;
    const model = {
      id: 'terminal-paths-budget', name: 'Terminal paths budget',
      async generate(_prompt: string, _systemPrompt?: string, tools: any[] = []) {
        modelTurn += 1;
        return {
          content: finalReport,
          toolCalls: [{ id: `probe-${modelTurn}`, name: 'shell', arguments: { command: `probe-${modelTurn}` } }]
        };
      }
    };
    SkillRegistry.register({
      name: 'shell', description: 'Test shell (tool-budget probe)', inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
      async execute() { return { stdout: 'ok', stderr: '', exitCode: 0 }; }
    });

    const sessionId = `suppressed-budget-${Date.now()}`;
    const runner = makeRunner(events, model);
    await runner.processMessage(sessionId, {
      id: 'msg-budget', channel: 'background', senderId: 'smoke',
      content: 'Summarize the workspace state.',
      timestamp: Date.now(),
      metadata: { backgroundGoalId: 'smoke-terminal-budget' }
    });

    const finals = assistantFinalNotes(runner, sessionId);
    assert.strictEqual(finals.length, 1, 'exactly one assistant-final memory entry');
    assert.strictEqual(finals[0].metadata.toolBudgetStopped, true, 'toolBudgetStopped flag recorded');
    assert.strictEqual(finals[0].metadata.completed, true, 'candidate text marks completion');
    assert.ok(String(finals[0].content).includes('# Final report'), 'final text is the candidate');
    assert.ok(
      (runner as any).memory.getAll(sessionId).some((m: any) => m.metadata?.type === 'mission_tool_budget'),
      'mission_tool_budget system memory exists'
    );
    assert.ok(modelTurn >= 6, `budget stop needs ≥6 model turns, got ${modelTurn}`);

    const done = events.filter((e: any) => e.type === 'assistant_done');
    assert.strictEqual(done.length, 1, 'exactly one assistant_done (the terminal final)');
    assert.strictEqual(done[0].ok, true, 'assistant_done ok matches completed=true');
    assert.ok(String(done[0].finalText).includes('# Final report'), 'delivered final text is the candidate');

    const task = missionTask(sessionId);
    assert.ok(task, 'mission Task exists');
    assert.strictEqual(task.status, 'COMPLETED', 'task COMPLETED through runMission');
    assert.strictEqual(task.outcome?.status, 'SUCCESS', 'outcome SUCCESS when candidate exists');
    assert.strictEqual(task.timing.turns, modelTurn, 'every host iteration is an engine-owned turn');

    const started = busEvents.filter(event => event.name === 'TaskTurnStarted');
    const completedTurns = busEvents.filter(event => event.name === 'TaskTurnCompleted');
    assert.strictEqual(started.length, modelTurn, 'every mission iteration emits TaskTurnStarted');
    assert.strictEqual(completedTurns.length, modelTurn, 'every mission iteration emits TaskTurnCompleted');
    assert.strictEqual(completedTurns[completedTurns.length - 1]?.data?.verdict, 'complete', 'forced final uses the engine complete verdict');
    off1(); off2();
    passed += 1;
    console.log('1. suppressed-tool-budget stop                                ok');
  }

  // ------------------------------------------------------------------
  // 2. Repeated-tool-batch stop
  // ------------------------------------------------------------------
  {
    // maxRepeatedToolBatches=2 => first identical failing batch executes and
    // fails; the second identical batch spends the one recovery (~2242); the
    // third identical batch fires the blocked terminal (~2268).
    writeConfig({ maxToolCalls: 8, maxTurns: 12, maxRepeatedToolBatches: 2, repetitionGuard: { maxRepeatedToolBatches: 2, maxExplorationBatches: 12 } });
    const events: any[] = [];
    const busEvents: any[] = [];
    const off1 = taskEventBus.on('TaskTurnStarted', (event) => { busEvents.push(event); });
    const off2 = taskEventBus.on('TaskTurnCompleted', (event) => { busEvents.push(event); });
    let modelTurn = 0;
    const model = {
      id: 'terminal-paths-repeat', name: 'Terminal paths repeat',
      async generate() {
        modelTurn += 1;
        return {
          content: '',
          toolCalls: [{ id: 'flaky-1', name: 'flaky', arguments: { command: 'boom' } }]
        };
      }
    };
    SkillRegistry.register({
      name: 'flaky', description: 'Test failing tool', inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
      async execute() { return { success: false, error: 'boom' }; }
    });

    const sessionId = `repeated-batch-${Date.now()}`;
    const runner = makeRunner(events, model);
    await runner.processMessage(sessionId, {
      // This path must be interactive: ExecutionStateManager only creates a
      // checklist for foreground missions, which lets the smoke verify the
      // real markBlocked side effect rather than a background no-op.
      id: 'msg-repeat', channel: 'test', senderId: 'smoke',
      content: 'Build the requested artifact.',
      timestamp: Date.now()
    });

    const finals = assistantFinalNotes(runner, sessionId);
    assert.strictEqual(finals.length, 1, 'exactly one assistant-final memory entry');
    assert.strictEqual(finals[0].metadata.blocked, true, 'blocked flag recorded');
    assert.strictEqual(finals[0].metadata.completed, false, 'completed=false on the blocked stop');
    assert.ok(String(finals[0].content).includes('same failed tool action was repeated'), 'blocked text mentions the repeated batch');
    assert.ok(
      (runner as any).memory.getAll(sessionId).some((m: any) => m.metadata?.type === 'repetition_recovery'),
      'repetition_recovery system memory exists'
    );
    assert.ok(modelTurn >= 3, `blocked stop needs ≥3 model turns, got ${modelTurn}`);

    const done = events.filter((e: any) => e.type === 'assistant_done');
    assert.strictEqual(done.length, 1, 'exactly one assistant_done (the blocked final)');
    assert.strictEqual(done[0].ok, false, 'assistant_done ok=false on the blocked stop');
    assert.ok(String(done[0].finalText).includes('same failed tool action was repeated'), 'delivered blocked text');

    const task = missionTask(sessionId);
    assert.ok(task, 'mission Task exists');
    assert.strictEqual(task.status, 'FAILED', 'task FAILED through runMission');
    assert.strictEqual(task.outcome?.status, 'PARTIAL', 'blocked terminal records the partial outcome');
    assert.strictEqual(task.timing.turns, modelTurn, 'every host iteration is an engine-owned turn');

    const state = executionStateManager.getState(sessionId);
    assert.ok(String(state?.lastBlockingReason || '').includes('Repeated the same tool batch'),
      'markBlocked recorded the repetition reason');

    const started = busEvents.filter(event => event.name === 'TaskTurnStarted');
    const completedTurns = busEvents.filter(event => event.name === 'TaskTurnCompleted');
    assert.strictEqual(started.length, modelTurn, 'every mission iteration emits TaskTurnStarted');
    assert.strictEqual(completedTurns.length, modelTurn, 'every mission iteration emits TaskTurnCompleted');
    assert.strictEqual(completedTurns[completedTurns.length - 1]?.data?.verdict, 'blocked', 'repeated batch uses the engine blocked verdict');
    off1(); off2();
    passed += 1;
    console.log('2. repeated-tool-batch stop                                  ok');
  }

  console.log(JSON.stringify({ success: passed === total, passed, total }));
  if (passed !== total) process.exitCode = 1;
}

main()
  .then(() => process.exit(process.exitCode || 0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
