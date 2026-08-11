/**
 * Phase 12 Move 1 — the multi-turn execution contract.
 *
 * Proves `TaskEngine.runTurn()` owns the EXECUTING -> (VERIFYING) -> EXECUTING
 * / COMPLETED transitions across the turns of a long-running mission while the
 * host supplies each turn's verdict. Run with `npm run smoke:turn-contract`.
 *
 * Sections:
 *   1. normal turn (continue) — stays EXECUTING, turns counter advances
 *   2. tool-producing turn — tool executions + ToolStarted/ToolCompleted/
 *      ToolFailed events recorded on the Task
 *   3. failed turn — verdict fail -> FAILED, error surfaced
 *   4. verification-required turn — verdict verify runs the in-loop diagnose
 *      path (EXECUTING -> VERIFYING -> EXECUTING), returns diagnosis evidence
 *   5. multi-turn continuation — N continue turns then complete -> COMPLETED
 *   6. sequential enforcement — non-sequential turn numbers are rejected
 *   7. blocked turn — verdict blocked -> FAILED with PARTIAL outcome
 *   8. engine-owned completion — complete verdict records outcome + 100%
 */

import assert from 'assert';
import { TaskEngine, TaskEventBus, TaskEvent, TaskStore, TaskDiagnoser, TaskTurnVerdict } from '../src/core/task';

function setup() {
  const store = new TaskStore({ filePath: '' });
  const bus = new TaskEventBus();
  const events: TaskEvent[] = [];
  bus.on('*', (event) => { events.push(event); });
  const engine = new TaskEngine({ store, bus });
  return { store, bus, events, engine };
}

async function mission(engine: TaskEngine, goal = 'Fix the bug', turn = 1) {
  const task = await engine.create({ goal, kind: 'mission' });
  await engine.analyze(task.id);
  await engine.plan(task.id);
  await engine.start(task.id);
  return task;
}

