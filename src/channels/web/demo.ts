/**
 * Hidden /demo page — replays the recorded delta stream against the REAL
 * render pipeline, side by side: unthrottled (render every delta) vs the
 * deployed 60 ms throttled path.
 *
 * The page is assembled at request time from src's index.html so it can never
 * drift from the live UI: the exact <style> block, the real esc/HL_KEYWORDS,
 * markdown, highlightCode, enhanceCodeBlocks, nearBottom, renderThinking,
 * renderAssistantBody and scheduleAssistantRender are extracted verbatim and
 * scoped per panel via a makeSide() factory (each side gets its own $, state,
 * assistantRenderTimer, toast).
 *
 * The delta stream comes from demo-recording.json (the benchmark corpus split
 * into 10-char deltas — swap that file for a real captured assistant stream
 * to replay an actual run). Controls: play/pause, restart, pace slider, plus
 * live per-side metrics (renders, render work, worst frame), a page-level
 * frame-jank sparkline, long-task count and a final verdict line.
 *
 * Not linked from the UI — visit /demo directly.
 */

import fs from 'fs';

/** Extract a `function name(...){...}` verbatim from an inline <script>. */
function extractFn(script: string, name: string): string {
  const start = script.indexOf('function ' + name + '(');
  if (start < 0) throw new Error(`function ${name} not found in index.html`);
  let depth = 0;
  let inStr: string | null = null;
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
function extractConstLine(script: string, name: string): string {
  const start = script.indexOf('const ' + name + '=');
  if (start < 0) throw new Error(`const ${name} not found in index.html`);
  const end = script.indexOf('\n', start);
  return script.slice(start, end < 0 ? undefined : end);
}

interface Recording {
  version?: number;
  meta?: { chars?: number; deltas?: number; deltaSize?: number; source?: string };
  deltas: string[];
}

/** Load the recorded delta stream; fall back to an inline sample if missing. */
function loadDeltas(recordingPath: string): { deltas: string[]; meta: Recording['meta'] } {
  try {
    const rec: Recording = JSON.parse(fs.readFileSync(recordingPath, 'utf8'));
    if (Array.isArray(rec.deltas) && rec.deltas.length > 0) return { deltas: rec.deltas, meta: rec.meta };
  } catch {
    // fall through to the inline sample
  }
  const sample = '# Demo stream (no recording found)\n\n**This** is a fallback stream so the page never hard-fails. ' +
    'Drop a `demo-recording.json` next to index.html to replay the real corpus. ';
  const deltas: string[] = [];
  for (let i = 0; i < sample.length; i += 10) deltas.push(sample.slice(i, i + 10));
  return { deltas, meta: { chars: sample.length, deltas: deltas.length, deltaSize: 10, source: 'fallback sample' } };
}

export function buildDemoPage(indexPath: string, recordingPath: string): string {
  const html = fs.readFileSync(indexPath, 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
  const cssStart = html.indexOf('<style>') + '<style>'.length;
  const cssEnd = html.indexOf('</style>');
  const css = cssStart > cssEnd ? '' : html.slice(cssStart, cssEnd);

  const esc = extractConstLine(script, 'esc');
  const hlKeywords = extractConstLine(script, 'HL_KEYWORDS');
  const fns = ['markdown', 'highlightCode', 'enhanceCodeBlocks', 'nearBottom',
    'renderThinking', 'renderAssistantBody', 'scheduleAssistantRender']
    .map((n) => extractFn(script, n))
    .join('\n');

  const { deltas, meta } = loadDeltas(recordingPath);

  // The page's own app code. Backtick-free so it embeds cleanly; the real
  // functions above are scoped per side inside makeSide().
  const appCode = [
    "'use strict';",
    'const recording = window.DEMO_DELTAS;',
    '',
    'function makeSide(root, throttled) {',
    '  const $ = (s) => s === "#messages" ? root : root.querySelector(s);',
    '  let assistantRenderTimer = null;',
    '  const state = { messages: [] };',
    '  function toast() {}',
    esc,
    hlKeywords,
    fns,
    '  const metrics = { renders: 0, renderMs: 0, maxRender: 0 };',
    '  const realRender = renderAssistantBody;',
    '  renderAssistantBody = function (el, m) {',
    '    metrics.renders++;',
    '    const s0 = performance.now();',
    '    realRender(el, m);',
    '    const dt = performance.now() - s0;',
    '    metrics.renderMs += dt;',
    '    if (dt > metrics.maxRender) metrics.maxRender = dt;',
    '  };',
    '  function reset() {',
    '    state.messages = [];',
    '    assistantRenderTimer = null;',
    '    root.innerHTML = "";',
    '    const el = document.createElement("article");',
    '    el.className = "message assistant";',
    '    el.dataset.run = "DEMO";',
    '    el.innerHTML = \'<div class="role">G</div><div class="message-body"></div><div class="message-meta"></div>\';',
    '    root.appendChild(el);',
    '    const m = { kind: "assistant", text: "", runId: "DEMO", complete: false, pending: false, at: Date.now() };',
    '    state.messages.push(m);',
    '    metrics.renders = 0; metrics.renderMs = 0; metrics.maxRender = 0;',
    '    return m;',
    '  }',
    '  function push(text) {',
    '    const m = state.messages[0];',
    '    m.text = m.text + text;',
    '    if (throttled) scheduleAssistantRender(m, false);',
    '    else renderAssistantBody(root.querySelector(".message"), m);',
    '  }',
    '  function flush() {',
    '    const m = state.messages[0];',
    '    m.complete = true;',
    '    scheduleAssistantRender(m, true);',
    '  }',
    '  function bodyText() {',
    '    const b = root.querySelector(".message-body");',
    '    return b ? b.textContent.length : 0;',
    '  }',
    '  return { reset, push, flush, metrics, bodyText };',
    '}',
    '',
    'const sides = {',
    '  un: makeSide(document.getElementById("chat-un"), false),',
    '  th: makeSide(document.getElementById("chat-th"), true)',
    '};',
    '',
    'const frameRing = [];',
    'let lastFrame = performance.now();',
    'const jank = { frames: 0, longtasks: 0, longMs: 0 };',
    'if (typeof PerformanceObserver !== "undefined") {',
    '  try {',
    '    new PerformanceObserver(function (list) {',
    '      for (const e of list.getEntries()) { jank.longtasks++; jank.longMs += e.duration; }',
    '    }).observe({ type: "longtask", buffered: false });',
    '  } catch (e) {}',
    '}',
    'const canvas = document.getElementById("frames");',
    'const ctx = canvas ? canvas.getContext("2d") : null;',
    'function frameLoop() {',
    '  const now = performance.now();',
    '  const gap = now - lastFrame;',
    '  lastFrame = now;',
    '  frameRing.push(gap);',
    '  if (frameRing.length > 240) frameRing.shift();',
    '  if (gap > 50) jank.frames++;',
    '  if (ctx) {',
    '    const w = canvas.width, h = canvas.height;',
    '    ctx.clearRect(0, 0, w, h);',
    '    const bw = w / 240;',
    '    for (let i = 0; i < frameRing.length; i++) {',
    '      const g = frameRing[i];',
    '      const bh = Math.min(h, (g / 60) * h);',
    '      ctx.fillStyle = g > 50 ? "#ff6b7a" : "#43d3b4";',
    '      ctx.fillRect(i * bw, h - bh, bw - 1, bh);',
    '    }',
    '  }',
    '  requestAnimationFrame(frameLoop);',
    '}',
    'requestAnimationFrame(frameLoop);',
    '',
    'let playing = false, pace = 10, i = 0, timer = null, finished = false;',
    'function el(id) { return document.getElementById(id); }',
    'function fmt(ms) {',
    '  if (ms >= 1000) return (ms / 1000).toFixed(2) + " s";',
    '  if (ms >= 1) return ms.toFixed(1) + " ms";',
    '  return (ms * 1000).toFixed(0) + " µs";',
    '}',
    'function updateMetrics() {',
    '  for (const key of ["un", "th"]) {',
    '    const m = sides[key].metrics;',
    '    el("m-" + key + "-chars").textContent = sides[key].bodyText();',
    '    el("m-" + key + "-renders").textContent = m.renders;',
    '    el("m-" + key + "-total").textContent = fmt(m.renderMs);',
    '    el("m-" + key + "-max").textContent = fmt(m.maxRender);',
    '  }',
    '  el("progress").textContent = i + " / " + recording.length;',
    '  el("jank").textContent = jank.frames + " janky frames · " + jank.longtasks + " long tasks";',
    '}',
    'function tick() {',
    '  if (i >= recording.length) { finish(); return; }',
    '  const d = recording[i++];',
    '  sides.un.push(d);',
    '  sides.th.push(d);',
    '  updateMetrics();',
    '  if (playing) timer = setTimeout(tick, pace);',
    '}',
    'function playPause() {',
    '  if (finished) restart();',
    '  playing = !playing;',
    '  el("play").textContent = playing ? "⏸ Pause" : "▶ Play";',
    '  if (playing) tick();',
    '}',
    'function restart() {',
    '  if (timer) clearTimeout(timer);',
    '  playing = false; finished = false; i = 0;',
    '  el("play").textContent = "▶ Play";',
    '  sides.un.reset(); sides.th.reset();',
    '  el("verdict").textContent = "";',
    '  updateMetrics();',
    '}',
    'function finish() {',
    '  playing = false; finished = true;',
    '  el("play").textContent = "▶ Replay";',
    '  sides.th.flush();',
    '  updateMetrics();',
    '  const um = sides.un.metrics, tm = sides.th.metrics;',
    '  const ratio = (um.renderMs / Math.max(0.001, tm.renderMs)).toFixed(1);',
    '  el("verdict").textContent = "Unthrottled: " + um.renders + " renders, " + fmt(um.renderMs) + " render work · Throttled: " + tm.renders + " renders, " + fmt(tm.renderMs) + " · " + ratio + "x less main-thread render work";',
    '}',
    'el("play").addEventListener("click", playPause);',
    'el("restart").addEventListener("click", restart);',
    'const paceEl = el("pace");',
    'paceEl.addEventListener("input", function () { pace = parseInt(paceEl.value, 10) || 10; el("paceVal").textContent = pace + " ms"; });',
    'restart();'
  ].join('\n');

  const page = [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>Gitu — streaming render demo</title>',
    '<style>',
    css,
    // demo chrome (panels, controls, metrics) — distinct from the app CSS
    ':root{--bg:#0b0d12;--panel:#11141b;--line:#252b38;--text:#f4f6fb;--muted:#8e97a9;--soft:#c8ced9;--accent:#8b7cff;--accent2:#43d3b4;--danger:#ff6b7a;--warn:#f3ba63}',
    '*{box-sizing:border-box}',
    'html,body{height:100%;margin:0}',
    'body{font:14px/1.55 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--text);padding:18px;overflow:auto}',
    '.demo-head{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:12px}',
    '.demo-head h1{font-size:16px;margin:0;letter-spacing:-.02em}',
    '.demo-head .sub{color:var(--muted);font-size:12px}',
    '.controls{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:10px 0 14px}',
    '.controls button{background:var(--panel);border:1px solid var(--line);color:var(--soft);border-radius:9px;padding:6px 14px;cursor:pointer;font-size:13px}',
    '.controls button:hover{border-color:var(--accent);color:var(--text)}',
    '.controls label{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:12.5px}',
    '.controls input[type=range]{width:140px}',
    '#progress{color:var(--muted);font-size:12.5px;margin-left:auto}',
    '.panels{display:grid;grid-template-columns:1fr 1fr;gap:16px}',
    '.panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px;display:flex;flex-direction:column}',
    '.panel h2{font-size:13.5px;margin:0 0 10px;display:flex;align-items:center;gap:8px}',
    '.tag{font-size:10.5px;font-weight:600;padding:2px 8px;border-radius:20px}',
    '.tag.un{background:rgba(255,107,122,.14);color:var(--danger)}',
    '.tag.th{background:rgba(67,211,180,.14);color:var(--accent2)}',
    '.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:10px}',
    '.metric{background:#0e1117;border:1px solid var(--line);border-radius:9px;padding:7px 9px}',
    '.metric .k{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}',
    '.metric .v{font-size:14px;font-weight:600;margin-top:2px}',
    '.chat{height:44vh;overflow:auto;background:#0b0d12;border:1px solid var(--line);border-radius:12px;padding:16px}',
    '.chat .message{margin-bottom:0}',
    '#frames{width:100%;height:44px;margin-top:12px;border:1px solid var(--line);border-radius:9px;background:#0e1117}',
    '#jank{color:var(--muted);font-size:12px;margin-top:8px}',
    '#verdict{color:var(--accent2);font-size:13px;font-weight:600;margin-top:8px;min-height:18px}',
    '</style>',
    '</head>',
    '<body>',
    '<div class="demo-head"><h1>Streaming render — throttled vs unthrottled</h1><span class="sub" id="meta"></span></div>',
    '<div class="controls">',
    '<button id="play">▶ Play</button>',
    '<button id="restart">↺ Restart</button>',
    '<label>pace <input type="range" id="pace" min="2" max="60" value="10"><span id="paceVal">10 ms</span></label>',
    '<span id="progress">0 / 0</span>',
    '</div>',
    '<div class="panels">',
    '<section class="panel"><h2>Unthrottled <span class="tag un">before</span></h2>',
    '<div class="metrics">',
    '<div class="metric"><div class="k">chars</div><div class="v" id="m-un-chars">0</div></div>',
    '<div class="metric"><div class="k">renders</div><div class="v" id="m-un-renders">0</div></div>',
    '<div class="metric"><div class="k">render work</div><div class="v" id="m-un-total">0</div></div>',
    '<div class="metric"><div class="k">worst render</div><div class="v" id="m-un-max">0</div></div>',
    '</div>',
    '<div class="chat" id="chat-un"></div>',
    '</section>',
    '<section class="panel"><h2>Throttled 60 ms <span class="tag th">current</span></h2>',
    '<div class="metrics">',
    '<div class="metric"><div class="k">chars</div><div class="v" id="m-th-chars">0</div></div>',
    '<div class="metric"><div class="k">renders</div><div class="v" id="m-th-renders">0</div></div>',
    '<div class="metric"><div class="k">render work</div><div class="v" id="m-th-total">0</div></div>',
    '<div class="metric"><div class="k">worst render</div><div class="v" id="m-th-max">0</div></div>',
    '</div>',
    '<div class="chat" id="chat-th"></div>',
    '</section>',
    '</div>',
    '<canvas id="frames" width="1200" height="44"></canvas>',
    '<div id="jank">0 janky frames · 0 long tasks</div>',
    '<div id="verdict"></div>',
    '<script src="/vendor/marked.js"></script>',
    '<script>window.DEMO_DELTAS = ' + JSON.stringify(deltas) + ';</script>',
    '<script>',
    appCode,
    '</script>',
    '<script>document.getElementById("meta").textContent = ' +
      JSON.stringify(`${meta?.deltas ?? deltas.length} deltas · ${meta?.chars ?? ''} chars · ${meta?.source ?? 'recording'}`) + ';</script>',
    '</body>',
    '</html>'
  ].join('\n');

  return page;
}
