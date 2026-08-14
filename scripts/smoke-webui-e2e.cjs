/**
 * Phase 22 — battery-safe live browser E2E gate.
 *
 * Boots the REAL WebChannel server in an isolated temp cwd (no repo writes),
 * registers a demo user, replays synthetic mission events through the SAME
 * socket path the real runner uses, and drives the REAL served page with
 * headless Chromium (playwright, already in devDeps):
 *
 *   §1  a full mission produces ZERO generic `update` messages
 *   §2  no tool protocol markup (tool_call/arg_key) is ever visible
 *   §3  the execution card mounts with its own identity + tool rows
 *   §4  progress folds into a REAL assistant message (never an update bubble)
 *   §5  FIVE consecutive turns -> five DISTINCT execution cards (div-leak)
 *   §6  PAGE RELOAD: restored history replays every tool row + card (refresh)
 *
 * Safe in the battery: self-bootstrapped, self-port, cleaned up on exit.
 * Run: npm run smoke:webui-e2e (part of the battery).
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
require('ts-node/register');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitu-webui-e2e-'));
process.chdir(tmp);
process.env.GITU_DATA_ROOT = path.join(tmp, 'gitu-data');

const PORT = Number(process.env.WEBUI_E2E_PORT || 3120);
const BASE = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { WebChannel } = require(path.join(__dirname, '..', 'src', 'channels', 'web', 'server'));
  const channel = new WebChannel(PORT);
  channel.auth.register('webuidemo', 'demo1234');
  channel.start();
  await sleep(400);

  let missionNo = 0;
  channel.onMessage(async (msg) => {
    const content = String(msg?.content || msg?.text || '').trim();
    if (!content) return;
    missionNo += 1;
    const exId = `exec-e2e-${missionNo}`;
    const emit = (ev) => channel.sendStreamEvent(msg.senderId, ev);
    emit({ type: 'mission_start', executionId: exId, runId: exId, messageId: exId, progressPct: 0 });
    await sleep(80);
    emit({ type: 'assistant_start', executionId: exId, runId: `${exId}:t1`, messageId: `${exId}:t1` });
    emit({ type: 'assistant_delta', executionId: exId, runId: `${exId}:t1`, messageId: `${exId}:t1`, text: 'Tracing the login flow...' });
    await sleep(60);
    emit({ type: 'assistant_done', executionId: exId, runId: `${exId}:t1`, messageId: `${exId}:t1`, finalText: 'Tracing the login flow.', ok: true, progress: true });
    await sleep(50);
    emit({ type: 'tool_start', executionId: exId, runId: `${exId}:t1`, messageId: `${exId}:t1`, toolCallId: `${exId}:s1`, name: 'search', label: 'Searching repository' });
    await sleep(50);
    emit({ type: 'tool_done', executionId: exId, runId: `${exId}:t1`, messageId: `${exId}:t1`, toolCallId: `${exId}:s1`, name: 'search', status: 'completed', output: 'found auth.ts' });
    emit({ type: 'tool_start', executionId: exId, runId: `${exId}:t1`, messageId: `${exId}:t1`, toolCallId: `${exId}:r1`, name: 'read_file', label: 'Reading files' });
    await sleep(50);
    emit({ type: 'tool_done', executionId: exId, runId: `${exId}:t1`, messageId: `${exId}:t1`, toolCallId: `${exId}:r1`, name: 'read_file', status: 'completed' });
    emit({ type: 'assistant_start', executionId: exId, runId: `${exId}:t2`, messageId: `${exId}:t2` });
    emit({ type: 'assistant_delta', executionId: exId, runId: `${exId}:t2`, messageId: `${exId}:t2`, text: 'The login initializes session tokens.' });
    emit({ type: 'assistant_done', executionId: exId, runId: `${exId}:t2`, messageId: `${exId}:t2`, finalText: 'The login initializes session tokens.', ok: true, progress: true });
    emit({ type: 'mission_end', executionId: exId, runId: exId, messageId: exId, status: 'completed', progressPct: 100 });
  });

  const req = require('module').createRequire(path.join(__dirname, 'package.json'));
  const { chromium } = req('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  try {
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.fill('#loginUser', 'webuidemo');
    await page.fill('#loginPass', 'demo1234');
    await page.locator('button:has-text("Enter workspace")').click();
    await page.waitForSelector('#app:not(.hidden)', { timeout: 20000 });

    const newBtn = page.locator('button:has-text("New conversation")');
    if (await newBtn.count()) await newBtn.first().click();
    await sleep(500);

    const send = async (text) => {
      await page.fill('#chatInput', text);
      await page.press('#chatInput', 'Enter');
    };

    // §1/§2/§3/§4 — first mission.
    await send('first mission please');
    await sleep(1600);
    assert.strictEqual(await page.locator('.message.update').count(), 0, '§1: zero generic update messages');
    console.log('1.  full mission produces ZERO generic update messages      ok');

    const bodyText = await page.locator('#messages').innerText();
    assert.ok(!/<tool_call|<arg_key|<arg_value/.test(bodyText), '§2: no protocol markup in the chat DOM');
    console.log('2.  no tool protocol markup ever reaches the chat DOM       ok');

    assert.ok(await page.locator('.exec-card-message').count() >= 1, '§3: execution card mounted');
    const firstId = await page.locator('.exec-card-message').first().getAttribute('id');
    assert.ok(/^execution-card-/.test(firstId || ''), '§3: card id is execution-card-<id>');
    assert.ok(await page.locator('.exec-card-message .exec-tool-row').count() >= 2, '§3: both tool rows rendered');
    console.log('3.  execution card mounted with its own id + tool rows      ok');

    assert.ok(await page.locator('.message.assistant').count() >= 1, '§4: real assistant message exists');
    const finalText = await page.locator('.message.assistant').last().innerText();
    assert.ok(finalText.includes('session tokens'), '§4: progress folded into a REAL assistant message');
    console.log('4.  progress folds into a real assistant message            ok');

    // §5 — five consecutive turns, five distinct cards.
    for (let i = 0; i < 4; i++) {
      await send(`follow-up mission ${i + 2} please`);
      await sleep(1300);
    }
    const ids = await page.locator('.exec-card-message').evaluateAll((els) => els.map((e) => e.id));
    assert.strictEqual(new Set(ids).size, ids.length, '§5: every card id unique');
    assert.ok(ids.length >= 5, `§5: five consecutive turns -> ${ids.length} cards (no shared div)`);
    console.log(`5.  five turns -> ${ids.length} distinct cards (no div leak) ok`);

    // §6 — PAGE RELOAD: restored history replays the cards + tool rows.
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('#app:not(.hidden)', { timeout: 20000 });
    await sleep(900);
    const restored = await page.locator('.exec-card-message').evaluateAll((els) => els.map((e) => e.id));
    assert.ok(restored.length >= 5, `§6: refresh restores ${restored.length} execution cards`);
    const restoredRows = await page.locator('.exec-card-message .exec-tool-row').count();
    assert.ok(restoredRows >= 2, `§6: refresh replays tool rows (got ${restoredRows})`);
    const restoredText = await page.locator('#messages').innerText();
    assert.ok(!/<tool_call|<arg_key/.test(restoredText), '§6: restored history still sanitized');
    console.log(`6.  refresh restores ${restored.length} cards + ${restoredRows} tool rows ok`);

    assert.strictEqual(errors.length, 0, 'no page errors: ' + errors.join(' | '));
    console.log('webui-e2e: live DOM contract holds (6 gates)');
  } finally {
    await browser.close();
    await channel.stop?.();
    await sleep(200);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});