async function main() {
  // ---- 1. normal turn (continue) ----
  {
    const { engine, events } = setup();
    const task = await mission(engine);
    const result = await engine.runTurn(task.id, {
      turn: 1,
      verdict: { type: 'continue' },
      model: 'mock-model',
      progress: 20,
      summary: 'inspected the codebase'
    });
    assert.strictEqual(result.action, 'continue', 'continue verdict returns continue');
    assert.strictEqual(result.task.status, 'EXECUTING', 'task stays EXECUTING');
    assert.strictEqual(result.task.timing.turns, 1, 'turns counter advanced to 1');
    assert.strictEqual(result.task.model, 'mock-model', 'model recorded on the task');
    assert.strictEqual(result.task.progress, 20, 'progress recorded');
    assert.ok(events.some((e) => e.name === 'TaskTurnStarted' && e.taskId === task.id), 'TaskTurnStarted emitted');
    assert.ok(events.some((e) => e.name === 'TaskTurnCompleted' && e.taskId === task.id), 'TaskTurnCompleted emitted');
    console.log('1. normal turn (continue)                       ok');
  }

  // ---- 2. tool-producing turn ----
  {
    const { engine, events } = setup();
    const task = await mission(engine);
    const result = await engine.runTurn(task.id, {
      turn: 1,
      verdict: { type: 'continue' },
      tools: [
        { name: 'shell', arguments: { command: 'node -v' }, success: true, output: 'v22', durationMs: 42 },
        { name: 'shell', arguments: { command: 'node -e "process.exit(1)"' }, success: false, error: 'boom', durationMs: 10 }
      ]
    });
    assert.strictEqual(result.task.toolExecutions.length, 2, 'both tools recorded');
    assert.ok(
      result.task.toolExecutions.some((t) => t.name === 'shell' && t.status === 'COMPLETED'),
      'successful tool recorded as COMPLETED'
    );
    assert.ok(
      result.task.toolExecutions.some((t) => t.name === 'shell' && t.status === 'FAILED'),
      'failed tool recorded as FAILED'
    );
    assert.ok(events.some((e) => e.name === 'ToolStarted'), 'ToolStarted emitted');
    assert.ok(events.some((e) => e.name === 'ToolCompleted'), 'ToolCompleted emitted');
    assert.ok(events.some((e) => e.name === 'ToolFailed'), 'ToolFailed emitted');
    console.log('2. tool-producing turn                          ok');
  }

  // ---- 3. failed turn ----
  {
    const { engine } = setup();
    const task = await mission(engine);
    const result = await engine.runTurn(task.id, {
      turn: 1,
      verdict: { type: 'fail', error: 'model exceeded the tool budget' }
    });
    assert.strictEqual(result.action, 'failed', 'fail verdict returns failed');
    assert.strictEqual(result.task.status, 'FAILED', 'task is FAILED');
    assert.strictEqual(result.task.outcome?.status, 'FAILURE', 'outcome records FAILURE');
    assert.ok(result.task.failures.length >= 1, 'failure recorded');
    assert.strictEqual(result.error, 'model exceeded the tool budget', 'error surfaced');
    console.log('3. failed turn                                  ok');
  }

  // ---- 4. verification-required turn ----
  {
    const { engine, events } = setup();
    const task = await mission(engine);
    const diagnoser: TaskDiagnoser = async () => ({
      matchedFiles: ['src/auth.ts'],
      tests: [{ command: 'node --test src/auth.test.js', exitCode: 0, output: 'ok', passed: true }]
    });
    const result = await engine.runTurn(task.id, {
      turn: 1,
      verdict: { type: 'verify', reason: 'changes were made but no verification ran' }
    }, { diagnoser });
    assert.strictEqual(result.action, 'verify', 'verify verdict returns verify');
    assert.strictEqual(result.task.status, 'EXECUTING', 'task returns to EXECUTING (in-loop verification)');
    assert.strictEqual(result.task.timing.turns, 1, 'turn counted');
    assert.ok(result.diagnosis, 'diagnosis evidence returned');
    assert.deepStrictEqual(result.diagnosis?.matchedFiles, ['src/auth.ts'], 'matched files in diagnosis');
    assert.strictEqual(result.diagnosis?.tests?.[0]?.passed, true, 'test result in diagnosis');
    assert.ok(
      result.task.verification.some((v) => v.kind === 'unit' && v.status === 'PASSED'),
      'verification evidence recorded on the task'
    );
    assert.ok(events.some((e) => e.name === 'TaskVerifying'), 'TaskVerifying emitted');
    assert.ok(events.some((e) => e.name === 'TestPassed'), 'TestPassed emitted');
    assert.ok(events.some((e) => e.name === 'TaskRecovered'), 'TaskRecovered emitted');
    console.log('4. verification-required turn                   ok');
  }

  // ---- 5. multi-turn continuation ----
  {
    const { engine } = setup();
    const task = await mission(engine);
    const r1 = await engine.runTurn(task.id, { turn: 1, verdict: { type: 'continue' } });
    const r2 = await engine.runTurn(task.id, { turn: 2, verdict: { type: 'continue' } });
    const r3 = await engine.runTurn(task.id, { turn: 3, verdict: { type: 'continue' } });
    const r4 = await engine.runTurn(task.id, {
      turn: 4,
      verdict: { type: 'complete', summary: 'fixed and verified' },
      progress: 100
    });
    assert.strictEqual(r1.task.timing.turns, 1, 'turn 1 counted');
    assert.strictEqual(r2.task.timing.turns, 2, 'turn 2 counted');
    assert.strictEqual(r3.task.timing.turns, 3, 'turn 3 counted');
    assert.strictEqual(r4.action, 'complete', 'final turn completes');
    assert.strictEqual(r4.task.status, 'COMPLETED', 'task COMPLETED');
    assert.strictEqual(r4.task.timing.turns, 4, 'turn 4 counted on the completed task');
    assert.strictEqual(r4.task.outcome?.status, 'SUCCESS', 'SUCCESS outcome');
    assert.strictEqual(r4.task.outcome?.summary, 'fixed and verified', 'completion summary');
    assert.strictEqual(r4.task.progress, 100, 'completed task has 100% progress');
    console.log('5. multi-turn continuation                      ok');
  }

  // ---- 6. sequential enforcement ----
  {
    const { engine } = setup();
    const task = await mission(engine);
    await engine.runTurn(task.id, { turn: 1, verdict: { type: 'continue' } });
    await assert.rejects(
      () => engine.runTurn(task.id, { turn: 1, verdict: { type: 'continue' } }),
      /must be sequential/,
      'repeating a turn number is rejected'
    );
    await assert.rejects(
      () => engine.runTurn(task.id, { turn: 3, verdict: { type: 'continue' } }),
      /must be sequential/,
      'skipping a turn number is rejected'
    );
    await assert.rejects(
      () => engine.runTurn(task.id, { turn: 'abc' as any, verdict: { type: 'continue' } }),
      /must be sequential/,
      'non-numeric turn is rejected'
    );
    console.log('6. sequential enforcement                       ok');
  }

  // ---- 7. blocked turn ----
  {
    const { engine } = setup();
    const task = await mission(engine);
    const result = await engine.runTurn(task.id, {
      turn: 1,
      verdict: { type: 'blocked', error: 'approval denied', reason: 'user declined the destructive command' }
    });
    assert.strictEqual(result.action, 'blocked', 'blocked verdict returns blocked');
    assert.strictEqual(result.task.status, 'FAILED', 'blocked task is FAILED');
    assert.strictEqual(result.task.outcome?.status, 'PARTIAL', 'blocked outcome is PARTIAL');
    assert.strictEqual(result.error, 'approval denied', 'blocked error surfaced');
    console.log('7. blocked turn                                 ok');
  }

  // ---- 8. engine-owned completion ----
  {
    const { engine } = setup();
    const task = await mission(engine);
    const result = await engine.runTurn(task.id, {
      turn: 1,
      verdict: { type: 'complete', summary: 'done', result: { fixed: true }, confidence: 0.9 }
    });
    assert.strictEqual(result.action, 'complete', 'complete verdict returns complete');
    assert.strictEqual(result.task.status, 'COMPLETED', 'task COMPLETED');
    assert.deepStrictEqual(result.task.outcome?.result, { fixed: true }, 'result recorded on outcome');
    assert.strictEqual(result.task.outcome?.confidence, 0.9, 'confidence recorded');
    assert.strictEqual(result.task.progress, 100, 'complete() sets 100% progress');
    console.log('8. engine-owned completion                      ok');
  }

  console.log(JSON.stringify({ success: true, sections: 8 }));
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
