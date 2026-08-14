/**
 * TaskStore — Hermes Evolution Phase 1.
 *
 * In-memory store with optional JSON-file persistence. Keeps simple indexes
 * (by status / parent / root) so the engine and future schedulers can query
 * efficiently. Persistence follows the same data-root convention as the other
 * core managers (GITU_DATA_ROOT or ~/Documents/Gitu Data).
 *
 * The store is deliberately dumb: it stores and retrieves plain Task records.
 * All lifecycle logic lives in the Task model (task.ts) and TaskEngine
 * (task-engine.ts).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { Task, TaskStatus } from './task-types';
import { atomicWriteJsonSync } from '../atomic-write';

export interface TaskStoreOptions {
  /** JSON file path for persistence. Omit (or pass '') for a memory-only store. */
  filePath?: string;
  /** Persist on every mutation. Default true. */
  autoSave?: boolean;
}

export function defaultTaskStorePath(): string {
  const oneDrive = String(process.env.OneDrive || process.env.ONEDRIVE || '').trim();
  const dataRoot = process.env.GITU_DATA_ROOT || path.join(oneDrive || path.join(os.homedir(), 'Documents'), 'Gitu Data');
  return path.join(dataRoot, 'tasks', 'tasks.json');
}

export class TaskStore {
  private tasks = new Map<string, Task>();
  private byParent = new Map<string, Set<string>>();
  private byRoot = new Map<string, Set<string>>();
  private byStatus = new Map<TaskStatus, Set<string>>();
  private readonly filePath: string | undefined;
  private readonly autoSave: boolean;

  constructor(options: TaskStoreOptions = {}) {
    this.filePath = options.filePath || undefined;
    this.autoSave = options.autoSave !== false;
    if (this.filePath && fs.existsSync(this.filePath)) {
      this.load();
    }
  }

  /** Insert a task. The id must be unique; indexes are maintained. */
  create(task: Task): Task {
    if (this.tasks.has(task.id)) {
      throw new Error(`Task ${task.id} already exists in the store.`);
    }
    this.tasks.set(task.id, task);
    this.index(task);
    this.persist();
    return task;
  }

  /** Apply a partial update; bumps the version counter and persists. */
  update(id: string, patch: Partial<Task>): Task {
    const current = this.require(id);
    const before = current.status;
    const updated: Task = { ...current, ...patch, version: current.version + 1 };
    this.tasks.set(id, updated);
    if (updated.status !== before) {
      this.byStatus.get(before)?.delete(id);
      this.index(updated);
    }
    this.persist();
    return updated;
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  require(id: string): Task {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task ${id} not found.`);
    return task;
  }

  /** All tasks, newest first. */
  list(): Task[] {
    return Array.from(this.tasks.values()).sort((a, b) => b.timing.createdAt - a.timing.createdAt);
  }

  listByStatus(status: TaskStatus): Task[] {
    const ids = this.byStatus.get(status);
    if (!ids) return [];
    return Array.from(ids)
      .map((id) => this.tasks.get(id))
      .filter((task): task is Task => Boolean(task));
  }

  listByParent(parentId: string): Task[] {
    const ids = this.byParent.get(parentId);
    if (!ids) return [];
    return Array.from(ids)
      .map((id) => this.tasks.get(id))
      .filter((task): task is Task => Boolean(task));
  }

  listByRoot(rootId: string): Task[] {
    const ids = this.byRoot.get(rootId);
    if (!ids) return [];
    return Array.from(ids)
      .map((id) => this.tasks.get(id))
      .filter((task): task is Task => Boolean(task));
  }

  delete(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    this.tasks.delete(id);
    this.byParent.get(task.parentId || '')?.delete(id);
    this.byRoot.get(task.rootId)?.delete(id);
    this.byStatus.get(task.status)?.delete(id);
    this.persist();
    return true;
  }

  clear(): void {
    this.tasks.clear();
    this.byParent.clear();
    this.byRoot.clear();
    this.byStatus.clear();
    this.persist();
  }

  get size(): number {
    return this.tasks.size;
  }

  status() {
    return {
      size: this.tasks.size,
      byStatus: Array.from(this.byStatus.entries()).map(([status, ids]) => ({ status, count: ids.size })),
      filePath: this.filePath || null
    };
  }

  // ------------------------------------------------------------------ persistence

  save(): void {
    if (!this.filePath) return;
    // Phase 22 — resilient atomic write: transient file locks (OneDrive sync
    // holding the target open, EPERM on rename) must never abort the mission.
    // See src/core/atomic-write.ts for the retry/fallback contract.
    atomicWriteJsonSync(this.filePath, { tasks: this.list() });
  }

  load(): void {
    if (!this.filePath || !fs.existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      const tasks: Task[] = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
      for (const task of tasks) {
        if (!task || typeof task.id !== 'string') continue;
        this.tasks.set(task.id, task);
        this.index(task);
      }
    } catch (error) {
      console.warn('[TaskStore] Failed to load tasks file, starting empty:', error);
    }
  }

  private persist(): void {
    if (this.autoSave) this.save();
  }

  private index(task: Task): void {
    if (task.parentId) {
      const siblings = this.byParent.get(task.parentId) || new Set<string>();
      siblings.add(task.id);
      this.byParent.set(task.parentId, siblings);
    }
    const rootIds = this.byRoot.get(task.rootId) || new Set<string>();
    rootIds.add(task.id);
    this.byRoot.set(task.rootId, rootIds);
    const statusIds = this.byStatus.get(task.status) || new Set<string>();
    statusIds.add(task.id);
    this.byStatus.set(task.status, statusIds);
  }
}

/** Default process-wide store, persisted to the standard data root. */
export const taskStore = new TaskStore({ filePath: defaultTaskStorePath() });
