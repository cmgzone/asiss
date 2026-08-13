#!/usr/bin/env node
/**
 * DOM layout/paint benchmark — the streaming renderer measured in a REAL
 * browser engine (the desktop app's own Electron/Chromium), not just a
 * markdown parse in Node.
 *
 * Builds a standalone harness page from src/channels/web/public/index.html:
 *   - the exact <style> block (variables, .message, .message-body pre, .tok-*,
 *     .code-copy …),
 *   - the exact marked UMD the server serves (/vendor/marked.js →
 *     node_modules/marked/lib/marked.umd.js),
 *   - the REAL functions extracted verbatim: esc, HL_KEYWORDS, markdown,
 *     highlightCode, enhanceCodeBlocks, nearBottom, renderThinking,
 *     renderAssistantBody, scheduleAssistantRender.
 *
 * The heavy functions are wrapped so every call is timed, then the same
 * 22,943-char corpus is streamed as 10-char deltas through the REAL
 * throttled path (60 ms batching + final flush) and the unthrottled path at
 * two stream speeds, inside an off-screen BrowserWindow (Chromium freezes
 * hidden windows regardless of timer throttling — fake ~1s stalls — so the
 * window is created visible but parked at x/y -32000; backgroundThrottling
 * is off so rAF runs at full rate). Collected per scenario:
 *   - renders + total/max synchronous render time (parse+DOM+highlight),
 *   - rAF frame gaps: p95, worst gap, frames > 50 ms (visible jank),
 *   - long tasks (> 50 ms main-thread blocks) via PerformanceObserver,
 *   - wall time.
 * Plus a one-shot cost split of rendering the full answer: parse / DOM tree
 * build / layout / syntax highlight.
 *
 * Run: node scripts/bench-streaming-render.mjs --dom
 * (or: node scripts/bench-dom-render.mjs)
 */
import { readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildCorpus, DELTA_SIZE } from './bench-streaming-render.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOGS = path.join(ROOT, 'logs');
const INDEX = path.join(ROOT, 'src', 'channels', 'web', 'public', 'index.html');
const MARKED_UMD = path.join(ROOT, 'node_modules', 'marked', 'lib', 'marked.umd.js');
const ELECTRON = path.join(ROOT, 'desktop', 'node_modules', 'electron', 'dist', 'electron.exe');

