/**
 * Phase 22 — server-side hardening gates.
 *
 * §1 protocol sanitizer: raw agent-protocol markup (<tool_call>/<arg_key>/
 * <arg_value>) must NEVER survive into conversational text, at any shape —
 * full blocks, multiline, nested, self-closing, stray fragments, narration
 * leftovers — while surrounding prose is preserved verbatim.
 * §2 resilient persistence: the OneDrive EPERM mission-killer is gone.
 * A transient rename failure retries, then falls back to copy+unlink, and a
 * fully persistent lock degrades to warn-only (never a throw) with a deferred
 * retry — a mission's state save can never abort the mission again.
 *
 * Run: npm run smoke:phase22 (also part of the battery).
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { sanitizeConversationalText, containsProtocolMarkup } from '../src/core/protocol-sanitizer';
import { atomicWriteJsonSync } from '../src/core/atomic-write';

const REAL_RENAME = fs.renameSync;
const REAL_COPY = fs.copyFileSync;

function withPatchedRename(fn: () => void, behavior: (err: NodeJS.ErrnoException | null, src: string, dest: string) => boolean) {
  fs.renameSync = ((src: string, dest: string, cb?: any) => {
    if (behavior(null, src, dest)) return REAL_RENAME.call(fs, src, dest);
    const err = Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    if (typeof cb === 'function') return cb(err);
    throw err;
  }) as typeof fs.renameSync;
  try { fn(); } finally { fs.renameSync = REAL_RENAME; }
}

function main() {
  // §1 — sanitizer contract.
  const block = 'Working on it...\n<tool_call>read_file<arg_key>path</arg_key><arg_value>src/a.ts</arg_value></tool_call>\nDone.';
  const cleaned = sanitizeConversationalText(block);
  assert.ok(!/tool_call|arg_key|arg_value/.test(cleaned), 'whole tool_call block removed');
  assert.ok(cleaned.includes('Working on it...') && cleaned.includes('Done.'), 'prose preserved around the block');
  console.log('1.  full <tool_call> block stripped, prose preserved       ok');

  const multiline = '<tool_call>patch\n<arg_key>path</arg_key>\n<arg_value>\nline1\nline2\n</arg_value>\n</tool_call>\nAfter.';
  const multiCleaned = sanitizeConversationalText(multiline);
  assert.ok(!/tool_call|arg_key|arg_value/.test(multiCleaned), 'multiline block removed');
  assert.ok(multiCleaned.includes('After.'), 'prose after multiline block preserved');
  console.log('2.  multiline nested blocks removed                        ok');

  const stray = sanitizeConversationalText('stray <tool_call> then <arg_key>k</arg_key> and </tool_call> and <tool_call self_close="1"/> bits');
  assert.ok(!/tool_call|arg_key|arg_value/.test(stray), 'stray + self-closing fragments removed');
  assert.ok(stray.includes('stray') && stray.includes('bits'), 'prose around stray fragments preserved');
  console.log('3.  stray / self-closing fragments removed                 ok');

  const doublePass = sanitizeConversationalText('<tool_call><tool_call>a<arg_key>b</arg_key></tool_call></tool_call> tail');
  assert.ok(!/tool_call|arg_key|arg_value/.test(doublePass), 'nested tool_call pair fully removed');
  assert.ok(doublePass.includes('tail'), 'tail preserved after nesting');
  console.log('4.  nested / interleaved markup cannot survive             ok');

  const noMarkup = sanitizeConversationalText('Normal message with <b>markdown</b> and code: const x = 1;');
  assert.ok(noMarkup.includes('<b>markdown</b>'), 'legit markdown untouched');
  assert.ok(noMarkup.includes('const x = 1;'), 'code untouched');
  console.log('5.  legitimate markdown / code never damaged               ok');

  const empty = sanitizeConversationalText('');
  assert.strictEqual(empty, '', 'empty input -> empty output');
  const nonString = sanitizeConversationalText(null);
  assert.strictEqual(nonString, '', 'null input -> empty output (never throws)');
  console.log('6.  empty/null inputs handled without throwing             ok');

  assert.ok(containsProtocolMarkup('<tool_call>x</tool_call>'), 'detector catches blocks');
  assert.ok(containsProtocolMarkup('a<arg_key>b</arg_key>'), 'detector catches arg tags');
  assert.ok(!containsProtocolMarkup('plain text'), 'detector ignores clean text');
  console.log('7.  protocol markup detector (containsProtocolMarkup)      ok');

  const narration = sanitizeConversationalText('Tool call: read_file\nI read the file.\nUsing tool shell');
  assert.ok(!/Tool call: read_file/.test(narration), 'tool narration line dropped');
  assert.ok(narration.includes('I read the file.'), 'real prose kept alongside narration');
  console.log('8.  "Tool call: X" narration lines dropped                 ok');

  // §2 — resilient persistence contract.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitu-phase22-'));
  const file = path.join(dir, 'nested', 'tasks.json');
  const data = { tasks: [{ id: 't1', status: 'running' }] };

  atomicWriteJsonSync(file, data);
  assert.ok(fs.existsSync(file), 'normal write produces the file');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), JSON.stringify(data, null, 2), 'content round-trips');
  assert.ok(!fs.existsSync(`${file}.tmp`), 'no tmp residue after a clean write');
  console.log('9.  normal atomic write round-trips, no tmp residue       ok');

  let retries = 0;
  withPatchedRename(() => {
    atomicWriteJsonSync(file, { tasks: [{ id: 't1', status: 'completed' }] });
  }, () => {
    // Simulate a OneDrive transient lock: fail twice, then let it through.
    retries++;
    return retries > 2;
  });
  assert.ok(retries >= 3, `rename retried under transient EPERM (attempts=${retries})`);
  const afterRetry = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(afterRetry.tasks[0].status, 'completed', 'write landed via retry');
  assert.ok(!fs.existsSync(`${file}.tmp`), 'no tmp residue after retried write');
  console.log('10. transient EPERM retried until the lock clears         ok');

  // Persistent lock: rename ALWAYS fails -> copy fallback saves the data.
  fs.renameSync = () => { const err: any = new Error('permission denied'); err.code = 'EPERM'; throw err; };
  try {
    atomicWriteJsonSync(file, { tasks: [{ id: 't1', status: 'failed' }] });
  } finally {
    fs.renameSync = REAL_RENAME;
  }
  const afterFallback = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(afterFallback.tasks[0].status, 'failed', 'copy fallback landed the data');
  console.log('11. persistent EPERM falls back to copy+unlink            ok');

  // Everything locked: rename AND copy fail -> warn, never throw.
  fs.renameSync = () => { const err: any = new Error('permission denied'); err.code = 'EPERM'; throw err; };
  fs.copyFileSync = () => { const err: any = new Error('permission denied'); err.code = 'EPERM'; throw err; };
  let threw = false;
  try {
    atomicWriteJsonSync(file, { tasks: [{ id: 't1', status: 'blocked' }] });
  } catch {
    threw = true;
  } finally {
    fs.renameSync = REAL_RENAME;
    fs.copyFileSync = REAL_COPY;
  }
  assert.ok(!threw, 'full lock degrades to warn, never a throw (mission survives)');
  assert.ok(fs.existsSync(`${file}.tmp`), 'tmp kept for the deferred retry');
  console.log('12. full lock: warn-and-keep-tmp, never throws            ok');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('phase22: sanitizer + persistence hardening contract holds (12 gates)');
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}