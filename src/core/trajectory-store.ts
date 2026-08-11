import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { StreamEventPayload } from './types';

export interface TrajectoryRecord {
  id: string;
  source: 'api' | 'batch' | 'editor' | 'connector';
  userId: string;
  request: { content: string; metadata?: Record<string, unknown> };
  events: StreamEventPayload[];
  response: string;
  status: 'completed' | 'failed';
  error?: string;
  startedAt: number;
  completedAt: number;
  durationMs: number;
}

class TrajectoryStore {
  private readonly root: string;

  constructor() {
    const oneDrive = String(process.env.OneDrive || process.env.ONEDRIVE || '').trim();
    const dataRoot = process.env.GITU_DATA_ROOT || path.join(oneDrive || path.join(os.homedir(), 'Documents'), 'Gitu Data');
    this.root = path.join(dataRoot, 'trajectories');
    fs.mkdirSync(this.root, { recursive: true });
  }

  createId(): string {
    return `traj_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
  }

  save(record: TrajectoryRecord): void {
    const safe = this.sanitize(record);
    const day = new Date(record.startedAt).toISOString().slice(0, 10);
    fs.appendFileSync(path.join(this.root, `${day}.jsonl`), `${JSON.stringify(safe)}\n`, { encoding: 'utf8' });
  }

  list(limit = 50): Array<Omit<TrajectoryRecord, 'events' | 'request'> & { eventCount: number; promptPreview: string }> {
    const files = fs.readdirSync(this.root)
      .filter(name => name.endsWith('.jsonl'))
      .sort()
      .reverse();
    const records: TrajectoryRecord[] = [];
    for (const file of files) {
      const lines = fs.readFileSync(path.join(this.root, file), 'utf8').split(/\r?\n/).filter(Boolean).reverse();
      for (const line of lines) {
        try {
          records.push(JSON.parse(line));
          if (records.length >= Math.max(1, Math.min(limit, 500))) break;
        } catch {
          // Ignore a partially written final line after an interrupted process.
        }
      }
      if (records.length >= limit) break;
    }
    return records.map(({ events, request, ...record }) => ({
      ...record,
      eventCount: Array.isArray(events) ? events.length : 0,
      promptPreview: String(request?.content || '').slice(0, 180)
    }));
  }

  get(id: string): TrajectoryRecord | undefined {
    for (const file of fs.readdirSync(this.root).filter(name => name.endsWith('.jsonl')).sort().reverse()) {
      const lines = fs.readFileSync(path.join(this.root, file), 'utf8').split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        try {
          const record = JSON.parse(line) as TrajectoryRecord;
          if (record.id === id) return record;
        } catch {
          // Ignore malformed historical rows.
        }
      }
    }
    return undefined;
  }

  status() {
    const files = fs.readdirSync(this.root).filter(name => name.endsWith('.jsonl'));
    return { enabled: true, root: this.root, files: files.length };
  }

  private sanitize<T>(value: T): T {
    const serialized = JSON.stringify(value, (_key, item) => {
      if (typeof item !== 'string') return item;
      return item
        .replace(/sk-[A-Za-z0-9_-]{10,}/g, '[REDACTED]')
        .replace(/nvapi-[A-Za-z0-9_-]{10,}/g, '[REDACTED]')
        .replace(/(?:api[_-]?key|token|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
        .slice(0, 100_000);
    });
    return JSON.parse(serialized) as T;
  }
}

export const trajectoryStore = new TrajectoryStore();
