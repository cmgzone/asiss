/**
 * ProjectMemoryStore + ProjectMemoryBridge — Phase 18 Move 4 (G4).
 *
 * Project-scoped repository knowledge: conventions, architecture facts,
 * testing/deployment practices, and known failure patterns — keyed on the
 * workspace root, retained durably, and retrieved through the unified
 * memory layer.
 *
 * Phase 14's canonical MemoryRecord already declares the 'project' type and
 * scope; this is the producer that fills them. The store is the durable
 * content authority for project knowledge (its own JSON under the data
 * root, atomic tmp+rename, mirroring the consolidation overlay); the bridge
 * registers a 'project' provider on the UnifiedMemoryCatalog so the
 * existing weighted retrieval (relevance/recency/importance/confidence/
 * access) scores the records exactly like every other source — one
 * retrieval authority, one new content store.
 */

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { PersistentRepositoryIndex } from '../context/repo-index';
import {
  type MemoryProvider,
  type RetrievedMemory,
  type UnifiedMemoryCatalog,
  relevanceOf
} from './memory-catalog';
import type { MemoryConsolidation } from './memory-consolidation';
import {
  createMemoryRecord,
  memoryRecordId,
  type MemoryConfidence,
  type MemoryImportance,
  type MemoryRecord
} from './memory-record';

export type ProjectKnowledgeKind = 'architecture' | 'convention' | 'practice' | 'failure';
export type ProjectKnowledgeOrigin = 'index' | 'lesson' | 'manual';

/** One durable project-knowledge entry (the store's content authority). */
export interface ProjectKnowledgeEntry {
  /** Native id: '<rootHash>:<kind>:<slug>' — stable across refreshes. */
  id: string;
  workspaceRoot: string;
  kind: ProjectKnowledgeKind;
  title: string;
  content: string;
  origin: ProjectKnowledgeOrigin;
  importance: MemoryImportance;
  confidence: MemoryConfidence;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectCaptureInput {
  workspaceRoot: string;
  kind: ProjectKnowledgeKind;
  title: string;
  content: string;
  origin?: ProjectKnowledgeOrigin;
  importance?: MemoryImportance;
  confidence?: MemoryConfidence;
}

export interface ProjectMemoryStoreOptions {
  dataPath?: string;
}

export interface ProjectMemoryBridgeOptions {
  /** Durable store (a default one is created under the data root). */
  store?: ProjectMemoryStore;
  /** Forwarded to the default store when no store is given. */
  dataPath?: string;
  /** When wired, the 'project' provider registers on this catalog. */
  catalog?: UnifiedMemoryCatalog;
  /** Repositories with fewer files than this get no index-facts entry. Default 3. */
  minFiles?: number;
}

function dataRootDir(): string {
  const oneDrive = String(process.env.OneDrive || process.env.ONEDRIVE || '').trim();
  return process.env.GITU_DATA_ROOT || path.join(oneDrive || path.join(os.homedir(), 'Documents'), 'Gitu Data');
}

function rootHash(root: string): string {
  return crypto.createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 12);
}

function slugify(text: string): string {
  return (
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'entry'
  );
}

function projectEntryId(workspaceRoot: string, kind: ProjectKnowledgeKind, title: string): string {
  return `${rootHash(workspaceRoot)}:${kind}:${slugify(title)}`;
}

/** Durable, workspace-keyed content store for project knowledge. */
export class ProjectMemoryStore {
  private readonly entries = new Map<string, ProjectKnowledgeEntry>();
  private readonly dataPath: string;

  constructor(options: ProjectMemoryStoreOptions = {}) {
    this.dataPath = options.dataPath || path.join(dataRootDir(), 'memory', 'project-memory.json');
    this.load();
  }

  list(workspaceRoot?: string): ProjectKnowledgeEntry[] {
    const out = [...this.entries.values()];
    if (workspaceRoot) {
      const resolved = path.resolve(workspaceRoot);
      return out.filter((e) => path.resolve(e.workspaceRoot) === resolved);
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): ProjectKnowledgeEntry | undefined {
    return this.entries.get(id);
  }

  /** Insert or replace; persists only when the entry actually changed. */
  upsert(entry: ProjectKnowledgeEntry): void {
    const existing = this.entries.get(entry.id);
    if (
      existing &&
      existing.content === entry.content &&
      existing.importance === entry.importance &&
      existing.confidence === entry.confidence &&
      existing.title === entry.title
    ) {
      return; // unchanged — no disk write (index-facts refresh stays quiet)
    }
    this.entries.set(entry.id, entry);
    this.save();
  }

  remove(id: string): void {
    if (!this.entries.delete(id)) return;
    this.save();
  }

  save(): void {
    try {
      fs.mkdirSync(path.dirname(this.dataPath), { recursive: true });
      const payload = JSON.stringify({ entries: [...this.entries.values()] }, null, 2);
      const tmp = `${this.dataPath}.tmp`;
      fs.writeFileSync(tmp, payload);
      fs.renameSync(tmp, this.dataPath);
    } catch (err: any) {
      console.warn('[ProjectMemoryStore] save failed:', err?.message || err);
    }
  }

  private load(): void {
    if (!fs.existsSync(this.dataPath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.dataPath, 'utf-8'));
      const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
      for (const raw of entries) {
        if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') continue;
        this.entries.set(raw.id, raw as ProjectKnowledgeEntry);
      }
    } catch (err: any) {
      console.warn('[ProjectMemoryStore] load failed:', err?.message || err);
    }
  }
}

