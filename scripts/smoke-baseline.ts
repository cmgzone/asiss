/**
 * Baseline smoke test — Hermes Evolution Phase 0/1.
 *
 * Offline (no model API): guards the most important existing workflows plus
 * the new canonical Task system. Run with `npm run smoke:baseline`.
 *
 * Covers:
 *   1. task-memory (current-task resume, folded)   — canonical Task
 *   2. checkpoint-manager (create/rollback)        — existing
 *   3. Task state machine                          — new
 *   4. TaskEngine full lifecycle + events          — new
 *   5. Failure -> retry -> recovery path           — new
 *   6. Dependency blocking -> unblocking           — new
 *   7. pause / resume / cancel                     — new
 *   8. Child tasks (rootId/parentId/subtasks)      — new
 *   9. TaskStore JSON persistence round-trip       — new
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CheckpointManager } from '../src/core/checkpoint-manager';
import {
  TaskEngine,
  TaskStore,
  TaskEventBus,
  TaskEvent,
  TaskMemory,
  canTransition,
  isTerminal,
  Task,
  installTaskHooksBridge,
  TaskHooksSink
} from '../src/core/task';

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitu-smoke-baseline-'));
  try {
    // ---- 1. Folded: task-memory (current-task resume on canonical Tasks) ----
    // Phase 12 D2: the legacy TaskContext (current_task.json) is replaced by
    // TaskMemory over the canonical Task store; nothing writes current_task.json.
    const memoryStore = new TaskStore({ filePath: '' });
    const memoryEngine = new TaskEngine({ store: memoryStore, bus: new TaskEventBus() });
    const mem = new TaskMemory({ engine: memoryEngine });
    const started = await mem.start('Baseline smoke task', 'smoke-session', ['context point']);
    assert.equal(started.kind, 'resume', 'tracked task is a canonical resume task');
    assert.equal(mem.toEntry(started).goal, 'Baseline smoke task');
    assert.equal(await mem.addContext('smoke-session', 'second point'), true);
    assert.ok(mem.summaryPrompt('smoke-session').includes('Baseline smoke task'));
    assert.ok(mem.summaryPrompt('smoke-session').includes('2. second point'), 'context points render');
    assert.equal(mem.hasUnfinishedTask('smoke-session'), true);
    assert.equal(await mem.complete('smoke-session'), true);
    assert.equal(mem.current('smoke-session'), undefined);
    assert.equal(mem.recent('smoke-session').length, 1);
    const completed = memoryStore.require(started.id);
    assert.equal(completed.status, 'COMPLETED');
    assert.ok(!fs.existsSync(path.join(root, 'current_task.json')), 'current_task.json is never written');

    // ---- 2. Existing: checkpoint-manager (create/rollback) ----
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const checkpoints = new CheckpointManager(path.join(root, 'checkpoints'));
    const file = path.join(workspace, 'example.txt');
    fs.writeFileSync(file, 'original');
    const cp = checkpoints.create(workspace, 'before mutation', 'smoke-session');
    fs.writeFileSync(file, 'changed');
    const rollback = checkpoints.rollback(workspace, cp.id, 'smoke-session');
    assert.equal(rollback.success, true);
    assert.equal(fs.readFileSync(file, 'utf8'), 'original');

    // ---- 3. New: state machine ----
    assert.equal(canTransition('CREATED', 'ANALYZING'), true);
    assert.equal(canTransition('EXECUTING', 'VERIFYING'), true);
    assert.equal(canTransition('EXECUTING', 'COMPLETED'), true);
    assert.equal(canTransition('COMPLETED', 'EXECUTING'), false);
    assert.equal(isTerminal('COMPLETED'), true);
    assert.equal(isTerminal('CANCELLED'), true);
    assert.equal(isTerminal('READY'), false);

    // ---- 4. New: full lifecycle + events + tool recording ----
    const storeFile = path.join(root, 'tasks', 'tasks.json');
    const store = new TaskStore({ filePath: storeFile });
    const bus = new TaskEventBus();
    const events: TaskEvent[] = [];
    const off = bus.on('*', (event) => { events.push(event); });

    const engine = new TaskEngine({
      store,
      bus,
      executor: async (task) => {
        await engine.recordToolExecution(task.id, { name: 'apply_patch', status: 'COMPLETED', output: 'ok' });
        await engine.recordProgress(task.id, 100, 'implemented');
        await engine.recordCost(task.id, { model: 'mock', tokensIn: 10, tokensOut: 5 });
        return { success: true, summary: 'implemented', confidence: 0.9 };
      }
    });

    const created = await engine.create({ goal: 'Fix the auth bug', kind: 'mission', priority: 'high' });
    assert.equal(created.status, 'CREATED');
    const outcome = await engine.run(created.id);
    assert.equal(outcome.success, true);
    const finished = engine.require(created.id);
    assert.equal(finished.status, 'COMPLETED');
    assert.equal(finished.outcome?.status, 'SUCCESS');
    assert.equal(finished.outcome?.confidence, 0.9);
    assert.equal(finished.progress, 100);
    assert.equal(finished.toolExecutions.length, 1);
    assert.equal(finished.toolExecutions[0].name, 'apply_patch');
    assert.equal(finished.cost.tokensIn, 10);
    assert.equal(typeof finished.timing.durationMs, 'number');
    for (const name of ['TaskCreated', 'TaskAnalyzed', 'TaskPlanned', 'TaskReady', 'TaskStarted', 'ToolCompleted', 'TaskProgress', 'TaskCompleted']) {
      assert.ok(events.some((e) => e.name === name), `expected event ${name}`);
    }
    off();

    // ---- 5. New: failure -> retry -> recovery ----
    const bus2 = new TaskEventBus();
    const events2: TaskEvent[] = [];
    bus2.on('*', (event) => { events2.push(event); });
    let attempt = 0;
    const engine2 = new TaskEngine({
      store,
      bus: bus2,
      executor: async () => {
        attempt += 1;
        if (attempt === 1) return { success: false, error: 'build failed' };
        return { success: true, summary: 'fixed' };
      }
    });
    const failing = await engine2.create({ goal: 'Fix the build' });
    const first = await engine2.run(failing.id);
    assert.equal(first.success, false);
    assert.equal(first.failed, true);
    assert.equal(engine2.require(failing.id).status, 'FAILED');
    assert.equal(engine2.require(failing.id).failures.length, 1);
    const retried = await engine2.retry(failing.id, { repair: async () => { /* no-op repair */ } });
    assert.equal(retried.success, true);
    const recovered = engine2.require(failing.id);
    assert.equal(recovered.status, 'COMPLETED');
    assert.equal(recovered.timing.attempts, 2);
    for (const name of ['TaskFailed', 'TaskRetrying', 'TaskRecovered', 'TaskCompleted']) {
      assert.ok(events2.some((e) => e.name === name), `expected event ${name}`);
    }

    // ---- 6. New: dependency blocking -> unblocking ----
    const bus3 = new TaskEventBus();
    const events3: TaskEvent[] = [];
    bus3.on('*', (event) => { events3.push(event); });
    const engine3 = new TaskEngine({ store, bus: bus3, executor: async () => ({ success: true }) });
    const dep = await engine3.create({ goal: 'inspect API' });
    const dep2 = await engine3.create({ goal: 'inspect DB' });
    const planTask = await engine3.create({ goal: 'Plan', dependencies: [dep.id, dep2.id] });
    const blocked = await engine3.run(planTask.id);
    assert.equal(blocked.blocked, true);
    assert.equal(engine3.require(planTask.id).status, 'BLOCKED');
    assert.ok(events3.some((e) => e.name === 'TaskBlocked'));
    await engine3.run(dep.id);
    await engine3.run(dep2.id);
    assert.equal(engine3.require(planTask.id).status, 'READY', 'dependent should unblock');
    assert.ok(events3.some((e) => e.name === 'TaskRecovered'));
    const planOk = await engine3.run(planTask.id);
    assert.equal(planOk.success, true);
    assert.equal(engine3.require(planTask.id).status, 'COMPLETED');

    // ---- 7. New: pause / resume / cancel ----
    const p = await engine.create({ goal: 'Pauseable work' });
    await engine.analyze(p.id);
    await engine.plan(p.id);
    await engine.pause(p.id);
    assert.equal(engine.require(p.id).status, 'PAUSED');
    await engine.resume(p.id);
    assert.equal(engine.require(p.id).status, 'READY');
    const c = await engine.create({ goal: 'Cancel me' });
    await engine.cancel(c.id, 'user changed mind');
    assert.equal(engine.require(c.id).status, 'CANCELLED');
    assert.equal(engine.require(c.id).outcome?.status, 'CANCELLED');

    // ---- 8. New: child tasks ----
    const child = await engine.createChildTask(created.id, { goal: 'child step' });
    assert.equal(child.rootId, created.id);
    assert.equal(child.parentId, created.id);
    assert.ok(engine.require(created.id).subtasks.includes(child.id));

    // ---- 9. New: persistence round-trip ----
    const reloaded = new TaskStore({ filePath: storeFile });
    assert.equal(reloaded.get(created.id)?.status, 'COMPLETED');
    assert.equal(reloaded.get(failing.id)?.status, 'COMPLETED');
    assert.equal(reloaded.get(child.id)?.rootId, created.id);
    assert.ok(reloaded.get(child.id) instanceof Object);
    const task: Task | undefined = reloaded.get(created.id);
    assert.ok(task && task.verification.length === 0 && task.artifacts.length === 0);

    // ---- 10. New: host-driven lifecycle (start / completeToolExecution / failTask) ----
    const bus4 = new TaskEventBus();
    const events4: TaskEvent[] = [];
    bus4.on('*', (event) => { events4.push(event); });
    const engine4 = new TaskEngine({ store, bus: bus4 });
    const host = await engine4.create({ goal: 'Host-driven mission' });
    await engine4.analyze(host.id);
    await engine4.plan(host.id);
    await engine4.start(host.id);
    assert.equal(engine4.require(host.id).status, 'EXECUTING');
    const exec = await engine4.recordToolExecution(host.id, {
      name: 'shell',
      arguments: { command: 'npm test' },
      status: 'STARTED'
    });
    const doneExec = await engine4.completeToolExecution(host.id, exec.id, {
      status: 'COMPLETED',
      output: 'all tests passed'
    });
    assert.equal(doneExec?.status, 'COMPLETED');
    assert.equal(typeof doneExec?.durationMs, 'number');
    const failedExec = await engine4.recordToolExecution(host.id, { name: 'git', status: 'STARTED' });
    await engine4.completeToolExecution(host.id, failedExec.id, { status: 'FAILED', error: 'merge conflict' });
    await engine4.failTask(host.id, 'verification failed', 'EXECUTING');
    assert.equal(engine4.require(host.id).status, 'FAILED');
    assert.equal(engine4.require(host.id).failures.length, 1);
    assert.equal(engine4.require(host.id).toolExecutions.length, 2);
    assert.equal(engine4.require(host.id).toolExecutions[1].status, 'FAILED');
    for (const name of ['ToolStarted', 'ToolCompleted', 'ToolFailed', 'TaskFailed']) {
      assert.ok(events4.some((e) => e.name === name), `expected event ${name}`);
    }

    // ---- 11. New: task-hooks bridge (TaskEventBus -> hookManager) ----
    const bus5 = new TaskEventBus();
    const observed: Array<{ name: string; taskId?: string; sessionId?: string; tool?: unknown; error?: unknown; success?: unknown; projectId?: unknown; output?: unknown; durationMs?: unknown }> = [];
    const mockHooks: TaskHooksSink = {
      emit: async (name, data, sessionId) => {
        observed.push({
          name,
          taskId: String(data?.taskId || ''),
          sessionId,
          tool: data?.tool,
          error: data?.error,
          success: data?.success,
          projectId: data?.projectId,
          output: data?.output,
          durationMs: data?.durationMs
        });
      }
    };
    const uninstallBridge = installTaskHooksBridge(bus5, mockHooks);
    const engine5 = new TaskEngine({ store, bus: bus5, executor: async () => ({ success: true }) });
    const bridged = await engine5.create({ goal: 'Bridged mission', sessionId: 'bridge-session' });
    await engine5.run(bridged.id);
    // Phase 12 D3: tool lifecycle is bus-only, aliased for legacy subscribers.
    // Record a STARTED -> COMPLETED tool execution (the canonical events the
    // ToolEngine would emit) and assert the bridge forwards BOTH the canonical
    // name and the legacy alias with equivalent payloads.
    const aliasExec = await engine5.recordToolExecution(bridged.id, {
      name: 'shell',
      arguments: { command: 'npm test' },
      status: 'STARTED',
      projectId: 'p-7'
    });
    await engine5.completeToolExecution(bridged.id, aliasExec.id, {
      status: 'COMPLETED',
      output: 'all tests passed',
      durationMs: 42
    });
    const aliasFailedExec = await engine5.recordToolExecution(bridged.id, { name: 'git', status: 'STARTED' });
    await engine5.completeToolExecution(bridged.id, aliasFailedExec.id, { status: 'FAILED', error: 'merge conflict' });
    uninstallBridge();
    assert.ok(observed.some((e) => e.name === 'TaskCreated' && e.taskId === bridged.id), 'TaskCreated forwarded with taskId');
    assert.ok(observed.some((e) => e.name === 'TaskStarted' && e.sessionId === 'bridge-session'), 'TaskStarted forwarded with sessionId');
    assert.ok(observed.some((e) => e.name === 'TaskCompleted' && e.sessionId === 'bridge-session'), 'TaskCompleted forwarded with sessionId');
    // Canonical tool events forwarded.
    assert.ok(observed.some((e) => e.name === 'ToolStarted' && e.tool === 'shell'), 'ToolStarted forwarded');
    assert.ok(observed.some((e) => e.name === 'ToolCompleted' && e.tool === 'shell'), 'ToolCompleted forwarded');
    assert.ok(observed.some((e) => e.name === 'ToolFailed' && e.tool === 'git'), 'ToolFailed forwarded');
    // Legacy aliases preserved (D3): same lifecycle, legacy names + payloads.
    const before = observed.find((e) => e.name === 'before_tool' && e.tool === 'shell');
    assert.ok(before, 'before_tool alias emitted for the shell call');
    const beforeCanonical = observed.find((e) => e.name === 'ToolStarted' && e.tool === 'shell');
    assert.ok(beforeCanonical, 'ToolStarted carries tool');
    assert.strictEqual(String(beforeCanonical?.projectId || ''), 'p-7', 'projectId flows through the canonical event');
    const after = observed.find((e) => e.name === 'after_tool' && e.tool === 'shell');
    assert.ok(after, 'after_tool alias emitted on success');
    assert.strictEqual(after?.success, true, 'after_tool carries success flag');
    const afterCanonical = observed.find((e) => e.name === 'ToolCompleted' && e.tool === 'shell');
    assert.strictEqual(String(afterCanonical?.output || ''), 'all tests passed', 'output flows through ToolCompleted');
    assert.strictEqual(afterCanonical?.durationMs, 42, 'tool timing flows through ToolCompleted');
    const toolError = observed.find((e) => e.name === 'tool_error' && e.tool === 'git');
    assert.ok(toolError, 'tool_error alias emitted on failure');
    assert.strictEqual(toolError?.error, 'merge conflict', 'tool_error carries the error');
    assert.strictEqual(typeof toolError?.durationMs, 'number', 'tool timing flows through ToolFailed too');
    assert.ok(!observed.some((e) => e.name === 'TaskCreated' && e.taskId !== bridged.id), 'no stray task events');
    // After uninstall, further events are not forwarded.
    await engine5.create({ goal: 'Unobserved' });
    assert.ok(!observed.some((e) => e.name === 'TaskCreated' && e.taskId !== bridged.id), 'bridge unsubscribes cleanly');

    console.log(JSON.stringify({
      taskMemory: true,
      checkpoints: true,
      stateMachine: true,
      lifecycle: true,
      failureRecovery: true,
      dependencies: true,
      pauseResumeCancel: true,
      childTasks: true,
      persistence: true,
      hostDrivenLifecycle: true,
      hooksBridge: true
    }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
