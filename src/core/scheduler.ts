import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

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
};

export class SchedulerManager {
  private filePath: string;
  private jobs: Record<string, ScheduledJob> = {};
  private timers: Map<string, NodeJS.Timeout> = new Map();
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
      fs.writeFileSync(this.filePath, JSON.stringify(this.jobs, null, 2));
    } catch {
    }
  }

  start() {
    for (const job of Object.values(this.jobs)) {
      if (!job.enabled) continue;
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
    const runAt = typeof params.runAt === 'number' ? params.runAt : now + (typeof params.delayMs === 'number' ? params.delayMs : 0);
    const job: ScheduledJob = {
      id: uuidv4(),
      type: 'agent_prompt',
      sessionId: params.sessionId,
      prompt: params.prompt,
      runAt: Math.max(now + 1, runAt),
      intervalMs: typeof params.intervalMs === 'number' ? params.intervalMs : undefined,
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
    const delay = Math.max(0, job.runAt - Date.now());
    const t = setTimeout(async () => {
      await this.runJob(job.id);
    }, delay);
    this.timers.set(job.id, t);
  }

  private async runJob(id: string) {
    const job = this.jobs[id];
    if (!job || !job.enabled) return;
    job.lastRunAt = Date.now();
    job.runCount = (job.runCount || 0) + 1;
    this.jobs[id] = job;
    this.save();

    try {
      await this.onRun(job);
    } catch {
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
  }
}