/** Compact, stable summary of the repository index for one workspace root. */
function summarizeIndexFacts(index: PersistentRepositoryIndex): string {
  const languages = Object.entries(index.languages)
    .filter(([ext]) => ext !== '')
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([ext, count]) => `${ext.slice(1) || 'text'} (${count})`)
    .join(', ');
  const testFiles = index.files.filter((f) => f.isTest).length;
  const configFiles = index.files.filter((f) => f.isConfig).length;
  const symbols = index.files.reduce((n, f) => n + f.symbols.length, 0);
  const lines = [
    `Workspace: ${index.root}`,
    `${index.fileCount} files, ${(index.totalBytes / 1024).toFixed(0)} KB, ${symbols} indexed symbols`,
    languages ? `Languages: ${languages}` : 'No source languages detected',
    `Tests: ${testFiles} test file(s)`,
    `Config: ${configFiles} config file(s)`
  ];
  return lines.join('\n');
}

/**
 * The producer + retrieval bridge. Registers the 'project' provider on the
 * catalog (or reads through it / the consolidation layer), captures durable
 * index facts (idempotent per root — refresh never grows the store), and
 * exposes a generic capture for conventions / practices / failure patterns.
 */
export class ProjectMemoryBridge {
  readonly store: ProjectMemoryStore;
  private readonly catalog?: UnifiedMemoryCatalog;
  private readonly minFiles: number;

  constructor(options: ProjectMemoryBridgeOptions = {}) {
    this.store = options.store || new ProjectMemoryStore({ dataPath: options.dataPath });
    this.catalog = options.catalog;
    this.minFiles = options.minFiles ?? 3;
    this.catalog?.register(this.provider());
  }

  /** The 'project' MemoryProvider for the unified catalog. */
  provider(): MemoryProvider {
    const self = this;
    return {
      id: 'project',
      name: 'project',
      records: () => self.store.list().map((e) => self.toRecord(e)),
      search(query, limit) {
        const tokens = String(query || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
        if (tokens.length === 0) return [];
        const hits = self.store
          .list()
          .filter((e) => {
            const hay = `${e.title} ${e.content} ${e.kind}`.toLowerCase();
            return tokens.every((t) => hay.includes(t));
          })
          .slice(0, limit);
        return hits.map((e) => self.toRecord(e));
      }
    };
  }

  /**
   * Capture durable architecture facts from the repository index (Phase 18
   * Move 4, G4): languages, tests, config files, scale — one entry per
   * workspace root, upserted so warm refreshes never accumulate. No-op for
   * lightweight indexes or repositories under `minFiles`.
   */
  captureIndexFacts(index: PersistentRepositoryIndex | undefined): ProjectKnowledgeEntry | undefined {
    if (!index || (index as any).version === undefined) return undefined;
    if (index.fileCount < this.minFiles) return undefined;
    return this.capture({
      workspaceRoot: index.root,
      kind: 'architecture',
      title: 'Repository facts',
      content: summarizeIndexFacts(index),
      origin: 'index',
      importance: 3,
      confidence: 0.9
    });
  }

  /**
   * Generic capture for project knowledge (conventions, practices, failure
   * patterns, lesson-derived rules). Upserts by
   * '<rootHash>:<kind>:<slug(title)>' — idempotent, no write when unchanged.
   */
  capture(input: ProjectCaptureInput): ProjectKnowledgeEntry {
    const now = Date.now();
    const id = projectEntryId(input.workspaceRoot, input.kind, input.title);
    const existing = this.store.get(id);
    const entry: ProjectKnowledgeEntry = {
      id,
      workspaceRoot: input.workspaceRoot,
      kind: input.kind,
      title: String(input.title || '').trim() || 'Project knowledge',
      content: String(input.content || '').trim(),
      origin: input.origin ?? 'manual',
      importance: input.importance ?? 3,
      confidence: input.confidence ?? 0.7,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    this.store.upsert(entry);
    return entry;
  }

  /**
   * Retrieval through the unified layer: the consolidation layer when given
   * (dedupe/merge + lifecycle applied, archived/expired excluded), else the
   * catalog's weighted scorer — filtered to 'project' records for this
   * workspace root. Empty when no unified layer is wired.
   */
  retrieve(
    workspaceRoot: string,
    query: string,
    options: { layer?: MemoryConsolidation; limit?: number } = {}
  ): RetrievedMemory[] {
    const limit = Math.max(1, Math.floor(options.limit ?? 5));
    const layer: any = options.layer ?? this.catalog;
    if (!layer || typeof layer.retrieve !== 'function') return [];
    const hits = layer.retrieve(query, { source: 'project', types: ['project'], limit: limit * 2 });
    const resolved = path.resolve(workspaceRoot);
    return hits
      .filter((r: RetrievedMemory) => r.metadata?.workspaceRoot && path.resolve(String(r.metadata.workspaceRoot)) === resolved)
      .slice(0, limit);
  }

  /** Lexical relevance of a query to a project entry (smoke-observable). */
  relevance(query: string, entry: ProjectKnowledgeEntry): number {
    return relevanceOf(query, `${entry.title}\n${entry.content}`);
  }

  private toRecord(entry: ProjectKnowledgeEntry): MemoryRecord {
    return createMemoryRecord({
      id: memoryRecordId('project', entry.id),
      type: 'project',
      content: `${entry.title}\n${entry.content}`,
      source: 'project',
      scope: 'project',
      importance: entry.importance,
      confidence: entry.confidence,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      metadata: {
        workspaceRoot: entry.workspaceRoot,
        kind: entry.kind,
        origin: entry.origin,
        title: entry.title
      }
    });
  }
}
