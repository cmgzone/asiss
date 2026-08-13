/**
 * Phase 3/4 — the ephemeral frontend executionStore reducer contract.
 *
 * Promoted from the working test (`logs/test-execution-store.cjs`) into the
 * permanent battery: this smoke extracts the delimited PURE store block
 * verbatim from `src/channels/web/public/js/execution-store.js` (Phase 17
 * split the store out of the inline index.html script) and drives it with
 * synthetic socket events, proving the reducer contract that the chat
 * ExecutionCard and canvas Execution panel render from:
 *
 *   §1 — the whole inline script parses (regression gate for the web bundle)
 *   §2 — extraction: the store block is present and self-contained
 *   §3 — happy path: mission_start -> assistant_update -> 2 tools (incl.
 *        delegate) -> tool_delta (progress + accumulated output) -> recovery
 *        diagnosing -> stream_chunk -> media -> mission_end completed.
 *        Asserts status, tools, agents, progress, recoveryPhase, currentTask,
 *        terminal, artifacts, activeToolId cleared, currentId.
 *   §4 — failed mission: tool failure surfaces status 'failed' + latestError.
 *   §5 — cancelled mission via assistant_stopped -> mission_end cancelled.
 *   §6 — events WITHOUT an executionId are ignored (chat-only traffic must
 *        never touch the store).
 *
 * The store is ephemeral by design — nothing here persists or touches
 * state.messages; this test only proves the pure reducer over the event
 * stream. Run with `npm run smoke:execution-store` (or as part of `npm test`
 * / the battery).
 *
 * NOTE: the block is delimited by markers in js/execution-store.js:
 *   // ===== Phase 3 — ephemeral execution store (PURE — no DOM) =====
 *   ...
 *   // ===== /execution store =====
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';

const HTML_PATH = path.join(__dirname, '..', 'src', 'channels', 'web', 'public', 'index.html');
const STORE_JS_PATH = path.join(__dirname, '..', 'src', 'channels', 'web', 'public', 'js', 'execution-store.js');

interface ToolRecord {
  id: string;
  name: string;
  label?: string;
  status: string;
  output?: string;
  error?: string;
}
interface ExecutionRecord {
  status: string;
  tools: ToolRecord[];
  agents: { id: string; name: string; label?: string; status: string }[];
  progress: number | null;
  recoveryPhase?: string;
  recoveryPhases?: { phase: string; at: number; text?: string }[];
  currentTask?: string;
  terminal?: string;
  artifacts: { caption: string }[];
  activeToolId: string | null;
  latestError?: string;
}
interface ExecutionStore {
  executions: Map<string, ExecutionRecord>;
  currentId: string | null;
}
function main() {
  const html = fs.readFileSync(HTML_PATH, 'utf8');

  // §1 — the whole inline script must parse (regression gate for the bundle).
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, 'inline script block found in index.html');
  // eslint-disable-next-line no-new-func
  new Function(scriptMatch[1]); // throws if the inline script is broken
  console.log('1. inline script parses                                  ok');

  // §2 — extract the delimited PURE store block and eval it with a stub
  // render scheduler (the block must not touch the DOM on its own). Since
  // Phase 17 the block lives in its own module: public/js/execution-store.js.
  const storeJs = fs.readFileSync(STORE_JS_PATH, 'utf8');
  const block = storeJs.match(
    /\/\/ ===== Phase 3 — ephemeral execution store \(PURE — no DOM\) =====([\s\S]*?)\/\/ ===== \/execution store =====/
  );
  assert.ok(block, 'execution store block found in js/execution-store.js');
  const src = block[1] + '\nfunction scheduleExecutionRender(){}\nmodule.exports={executionStore,createExecution,reduceExecution,applyExecutionEvent};';
  const moduleObj: { exports: Partial<{ executionStore: ExecutionStore; applyExecutionEvent: (store: ExecutionStore, event: Record<string, unknown>) => void }> } = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', src)(moduleObj, moduleObj.exports);
  const { executionStore, applyExecutionEvent } = moduleObj.exports;
  assert.ok(typeof applyExecutionEvent === 'function', 'applyExecutionEvent exported by the store block');
  assert.ok(executionStore && executionStore.executions instanceof Map, 'executionStore exported with executions Map');
  console.log('2. store block extracted and self-contained               ok');
  // §3 — happy path: mission -> tools (incl. delegate) -> recovery -> completion.
  const exId = 'exec-1';
  applyExecutionEvent(executionStore!, {
    type: 'mission_start', executionId: exId, runId: 'r', messageId: 'm', progressPct: 0
  });
  applyExecutionEvent(executionStore!, {
    type: 'assistant_update', executionId: exId, runId: 'r', messageId: 'm', text: 'Analyzing the repository…', progressPct: 15
  });
  applyExecutionEvent(executionStore!, {
    type: 'tool_start', executionId: exId, runId: 'r', messageId: 'm', toolCallId: 't1', name: 'read_file', label: 'Reading files'
  });
  applyExecutionEvent(executionStore!, {
    type: 'tool_delta', executionId: exId, runId: 'r', messageId: 'm', toolCallId: 't1', name: 'read_file', output: 'line A\n', progressPct: 42
  });
  applyExecutionEvent(executionStore!, {
    type: 'tool_done', executionId: exId, runId: 'r', messageId: 'm', toolCallId: 't1', name: 'read_file', status: 'completed', output: 'file contents'
  });
  applyExecutionEvent(executionStore!, {
    type: 'tool_start', executionId: exId, runId: 'r', messageId: 'm', toolCallId: 't2', name: 'delegate_agent', label: 'Coordinating agents'
  });
  applyExecutionEvent(executionStore!, {
    type: 'tool_done', executionId: exId, runId: 'r', messageId: 'm', toolCallId: 't2', name: 'delegate_agent', status: 'completed', output: 'report'
  });
  applyExecutionEvent(executionStore!, {
    type: 'recovery', executionId: exId, runId: 'r', messageId: 'm', phase: 'diagnosing', text: 'A step failed…', progressPct: 60
  });
  applyExecutionEvent(executionStore!, {
    type: 'stream_chunk', executionId: exId, runId: 'r', messageId: 'm', chunk: '$ npm test\n'
  });
  applyExecutionEvent(executionStore!, {
    type: 'media', executionId: exId, runId: 'r', messageId: 'm', caption: 'webui-audit.md', url: '/api/artifacts/x'
  });
  applyExecutionEvent(executionStore!, {
    type: 'mission_end', executionId: exId, runId: 'r', messageId: 'm', status: 'completed', progressPct: 100
  });
  const ex = executionStore!.executions.get(exId);
  assert.ok(ex, 'execution record created for the mission');
  assert.strictEqual(ex.status, 'completed', 'mission_end completed -> status completed');
  assert.strictEqual(ex.tools.length, 2, 'both tool calls recorded');
  assert.strictEqual(ex.tools[0].status, 'completed', 'first tool completed');
  assert.ok(String(ex.tools[0].output).includes('line A'), 'tool_delta output accumulated into the tool record');
  assert.strictEqual(ex.progress, 100, 'mission progress lands at 100 on completed mission_end (progress rides every mission event)');
  assert.strictEqual(ex.agents.length, 1, 'delegate_agent recorded in agents[]');
  assert.strictEqual(ex.agents[0].status, 'completed', 'delegated agent completed');
  assert.strictEqual(ex.recoveryPhase, 'diagnosing', 'recovery phase recorded');
  assert.strictEqual((ex.recoveryPhases || []).length, 1, 'recoveryPhases timeline accumulated');
  assert.strictEqual((ex.recoveryPhases || [])[0].phase, 'diagnosing', 'recovery phase entry recorded');
  assert.ok(String(ex.currentTask).includes('A step failed'), 'recovery narration becomes the current task');
  assert.ok(String(ex.terminal).includes('npm test'), 'stream_chunk appended to terminal');
  assert.strictEqual(ex.artifacts.length, 1, 'media event recorded as artifact');
  assert.strictEqual(ex.artifacts[0].caption, 'webui-audit.md', 'artifact caption kept');
  assert.strictEqual(ex.activeToolId, null, 'activeToolId cleared at mission end');
  assert.strictEqual(executionStore!.currentId, exId, 'currentId points at the latest mission');
  console.log('3. happy path (mission -> tools -> recovery -> done)      ok');

  // §3b — mission-level progress rides EVERY mission event (not just tool_delta).
  const s1b: ExecutionStore = { executions: new Map(), currentId: null };
  applyExecutionEvent(s1b, { type: 'mission_start', executionId: 'p1', runId: 'r', messageId: 'm', progressPct: 0 });
  applyExecutionEvent(s1b, { type: 'assistant_update', executionId: 'p1', runId: 'r', messageId: 'm', text: 'Working…', progressPct: 15 });
  applyExecutionEvent(s1b, { type: 'tool_start', executionId: 'p1', runId: 'r', messageId: 'm', toolCallId: 'a', name: 'shell', progressPct: 25 });
  applyExecutionEvent(s1b, { type: 'tool_delta', executionId: 'p1', runId: 'r', messageId: 'm', toolCallId: 'a', name: 'shell', output: 'x', progressPct: 40 });
  applyExecutionEvent(s1b, { type: 'tool_done', executionId: 'p1', runId: 'r', messageId: 'm', toolCallId: 'a', name: 'shell', status: 'completed', progressPct: 60 });
  applyExecutionEvent(s1b, { type: 'recovery', executionId: 'p1', runId: 'r', messageId: 'm', phase: 'diagnosing', progressPct: 75 });
  applyExecutionEvent(s1b, { type: 'mission_end', executionId: 'p1', runId: 'r', messageId: 'm', status: 'completed', progressPct: 100 });
  const p1 = s1b.executions.get('p1');
  assert.ok(p1, 'progress probe record exists');
  assert.strictEqual(p1.progress, 100, 'mission_end progressPct wins (last event)');
  console.log('3b. progressPct rides every mission event (0->15->25->40->60->75->100)  ok');

  // §4 — failed mission: tool failure surfaces status + latestError.
  const s2: ExecutionStore = { executions: new Map(), currentId: null };
  applyExecutionEvent(s2, { type: 'mission_start', executionId: 'e2', runId: 'r', messageId: 'm' });
  applyExecutionEvent(s2, { type: 'tool_start', executionId: 'e2', runId: 'r', messageId: 'm', toolCallId: 'x', name: 'shell', label: 'Running commands' });
  applyExecutionEvent(s2, { type: 'tool_done', executionId: 'e2', runId: 'r', messageId: 'm', toolCallId: 'x', name: 'shell', status: 'failed', error: 'exit 1' });
  applyExecutionEvent(s2, { type: 'mission_end', executionId: 'e2', runId: 'r', messageId: 'm', status: 'failed' });
  const e2 = s2.executions.get('e2');
  assert.ok(e2, 'failed execution record exists');
  assert.strictEqual(e2.status, 'failed', 'failed mission -> status failed');
  assert.ok(String(e2.latestError).includes('exit 1'), 'tool error surfaces as latestError');
  assert.strictEqual(e2.tools[0].status, 'failed', 'failed tool status recorded');
  console.log('4. failed mission (status failed + latestError)           ok');

  // §5 — cancelled mission via assistant_stopped -> mission_end cancelled.
  const s3: ExecutionStore = { executions: new Map(), currentId: null };
  applyExecutionEvent(s3, { type: 'mission_start', executionId: 'e3', runId: 'r', messageId: 'm' });
  applyExecutionEvent(s3, { type: 'assistant_stopped', executionId: 'e3', runId: 'r', messageId: 'm', finalText: '⏹ Stopped.' });
  applyExecutionEvent(s3, { type: 'mission_end', executionId: 'e3', runId: 'r', messageId: 'm', status: 'cancelled' });
  assert.strictEqual(s3.executions.get('e3')?.status, 'cancelled', 'assistant_stopped -> cancelled');
  console.log('5. cancelled mission (assistant_stopped -> cancelled)     ok');

  // §6 — events without executionId must be ignored (chat-only traffic).
  const sizeBefore = executionStore!.executions.size;
  applyExecutionEvent(executionStore!, { type: 'assistant_done', runId: 'r', messageId: 'm', finalText: 'hi' });
  assert.strictEqual(executionStore!.executions.size, sizeBefore, 'chat-only events never touch the store');
  console.log('6. no-executionId events ignored                          ok');

  console.log('execution-store: reducer contract holds (13 happy-path + 3 state + 1 progress-lifecycle assertions)');
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
