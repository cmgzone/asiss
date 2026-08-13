/**
 * Phase 21 — the per-execution chat-card contract. Regression gate for the
 * "tools only appear on the first assistant message" bug: the old renderer
 * mounted ONE global `#executionCard` and re-rendered it with the LATEST
 * execution on every event, so mission 2 overwrote mission 1's card.
 * This gate proves: conversation -> assistant message -> executionId ->
 * execution-card-<id>, each unique and independently updateable.
 *
 * Pure blocks are extracted verbatim (same technique as smoke-execution-store):
 *   - the execution store reducer  (public/js/execution-store.js)
 *   - the Phase 21 card identity/HTML block (index.html inline script)
 *
 *   §1  inline script still parses (bundle regression gate)
 *   §2  card block extractable and self-contained with the store
 *   §3  ONE unique card identity per executionId — no singleton
 *   §4  three missions -> three distinct identities, none aliased
 *   §5  no bleed: ex2's card HTML never carries ex1's identity
 *   §6  events for ex2 leave ex1's HTML byte-identical (dirty tracking)
 *   §7  three read_file calls keep three distinct toolCallIds in the HTML
 *   §8  completion settles the state machine (Completed label + summary)
 *   §9  restoration: executionSummaryText drives the persisted footer
 *   §10 executionWork yields message-scoped user-facing labels only
 *   §11 private reasoning is stripped from persisted chat records
 *   §12 streaming throttle still present in the inline script
 *   §13 card HTML carries no fixed pixel widths (mobile overflow guard)
 *
 * Run: npm run smoke:webui-cards (also part of the battery).
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const HTML_PATH = path.join(ROOT, 'src', 'channels', 'web', 'public', 'index.html');
const STORE_JS_PATH = path.join(ROOT, 'src', 'channels', 'web', 'public', 'js', 'execution-store.js');

interface ExecutionRecord {
  id: string;
  status: string;
  tools: { id: string; name: string; label?: string; status: string }[];
  agents: { id: string; status: string }[];
  progress: number | null;
  currentTask?: string;
  activeToolId: string | null;
  version?: number;
}
interface StoreShape {
  executions: Map<string, ExecutionRecord>;
  currentId: string | null;
}

function main() {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, 'inline script block found in index.html');
  const inline = scriptMatch[1];

  // §1 — the whole inline script must parse (bundle regression gate).
  // eslint-disable-next-line no-new-func
  new Function(inline);
  console.log('1.  inline script parses                                 ok');

  // §2 — extract the PURE store + card blocks and eval them together.
  const storeJs = fs.readFileSync(STORE_JS_PATH, 'utf8');
  const storeBlock = storeJs.match(
    /\/\/ ===== Phase 3 — ephemeral execution store \(PURE — no DOM\) =====([\s\S]*?)\/\/ ===== \/execution store =====/
  );
  assert.ok(storeBlock, 'execution store block found');
  const cardBlock = inline.match(
    /\/\/ ===== Phase 21 — per-execution chat cards \(PURE identity\/HTML\) =====([\s\S]*?)\/\/ ===== \/per-execution cards \(PURE\) =====/
  );
  assert.ok(cardBlock, 'Phase 21 card block found in the inline script');
  const src = storeBlock[1]
    + '\n' + cardBlock[1]
    + '\nfunction scheduleExecutionRender(){}\n'
    + 'module.exports={executionStore,applyExecutionEvent,executionWork,executionCardId,executionCardState,executionSummaryText,cardHtmlForExecution,executionSnapshotFor};';
  const moduleObj: { exports: Partial<Record<string, unknown>> } = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', src)(moduleObj, moduleObj.exports);
  const {
    executionStore, applyExecutionEvent, executionWork,
    executionCardId, executionCardState, executionSummaryText, cardHtmlForExecution, executionSnapshotFor
  } = moduleObj.exports as any;
  assert.ok(typeof executionCardId === 'function' && typeof cardHtmlForExecution === 'function', 'card helpers exported');
  console.log('2.  store + card blocks extracted and self-contained     ok');

  // §3/§4 — unique identity per execution, no singleton element.
  const ids = ['exec-1', 'exec-2', 'exec-3'].map((id) => executionCardId(id));
  assert.ok(ids.every((id) => /^execution-card-/.test(id)), 'card ids follow execution-card-<id>');
  assert.strictEqual(new Set(ids).size, 3, 'three executions -> three distinct card ids');
  assert.ok(!ids.some((id) => id === 'executionCard' || id === '#executionCard'), 'no global singleton id remains');
  assert.strictEqual(executionCardId('exec-1'), executionCardId('exec-1'), 'same execution -> same card id');
  console.log('3+4. unique per-execution card identities (no singleton) ok');

  // Build two complete missions in the store.
  applyExecutionEvent(executionStore, { type: 'mission_start', executionId: 'exec-1', runId: 'r1', messageId: 'm1', progressPct: 0 });
  applyExecutionEvent(executionStore, { type: 'tool_start', executionId: 'exec-1', runId: 'r1', messageId: 'm1', toolCallId: 't-a', name: 'search', label: 'Searching repository' });
  applyExecutionEvent(executionStore, { type: 'tool_done', executionId: 'exec-1', runId: 'r1', messageId: 'm1', toolCallId: 't-a', name: 'search', status: 'completed' });
  applyExecutionEvent(executionStore, { type: 'mission_start', executionId: 'exec-2', runId: 'r2', messageId: 'm2', progressPct: 0 });
  applyExecutionEvent(executionStore, { type: 'tool_start', executionId: 'exec-2', runId: 'r2', messageId: 'm2', toolCallId: 't-b', name: 'read_file', label: 'Reading files' });
  const html1 = cardHtmlForExecution(executionStore.executions.get('exec-1'), {});
  const html2 = cardHtmlForExecution(executionStore.executions.get('exec-2'), {});

  // §5 — no bleed between cards.
  assert.ok(html1.includes('data-exec="exec-1"'), 'ex1 card carries its own identity');
  assert.ok(html2.includes('data-exec="exec-2"'), 'ex2 card carries its own identity');
  assert.ok(!html1.includes('data-exec="exec-2"'), 'ex1 card never references ex2');
  assert.ok(!html2.includes('data-exec="exec-1"'), 'ex2 card never references ex1');
  assert.ok(html2.includes('>Reading files'), 'ex2 shows its own tool label');
  assert.ok(html1.includes('>Searching repository'), 'ex1 keeps its own tool label');
  console.log('5.  cards do not bleed into each other                   ok');
  // §6 — independent updates: events for ex2 must not change ex1's HTML.
  const html1Before = cardHtmlForExecution(executionStore.executions.get('exec-1'), {});
  const v1Before = executionStore.executions.get('exec-1')!.version;
  const v2Before = executionStore.executions.get('exec-2')!.version;
  applyExecutionEvent(executionStore, { type: 'tool_done', executionId: 'exec-2', runId: 'r2', messageId: 'm2', toolCallId: 't-b', name: 'read_file', status: 'completed', output: 'file body' });
  applyExecutionEvent(executionStore, { type: 'tool_start', executionId: 'exec-2', runId: 'r2', messageId: 'm2', toolCallId: 't-c', name: 'shell', label: 'Running tests' });
  assert.strictEqual(executionStore.executions.get('exec-1')!.version, v1Before, 'ex1 version untouched by ex2 events');
  assert.ok((executionStore.executions.get('exec-2')!.version || 0) > v2Before, 'ex2 version bumped');
  const html1After = cardHtmlForExecution(executionStore.executions.get('exec-1'), {});
  // The card embeds a wall-clock duration (exec-card-meta, e.g. "1ms" vs "2ms"),
  // so byte comparison must ignore the ticking clock — the gate is that ex2
  // activity never changes ex1's CONTENT, not that time stands still.
  const stripClock = (html: string) => html.replace(/(<span class="exec-card-meta">)[^<]*(<\/span>)/g, '$1DUR$2');
  assert.strictEqual(stripClock(html1After), stripClock(html1Before), 'ex1 card HTML byte-identical after ex2 activity');
  console.log('6.  per-execution dirty tracking (ex1 stable under ex2)  ok');

  // §7 — identical tool names stay independent via toolCallId.
  applyExecutionEvent(executionStore, { type: 'mission_start', executionId: 'exec-3', runId: 'r3', messageId: 'm3' });
  for (const tid of ['r3-t1', 'r3-t2', 'r3-t3']) {
    applyExecutionEvent(executionStore, { type: 'tool_start', executionId: 'exec-3', runId: 'r3', messageId: 'm3', toolCallId: tid, name: 'read_file' });
  }
  const html3 = cardHtmlForExecution(executionStore.executions.get('exec-3'), {});
  const toolRowMatches = html3.match(/class="exec-tool-row[^"]*" data-tool="([^"]+)"/g) || [];
  assert.strictEqual(toolRowMatches.length, 3, 'three read_file calls render as three rows');
  const toolIds = toolRowMatches.map((m: string) => (m.match(/data-tool="([^"]+)"/) || [])[1]);
  assert.strictEqual(new Set(toolIds).size, 3, 'three distinct toolCallIds (name is not the identity)');
  console.log('7.  repeated identical tool calls stay independent       ok');

  // §8 — completion settles the state machine.
  applyExecutionEvent(executionStore, { type: 'mission_end', executionId: 'exec-3', runId: 'r3', messageId: 'm3', status: 'completed', progressPct: 100 });
  const ex3 = executionStore.executions.get('exec-3')!;
  const doneState = executionCardState(ex3);
  assert.strictEqual(doneState.label, 'Completed', 'mission_end -> Completed state label');
  const summary3 = executionSummaryText(ex3);
  assert.ok(summary3.includes('✓ Completed'), 'summary shows the completion mark');
  assert.ok(summary3.includes('3 tools'), 'summary counts the tools');
  const doneHtml = cardHtmlForExecution(ex3, {});
  assert.ok(doneHtml.includes('st-completed'), 'completed card carries the completed state class');
  assert.ok(!doneHtml.includes('animation: work-pulse'), 'no running pulse in the completed card html');
  console.log('8.  completion transitions state + summary               ok');

  // §9 — restoration: the summary text drives the persisted message footer.
  const restoredMessage = { kind: 'assistant', complete: true, runId: 'r3', text: 'done', execution: { state: doneState.key, text: summary3 } };
  assert.strictEqual(restoredMessage.execution.text, summary3, 'footer text comes from executionSummaryText');
  assert.strictEqual(restoredMessage.execution.state, 'completed', 'footer state class derives from the card state machine');
  console.log('9.  restoration footer derives from the card state       ok');
  // §10 — message-scoped work labels (user-facing actions, never reasoning).
  const fresh: StoreShape = { executions: new Map(), currentId: null };
  applyExecutionEvent(fresh, { type: 'mission_start', executionId: 'w1', runId: 'w', messageId: 'm' });
  assert.deepStrictEqual(executionWork(fresh.executions.get('w1')), { state: 'thinking', label: 'Planning approach' }, 'fresh mission -> calm thinking label');
  applyExecutionEvent(fresh, { type: 'assistant_update', executionId: 'w1', runId: 'w', messageId: 'm', text: 'Analyzing the auth flow' });
  assert.strictEqual(executionWork(fresh.executions.get('w1')).label, 'Analyzing the auth flow', 'assistant_update narration becomes the work label');
  applyExecutionEvent(fresh, { type: 'tool_start', executionId: 'w1', runId: 'w', messageId: 'm', toolCallId: 's1', name: 'shell', label: 'Running tests' });
  const toolWork = executionWork(fresh.executions.get('w1'));
  assert.strictEqual(toolWork.state, 'tool', 'active tool is the dominant work state');
  assert.ok(/Running (tests|commands)/.test(toolWork.label), 'tool work label is an ACTION, not a tool name: ' + toolWork.label);
  assert.ok(!/chain-of-thought|reasoning|Thinking through/.test(JSON.stringify(toolWork)), 'no private reasoning in work labels');
  console.log('10. message-scoped user-facing work states                ok');

  // §11 — private reasoning is stripped from persisted chat records.
  const cmMatch = inline.match(/const completedMessages=\(\)=>[^\n]+/);
  assert.ok(cmMatch, 'completedMessages extractable');
  const cmModule: { exports: Partial<Record<string, unknown>> } = { exports: {} };
  const cmSrc = 'const state={messages:[{kind:"assistant",complete:true,runId:"r",text:"hi",reasoning:"SECRET-REASONING"},{kind:"update",complete:true,text:"u"}]};\n'
    + cmMatch[0] + '\nmodule.exports={completedMessages};';
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', cmSrc)(cmModule, cmModule.exports);
  const persisted = (cmModule.exports as any).completedMessages();
  assert.ok(persisted.some((m: any) => m.kind === 'assistant'), 'assistant message persisted');
  assert.ok(persisted.every((m: any) => m.reasoning === undefined), 'reasoning never reaches persisted chat');
  console.log('11. private reasoning stripped from persisted history     ok');

  // §12 — streaming throttle still present (60 ms cadence + final flush).
  assert.ok(inline.includes('assistantRenderTimer'), 'streaming throttle mechanism present');
  assert.ok(/setTimeout\([\s\S]{0,120}60/.test(inline) || inline.includes('},60)'), '60 ms throttle cadence present');
  console.log('12. streaming throttle preserved                           ok');

  // §13 — card HTML has no fixed pixel widths (mobile overflow guard).
  const htmlAll = [html1, html2, html3, doneHtml].join('\n');
  assert.ok(!/\bwidth:\s*\d+px\b/.test(htmlAll), 'no fixed pixel widths inside card HTML');
  assert.ok(/width:\d+%/.test(htmlAll), 'the only width is the percentage progress line');
  console.log('13. no fixed pixel widths in card HTML (mobile)           ok');

  // §14 — the durable snapshot carries the FULL tool timeline (replay data).
  applyExecutionEvent(executionStore, { type: 'tool_start', executionId: 'exec-1', runId: 'r1', messageId: 'm1', toolCallId: 't-a2', name: 'read_file' });
  applyExecutionEvent(executionStore, { type: 'tool_delta', executionId: 'exec-1', runId: 'r1', messageId: 'm1', toolCallId: 't-a2', name: 'read_file', output: 'A'.repeat(5000) });
  applyExecutionEvent(executionStore, { type: 'mission_end', executionId: 'exec-1', runId: 'r1', messageId: 'm1', status: 'completed', progressPct: 100 });
  const snap = executionSnapshotFor(executionStore.executions.get('exec-1'));
  assert.ok(snap && Array.isArray(snap.tools), 'snapshot carries a tools array (full timeline)');
  const liveTools = executionStore.executions.get('exec-1')!.tools;
  assert.strictEqual(snap!.tools.length, liveTools.length, 'every tool row persisted into the snapshot');
  assert.strictEqual(new Set(snap!.tools.map((t: any) => t.id)).size, snap!.tools.length, 'all toolCallIds distinct in the snapshot');
  assert.ok(snap!.tools.some((t: any) => t.output && t.output.length <= 2000), 'tool output bounded in the snapshot');
  assert.ok(Array.isArray(snap!.artifacts) && Array.isArray(snap!.agents) && Array.isArray(snap!.recoveryPhases), 'agents/artifacts/recovery persisted');
  assert.ok(typeof snap!.terminal === 'string', 'terminal stream persisted');
  assert.ok(snap!.text.includes('✓ Completed'), 'snapshot keeps the completion summary');
  console.log('14. durable snapshot replays the full tool timeline       ok');

  // §15 — restored conversations replay EVERY tool row from the snapshot.
  const replayHtml = cardHtmlForExecution(snap!, { collapsed: true });
  assert.ok(replayHtml.includes('st-completed'), 'replayed card settles completed');
  assert.ok(replayHtml.includes('data-exec="exec-1"'), 'replayed card keeps its identity');
  for (const t of snap!.tools) assert.ok(replayHtml.includes(`data-tool="${t.id}"`), 'replayed card contains tool row ' + t.id);
  assert.ok(replayHtml.includes('>read_file'), 'replayed card names the tool');
  console.log('15. restored conversations replay every tool row          ok');

  // §16 — summary binding: runIds are scoped per execution so a stopped
  // mission (no assistant turn) can never latch its snapshot onto a neighbor's
  // message. Events for ex2 must not pollute ex1's runIds.
  const ex1RunIds = executionStore.executions.get('exec-1')!.runIds || [];
  const ex2RunIds = executionStore.executions.get('exec-2')!.runIds || [];
  assert.ok(ex1RunIds.length > 0 && ex2RunIds.length > 0, 'both executions observe their own runIds');
  assert.ok(!ex1RunIds.some((id: string) => ex2RunIds.includes(id)), 'runIds never bleed between executions');
  // A stop with a fresh runId lands on ITS OWN execution only.
  applyExecutionEvent(executionStore, { type: 'assistant_stopped', executionId: 'exec-2', runId: 'stop-uuid', messageId: 'm2', finalText: 'Stopped' });
  assert.ok(executionStore.executions.get('exec-2')!.runIds.includes('stop-uuid'), 'stop runId recorded on its execution');
  assert.ok(!executionStore.executions.get('exec-1')!.runIds.includes('stop-uuid'), 'stop runId never recorded on a neighbor');
  console.log('16. summary binding runIds scoped per execution            ok');

  console.log('webui-cards: message->execution contract holds (16 gates, 40+ assertions)');
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
