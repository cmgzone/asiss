/**
 * Phase 22 — MANUAL-QUALITY LIVE ACCEPTANCE (runs against the REAL dev server).
 *
 * Prereqs: dev server on http://localhost:3000 with a REAL model configured
 * (this run expects OpenRouter + openai/gpt-oss-20b:free via .env), and a
 * login user `acceptance` / `acctest123` in users.json.
 *
 * Drives the actual WebUI like a human, captures a DOM timeline every 400ms,
 * saves screenshots to ./acceptance-shots/, and checks the Phase 22 §17
 * acceptance criteria + the 10-point acceptance checklist:
 *
 *   A. REAL multi-tool task: tools actually called; activity appears LIVE
 *      during execution; zero generic update messages; no protocol markup;
 *      tool rows grow IN-PLACE (message count constant); state transitions
 *      event-driven (not fake timers).
 *   B. Parallel sub-agents via delegate_agent: each agent has its OWN live
 *      visual state (running -> completed), named + labelled, counted.
 *   C. Cancellation via the real stop button; smart-scroll pill.
 *   R. Reload restores every card + tool row, still sanitized.
 *
 * Not battery-safe by design: needs a live server + paid model. Run manually.
 */
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const BASE = process.env.ACCEPT_BASE || 'http://localhost:3000';
const SHOTS = path.join(__dirname, '..', 'acceptance-shots');
fs.mkdirSync(SHOTS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROTOCOL_RE = /<tool_call|<arg_key|<arg_value|<thinking>|<\/thinking>/;

const results = [];
function gate(id, ok, detail) {
  results.push({ id, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${detail}`);
}

async function sampleDOM(page) {
  return page.evaluate(() => {
    const messages = document.querySelectorAll('#messages .message');
    const text = document.querySelector('#messages')?.innerText || '';
    const cards = [...document.querySelectorAll('.exec-card-message')].map((el) => ({
      id: el.id,
      state: el.querySelector('.exec-card')?.className.match(/st-([a-z]+)/)?.[1] || null,
      stateLabel: el.querySelector('.exec-card-state')?.textContent?.trim() || null,
      line: el.querySelector('.exec-card-line')?.textContent?.trim() || '',
      tools: el.querySelectorAll('.exec-tool-row').length,
      toolStates: [...el.querySelectorAll('.exec-tool-row')].map((r) => r.className),
      agents: [...el.querySelectorAll('.exec-agent-row')].map((a) => ({
        name: a.querySelector('.exec-agent-name')?.textContent?.trim() || '',
        label: a.querySelector('.exec-agent-label')?.textContent?.trim() || '',
        state: a.className.match(/\b(running|completed|failed)\b/)?.[1] || '?',
      })),
      progress: el.querySelector('.exec-progress-line span')?.style?.width || null,
      counts: el.querySelector('.exec-card-counts')?.textContent?.trim() || null,
    }));
    return {
      t: Date.now(),
      msgCount: messages.length,
      updateCount: document.querySelectorAll('#messages .message.update').length,
      assistantCount: document.querySelectorAll('#messages .message.assistant').length,
      protocolMarkup: /<tool_call|<arg_key|<arg_value/.test(text) || /<\/?(thinking|reasoning)>/.test(text),
      rawDivInBody: /<div[ >]/.test(text),
      stopHidden: document.querySelector('#stopBtn')?.classList.contains('hidden') ?? true,
      pillVisible: !!document.querySelector('.new-activity-pill:not(.hidden)'),
      cards,
      textLen: text.length,
    };
  });
}

async function waitMissionEnd(page, timeline, timeoutMs = 420000) {
  const start = Date.now();
  let lastChange = Date.now();
  let prev = null;
  while (Date.now() - start < timeoutMs) {
    const s = await sampleDOM(page);
    timeline.push(s);
    const changed = !prev || JSON.stringify(s.cards) !== JSON.stringify(prev.cards) ||
      s.msgCount !== prev.msgCount || s.assistantCount !== prev.assistantCount;
    if (changed) lastChange = Date.now();
    const active = !s.stopHidden;
    const done = !active && (s.cards.some((c) => ['ok', 'err', 'stopped'].includes(c.state)) || Date.now() - lastChange > 3000);
    if (done) return s;
    prev = s;
    await sleep(400);
  }
  return sampleDOM(page);
}

async function main() {
  const req = require('module').createRequire(path.join(__dirname, 'package.json'));
  const { chromium } = req('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  const timeline = [];

  try {
    // ---- login + fresh conversation ----
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.fill('#loginUser', 'acceptance');
    await page.fill('#loginPass', 'acctest123');
    await page.locator('button:has-text("Enter workspace")').click();
    await page.waitForSelector('#app:not(.hidden)', { timeout: 30000 });
    await page.screenshot({ path: path.join(SHOTS, '01-logged-in.png') });
    const newBtn = page.locator('#newChat');
    if (await newBtn.count()) await newBtn.click();
    await sleep(600);

    // ================= TASK A — real multi-tool task =================
    console.log('\n--- TASK A: real multi-tool exploration task ---');
    await page.fill('#chatInput', 'Explore this repository with your tools: (1) list the top-level directory structure, (2) read package.json and summarize the scripts, (3) use search to find where web channels are registered, (4) read one of those files. Then give a short 4-bullet summary. Use REAL tool calls — do not answer from memory.');
    await page.click('#sendBtn');
    await sleep(2500);
    await page.screenshot({ path: path.join(SHOTS, '02-taskA-live.png') });
    const endA = await waitMissionEnd(page, timeline);
    await page.screenshot({ path: path.join(SHOTS, '03-taskA-done.png') });

    const aCards = timeline.map((s) => s.cards).filter((c) => c.length).flat();
    const aToolsTotal = Math.max(...timeline.map((s) => s.cards.reduce((n, c) => n + c.tools, 0)));
    gate('A1 real multi-tool', aToolsTotal >= 3, `final card has ${aToolsTotal} tool rows`);
    const aLive = timeline.filter((s) => s.cards.some((c) => ['run', 'tool', 'working'].includes(c.state) && c.line && c.tools > 0));
    gate('A2 live during execution', aLive.length > 0, `${aLive.length} samples show a live card (state ${[...new Set(aLive.map((s) => s.cards.map((c) => c.state).join(',')))].join('/') || 'none'}) with activity text + tools BEFORE completion`);
    const maxUpdates = Math.max(...timeline.map((s) => s.updateCount));
    gate('A3 zero generic updates', maxUpdates === 0, `max .message.update across ${timeline.length} samples = ${maxUpdates}`);
    const anyMarkup = timeline.some((s) => s.protocolMarkup || s.rawDivInBody);
    gate('A4 no protocol markup', !anyMarkup, 'no <tool_call>/<arg_key>/<arg_value> or raw <div> in chat DOM at any sample');
    const activeMsgs = timeline.filter((s) => !s.stopHidden);
    const msgCountsDuring = activeMsgs.map((s) => s.msgCount);
    const msgsConstant = msgCountsDuring.length === 0 || Math.max(...msgCountsDuring) === Math.min(...msgCountsDuring);
    const firstRunTools = activeMsgs.length ? Math.max(...activeMsgs.map((s) => s.cards.reduce((n, c) => n + c.tools, 0))) : 0;
    const firstRunMsgs = activeMsgs.length ? activeMsgs[0].msgCount : 0;
    const grewInPlace = firstRunTools > 0 && msgsConstant;
    gate('A5 in-place updates', msgsConstant && grewInPlace,
      `msg count constant while running (${Math.min(...msgCountsDuring)}), card tool rows grew ${firstRunTools} within stable messages`);
    const lastACard = endA.cards[0];
    gate('A6 completion state', lastACard && ['ok', 'completed'].includes(lastACard.state), `final card state = ${lastACard?.state} (${lastACard?.stateLabel})`);

    // ================= TASK B — parallel sub-agents =================
    console.log('\n--- TASK B: parallel sub-agents via delegate_agent ---');
    timeline.length = 0;
    await page.fill('#chatInput', 'Use the delegate_agent tool exactly twice, in parallel, both with agentId "auto": sub-task 1 = summarize src/core/hooks.ts; sub-task 2 = summarize src/core/atomic-write.ts. Wait for BOTH child results before replying, then give a combined one-paragraph verdict.');
    await page.click('#sendBtn');
    await sleep(3000);
    await page.screenshot({ path: path.join(SHOTS, '04-taskB-live.png') });
    const endB = await waitMissionEnd(page, timeline, 480000);
    await page.screenshot({ path: path.join(SHOTS, '05-taskB-done.png') });

    const bSamples = timeline.filter((s) => s.cards.length);
    const bAgentsSeen = new Set();
    const bAllRows = [];
    let bMaxRows = 0;
    for (const s of bSamples) for (const c of s.cards) {
      if (c.agents.length > bMaxRows) bMaxRows = c.agents.length;
      for (const a of c.agents) {
        bAgentsSeen.add(`${a.name}${a.label ? ` (${a.label})` : ''}`);
        bAllRows.push({ ...a, state: a.state });
      }
    }
    const bothRunning = bSamples.some((s) => s.cards.some((c) =>
      c.agents.filter((a) => a.state === 'running').length >= 2));
    gate('B1 two agents live at once', bothRunning, 'a sample shows >=2 agent rows running simultaneously');
    gate('B2 two distinct agent rows', bMaxRows >= 2, `max ${bMaxRows} agent rows on a card (identities: ${[...bAgentsSeen].join(', ')})`);
    const finalBAgents = endB.cards.length ? endB.cards[0].agents : [];
    const settled = finalBAgents.length >= 2 && finalBAgents.every((a) => a.state === 'completed' || a.state === 'failed');
    gate('B3 agents settle', settled, `${finalBAgents.length} agent rows on final card, states: ${finalBAgents.map((a) => a.state).join(',')}`);
    const countsLine = endB.cards.length ? endB.cards[0].counts : null;
    gate('B4 agent count on card', !!countsLine && countsLine.includes('agents'), `card counts: "${countsLine}"`);

    // ================= TASK C — cancellation + smart scroll =================
    console.log('\n--- TASK C: cancellation via real stop button ---');
    timeline.length = 0;
    await page.fill('#chatInput', 'Read every file in src/core/ and src/channels/ one by one with read_file and write a one-line summary per file. Be exhaustive and take your time.');
    await page.click('#sendBtn');
    const cStart = Date.now();
    let sawCard = false, sawTool = false, stoppedClicked = false;
    let pillSeen = false;
    while (Date.now() - cStart < 240000) {
      const s = await sampleDOM(page);
      timeline.push(s);
      if (!s.stopHidden) {
        if (!sawCard && s.cards.length) {
          sawCard = true;
          // scroll to top IMMEDIATELY so future renders must trigger the pill
          await page.evaluate(() => { document.querySelector('#messages')?.scrollTo({ top: 0 }); });
        }
        if (s.cards.some((c) => c.tools > 0)) sawTool = true;
        if (sawCard && !pillSeen) {
          if (s.pillVisible) {
            pillSeen = true;
            await page.screenshot({ path: path.join(SHOTS, '06-taskC-pill.png') });
            await page.click('.new-activity-pill');
            await sleep(500);
            const after = await sampleDOM(page);
            timeline.push(after);
            const scrolled = await page.evaluate(() => {
              const el = document.querySelector('#messages');
              return el ? el.scrollTop + el.clientHeight >= el.scrollHeight - 40 : false;
            });
            gate('C2 smart-scroll pill', true, 'pill appeared while scrolled away during activity');
            gate('C2b pill click scrolls to live bottom + hides', scrolled && !after.pillVisible, `scrolled=${scrolled} pillHidden=${!after.pillVisible}`);
          }
        }
        if (sawTool && !stoppedClicked && !pillSeen && Date.now() - cStart > 8000) {
          stoppedClicked = true;
          await page.screenshot({ path: path.join(SHOTS, '06b-taskC-before-stop.png') });
          await page.click('#stopBtn');
          console.log('  stop clicked at', Date.now() - cStart, 'ms');
        }
      }
      if (!s.stopHidden && stoppedClicked && pillSeen) break;
      if (s.stopHidden && stoppedClicked) break;
      await sleep(400);
    }
    gate('C1 saw live activity before stop', sawTool, sawTool ? 'tool rows appeared while running, stop was pressed' : 'NO tool activity observed before stop');
    if (!pillSeen) gate('C2 smart-scroll pill', false, 'pill did NOT appear while scrolled away during activity');
    if (!stoppedClicked) gate('C1b stop pressed while active', false, 'mission ended before stop could be clicked');
    const cEnd = await waitMissionEnd(page, timeline, 90000);
    await page.screenshot({ path: path.join(SHOTS, '07-taskC-stopped.png') });
    const stoppedCard = cEnd.cards.find((c) => c.state === 'stopped');
    const stoppedMeta = await page.evaluate(() =>
      [...document.querySelectorAll('.message-meta')].map((e) => e.textContent));
    gate('C3 stopped state', !!stoppedCard || stoppedMeta.includes('Stopped'),
      `card=${stoppedCard ? 'st-stopped' : 'none'} meta=${stoppedMeta.filter((t) => t && t !== 'Completed').join(',') || 'none'}`);

    // ================= RELOAD =================
    console.log('\n--- RELOAD: restored history ---');
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('#app:not(.hidden)', { timeout: 30000 });
    await sleep(1500);
    const r = await sampleDOM(page);
    await page.screenshot({ path: path.join(SHOTS, '08-reloaded.png') });
    gate('R1 cards restored', r.cards.length >= 2, `${r.cards.length} execution cards after reload`);
    const rTools = r.cards.reduce((n, c) => n + c.tools, 0);
    gate('R2 tool rows restored', rTools >= 3, `${rTools} tool rows replayed`);
    gate('R3 restored sanitized', !r.protocolMarkup && !r.rawDivInBody, 'no protocol markup in restored history');

    gate('R4 no page errors', pageErrors.length === 0, pageErrors.length ? pageErrors.join(' | ') : 'clean console');

    // ---- summary ----
    console.log('\n===== ACCEPTANCE SUMMARY =====');
    const pass = results.filter((r) => r.ok).length;
    console.log(`${pass}/${results.length} gates passed`);
    const A = endA, B = endB;
    console.log('Task A tools:', aToolsTotal, '| Task B agents:', bAgentsSeen.size, '| Task C stopped:', !!stoppedCard);
    console.log('Screenshots in:', SHOTS);
    console.log('pageErrors:', pageErrors.length);
  } finally {
    try {
      fs.writeFileSync(path.join(SHOTS, 'timeline.json'), JSON.stringify(timeline, null, 1));
      fs.writeFileSync(path.join(SHOTS, 'results.json'), JSON.stringify(results, null, 1));
    } catch { /* best-effort */ }
    await browser.close();
  }
  process.exit(results.every((r) => r.ok) ? 0 : 2);
}

main().catch((e) => { console.error('ACCEPTANCE CRASHED:', e); process.exit(1); });