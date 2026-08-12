import { Skill } from '../core/skills';
import { SchedulerManager, type ScheduledJob } from '../core/scheduler';

export class SchedulerSkill implements Skill {
  name = 'scheduler';
  description = 'Schedule tasks for later. Actions: create, list, cancel.';
  inputSchema = {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'list', 'cancel'] },
      message: { type: 'string', description: 'Task prompt/message for the agent' },
      delayMs: { type: 'number', description: 'Delay in milliseconds (optional)' },
      runAtIso: { type: 'string', description: 'Run time ISO string (optional)' },
      intervalMs: { type: 'number', description: 'Repeat interval in milliseconds (optional)' },
      id: { type: 'string', description: 'Job id (for cancel)' },
      sessionId: { type: 'string', description: 'Override session id (optional)' }
    },
    required: ['action']
  };

  private scheduler: SchedulerManager;

  constructor(scheduler: SchedulerManager) {
    this.scheduler = scheduler;
  }

  async execute(params: any): Promise<any> {
    const action = String(params?.action || '').trim();
    const sessionId = String(params?.sessionId || params?.__sessionId || '').trim();

    if (action === 'list') {
      const jobs = this.scheduler.list(sessionId ? { sessionId } : undefined);
      return { jobs: jobs.map(job => this.describeJob(job)) };
    }

    if (action === 'cancel') {
      const id = String(params?.id || '').trim();
      if (!id) return { error: 'id is required' };
      const ok = this.scheduler.cancel(id);
      return { success: ok };
    }

    if (action === 'create') {
      if (!sessionId) return { error: 'sessionId is required' };
      const message = String(params?.message || '').trim();
      if (!message) return { error: 'message is required' };
      const delayMs = typeof params?.delayMs === 'number' ? params.delayMs : undefined;
      const intervalMs = typeof params?.intervalMs === 'number' ? params.intervalMs : undefined;
      const runAtIso = typeof params?.runAtIso === 'string' ? params.runAtIso : undefined;
      let runAt: number | undefined;
      if (runAtIso) {
        const t = Date.parse(runAtIso);
        if (!Number.isNaN(t)) runAt = t;
      }
      const job = this.scheduler.create({
        sessionId,
        prompt: message,
        delayMs,
        intervalMs,
        runAt
      });
      return { job };
    }

    return { error: `Unknown action: ${action}` };
  }

  /** Enrich a job with readable overlap-skip info for the list output. */
  private describeJob(job: ScheduledJob) {
    const skipped = job.skippedRuns || 0;
    const lastSkippedAt = job.lastSkippedAt ? new Date(job.lastSkippedAt).toISOString() : undefined;
    return {
      ...job,
      lastSkippedAtLabel: lastSkippedAt,
      overlap: skipped > 0
        ? `Skipped ${skipped} run${skipped === 1 ? '' : 's'} because the previous run was still in flight${lastSkippedAt ? ` (last at ${lastSkippedAt})` : ''}`
        : undefined
    };
  }
}

