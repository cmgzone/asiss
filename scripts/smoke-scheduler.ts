/**
 * Scheduler overlap guard smoke — Phase 13 Step 9.3.
 *
 * Proves a recurring scheduled job never starts a new run while its previous
 * run is still in flight:
 *
 *   1. A gated onRun holds the first run open.
 *   2. A re-entrant runJob tick is skipped (skippedRuns bumps, runCount stays
 *      1, the timer is re-armed for the next interval).
 *   3. After the run completes the job still reschedules and runs again
 *      (the guard does not stick).
 *   4. One-shot jobs are unaffected and disable themselves.
 *   5. skippedRuns persists to scheduler.json.
 *   6. The scheduler skill's list output surfaces skippedRuns, a readable
 *      lastSkippedAtLabel, and an overlap summary.
 *
 * Run: npm run smoke:scheduler
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitu-scheduler-'));
  process.chdir(tempDir);

  const { SchedulerManager } = await import('../src/core/scheduler');

  const runs: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });

  const scheduler = new SchedulerManager(async (job) => {
    runs.push(job.id);
    await gate;
  });

  // ------------------------------------------------------------ 1. guard
  // Long interval so the create()-armed real timer cannot interfere with the
  // deterministic re-entry below.
  const job = scheduler.create({ sessionId: 's1', prompt: 'recurring', intervalMs: 60000, delayMs: 60000 });
  const firstRun = (scheduler as any).runJob(job.id);
  await sleep(20);
  assert.strictEqual(job.runCount, 1, 'first run started');
  assert.strictEqual(runs.length, 1, 'onRun called exactly once');

  // Re-entrant tick while the first run is still in flight → skipped.
  await (scheduler as any).runJob(job.id);
  assert.strictEqual(job.runCount, 1, 'no second run while in flight');
  assert.strictEqual(job.skippedRuns, 1, 'guard recorded the skipped tick');
  assert.ok(typeof job.lastSkippedAt === 'number', 'guard recorded when it skipped');
  assert.ok(job.runAt > Date.now(), 'timer re-armed for the next interval');

  // start() re-entry while in flight must not start a second run either.
  scheduler.start();
  await sleep(20);
  assert.strictEqual(job.runCount, 1, 'no overlap after start() re-entry');

  // ------------------------------------------------------------ 2. completion
  release();
  await firstRun;
  assert.strictEqual(job.runCount, 1, 'run count unchanged after completion');
  assert.strictEqual(job.enabled, true, 'recurring job stays enabled');
  assert.ok(job.runAt > Date.now(), 'recurring job rescheduled after completion');

  // The next tick (simulated deterministically) runs normally now that the
  // guard is clear — the skip never sticks.
  await (scheduler as any).runJob(job.id);
  assert.strictEqual(job.runCount, 2, 'next tick ran after the previous completed');
  assert.strictEqual(runs.length, 2, 'onRun called for the second run');
  assert.strictEqual(job.skippedRuns, 1, 'guard counter did not change on a clean run');

  assert.strictEqual(scheduler.cancel(job.id), true, 'cancel works');
  assert.strictEqual(job.enabled, false, 'cancelled job disabled');

  // ------------------------------------------------------------ 3. one-shot
  const once = scheduler.create({ sessionId: 's1', prompt: 'once', delayMs: 60000 });
  await (scheduler as any).runJob(once.id);
  assert.strictEqual(once.runCount, 1, 'one-shot ran');
  assert.strictEqual(once.enabled, false, 'one-shot disabled itself');
  assert.strictEqual(once.skippedRuns, undefined, 'no guard involvement for one-shots');
  scheduler.cancel(once.id);

  // ------------------------------------------------------------ 4. persistence
  const raw = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'scheduler.json'), 'utf-8'));
  assert.strictEqual(raw[job.id].skippedRuns, 1, 'skippedRuns persisted');

  // ------------------------------------------------------------ 5. skill list surface
  const { SchedulerSkill } = await import('../src/skills/scheduler');
  const skill = new SchedulerSkill(scheduler);
  const listed = await skill.execute({ action: 'list', sessionId: 's1' });
  const listedJob = (listed.jobs as any[]).find((j: any) => j.id === job.id);
  assert.ok(listedJob, 'job listed');
  assert.strictEqual(listedJob.skippedRuns, 1, 'skippedRuns surfaced in skill list');
  assert.ok(listedJob.lastSkippedAtLabel, 'lastSkippedAtLabel surfaced in skill list');
  assert.ok(String(listedJob.overlap).includes('Skipped 1 run'), 'overlap summary surfaced in skill list');

  // ------------------------------------------------------------ 6. failure recording
  // Phase 15 Move 2: a throwing onRun is recorded on the job (failureCount /
  // lastError / lastFailedAt) instead of being swallowed — scheduled failures
  // are visible and auditable, and one-shots still disable themselves.
  const failing = new SchedulerManager(async () => {
    throw new Error('boom: scheduled job failed');
  });
  const flaky = failing.create({ sessionId: 's1', prompt: 'flaky', delayMs: 60000 });
  await (failing as any).runJob(flaky.id);
  assert.strictEqual(flaky.failureCount, 1, 'job failure counted');
  assert.ok(String(flaky.lastError).includes('boom'), 'job failure error recorded');
  assert.ok(typeof flaky.lastFailedAt === 'number', 'job failure timestamp recorded');
  assert.strictEqual(flaky.enabled, false, 'failed one-shot disables itself');
  const flakyRaw = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'scheduler.json'), 'utf-8'));
  assert.strictEqual(flakyRaw[flaky.id].failureCount, 1, 'job failure persisted');

  console.log('\n{"success":true}');
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
