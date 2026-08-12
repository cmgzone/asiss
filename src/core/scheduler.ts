import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

// Node.js clamps setTimeout delays above this value (2^31-1 ms ~ 24.8 days) to 1 ms,
// which would make far-future jobs fire immediately. Keep every delay under it.
const MAX_TIMEOUT_MS = 2147483647;

export type ScheduledJobType = 'agent_prompt';

export type ScheduledJob = {
  id: string;
  type: ScheduledJobType;
  sessionId: string;
  prompt: string;
  runAt: number;
  intervalMs?: number;
  enabled: boolean;
  createdAt: number;
  lastRunAt?: number;
  runCount: number;
  /** Overlap-guard bookkeeping: how many ticks were skipped because the previous run was still in flight. */
  skippedRuns?: number;
  lastSkippedAt?: number;
  /** Failure bookkeeping (Phase 15 Move 2): last error, count, and when — a
   *  scheduled job that fails is visible and auditable, not swallowed. */
  lastError?: string;
  failureCount?: number;
  lastFailedAt?: number;
};

export class SchedulerManager {
  private filePath: string;
  private jobs: Record<string, ScheduledJob> = {};
  private timers: Map<string, NodeJS.Timeout> = new Map();
  /** Job ids whose onRun is currently executing (overlap guard). */
  private running: Set<string> = new Set();
  private onRun: (job: ScheduledJob) => Promise<void>;

  constructor(onRun: (job: ScheduledJob) => Promise<void>, filename: string = 'scheduler.json') {
    this.filePath = path.join(process.cwd(), filename);
    this.onRun = onRun;
    this.load();
  }

  private load() {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      this.jobs = JSON.parse(raw) || {};
    } catch {
      this.jobs = {};
    }
  }

  private save() {
    try {
      const tmpPath = `${this.filePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(this.jobs, null, 2));
      fs.renameSync(tmpPath, this.filePath);
    } catch (e) {
      console.error('[Scheduler] Failed to save jobs:', e);
    }
  }

  start() {
    for (const job of Object.values(this.jobs)) {
      if (!job.enabled) continue;
      // Never re-arm a job whose previous run is still executing (e.g. when
      // start() is re-entered mid-run): the overlap guard owns in-flight jobs.
      if (this.running.has(job.id)) continue;
      this.scheduleTimer(job);
    }
  }

  list(filter?: { sessionId?: string }) {
    const jobs = Object.values(this.jobs).filter(j => (filter?.sessionId ? j.sessionId === filter.sessionId : true));
    jobs.sort((a, b) => a.runAt - b.runAt);
    return jobs;
  }

  create(params: { sessionId: string; prompt: string; runAt?: number; delayMs?: number; intervalMs?: number }) {
    const now = Date.now();
    const rawRunAt = typeof params.runAt === 'number' ? params.runAt : now + (typeof params.delayMs === 'number' ? params.delayMs : 0);
    // Clamp to the longest timeout Node supports so far-future jobs degrade to
    // a scheduled run instead of firing immediately (setTimeout overflow).
    const runAt = Math.min(Math.max(now + 1, rawRunAt), now + MAX_TIMEOUT_MS);
    if (rawRunAt > runAt) {
      console.warn(`[Scheduler] Job run time was beyond the maximum supported delay (${Math.round(MAX_TIMEOUT_MS / 86400000)} days); clamped to ${new Date(runAt).toISOString()}.`);
    }
    const intervalMs = typeof params.intervalMs === 'number'
      ? Math.min(Math.max(1, Math.floor(params.intervalMs)), MAX_TIMEOUT_MS)
      : undefined;
    const job: ScheduledJob = {
      id: uuidv4(),
      type: 'agent_prompt',
      sessionId: params.sessionId,
      prompt: params.prompt,
      runAt,
      intervalMs,
      enabled: true,
      createdAt: now,
      runCount: 0,
    };
    this.jobs[job.id] = job;
    this.save();
    this.scheduleTimer(job);
    return job;
  }

  cancel(id: string) {
    const job = this.jobs[id];
    if (!job) return false;
    job.enabled = false;
    this.jobs[id] = job;
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
    this.save();
    return true;
  }

  private scheduleTimer(job: ScheduledJob) {
    const existing = this.timers.get(job.id);
    if (existing) {
      clearTimeout(existing);
      this.timers.delete(job.id);
    }
    const delay = Math.max(0, Math.min(job.runAt - Date.now(), MAX_TIMEOUT_MS));
    const t = setTimeout(async () => {
      await this.runJob(job.id);
    }, delay);
    this.timers.set(job.id, t);
  }

  private async runJob(id: string) {
    const job = this.jobs[id];
    if (!job || !job.enabled) return;

    // Overlap guard: a recurring job never starts while its previous run is
    // still in flight. Skip this tick and re-arm so the cadence shifts instead
    // of the job being lost (one-shots have no timer during a run, so this only
    // matters for recurring jobs and start()-re-entry edge paths).
    if (this.running.has(id)) {
      if (typeof job.intervalMs === 'number' && job.intervalMs > 0) {
        job.skippedRuns = (job.skippedRuns || 0) + 1;
        job.lastSkippedAt = Date.now();
        job.runAt = Date.now() + job.intervalMs;
        this.jobs[id] = job;
        this.save();
        this.scheduleTimer(job);
        console.warn(`[Scheduler] Job '${job.id}' still running; skipped this tick (skippedRuns=${job.skippedRuns}).`);
      }
      return;
    }

    this.running.add(id);
    try {
      job.lastRunAt = Date.now();
      job.runCount = (job.runCount || 0) + 1;
      this.jobs[id] = job;
      this.save();

      try {
        await this.onRun(job);
      } catch (err: any) {
        // Phase 15 Move 2: record failures instead of swallowing them — the
        // canonical Task carries the execution evidence; the job record makes
        // the failure visible and auditable.
        job.lastError = err?.message || 'Scheduled job failed';
        job.failureCount = (job.failureCount || 0) + 1;
        job.lastFailedAt = Date.now();
        this.jobs[id] = job;
        this.save();
        console.warn(`[Scheduler] Job '${job.id}' failed (failureCount=${job.failureCount}): ${job.lastError}`);
      }

      const updated = this.jobs[id];
      if (!updated || !updated.enabled) return;

    if (typeof updated.intervalMs === 'number' && updated.intervalMs > 0) {
      updated.runAt = Date.now() + updated.intervalMs;
      this.jobs[id] = updated;
      this.save();
      this.scheduleTimer(updated);
      return;
    }

    updated.enabled = false;
    this.jobs[id] = updated;
    this.save();
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
    } finally {
      this.running.delete(id);
    }
  }
}