/** Extract a `function name(...){...}` verbatim from the inline <script>. */
function extractFn(script, name) {
  const start = script.indexOf('function ' + name + '(');
  if (start < 0) throw new Error(`function ${name} not found in index.html`);
  let depth = 0;
  let inStr = null;
  for (let i = start; i < script.length; i++) {
    const c = script[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return script.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces in function ${name}`);
}

/** Extract a single-line `const NAME=...;` declaration verbatim. */
function extractConstLine(script, name) {
  const start = script.indexOf('const ' + name + '=');
  if (start < 0) throw new Error(`const ${name} not found in index.html`);
  const end = script.indexOf('\n', start);
  return script.slice(start, end < 0 ? undefined : end);
}

export function buildHarness() {
  const html = readFileSync(INDEX, 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const cssStart = html.indexOf('<style>') + '<style>'.length;
  const cssEnd = html.indexOf('</style>');
  const css = html.slice(cssStart, cssEnd);

  const esc = extractConstLine(script, 'esc');
  const hlKeywords = extractConstLine(script, 'HL_KEYWORDS');
  const fns = ['markdown', 'highlightCode', 'enhanceCodeBlocks', 'nearBottom',
    'renderThinking', 'renderAssistantBody', 'scheduleAssistantRender']
    .map((n) => extractFn(script, n))
    .join('\n');

  const corpus = buildCorpus();

  // Harness engine. Reuses the extracted functions VERBATIM; wraps the
  // heavy ones so every call is timed. This IS the live render path, just
  // pointed at a scratch container.
  const engine = [
    "'use strict';",
    "const $ = s => document.querySelector(s);",
    'let assistantRenderTimer = null;',
    'const state = { messages: [] };',
    'function toast(){}',
    esc,
    hlKeywords,
    fns,
    '',
    "const sleep = ms => new Promise(r => setTimeout(r, ms));",
    `const CORPUS = ${JSON.stringify(corpus)};`,
    `const DELTA_SIZE = ${DELTA_SIZE};`,
    'const deltas = [];',
    'for (let i = 0; i < CORPUS.length; i += DELTA_SIZE) deltas.push(CORPUS.slice(i, i + DELTA_SIZE));',
    '',
    'let renderCount = 0, renderMs = 0, renderMax = 0, parseMs = 0, enhanceMs = 0;',
    'const realMarkdown = markdown;',
    'markdown = function (t) { const s0 = performance.now(); const r = realMarkdown(t); parseMs += performance.now() - s0; return r; };',
    'const realEnhance = enhanceCodeBlocks;',
    'enhanceCodeBlocks = function (root) { const s0 = performance.now(); realEnhance(root); enhanceMs += performance.now() - s0; };',
    'const realRender = renderAssistantBody;',
    'renderAssistantBody = function (el, m) { renderCount++; const s0 = performance.now(); realRender(el, m); const dt = performance.now() - s0; renderMs += dt; if (dt > renderMax) renderMax = dt; renderTimes.push({ len: m.text.length, dt }); };',
    '',
    'function freshChat() {',
    "  state.messages = [];",
    "  const root = $('#messages');",
    "  root.innerHTML = '';",
    "  const el = document.createElement('article');",
    "  el.className = 'message assistant';",
    "  el.dataset.run = 'R1';",
    "  el.innerHTML = '<div class=\"role\">G</div><div class=\"message-body\"></div><div class=\"message-meta\"></div>';",
    '  root.appendChild(el);',
    "  const m = { kind: 'assistant', text: '', runId: 'R1', complete: false, pending: false, at: Date.now() };",
    '  state.messages.push(m);',
    '  return { el, m };',
    '}',
    '',
    'async function runScenario(every, throttled, count) {',
    '  renderCount = 0; renderMs = 0; renderMax = 0; parseMs = 0; enhanceMs = 0;',
    '  const chat = freshChat();',
    '  const longtasks = [];',
    '  let obs = null;',
    "  if (typeof PerformanceObserver !== 'undefined') {",
    '    obs = new PerformanceObserver(function (list) { for (const e of list.getEntries()) longtasks.push(e.duration); });',
    "    obs.observe({ type: 'longtask', buffered: false });",
    '  }',
    '  const frames = [];',
    '  let raf = 0;',
    '  const sample = function () { frames.push(performance.now()); raf = requestAnimationFrame(sample); };',
    '  raf = requestAnimationFrame(sample);',
    '  const w0 = performance.now();',
    '  const stream = count ? deltas.slice(0, count) : deltas;',
    '  for (const d of stream) {',
    '    chat.m.text += d;',
    '    if (throttled) scheduleAssistantRender(chat.m, false);',
    '    else renderAssistantBody(chat.el, chat.m);',
    '    await sleep(every);',
    '  }',
    '  scheduleAssistantRender(chat.m, true);',
    '  const wallMs = performance.now() - w0;',
    '  cancelAnimationFrame(raf);',
    '  if (obs) obs.disconnect();',
    '  const intervals = [];',
    '  for (let i = 1; i < frames.length; i++) intervals.push(frames[i] - frames[i - 1]);',
    '  const sorted = intervals.slice().sort(function (a, b) { return a - b; });',
    '  const janky = intervals.filter(function (g) { return g > 50; }).length;',
    '  let longMs = 0;',
    '  for (const d of longtasks) longMs += d;',
    '  return {',
    '    every, throttled,',
    '    wallMs, renders: renderCount,',
    '    renderMs, renderMax,',
    '    parseMs, enhanceMs,',
    '    frames: frames.length,',
    '    p95: sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : 0,',
    '    maxGap: sorted.length ? sorted[sorted.length - 1] : 0,',
    '    janky,',
    '    longtasks: longtasks.length, longMs',
    '  };',
    '}',
    '',
    'function breakdownOnce() {',
    '  const chat = freshChat();',
    "  const body = chat.el.querySelector('.message-body');",
    '  let t0 = performance.now();',
    '  const html = markdown(CORPUS);',
    '  const parseMs = performance.now() - t0;',
    '  t0 = performance.now();',
    '  body.innerHTML = html;',
    '  const domMs = performance.now() - t0;',
    '  t0 = performance.now();',
    '  void body.offsetHeight;',
    '  const layoutMs = performance.now() - t0;',
    '  t0 = performance.now();',
    '  enhanceCodeBlocks(body);',
    '  const enhanceMs = performance.now() - t0;',
    '  t0 = performance.now();',
    '  void body.offsetHeight;',
    '  const layout2 = performance.now() - t0;',
    '  return { chars: CORPUS.length, parseMs, domMs, layoutMs: layoutMs + layout2, enhanceMs, totalMs: parseMs + domMs + layoutMs + layout2 + enhanceMs };',
    '}',
    '',
    'const renderTimes = [];',
    'window.__internals = { runScenario, deltas, state, freshChat, renderTimes, breakdownOnce };',
    'window.__benchRun = async function () {',
    '  const scenarios = [];',
    '  scenarios.push(await runScenario(10, true));',
    '  scenarios.push(await runScenario(10, false));',
    '  scenarios.push(await runScenario(5, true));',
    '  scenarios.push(await runScenario(5, false));',
    '  return { scenarios, breakdown: breakdownOnce() };',
    '};'
  ].join('\n');

  const markedUm = readFileSync(MARKED_UMD, 'utf8');
  const harness = [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<style>', css,
    // #messages sizing is layout-driven in the live app (flex sidebar); pin it
    // for the isolated harness so nearBottom() behaves like the real window.
    '#messages{height:100vh;overflow:auto;padding:24px}',
    '</style></head><body>',
    '<div id="messages"></div>',
    '<script>', markedUm, '</script>',
    '<script>', engine, '</script>',
    '</body></html>'
  ].join('\n');

  return harness;
}

const ELECTRON_MAIN = [
  "const { app, BrowserWindow } = require('electron');",
  'const harness = process.argv[process.argv.length - 1];',
  'app.whenReady().then(async () => {',
  '  try {',
  '    // Visible but parked off-screen: Chromium freezes hidden windows (fake ~1s stalls),',
  '    // so the benchmark window must count as visible.',
  '    const win = new BrowserWindow({ show: true, x: -32000, y: -32000, width: 1280, height: 800, webPreferences: { backgroundThrottling: false } });',
  '    win.webContents.setBackgroundThrottling(false);',
  "    await win.loadFile(harness);",
  "    const result = await win.webContents.executeJavaScript('window.__benchRun()');",
  "    console.log('BENCH_RESULT' + JSON.stringify(result));",
  '    app.exit(0);',
  '  } catch (err) {',
  "    console.error('BENCH_ERROR ' + (err && (err.stack || err)));",
  '    app.exit(1);',
  '  }',
  '});',
  "app.on('window-all-closed', () => app.exit(0));",
  "setTimeout(() => { console.error('BENCH_TIMEOUT'); app.exit(2); }, 480000);"
].join('\n');

function runElectron(harnessPath) {
  return new Promise((resolve, reject) => {
    const mainPath = path.join(LOGS, 'bench-dom-main.js');
    writeFileSync(mainPath, ELECTRON_MAIN);
    const child = spawn(ELECTRON, [mainPath, harnessPath], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('electron benchmark timed out after 480s\n' + err.slice(-2000)));
    }, 490000);
    child.on('error', (e) => { clearTimeout(timer); reject(new Error('failed to launch electron: ' + e.message)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const marker = out.indexOf('BENCH_RESULT');
      if (marker >= 0) {
        try { resolve(JSON.parse(out.slice(marker + 'BENCH_RESULT'.length).split('\n')[0])); return; }
        catch { /* fall through */ }
      }
      if (err.includes('BENCH_ERROR')) reject(new Error(err.slice(err.indexOf('BENCH_ERROR'), err.indexOf('BENCH_ERROR') + 2000)));
      else reject(new Error(`electron exited ${code} without a result\nstdout: ${out.slice(-1500)}\nstderr: ${err.slice(-1500)}`));
    });
  });
}

function fmtMs(ms) {
  if (ms >= 1000) return (ms / 1000).toFixed(2) + ' s';
  if (ms >= 1) return ms.toFixed(1) + ' ms';
  return (ms * 1000).toFixed(0) + ' µs';
}

function printReport(result) {
  const scenarios = result.scenarios;
  const th10 = scenarios.find((s) => s.every === 10 && s.throttled);
  const un10 = scenarios.find((s) => s.every === 10 && !s.throttled);
  const th5 = scenarios.find((s) => s.every === 5 && s.throttled);
  const un5 = scenarios.find((s) => s.every === 5 && !s.throttled);

  console.log('\n' + '═'.repeat(100));
  console.log('DOM LAYOUT & PAINT — real Chromium (desktop Electron), real markdown/highlight/CSS from index.html');
  console.log('Corpus: ' + result.breakdown.chars.toLocaleString() + ' chars · ' + Math.ceil(result.breakdown.chars / DELTA_SIZE).toLocaleString() + ' deltas of ' + DELTA_SIZE + ' chars');
  console.log('═'.repeat(100));
  console.log('scenario           renders   render work (total)   max single   janky>50ms   longtasks   wall time');
  const rows = [th10, un10, th5, un5];
  for (const r of rows) {
    const label = (r.every + ' ms/delta  ' + (r.throttled ? 'throttled  ' : 'unthrottled')).padEnd(20);
    const renders = String(r.renders).padStart(5) + '    ';
    const work = fmtMs(r.renderMs).padStart(14) + '      ';
    const maxS = fmtMs(r.renderMax).padStart(8) + '      ';
    const janky = String(r.janky).padStart(6) + '       ';
    const lt = String(r.longtasks).padStart(4) + '          ';
    const wall = fmtMs(r.wallMs);
    console.log(label + renders + work + maxS + janky + lt + wall);
  }
  console.log('');
  const jankTh = th10.janky + th5.janky;
  const jankUn = un10.janky + un5.janky;
  const workTh = th10.renderMs + th5.renderMs;
  const workUn = un10.renderMs + un5.renderMs;
  console.log('→ main-thread render work: ' + fmtMs(workUn) + ' (unthrottled) vs ' + fmtMs(workTh) + ' (throttled) — ' +
    (workUn / Math.max(0.001, workTh)).toFixed(1) + 'x less');
  console.log('→ janky frames (>50 ms): ' + jankUn + ' (unthrottled) vs ' + jankTh + ' (throttled) — ' +
    (jankUn / Math.max(1, jankTh)).toFixed(1) + 'x fewer');
  console.log('→ worst single frame: ' + fmtMs(un10.renderMax) + ' (unthrottled) vs ' + fmtMs(th10.renderMax) + ' (throttled)');

  const b = result.breakdown;
  console.log('\nSingle full-size render cost split (' + b.chars.toLocaleString() + ' chars, real DOM):');
  console.log('  parse (marked)      ' + fmtMs(b.parseMs));
  console.log('  DOM tree build      ' + fmtMs(b.domMs));
  console.log('  layout              ' + fmtMs(b.layoutMs));
  console.log('  syntax highlight    ' + fmtMs(b.enhanceMs));
  console.log('  TOTAL (one frame)   ' + fmtMs(b.totalMs));
  console.log('');
}

export async function runDomBenchmark() {
  if (!existsSync(INDEX)) {
    console.error('[dom-bench] index.html not found at ' + INDEX + ' — nothing to measure');
    return;
  }
  if (!existsSync(ELECTRON)) {
    console.error('[dom-bench] desktop Electron not found at ' + ELECTRON + ' — run `cd desktop && npm install` first. Skipping DOM measurement (parse gate unaffected).');
    return;
  }
  mkdirSync(LOGS, { recursive: true });
  const harnessPath = path.join(LOGS, 'bench-dom-harness.html');
  writeFileSync(harnessPath, buildHarness());
  try {
    const result = await runElectron(harnessPath);
    printReport(result);
  } finally {
    rmSync(harnessPath, { force: true });
    rmSync(path.join(LOGS, 'bench-dom-main.js'), { force: true });
  }
}

// Direct entry: `node scripts/bench-dom-render.mjs`
const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) runDomBenchmark();
