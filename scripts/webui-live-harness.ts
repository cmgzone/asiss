/**
 * Dev harness — boots the REAL WebChannel server with fully isolated state
 * and drives the served page with synthetic mission events THROUGH THE SAME
 * handler path the real agent runner uses (socket 'message' → onMessage →
 * sendStreamEvent → scoped room → browser). Purpose: visually verify the
 * per-execution chat cards end to end (two missions, two cards, independent).
 *
 * Isolation: users.json + background_*.json live under a temp cwd,
 * conversations under GITU_DATA_ROOT (also temp). Nothing in the repo is
 * created or modified. The public dir + marked vendor resolve via __dirname,
 * so the REAL frontend is served.
 *
 * Run:   npx ts-node scripts/webui-live-harness.ts
 * Then:  open http://localhost:3110 · login webuidemo / demo1234
 *        click "New conversation", send a message → mission 1 plays;
 *        send another message → mission 2 plays (its own execution card).
 */
import os from 'os';
import path from 'path';
import fs from 'fs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitu-webui-'));
process.chdir(tmp);
process.env.GITU_DATA_ROOT = path.join(tmp, 'gitu-data');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { WebChannel } = await import('../src/channels/web/server');
  const PORT = Number(process.env.WEBUI_PORT || 3110);
  const channel = new WebChannel(PORT) as any;
  const auth = channel.auth as { register: (u: string, p: string) => boolean };
  auth.register('webuidemo', 'demo1234');

  let missionNo = 0;
  channel.onMessage(async (msg: any) => {
    const content = String(msg?.content || msg?.text || '').trim();
    if (!content) return; // stop/approval/system messages never start a mission here
    const senderId = msg.senderId;
    missionNo += 1;
    const exId = `exec-demo-${missionNo}`;
    const turn1 = `${exId}:t1`;
    const turn2 = `${exId}:t2`;
    console.log(`[harness] mission ${missionNo} "${content.slice(0, 48)}" → ${senderId}`);
    const emit = (ev: any) => channel.sendStreamEvent(senderId, ev);

    // mission + progress narration (folds into the owning message's work label)
    emit({ type: 'mission_start', executionId: exId, runId: exId, messageId: exId, progressPct: 0 });
    await sleep(260);
    emit({ type: 'assistant_update', executionId: exId, runId: turn1, messageId: `${exId}:progress`, text: missionNo === 1 ? 'Analyzing the repository structure…' : 'Checking the failing test…', progressPct: 10 });
    await sleep(260);

    // turn 1: a short progress stream that ends in tool calls (progress bubble)
    emit({ type: 'assistant_start', executionId: exId, runId: turn1, messageId: turn1 });
    emit({ type: 'assistant_delta', executionId: exId, runId: turn1, messageId: turn1, text: 'I’ll trace how the login flow initializes…' });
    await sleep(220);
    emit({ type: 'assistant_done', executionId: exId, runId: turn1, messageId: turn1, finalText: 'I’ll trace how the login flow initializes.', ok: true, progress: true });
    await sleep(180);

    // tools — mission 2 re-uses read_file twice to prove toolCallId identity
    const tools = missionNo === 1
      ? [
          { id: `${exId}:call-1`, name: 'search', label: 'Searching repository' },
          { id: `${exId}:call-2`, name: 'read_file', label: 'Reading files' },
          { id: `${exId}:call-3`, name: 'shell', label: 'Running tests' }
        ]
      : [
          { id: `${exId}:call-1`, name: 'read_file', label: 'Reading files' },
          { id: `${exId}:call-2`, name: 'read_file', label: 'Reading files' },
          { id: `${exId}:call-3`, name: 'patch', label: 'Applying changes' }
        ];
    for (let i = 0; i < tools.length; i++) {
      const t = tools[i];
      emit({ type: 'tool_start', executionId: exId, runId: turn1, messageId: `${turn1}:tool:0:${i}`, toolCallId: t.id, name: t.name, label: t.label, progressPct: 15 + i * 20 });
      await sleep(620);
      if (t.name === 'shell') {
        emit({ type: 'tool_delta', executionId: exId, runId: turn1, messageId: turn1, toolCallId: t.id, name: t.name, output: '$ npm test\nPASS auth.spec.ts (12)\n', progressPct: 72 });
        await sleep(240);
      }
      const output = t.name === 'read_file' ? 'Token validated before request context initialized.' : t.name === 'search' ? 'Found src/auth.ts + src/middleware.ts' : t.name === 'patch' ? '3 files changed · +24 / −9 lines' : '12 passing · 0 failing';
      emit({ type: 'tool_done', executionId: exId, runId: turn1, messageId: turn1, toolCallId: t.id, name: t.name, status: 'completed', output, progressPct: 82 });
      await sleep(320);
    }

    // final response turn (streams into its own assistant message)
    const answer = missionNo === 1
      ? 'I found the issue. The middleware validates the token **before** the request context is initialized, so the handler never sees the authenticated user. I’ll fix the initialization order.'
      : 'I applied the fix and the suite is green. The request context is now initialized **before** token validation, and the handler receives the authenticated user.';
    emit({ type: 'assistant_start', executionId: exId, runId: turn2, messageId: turn2 });
    for (let i = 0; i < answer.length; i += 16) {
      emit({ type: 'assistant_delta', executionId: exId, runId: turn2, messageId: turn2, text: answer.slice(i, i + 16) });
      await sleep(70);
    }
    emit({ type: 'assistant_done', executionId: exId, runId: turn2, messageId: turn2, finalText: answer, ok: true });
    await sleep(160);
    emit({ type: 'mission_end', executionId: exId, runId: exId, messageId: exId, status: 'completed', progressPct: 100 });
    console.log(`[harness] mission ${missionNo} complete (${exId})`);
  });

  channel.start();
  console.log(`[harness] http://localhost:${PORT}`);
  console.log(`[harness] login: webuidemo / demo1234 · isolated state in ${tmp}`);
  // keep alive
  setInterval(() => {}, 1 << 30);
}

main().catch((e) => {
  console.error('[harness] failed:', e);
  process.exit(1);
});
