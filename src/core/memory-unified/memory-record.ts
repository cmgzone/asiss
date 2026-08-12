/**
 * Canonical MemoryRecord — Phase 14 Move 1 (docs/hermes/MEMORY_AUDIT.md).
 *
 * One record shape for every memory surface (conversation, learning, tasks).
 * Wrap-first: existing stores stay authoritative; this model only projects a
 * canonical view and carries the fields the unified retrieval scorer needs.
 * It creates NO new storage authority.
 */

export type MemoryType = 'working' | 'episodic' | 'semantic' | 'procedural' | 'project' | 'task';
export type MemorySource = 'conversation' | 'learning' | 'task' | 'user' | 'agent' | 'checkpoint' | 'project';
export type MemoryScope = 'global' | 'project' | 'session' | 'task' | 'agent';
export type MemoryImportance = 0 | 1 | 2 | 3 | 4 | 5;
export type MemoryConfidence = number;
export type MemoryLifecycle = 'candidate' | 'active' | 'archived' | 'expired';

export interface MemoryRelation {
  type: 'reference' | 'cause' | 'derived-from' | 'related';
  targetId: string;
}

/** The full Phase 14.1 field set. */
export interface MemoryRecord {
  /** Stable across restarts: '<source>:<nativeId>'. */
  id: string;
  type: MemoryType;
  content: string;
  source: MemorySource;
  scope: MemoryScope;
  /** 0-5, low -> critical. */
  importance: MemoryImportance;
  /** 0..1. */
  confidence: MemoryConfidence;
  lifecycle: MemoryLifecycle;
  createdAt: number;
  updatedAt: number;
  accessCount: number;
  lastAccessedAt?: number;
  relations: MemoryRelation[];
  metadata?: Record<string, unknown>;
  /** Semantic similarity to the last query — set by retrieval when the
   *  source store already computed one (e.g. MemoryManager.semanticSearch). */
  semanticScore?: number;
}

export interface MemoryRecordInput {
  id: string;
  type: MemoryType;
  content: string;
  source: MemorySource;
  scope: MemoryScope;
  importance?: MemoryImportance;
  confidence?: MemoryConfidence;
  lifecycle?: MemoryLifecycle;
  createdAt?: number;
  updatedAt?: number;
  accessCount?: number;
  lastAccessedAt?: number;
  relations?: MemoryRelation[];
  metadata?: Record<string, unknown>;
  semanticScore?: number;
}

/** Canonical id: '<source>:<nativeId>' — dedupe-safe across providers. */
export function memoryRecordId(source: MemorySource, nativeId: string): string {
  return `${source}:${nativeId}`;
}

export function createMemoryRecord(input: MemoryRecordInput): MemoryRecord {
  const now = Date.now();
  return {
    id: input.id,
    type: input.type,
    content: String(input.content || '').trim(),
    source: input.source,
    scope: input.scope,
    importance: input.importance ?? 2,
    confidence: input.confidence ?? 0.5,
    lifecycle: input.lifecycle ?? 'active',
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? input.createdAt ?? now,
    accessCount: input.accessCount ?? 0,
    lastAccessedAt: input.lastAccessedAt,
    relations: input.relations ?? [],
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    ...(input.semanticScore !== undefined ? { semanticScore: input.semanticScore } : {})
  };
}

export function recordSessionId(record: MemoryRecord): string | undefined {
  const value = record.metadata?.sessionId;
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function recordTaskId(record: MemoryRecord): string | undefined {
  const value = record.metadata?.taskId;
  return typeof value === 'string' && value.trim() ? value : undefined;
}
