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
 *   9. completion-verdict hook (continue) — no explicit verdict: the engine
 *      asks the host hook "is completion allowed?", owns the transition, and
 *      records the answer as a decision
 *   10. completion-verdict hook (blocked) — evidence with an exhausted retry
 *       budget and a failed batch -> blocked -> FAILED with PARTIAL outcome
 *   11. completion-verdict hook (complete) — hook's complete answer terminates
 *       the task with SUCCESS + 100%
 *   12. engine-level hook + missing-hook guard — engine-level hook answers
 *       when no per-call hook is passed; runTurn without a verdict and without
 *       any hook rejects
 *   13. verify verdict runs the in-loop diagnose authority
 *   14. recordToolKind drives verification-pending
 *   15. runMission drives the loop (tool batch -> final answer, step limit,
 *       host-recorded tools, explicit forced-final verdict)
 *   16. (Phase 17 Move 2) terminal verification gate — the 'verify' verdict
 *       runs a verifier (goal-matched tests): pass -> COMPLETED with PASSED
 *       verification; fail -> repair (recover to EXECUTING, attempts+1) and
 *       re-run at the next completion point; fail until the turn budget
 *       exhausts -> FAILED (terminal, feeds failure memory)
 *   17. (Phase 19 Move 7) deterministic acceptance-criteria evaluation —
 *       criteria that look like assertions (file-contains / test-command)
 *       are evaluated; uncheckable criteria are reported, never silently
 *       passed; the completion gate records each as 'criteria'
 *       TaskVerification evidence and a failing criterion repairs
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { TaskEngine, TaskEventBus, TaskEvent, TaskStore, TaskDiagnoser, TaskTurnVerdict } from '../src/core/task';
import { evaluateAcceptanceCriteria } from '../src/core/context';

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

  // ---- 9. completion-verdict hook: engine asks, host answers (continue) ---
  {
    const { engine } = setup();
    const task = await mission(engine);
    let asked = false;
    const result = await engine.runTurn(task.id, {
      turn: 1,
      evidence: { toolRequired: true, totalToolCalls: 0, forcedContinuations: 0, maxForcedContinuations: 4 }
    }, {
      completionVerdict: async ({ evidence }) => {
        asked = true;
        assert.strictEqual(evidence.toolRequired, true, 'engine passes the host evidence');
        return { type: 'continue', reason: 'The action task has not used any tools yet.' };
      }
    });
    assert.ok(asked, 'engine asked the host for the completion verdict');
    assert.strictEqual(result.action, 'continue', 'continue action returned');
    assert.strictEqual(result.reason, 'The action task has not used any tools yet.', 'reason surfaced to the host');
    assert.strictEqual(result.task.status, 'EXECUTING', 'task stays EXECUTING');
    assert.ok(
      result.task.decisions.some((d) => d.summary.includes('completion verdict: continue')),
      'completion verdict recorded as a decision'
    );
    console.log('9. completion-verdict hook (continue)            ok');
  }

  // ---- 10. completion-verdict hook: blocked on exhausted budget ----
  {
    const { engine } = setup();
    const task = await mission(engine);
    const result = await engine.runTurn(task.id, {
      turn: 1,
      evidence: { lastBatchHadFailure: true, forcedContinuations: 4, maxForcedContinuations: 4 }
    }, {
      // Mirrors the runner's old text/tool/verification completionBlocked
      // heuristic, now answered as a verdict the engine owns.
      completionVerdict: async ({ evidence }) => {
        const withinBudget = (evidence.forcedContinuations ?? 0) < (evidence.maxForcedContinuations ?? 4);
        const blocked = Boolean(evidence.lastBatchHadFailure);
        return withinBudget && !blocked
          ? { type: 'continue', reason: 'recover' }
          : blocked
            ? { type: 'blocked', error: 'Required tool work or verification did not succeed.', reason: 'tool work failed' }
            : { type: 'complete', summary: evidence.finalDraft };
      }
    });
    assert.strictEqual(result.action, 'blocked', 'blocked action returned');
    assert.strictEqual(result.task.status, 'FAILED', 'blocked task is FAILED');
    assert.strictEqual(result.task.outcome?.status, 'PARTIAL', 'blocked outcome is PARTIAL');
    assert.strictEqual(result.error, 'Required tool work or verification did not succeed.', 'blocked error surfaced');
    console.log('10. completion-verdict hook (blocked)            ok');
  }

  // ---- 11. completion-verdict hook: complete ----
  {
    const { engine } = setup();
    const task = await mission(engine);
    const result = await engine.runTurn(task.id, {
      turn: 1,
      evidence: { finalDraft: 'fixed and verified for real this time', toolRequired: true, totalToolCalls: 2 }
    }, {
      completionVerdict: async ({ evidence }) => ({
        type: 'complete',
        summary: (evidence.finalDraft || '').slice(0, 80)
      })
    });
    assert.strictEqual(result.action, 'complete', 'complete action returned');
    assert.strictEqual(result.task.status, 'COMPLETED', 'task COMPLETED');
    assert.strictEqual(result.task.outcome?.status, 'SUCCESS', 'SUCCESS outcome');
    assert.strictEqual(result.task.progress, 100, 'completed task has 100% progress');
    assert.strictEqual(result.task.outcome?.summary, 'fixed and verified for real this time', 'summary recorded');
    console.log('11. completion-verdict hook (complete)           ok');
  }

  // ---- 12. engine-level hook + missing-hook guard ----
  {
    const engine = new TaskEngine({
      store: new TaskStore({ filePath: '' }),
      bus: new TaskEventBus(),
      completionVerdict: async () => ({ type: 'continue', reason: 'engine-level hook' })
    });
    const task = await mission(engine);
    const result = await engine.runTurn(task.id, { turn: 1, evidence: { toolRequired: true } });
    assert.strictEqual(result.action, 'continue', 'engine-level hook answers when the host omits a per-call hook');
    assert.strictEqual(result.reason, 'engine-level hook', 'engine-level reason surfaced');

    const bare = new TaskEngine({ store: new TaskStore({ filePath: '' }), bus: new TaskEventBus() });
    const bareTask = await mission(bare);
    await assert.rejects(
      () => bare.runTurn(bareTask.id, { turn: 1, evidence: { finalDraft: 'x' } }),
      /requires either a `verdict` or a completionVerdict hook/,
      'runTurn without a verdict and without any hook rejects'
    );
    console.log('12. engine-level hook + guard                   ok');
  }

  // ---- 13. verify verdict runs the in-loop diagnose authority ----
  {
    const { engine, events } = setup();
    const task = await mission(engine);
    let diagnoserRan = false;
    const diagnoser: TaskDiagnoser = async (t) => {
      diagnoserRan = true;
      return {
        matchedFiles: ['src/node.ts'],
        tests: [{ command: 'node --test', exitCode: 0, output: 'ok', passed: true }],
        evidence: 'Goal-matched verification ran `node --test` (exit 0):\nok'
      };
    };
    const result = await engine.runTurn(task.id, {
      turn: 1,
      verdict: { type: 'verify', reason: 'Changes were made but no later verification has run.' }
    }, { diagnoser });
    assert.ok(diagnoserRan, 'verify verdict runs the injected repository diagnoser');
    assert.strictEqual(result.action, 'verify', 'verify action returned');
    assert.strictEqual(result.task.status, 'EXECUTING', 'task returns to EXECUTING');
    assert.strictEqual(result.diagnosis?.matchedFiles?.[0], 'src/node.ts', 'diagnosis carries goal-matched files');
    assert.ok(result.task.verification.some(v => v.status === 'PASSED'), 'diagnose recorded canonical PASSED verification evidence');
    assert.ok(events.some(e => e.name === 'TaskVerifying'), 'TaskVerifying emitted during in-loop verify');
    assert.ok(events.some(e => e.name === 'TaskVerified'), 'TaskVerified emitted for PASSED in-loop verification');
    console.log('13. verify verdict runs diagnose authority        ok');
  }

  // ---- 14. verification-pending state: recordToolKind + verificationPending ----
  {
    const { engine } = setup();
    const task = await mission(engine, 'fix the bug');
    const patchExec = await engine.recordToolExecution(task.id, {
      name: 'apply_patch', status: 'COMPLETED', output: 'ok'
    });
    await engine.recordToolKind(task.id, patchExec.id, 'mutation');
    assert.strictEqual(engine.verificationPending(task.id), true, 'mutation + no verification => pending');
    const testExec = await engine.recordToolExecution(task.id, {
      name: 'shell', arguments: { command: 'node --test' }, status: 'COMPLETED', output: 'ok'
    });
    assert.strictEqual(engine.verificationPending(task.id), true, 'verification tool still pending until kind annotated');
    await engine.recordToolKind(task.id, testExec.id, 'verification');
    assert.strictEqual(engine.verificationPending(task.id), false, 'mutation then verification kind => resolved');
    console.log('14. recordToolKind drives verification-pending    ok');
  }

  // ---- 15. runMission drives the loop (Move 4a) ----
  {
    const { engine, events } = setup();
    const task = await mission(engine);
    const iterations: string[] = [];
    const result = await engine.runMission(task.id, {
      iterate: async ({ turn }) => {
        if (turn === 1) {
          iterations.push(`t${turn}:tools`);
          return { content: 'applying the patch', tools: [{ name: 'apply_patch', success: true, output: 'ok' }], model: 'gpt-x' };
        }
        iterations.push(`t${turn}:draft`);
        return { content: 'patch applied and verified for real' };
      },
      completionVerdict: async ({ evidence }) => ({
        type: 'complete',
        summary: (evidence.finalDraft || '').slice(0, 60)
      }),
      budget: { maxTurns: 3, maxForcedContinuations: 2 },
      onTurn: (r, ctx) => { events.push({ name: `turn-${ctx.turn}` as any, action: r.action } as any); }
    });
    assert.deepStrictEqual(iterations, ['t1:tools', 't2:draft'], 'engine walks tool batch then final answer');
    assert.strictEqual(result.action, 'complete', 'mission completed through the driver');
    assert.strictEqual(result.task.status, 'COMPLETED', 'task COMPLETED');
    assert.strictEqual(result.task.outcome?.summary, 'patch applied and verified for real', 'summary recorded');
    assert.strictEqual(result.turns, 2, 'two iterations processed');
    assert.strictEqual(result.task.toolExecutions.length, 1, 'tool batch recorded on the task');
    assert.strictEqual(result.task.toolExecutions[0].name, 'apply_patch', 'tool execution recorded');
    assert.strictEqual(result.stoppedByStepLimit, false, 'completed within budget');

    // step-limit: no terminal answer within budget -> blocked + stoppedByStepLimit
    const engine2 = setup().engine;
    const endless = await mission(engine2, 'keep crafting');
    const limResult = await engine2.runMission(endless.id, {
      iterate: async ({ turn }) => {
        if (turn === 1) return { content: 'working...', tools: [{ name: 'apply_patch', success: true }] };
        return { content: 'still working...' };
      },
      completionVerdict: async () => ({ type: 'continue', reason: 'keep going' }),
      budget: { maxTurns: 2, maxForcedContinuations: 2 }
    });
    assert.strictEqual(limResult.action, 'blocked', 'step limit answered blocked');
    assert.strictEqual(limResult.stoppedByStepLimit, true, 'stoppedByStepLimit surfaced');
    assert.strictEqual(limResult.task.status, 'FAILED', 'terminal state owned by the engine');

    // host-recorded tool work (usedTools): the driver must NOT re-record the
    // executions the host already wrote via its own tool engine.
    const engine3 = setup().engine;
    const selfRecorded = await mission(engine3, 'record my own tools');
    const ownedExec = await engine3.recordToolExecution(selfRecorded.id, { name: 'apply_patch', status: 'COMPLETED', output: 'ok' });
    await engine3.recordToolKind(selfRecorded.id, ownedExec.id, 'mutation');
    const ownedResult = await engine3.runMission(selfRecorded.id, {
      iterate: async ({ turn }) => {
        if (turn === 1) return { content: 'patching', usedTools: true };
        return { content: 'done and verified for real' };
      },
      completionVerdict: async ({ evidence }) => ({ type: 'complete', summary: evidence.finalDraft }),
      budget: { maxTurns: 3 }
    });
    assert.strictEqual(ownedResult.action, 'complete', 'usedTools mission completed');
    assert.strictEqual(ownedResult.task.toolExecutions.length, 1, 'host-recorded execution NOT duplicated');
    assert.strictEqual(engine3.verificationPending(selfRecorded.id), true, 'mutation kind preserved without re-record (unverified)');

    // An explicit host safety verdict is still executed by the engine. This is
    // how Move 4c routes a forced final through TaskEngine rather than letting
    // AgentRunner complete the Task independently.
    const engine4 = setup().engine;
    const forcedFinal = await mission(engine4, 'summarize collected evidence');
    const forcedFinalResult = await engine4.runMission(forcedFinal.id, {
      iterate: async () => ({
        content: 'Collected evidence has been summarized.',
        verdict: { type: 'complete', summary: 'Collected evidence has been summarized.' }
      }),
      completionVerdict: async () => {
        throw new Error('explicit mission verdict must not call the completion hook');
      }
    });
    assert.strictEqual(forcedFinalResult.action, 'complete', 'explicit forced-final verdict completes through the engine');
    assert.strictEqual(forcedFinalResult.task.status, 'COMPLETED', 'explicit forced-final owns the terminal state');
    assert.strictEqual(forcedFinalResult.task.timing.turns, 1, 'explicit forced-final records one canonical turn');

    console.log('15. runMission drives the loop                     ok');
  }

  // ---- 16. Phase 17 Move 2 — terminal verification gate (verify verdict) ----
  {
    // 16a. gate pass -> COMPLETED with PASSED verification evidence.
    const { engine, events } = setup();
    const task = await mission(engine, 'fix the flaky test');
    let gateCalls = 0;
    const result = await engine.runMission(task.id, {
      iterate: async () => ({ content: 'patched and ready.', verdict: { type: 'verify', reason: 'completion gate' } }),
      verifier: async () => { gateCalls += 1; return { passed: true, detail: 'node --test exit 0' }; },
      budget: { maxTurns: 3 }
    });
    assert.strictEqual(result.action, 'complete', 'gate pass completes the mission');
    assert.strictEqual(result.task.status, 'COMPLETED', 'task COMPLETED on gate pass');
    assert.strictEqual(gateCalls, 1, 'gate ran once on pass');
    assert.ok(result.task.verification.some(v => v.status === 'PASSED' && v.kind === 'custom'), 'PASSED custom verification recorded');
    assert.ok(events.some(e => e.name === 'TaskVerifying'), 'TaskVerifying emitted by the gate');
    assert.ok(events.some(e => e.name === 'TaskVerified'), 'TaskVerified emitted on gate pass');

    // 16b. gate fail -> repair -> gate pass -> COMPLETED (attempts bumped).
    const { engine: e2 } = setup();
    const task2 = await mission(e2, 'fix the flaky test');
    let calls = 0;
    const iterations: string[] = [];
    const result2 = await e2.runMission(task2.id, {
      iterate: async ({ turn }) => {
        iterations.push(`t${turn}`);
        return { content: turn === 1 ? 'first repair attempt' : 'second repair attempt', verdict: { type: 'verify', reason: 'completion gate' } };
      },
      verifier: async () => {
        calls += 1;
        return calls === 1
          ? { passed: false, detail: 'node --test exit 1: test failed' }
          : { passed: true, detail: 'node --test exit 0' };
      },
      budget: { maxTurns: 3 }
    });
    assert.strictEqual(result2.action, 'complete', 'repair loop completes after the gate passes');
    assert.deepStrictEqual(iterations, ['t1', 't2'], 'gate failure consumed a repair iteration');
    assert.strictEqual(calls, 2, 'gate ran twice (fail then pass)');
    assert.strictEqual(result2.task.status, 'COMPLETED', 'task COMPLETED after repair');
    assert.ok(result2.task.timing.attempts >= 2, 'gate failure bumped attempts (recovery)');
    assert.ok(result2.task.verification.some(v => v.status === 'FAILED'), 'FAILED verification recorded for the first gate run');
    assert.ok(result2.task.verification.some(v => v.status === 'PASSED'), 'PASSED verification recorded after repair');

    // 16c. gate fail until the budget exhausts -> FAILED (terminal, feeds memory).
    const { engine: e3, events: ev3 } = setup();
    const task3 = await mission(e3, 'fix the flaky test');
    const result3 = await e3.runMission(task3.id, {
      iterate: async () => ({ content: 'still broken.', verdict: { type: 'verify', reason: 'completion gate' } }),
      verifier: async () => ({ passed: false, detail: 'node --test exit 1: still failing' }),
      budget: { maxTurns: 2 }
    });
    assert.strictEqual(result3.action, 'failed', 'budget-exhausted verification fails the mission');
    assert.strictEqual(result3.task.status, 'FAILED', 'task FAILED when the repair budget is exhausted');
    assert.ok(ev3.some(e => e.name === 'TaskVerificationFailed'), 'TaskVerificationFailed emitted on gate fail');
    assert.ok(ev3.some(e => e.name === 'TaskRetrying'), 'TaskRetrying emitted for the gate-failure repair');
    assert.ok(ev3.some(e => e.name === 'TaskFailed'), 'TaskFailed emitted on budget-exhausted gate failure');

    console.log('16. terminal verification gate (pass/repair/exhaust) ok');
  }

  // ---- 17. Phase 19 Move 7 — deterministic acceptance-criteria evaluation ----
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'criteria-check-'));
    try {
      fs.writeFileSync(path.join(tmp, 'notes.txt'), 'hello world\nsecond line\n', 'utf8');

      // 17a. the deterministic evaluator itself.
      const results = await evaluateAcceptanceCriteria(
        ["the file notes.txt should contain 'hello'", "notes.txt contains 'nope'"],
        tmp
      );
      assert.strictEqual(results.length, 2, 'two criteria -> two results');
      assert.strictEqual(results[0].kind, 'file-contains', 'file-contains classification');
      assert.strictEqual(results[0].passed, true, 'present needle passes');
      assert.strictEqual(results[1].kind, 'file-contains', 'second file-contains classification');
      assert.strictEqual(results[1].passed, false, 'absent needle fails');

      const results2 = await evaluateAcceptanceCriteria(
        [
          "the file missing.txt should contain 'x'",
          'run node --version',
          'run node --no-such-flag-xyz',
          'make the UI more beautiful',
          'the command `node --version` passes'
        ],
        tmp
      );
      assert.strictEqual(results2.length, 5, 'five criteria -> five results');
      assert.strictEqual(results2[0].passed, false, 'missing file fails');
      assert.ok(String(results2[0].detail).includes('not found'), 'missing-file detail explains why');
      assert.strictEqual(results2[1].kind, 'test-command', 'run <cmd> classified as test-command');
      assert.strictEqual(results2[1].passed, true, 'exit-0 command passes');
      assert.strictEqual(results2[2].kind, 'test-command', 'failing command still test-command');
      assert.strictEqual(results2[2].passed, false, 'exit-1 command fails');
      assert.strictEqual(results2[3].kind, 'uncheckable', 'plain prose is uncheckable');
      assert.strictEqual(results2[3].passed, null, 'uncheckable is never silently passed');
      assert.strictEqual(results2[4].kind, 'test-command', 'backtick-quoted command classified');
      assert.strictEqual(results2[4].passed, true, 'backtick-quoted command runs and passes');

      // 17b. the gate integration (runner-verifier shape): each criterion is
      // recorded as 'criteria' TaskVerification evidence; a failing criterion
      // fails the gate and repairs; all-pass (incl. uncheckable -> SKIPPED)
      // completes.
      const { engine: e4 } = setup();
      const task4 = await mission(e4, 'write a file');
      const gate4 = await e4.runMission(task4.id, {
        iterate: async () => ({ content: 'done.', verdict: { type: 'verify', reason: 'completion gate' } }),
        verifier: async (task, eng) => {
          const crs = await evaluateAcceptanceCriteria(
            ["the file notes.txt should contain 'hello'", 'make the UI more beautiful'],
            tmp
          );
          let allPassed = true;
          for (const cr of crs) {
            const status = cr.passed === null ? 'SKIPPED' : cr.passed ? 'PASSED' : 'FAILED';
            await eng.recordVerification(task.id, 'criteria', status, `[${cr.kind}] ${cr.detail}`);
            if (cr.passed === false) allPassed = false;
          }
          return { passed: allPassed, detail: 'criteria evaluated' };
        },
        budget: { maxTurns: 3 }
      });
      assert.strictEqual(gate4.action, 'complete', 'all-pass criteria completes the mission');
      assert.strictEqual(gate4.task.status, 'COMPLETED', 'task COMPLETED on criteria pass');
      assert.ok(
        gate4.task.verification.some(v => v.kind === 'criteria' && v.status === 'PASSED'),
        'criteria PASSED evidence recorded'
      );
      assert.ok(
        gate4.task.verification.some(v => v.kind === 'criteria' && v.status === 'SKIPPED'),
        'uncheckable criterion recorded as SKIPPED, not silently passed'
      );

      // failing criterion -> gate fails -> repairs -> second pass completes.
      const { engine: e5 } = setup();
      const task5 = await mission(e5, 'write a file');
      let calls5 = 0;
      const iterations5: string[] = [];
      const gate5 = await e5.runMission(task5.id, {
        iterate: async ({ turn }) => {
          iterations5.push(`t${turn}`);
          return { content: turn === 1 ? 'repairing' : 'fixed.', verdict: { type: 'verify', reason: 'completion gate' } };
        },
        verifier: async (task, eng) => {
          calls5 += 1;
          const needle = calls5 === 1 ? 'MISSING' : 'hello';
          const crs = await evaluateAcceptanceCriteria([`the file notes.txt should contain '${needle}'`], tmp);
          const passed = crs.every(c => c.passed !== false);
          await eng.recordVerification(task.id, 'criteria', passed ? 'PASSED' : 'FAILED', `criterion call ${calls5}`);
          return { passed, detail: passed ? 'criterion passed' : 'criterion failed' };
        },
        budget: { maxTurns: 3 }
      });
      assert.strictEqual(gate5.action, 'complete', 'repair completes after the criterion passes');
      assert.deepStrictEqual(iterations5, ['t1', 't2'], 'criterion failure consumed a repair iteration');
      assert.strictEqual(calls5, 2, 'gate ran twice (fail then pass)');
      assert.strictEqual(gate5.task.status, 'COMPLETED', 'task COMPLETED after repair');
      assert.ok(gate5.task.timing.attempts >= 2, 'criterion failure bumped attempts (recovery)');
      assert.ok(
        gate5.task.verification.some(v => v.kind === 'criteria' && v.status === 'FAILED'),
        'criteria FAILED evidence recorded for the first gate run'
      );
      assert.ok(
        gate5.task.verification.some(v => v.kind === 'criteria' && v.status === 'PASSED'),
        'criteria PASSED evidence recorded after repair'
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }

    console.log('17. deterministic acceptance-criteria evaluation ok');
  }

  // ---- 18. Phase 20 Move 7 — live plan-step status ----
  {
    const { engine } = setup();
    const task = await engine.create({ goal: 'Fix the bug and verify', kind: 'mission' });
    await engine.analyze(task.id);
    await engine.plan(task.id, [
      { id: 's1', title: 'Understand the goal and current state', status: 'PENDING' },
      { id: 's2', title: 'Run `npm test`', status: 'PENDING' },
      { id: 's3', title: 'Verify completion', status: 'PENDING' }
    ]);
    await engine.start(task.id);

    // Tool-kind derivation: a successful MUTATION starts the first step.
    const ex1 = await engine.recordToolExecution(task.id, { name: 'apply_patch', status: 'STARTED', startedAt: Date.now() });
    await engine.completeToolExecution(task.id, ex1.id, { status: 'COMPLETED' });
    await engine.recordToolKind(task.id, ex1.id, 'mutation');
    let plan = engine.get(task.id)!.plan!;
    assert.strictEqual(plan[0].status, 'IN_PROGRESS', 'mutation starts the first step');
    assert.strictEqual(plan[1].status, 'PENDING', 'later steps stay pending');
    assert.strictEqual(plan[2].status, 'PENDING', 'later steps stay pending');

    // A successful VERIFICATION completes the in-progress step + starts next.
    const ex2 = await engine.recordToolExecution(task.id, { name: 'shell', status: 'STARTED', startedAt: Date.now() });
    await engine.completeToolExecution(task.id, ex2.id, { status: 'COMPLETED' });
    await engine.recordToolKind(task.id, ex2.id, 'verification');
    plan = engine.get(task.id)!.plan!;
    assert.strictEqual(plan[0].status, 'COMPLETED', 'verification completes the in-progress step');
    assert.strictEqual(plan[1].status, 'IN_PROGRESS', 'verification starts the next step');
    assert.strictEqual(plan[2].status, 'PENDING', 'third step stays pending');

    // Failed tools do not advance the plan.
    const ex3 = await engine.recordToolExecution(task.id, { name: 'shell', status: 'STARTED', startedAt: Date.now() });
    await engine.completeToolExecution(task.id, ex3.id, { status: 'FAILED', error: 'boom' });
    await engine.recordToolKind(task.id, ex3.id, 'verification');
    plan = engine.get(task.id)!.plan!;
    assert.strictEqual(plan[1].status, 'IN_PROGRESS', 'a failed verification does not advance the plan');

    // Progress records map percent onto equal slices (monotonic forward).
    await engine.recordProgress(task.id, 40);
    plan = engine.get(task.id)!.plan!;
    assert.strictEqual(plan[0].status, 'COMPLETED', 'progress completes crossed slices');
    assert.strictEqual(plan[1].status, 'IN_PROGRESS', 'progress keeps the current slice in progress');
    assert.strictEqual(plan[2].status, 'PENDING', 'future slice stays pending');

    // Explicit markPlanStep: validated, monotonic (a COMPLETED step never reverts).
    await engine.markPlanStep(task.id, 's1', 'IN_PROGRESS');
    assert.strictEqual(engine.get(task.id)!.plan![0].status, 'COMPLETED', 'completed steps never revert');
    await engine.markPlanStep(task.id, 's2', 'COMPLETED');
    plan = engine.get(task.id)!.plan!;
    assert.strictEqual(plan[1].status, 'COMPLETED', 'explicit mark completes a step');
    assert.ok(engine.planSteps(task.id) === plan, 'planSteps exposes the current plan');

    // Terminal completion finishes every remaining step.
    await engine.complete(task.id, { status: 'SUCCESS' });
    plan = engine.get(task.id)!.plan!;
    assert.ok(plan.every((s) => s.status === 'COMPLETED'), 'completed task finishes the whole plan');
    console.log('18. live plan-step status                       ok');
  }

  console.log(JSON.stringify({ success: true, sections: 18 }));
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
