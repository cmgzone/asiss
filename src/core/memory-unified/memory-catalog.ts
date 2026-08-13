/**
 * UnifiedMemoryCatalog — Phase 14 Move 1 (docs/hermes/MEMORY_AUDIT.md).
 *
 * One retrieval interface over the existing memory authorities:
 *
 *   conversation (MemoryManager) -> episodic / working
 *   learning     (LearningManager) -> procedural rules (confidence-scored)
 *   task         (TaskEngine / TaskMemory) -> working + episodic task evidence
 *
 * Wrap-first: every provider reads through the source store; the catalog
 * itself persists NOTHING except in-memory access stats (durable access
 * tracking lands with the consolidation move). Retrieval scores relevance /
 * recency / importance / confidence / access and returns the smallest useful
 * context (budget limit), deduped by canonical id.
 */

import type { MemoryManager } from '../memory';
import type { LearningManager } from '../learning-manager';
import type { TaskEngine } from '../task';
import type { TaskMemory } from '../task/task-memory';
import type { EpisodicCapture } from './episodic-capture';
import {
  createMemoryRecord,
  memoryRecordId,
  recordSessionId,
  type MemoryImportance,
  type MemoryRecord,
  type MemorySource,
  type MemoryType
} from './memory-record';

export interface MemoryProvider {
  /** Canonical source id (conversation | learning | task | ...). */
  id: MemorySource;
  name: string;
  /** All records this provider currently knows, as canonical MemoryRecords. */
  records(sessionId?: string): MemoryRecord[];
  /** Cross-session keyword search (episodic recall without a session scope). */
  search?(query: string, limit: number): MemoryRecord[];
}

export interface UnifiedMemoryDeps {
  memory: MemoryManager;
  learning: LearningManager;
  taskEngine: TaskEngine;
  taskMemory?: TaskMemory;
  /** Event-driven episodic capture (Move 2). When provided, terminal-task
   *  episodes come from the capture feed instead of a full engine scan. */
  capture?: EpisodicCapture;
}

export interface RetrieveOptions {
  sessionId?: string;
  /** Restrict hits to one source store (conversation | learning | task). */
  source?: MemorySource;
  /** Context budget — "smallest useful context". Default 5. */
  limit?: number;
  types?: MemoryType[];
  minImportance?: MemoryImportance;
  minConfidence?: number;
  /** Recency half-life in days. Default 30. */
  halfLifeDays?: number;
  relevanceWeight?: number;
  recencyWeight?: number;
  importanceWeight?: number;
  confidenceWeight?: number;
  accessWeight?: number;
}

export interface RetrievedMemory extends MemoryRecord {
  score: number;
  /** Inspectable scoring terms. `semantic` is set only when the source store
   *  computed an embedding similarity; otherwise `lexical` carries the token-
   *  overlap relevance. Both are surfaced so retrieval behavior is auditable. */
  scoreBreakdown: Record<string, number | undefined>;
}

export interface ScoredCandidate {
  record: MemoryRecord;
  /** Precomputed relevance (0..1) — token overlap or the source semanticScore. */
  relevance: number;
}

const DEFAULT_WEIGHTS = {
  relevance: 0.5,
  recency: 0.2,
  importance: 0.15,
  confidence: 0.1,
  access: 0.05
};

/**
 * Ranked scoring over candidate records with a context budget. Deduped by
 * canonical id (higher score wins); filters type / minImportance /
 * minConfidence; each hit carries a scoreBreakdown. Shared by the catalog's
 * session + cross-session retrieval and the consolidation layer (Move 3).
 */
