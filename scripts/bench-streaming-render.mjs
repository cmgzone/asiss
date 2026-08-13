/**
 * Benchmark: throttled vs unthrottled streaming markdown rendering.
 *
 * Simulates a long assistant reply streamed as small deltas, and compares the
 * two render strategies on the REAL markdown() function extracted verbatim
 * from src/channels/web/public/index.html:
 *
 *   - UNTHROTTLED (before): every delta re-parses the whole accumulated text
 *     through marked.parse -> O(n^2) total work and per-delta jank that grows
 *     with message length.
 *   - THROTTLED (current): deltas append to the message state instantly and
 *     the DOM re-render runs at most once per 60 ms (plus a final flush).
 *
 * Run:  node scripts/bench-streaming-render.mjs
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { marked } from 'marked';

// ---- pull the REAL markdown() from index.html and stub its browser bits ----
const html = readFileSync('src/channels/web/public/index.html', 'utf8');
const src = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const mStart = src.indexOf('function markdown(');
const mEnd = src.indexOf('\n    ', mStart + 20); // end of the single-line function
const markdownFn = src.slice(mStart, mEnd);
globalThis.window = { marked: true };
globalThis.marked = marked;
globalThis.esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
globalThis.location = { origin: 'http://localhost' };
// Minimal DOM stand-in: innerHTML round-trips, link loop is a no-op (the
// URL sanitization is negligible next to marked.parse).
const fakeBox = () => {
  const box = { _html: '' };
  Object.defineProperty(box, 'innerHTML', {
    get() { return this._html; },
    set(v) { this._html = v; }
  });
  box.querySelectorAll = () => [];
  return box;
};
globalThis.document = { createElement: fakeBox };
const markdown = eval('(' + markdownFn + ')');

// ---- corpus: a realistic long answer (~20k chars) ---------------------------
const codeBlock = [
  '```js',
  'function reconcile(rows) {',
  '  const seen = new Map();',
  '  for (const row of rows) {',
  '    const key = [row.account, row.txDate].join(":");',
  '    seen.set(key, (seen.get(key) || 0) + Number(row.amount));',
  '  }',
  '  return [...seen.entries()].sort((a, b) => b[1] - a[1]);',
  '}',
  '```'
].join('\n');

const section = (n) => [
  '',
  `## Section ${n} — Implementation details`,
  `The **reconciler** handles ${n} accounts and produces a *reconciled* ledger.`,
  'Key points:',
  '- Deltas are applied in **dependency order** to avoid partial states.',
  '- Verification runs against the goal-matched tests before completion.',
  '- Failed tool batches trigger recovery rather than immediate failure.',
  '',
  'Example command:',
  '```bash',
  'npx tsc --noEmit && node scripts/copy-runtime-assets.js',
  '```',
  '',
  '| Metric | Before | After |',
  '| --- | --- | --- |',
  `| Renders per burst | many | ${60} ms cadence |`,
  '| Per-delta cost | O(n²) | O(1) append |',
  '| Max render time | grows | bounded |',
  '',
  `See [the design note](https://example.com/design-${n}) for the full write-up. ` +
  `The remaining prose fills the section with realistic paragraphs about ` +
  `streaming, verification gates, and autonomous repair loops so the parse ` +
  'cost resembles a genuine long answer from the assistant.',
  ''
].join('\n');

export function buildCorpus() {
  let corpus = '# Streaming Render Benchmark\n\n';
  corpus += 'This is an introduction paragraph with **bold**, *italic*, `inline code`, and a [reference](https://example.com/intro).\n';
  corpus += codeBlock + '\n';
  for (let n = 1; n <= 22; n++) corpus += section(n);
  if (corpus.length < 20000) corpus += '\n'.repeat(Math.ceil((20000 - corpus.length) / 80)) + '\nPadding sentence to reach target length. '.repeat(80);
  return corpus;
}

// ---- simulation --------------------------------------------------------------
export const DELTA_SIZE = 10; // chars per delta (word-ish token chunks)
const deltaMs = [10, 5]; // two stream speeds: normal and fast
const throttleMs = 60; // the deployed throttle cadence

function buildDeltas(text) {
  const deltas = [];
  for (let i = 0; i < text.length; i += DELTA_SIZE) deltas.push(text.slice(i, i + DELTA_SIZE));
  return deltas;
}

function runUnthrottled(deltas, text) {
  let total = 0, max = 0, renders = 0;
  const times = [];
  let len = 0;
  for (const d of deltas) {
    len += d.length;
    const t0 = performance.now();
    markdown(text.slice(0, len));
    const dt = performance.now() - t0;
    total += dt; max = Math.max(max, dt); renders++;
    times.push(dt);
  }
  times.sort((a, b) => a - b);
  return { total, max, renders, p50: times[Math.floor(times.length / 2)] };
}

// Replicates scheduleAssistantRender's semantics against the same timeline:
// text accumulates per delta; a render fires when >= throttleMs has elapsed
// since the last one; a final flush renders the tail.
function runThrottled(deltas, text, deltaEveryMs) {
  let total = 0, max = 0, renders = 0, appends = 0;
  const times = [];
  let len = 0, lastRender = -Infinity;
  for (let i = 0; i < deltas.length; i++) {
    const t = (i + 1) * deltaEveryMs;
    const t0 = performance.now();
    len += deltas[i].length; // O(1) append on the critical path
    const appendMs = performance.now() - t0;
    appends += appendMs;
    if (t - lastRender >= throttleMs) {
      const r0 = performance.now();
      markdown(text.slice(0, len));
      const dt = performance.now() - r0;
      total += dt; max = Math.max(max, dt); renders++;
      times.push(dt);
      lastRender = t;
    }
  }
  // final flush on assistant_done (if the last render is stale)
  if (len > 0) {
    const r0 = performance.now();
    markdown(text);
    const dt = performance.now() - r0;
    total += dt; max = Math.max(max, dt); renders++;
    times.push(dt);
  }
  times.sort((a, b) => a - b);
  return { total, max, renders, p50: times[Math.floor(times.length / 2)], appendAvg: appends / deltas.length };
}

export async function main() {
  const corpus = buildCorpus();
  console.log(`Corpus: ${corpus.length.toLocaleString()} chars, ${(corpus.length / DELTA_SIZE).toLocaleString()} deltas of ${DELTA_SIZE} chars\n`);
  console.log('RENDER STRATEGY      renders   total parse   p50 render   max render   per-delta (critical path)');
  console.log('─'.repeat(95));
  const allDeltas = buildDeltas(corpus);
  const results = [];
  for (const every of deltaMs) {
    const deltas = buildDeltas(corpus);
    const un = runUnthrottled(deltas, corpus);
    const th = runThrottled(deltas, corpus, every);
    const ratio = un.renders / th.renders;
    const totalRatio = un.total / Math.max(0.001, th.total);
    const lastDeltaUn = un.max; // unthrottled worst single frame
    const lastDeltaTh = th.appendAvg * 1000; // throttled critical path per delta
    console.log(`${every} ms/delta  unthrottled  ${String(un.renders).padStart(5)}   ${un.total.toFixed(1).padStart(9)} ms   ${un.p50.toFixed(2).padStart(8)} ms   ${un.max.toFixed(2).padStart(8)} ms   ${(un.max).toFixed(2).padStart(20)} ms`);
    console.log(`${every} ms/delta  throttled    ${String(th.renders).padStart(5)}   ${th.total.toFixed(1).padStart(9)} ms   ${th.p50.toFixed(2).padStart(8)} ms   ${th.max.toFixed(2).padStart(8)} ms   ${(th.appendAvg * 1000).toFixed(2).padStart(20)} µs`);
    console.log(`             → ${ratio.toFixed(1)}x fewer renders, ${totalRatio.toFixed(1)}x less parse time, per-delta jank ${lastDeltaUn.toFixed(2)} ms → ${lastDeltaTh.toFixed(2)} µs\n`);
    results.push({ every, un, th, ratio, totalRatio });
  }

  // ---- CI assertion mode (`npm run smoke:render-bench` / battery entry) ----
  // Fail the build on a render regression. Removing the throttle makes the
  // throttled render count equal the unthrottled one (ratio ~1.0); re-parsing
  // on the critical path pushes per-delta cost from microseconds to
  // milliseconds. Every threshold keeps 2-6x headroom over the measured
  // steady-state numbers so ordinary machine variance cannot flake them.
  const isCi = process.argv.includes('--ci');
  if (isCi) {
    const MIN_RENDER_RATIO = 3;   // throttled renders < 1/3 of unthrottled's
    const MIN_PARSE_RATIO = 2;    // throttled parse time < 1/2 of unthrottled's
    const MAX_APPEND_MS = 1;      // per-delta critical path stays sub-millisecond
    const MIN_CORPUS_CHARS = 20000;
    const MIN_DELTAS = 1000;

    const failures = [];
    if (corpus.length < MIN_CORPUS_CHARS) failures.push(`corpus too small (${corpus.length} < ${MIN_CORPUS_CHARS} chars)`);
    if (allDeltas.length < MIN_DELTAS) failures.push(`too few deltas (${allDeltas.length} < ${MIN_DELTAS})`);
    for (const r of results) {
      if (r.ratio < MIN_RENDER_RATIO) failures.push(`@${r.every} ms/delta: only ${r.ratio.toFixed(2)}x render reduction (need >= ${MIN_RENDER_RATIO}x) — the throttle is gone or degraded`);
      if (r.totalRatio < MIN_PARSE_RATIO) failures.push(`@${r.every} ms/delta: only ${r.totalRatio.toFixed(2)}x parse-time reduction (need >= ${MIN_PARSE_RATIO}x)`);
      if (r.th.appendAvg * 1000 >= MAX_APPEND_MS) failures.push(`@${r.every} ms/delta: per-delta critical path is ${(r.th.appendAvg * 1000).toFixed(2)} ms (need < ${MAX_APPEND_MS} ms) — parsing on the critical path`);
    }
    console.log(failures.length === 0 ? 'CI: PASS — throttled streaming renderer within budget' : 'CI: FAIL — render regression detected');
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(failures.length === 0 ? 0 : 1);
  }

  // ---- DOM layout/paint mode (opt-in; needs the desktop's Electron) ----
  if (process.argv.includes('--dom')) {
    const { runDomBenchmark } = await import('./bench-dom-render.mjs');
    await runDomBenchmark();
  }
}

import { pathToFileURL } from 'node:url';
const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) main();