export function scoreRecords(candidates: ScoredCandidate[], opts: RetrieveOptions = {}): RetrievedMemory[] {
  const limit = Math.max(1, Math.floor(opts.limit ?? 5));
  const weights = {
    relevance: opts.relevanceWeight ?? DEFAULT_WEIGHTS.relevance,
    recency: opts.recencyWeight ?? DEFAULT_WEIGHTS.recency,
    importance: opts.importanceWeight ?? DEFAULT_WEIGHTS.importance,
    confidence: opts.confidenceWeight ?? DEFAULT_WEIGHTS.confidence,
    access: opts.accessWeight ?? DEFAULT_WEIGHTS.access
  };
  const halfLifeMs = (opts.halfLifeDays ?? 30) * 24 * 60 * 60 * 1000;
  const now = Date.now();

  const scored = new Map<string, RetrievedMemory>();
  for (const { record, relevance } of candidates) {
    if (opts.types && !opts.types.includes(record.type)) continue;
    if (opts.source && record.source !== opts.source) continue;
    if (record.confidence < (opts.minConfidence ?? 0)) continue;
    if (record.importance < (opts.minImportance ?? 0)) continue;

    const ageMs = Math.max(0, now - record.updatedAt);
    const recency = halfLifeMs > 0 ? Math.exp((-Math.LN2 * ageMs) / halfLifeMs) : 0;
    const importance = record.importance / 5;
    const access = Math.min(record.accessCount, 5) / 5;
    const score = weights.relevance * relevance
      + weights.recency * recency
      + weights.importance * importance
      + weights.confidence * record.confidence
      + weights.access * access;

    // Inspectable breakdown: semantic (source-provided embedding similarity)
    // vs lexical (token overlap) relevance, plus the recency / importance /
    // confidence / access terms. `relevance` is the effective value used in
    // the score — semantic when the source store computed one, else lexical.
    const semantic = typeof record.semanticScore === 'number' ? record.semanticScore : undefined;
    const lexical = semantic === undefined ? relevance : undefined;

    const existing = scored.get(record.id);
    if (!existing || score > existing.score) {
      scored.set(record.id, {
        ...record,
        score,
        scoreBreakdown: { relevance, semantic, lexical, recency, importance, confidence: record.confidence, access }
      });
    }
  }
  return [...scored.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

export class UnifiedMemoryCatalog {
  private readonly providers: MemoryProvider[] = [];
  private readonly accessStats = new Map<string, { count: number; lastAt: number }>();

  register(provider: MemoryProvider): this {
    if (!this.providers.some(p => p.id === provider.id)) {
      this.providers.push(provider);
    }
    return this;
  }

  /** Every record across providers, newest-first, access stats applied. */
  records(opts: { sessionId?: string; types?: MemoryType[]; source?: MemorySource } = {}): MemoryRecord[] {
    const out: MemoryRecord[] = [];
    for (const provider of this.providers) {
      if (opts.source && provider.id !== opts.source) continue;
      for (const record of provider.records(opts.sessionId)) {
        if (opts.types && !opts.types.includes(record.type)) continue;
        if (opts.sessionId && recordSessionId(record) && recordSessionId(record) !== opts.sessionId) continue;
        out.push(this.withAccess(record));
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): MemoryRecord | undefined {
    for (const provider of this.providers) {
      for (const record of provider.records()) {
        if (record.id === id) return this.withAccess(record);
      }
    }
    return undefined;
  }

  /** Bump access_count / last_accessed_at for a canonical record. */
  recordAccess(id: string): void {
    const stats = this.accessStats.get(id) || { count: 0, lastAt: 0 };
    stats.count += 1;
    stats.lastAt = Date.now();
    this.accessStats.set(id, stats);
  }

  /**
   * Ranked retrieval with a context budget. Cross-session hits come from the
   * providers' search hooks; session-scoped records are scored in place.
   * Deduped by canonical id; each hit carries a scoreBreakdown (see
   * scoreRecords, shared with the consolidation layer).
   */
  retrieve(query: string, opts: RetrieveOptions = {}): RetrievedMemory[] {
    const limit = Math.max(1, Math.floor(opts.limit ?? 5));
    const candidates: ScoredCandidate[] = [];

    // 1) Cross-session hits from provider search hooks.
    for (const provider of this.providers) {
      if (!provider.search) continue;
      for (const record of provider.search(query, Math.max(limit * 2, 10))) {
        candidates.push({ record: this.withAccess(record), relevance: record.semanticScore ?? relevanceOf(query, record.content) });
      }
    }

    // 2) Session-scoped records, scored in place.
    for (const record of this.records({ sessionId: opts.sessionId, types: opts.types })) {
      candidates.push({ record, relevance: record.semanticScore ?? relevanceOf(query, record.content) });
    }

    return scoreRecords(candidates, opts);
  }

  private withAccess(record: MemoryRecord): MemoryRecord {
    const stats = this.accessStats.get(record.id);
    if (!stats) return record;
    return { ...record, accessCount: stats.count, lastAccessedAt: stats.lastAt };
  }
}

/** Simple token-overlap relevance (0..1). Semantic scoring rides on the
 *  source store's semanticScore when present. */
export function relevanceOf(query: string, content: string): number {
  const tokens = (text: string) => new Set(
    String(text || '').toLowerCase().match(/[a-z0-9_]{3,}/g) || []
  );
  const queryTokens = tokens(query);
  if (queryTokens.size === 0) return 0;
  const contentTokens = tokens(content);
  if (contentTokens.size === 0) return 0;
  let hits = 0;
  for (const token of queryTokens) {
    if (contentTokens.has(token)) hits += 1;
  }
  return hits / queryTokens.size;
}

// ------------------------------------------------------------ providers

/** MemoryManager messages -> episodic records (session-scoped). */
export function conversationProvider(memory: MemoryManager): MemoryProvider {
  const toRecord = (sessionId: string, message: any): MemoryRecord => {
    const nativeId = String(message.id ?? `${sessionId}:${message.timestamp}`);
    const role = message.role === 'user' ? 'user' : message.role === 'assistant' ? 'assistant' : 'system';
    return createMemoryRecord({
      id: memoryRecordId('conversation', nativeId),
      type: 'episodic',
      content: String(message.content || ''),
      source: 'conversation',
      scope: 'session',
      importance: role === 'system' ? 2 : 1,
      confidence: 1,
      createdAt: Number(message.timestamp) || Date.now(),
      updatedAt: Number(message.timestamp) || Date.now(),
      metadata: { sessionId, role }
    });
  };
  return {
    id: 'conversation',
    name: 'conversation',
    records(sessionId?: string) {
      if (!sessionId) return [];
      return memory.getAll(sessionId).map(m => toRecord(sessionId, m));
    },
    search(query, limit) {
      return memory.search(query, limit).map(m => toRecord(String(m.metadata?.sessionId || ''), m));
    }
  };
}

/** LearningManager applied actions -> procedural records (confidence-scored). */
export function learningProvider(learning: LearningManager): MemoryProvider {
  return {
    id: 'learning',
    name: 'learning',
    records(sessionId?: string) {
      const actions = learning.listPendingLearningActions(sessionId, true);
      const out: MemoryRecord[] = [];
      for (const action of actions) {
        const lines = Array.isArray(action.lines) && action.lines.length
          ? action.lines.map(line => String(line).trim()).filter(Boolean)
          : [String(action.action || '').trim()];
        for (const line of lines) {
          if (!line) continue;
          out.push(createMemoryRecord({
            id: memoryRecordId('learning', action.id),
            type: 'procedural',
            content: line,
            source: 'learning',
            scope: 'session',
            importance: action.status === 'applied' ? 4 : 3,
            confidence: Number.isFinite(Number(action.confidence)) ? Number(action.confidence) : 0.5,
            createdAt: Number(action.createdAt) || Date.now(),
            updatedAt: Number(action.appliedAt || action.lastFeedbackAt || action.createdAt) || Date.now(),
            metadata: {
              sessionId: action.sessionId,
              action: action.action,
              status: action.status,
              successCount: action.successCount,
              failureCount: action.failureCount,
              target: action.target,
              sectionTitle: action.sectionTitle,
              // Phase 20 Move 6: lessons extracted from a goal retrospective
              // stay attributable to the goal that produced them.
              ...(action.goalId ? { goalId: action.goalId } : {})
            }
          }));
        }
      }
      return out;
    }
  };
}

/** TaskEngine tasks -> working (current/in-flight) + episodic (terminal).
 *  Move 2: when an EpisodicCapture is wired, terminal episodes come from its
 *  event feed (bounded, recent); otherwise the durable engine is scanned. */
export function taskProvider(taskEngine: TaskEngine, taskMemory?: TaskMemory, capture?: EpisodicCapture): MemoryProvider {
  return {
    id: 'task',
    name: 'task',
    records(sessionId?: string) {
      const out: MemoryRecord[] = [];
      const current = taskMemory ? taskMemory.current(sessionId || '') : undefined;
      const currentId = current?.id;

      // Episodic: event-captured feed when wired, else static terminal scan.
      if (capture) {
        for (const episode of capture.recent(sessionId)) {
          if (episode.metadata?.taskId === currentId) continue;
          out.push(episode);
        }
      } else {
        for (const task of taskEngine.list()) {
          if (sessionId && task.sessionId !== sessionId) continue;
          if (task.id === currentId) continue; // rendered once as working below
          const terminal = task.status === 'COMPLETED' || task.status === 'FAILED' || task.status === 'CANCELLED';
          const result: any = task.outcome?.result;
          const summary = result?.summary || result?.finalOutput;
          if (!terminal || !summary) continue;
          out.push(createMemoryRecord({
            id: memoryRecordId('task', task.id),
            type: 'episodic',
            content: `Task ${task.kind} (${task.status}): ${task.goal}\n${summary}`,
            source: 'task',
            scope: 'session',
            importance: task.status === 'FAILED' ? 4 : 3,
            confidence: result?.status === 'completed' ? 0.8 : 0.5,
            createdAt: task.timing?.createdAt || Date.now(),
            updatedAt: task.timing?.completedAt ?? task.timing?.lastActivityAt ?? task.timing?.createdAt ?? Date.now(),
            metadata: { sessionId: task.sessionId, taskId: task.id, kind: task.kind, status: task.status }
          }));
        }
      }

      if (current) {
        out.push(createMemoryRecord({
          id: memoryRecordId('task', `${current.id}:current`),
          type: 'working',
          content: `Current task (${current.status}): ${current.goal}`,
          source: 'task',
          scope: 'session',
          importance: 5,
          confidence: 0.9,
          createdAt: current.timing?.createdAt || Date.now(),
          updatedAt: current.timing?.lastActivityAt ?? current.timing?.createdAt ?? Date.now(),
          metadata: { sessionId: current.sessionId, taskId: current.id, kind: current.kind, status: current.status }
        }));
      }
      return out;
    }
  };
}

/** The Phase 14 Move 1/2 wiring: one catalog over the existing authorities. */
export function createUnifiedMemory(deps: UnifiedMemoryDeps): UnifiedMemoryCatalog {
  return new UnifiedMemoryCatalog()
    .register(conversationProvider(deps.memory))
    .register(learningProvider(deps.learning))
    .register(taskProvider(deps.taskEngine, deps.taskMemory, deps.capture));
}
