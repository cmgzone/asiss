/**
 * MemoryConsolidation — Phase 14 Move 3 (docs/hermes/MEMORY_AUDIT.md).
 *
 * The consolidation/lifecycle layer over the unified catalog:
 *
 *   dedupe (canonical id + near-duplicate content) -> merge ->
 *   lifecycle (candidate -> active -> archived/expired) ->
 *   importance promotion from success feedback / access
 *
 * It reads canonical records THROUGH the catalog (the source stores stay
 * authoritative for content) and owns ONLY the state no source store has:
 * dedupe/merge results, the record lifecycle, feedback-driven promotion, and
 * durable access statistics. Persisted as a per-record overlay
 * (`memory/memory_lifecycle.json` under the data root) — content is never
 * duplicated, so there is still exactly one content authority per source and
 * one lifecycle authority here.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { atomicWriteJsonSync } from '../atomic-write';
import {
  relevanceOf,
  scoreRecords,
  type RetrievedMemory,
  type RetrieveOptions,
  type UnifiedMemoryCatalog
} from './memory-catalog';
import type { MemoryImportance, MemoryLifecycle, MemoryRecord } from './memory-record';

export type FeedbackOutcome = 'success' | 'failure';

export interface ConsolidationOverlay {
  lifecycle: MemoryLifecycle;
  /** 0..5 — may exceed the source value after promotion. */
  importance: number;
  /** 0..1 — moves with feedback. */
  confidence: number;
  accessCount: number;
  lastAccessedAt?: number;
  successFeedback: number;
  failureFeedback: number;
  /** Canonical ids merged into this record (near-duplicate dedupe). */
  mergedFrom?: string[];
  /** When archived: the canonical id this record was superseded by. */
  supersededBy?: string;
  updatedAt: number;
}

export interface ConsolidatedRecord extends MemoryRecord {
  mergedFrom: string[];
}

export interface ConsolidationOptions {
  dataPath?: string;
  /** Stale threshold (days without access) before active/candidate expire. */
  ttlDays?: number;
  /** Access count that promotes a candidate to active. Default 3. */
  promotionAccessThreshold?: number;
  /** Importance at/above which a fresh record starts active. Default 4. */
  promotionImportance?: MemoryImportance;
  /** Fresh records at/above this confidence AND activeImportance start active. */
  activeConfidence?: number;
  activeImportance?: MemoryImportance;
  /** Clock injection for deterministic expiry tests. */
  now?: () => number;
}

const DEFAULT_TTL_DAYS = 180;
const DEFAULT_PROMOTION_ACCESS = 3;
const DEFAULT_PROMOTION_IMPORTANCE: MemoryImportance = 4;
const DEFAULT_ACTIVE_CONFIDENCE = 0.66;
const DEFAULT_ACTIVE_IMPORTANCE: MemoryImportance = 3;
/** Near-duplicate merging applies only to knowledge sources — never to
 *  conversation events (each message is a distinct experience). */
const MERGE_SOURCES = new Set(['learning', 'task']);
const LIFECYCLE_ORDER: Record<MemoryLifecycle, number> = { active: 0, candidate: 1, archived: 2, expired: 3 };

function dataRootDir(): string {
  const oneDrive = String(process.env.OneDrive || process.env.ONEDRIVE || '').trim();
  return process.env.GITU_DATA_ROOT || path.join(oneDrive || path.join(os.homedir(), 'Documents'), 'Gitu Data');
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

function clampImportance(value: number): MemoryImportance {
  return Math.min(5, Math.max(0, Math.floor(Number(value) || 0))) as MemoryImportance;
}

function normalizeContent(text: string): string {
  return String(text || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function recordStrength(record: MemoryRecord): number {
  return (record.importance / 5) * 0.5 + record.confidence * 0.5;
}

export class MemoryConsolidation {
  private readonly overlays = new Map<string, ConsolidationOverlay>();
  /** Raw source records from the last consolidate() — used to seed overlay
   *  importance/confidence for session-scoped records (conversation/task) that
   *  catalog.get cannot resolve without a sessionId. Feedback/access in
   *  practice always follow a consolidate/retrieve, so the cache is warm. */
  private readonly sourceCache = new Map<string, MemoryRecord>();
  private readonly dataPath: string;
  private readonly ttlDays: number;
  private readonly promotionAccessThreshold: number;
  private readonly promotionImportance: number;
  private readonly activeConfidence: number;
  private readonly activeImportance: number;
  private readonly now: () => number;

  constructor(private readonly catalog: UnifiedMemoryCatalog, options: ConsolidationOptions = {}) {
    this.dataPath = options.dataPath || path.join(dataRootDir(), 'memory', 'memory_lifecycle.json');
    this.ttlDays = options.ttlDays ?? DEFAULT_TTL_DAYS;
    this.promotionAccessThreshold = options.promotionAccessThreshold ?? DEFAULT_PROMOTION_ACCESS;
    this.promotionImportance = options.promotionImportance ?? DEFAULT_PROMOTION_IMPORTANCE;
    this.activeConfidence = options.activeConfidence ?? DEFAULT_ACTIVE_CONFIDENCE;
    this.activeImportance = options.activeImportance ?? DEFAULT_ACTIVE_IMPORTANCE;
    this.now = options.now || (() => Date.now());
    this.load();
  }

  // ---------------------------------------------------- lifecycle API

  /** Bump access + warm the overlay (promotion applies at next consolidate). */
  recordAccess(id: string): void {
    const overlay = this.ensureOverlay(id);
    overlay.accessCount += 1;
    overlay.lastAccessedAt = this.now();
    overlay.updatedAt = this.now();
  }

  /**
   * Success feedback raises importance/confidence and promotes a candidate to
   * active; failure lowers confidence. The LearningManager feedback loop,
   * generalized to canonical records (14.8/14.9 consolidation).
   */
  recordFeedback(id: string, outcome: FeedbackOutcome): void {
    const overlay = this.ensureOverlay(id);
    if (outcome === 'success') {
      overlay.importance = clampImportance(overlay.importance + 1);
      overlay.confidence = clamp01(overlay.confidence + 0.1);
      overlay.successFeedback += 1;
      if (overlay.lifecycle === 'candidate') overlay.lifecycle = 'active';
    } else {
      overlay.confidence = clamp01(overlay.confidence - 0.1);
      overlay.failureFeedback += 1;
    }
    overlay.updatedAt = this.now();
  }

  promote(id: string): void {
    const overlay = this.ensureOverlay(id);
    overlay.lifecycle = 'active';
    overlay.updatedAt = this.now();
  }

  archive(id: string, supersededBy?: string): void {
    const overlay = this.ensureOverlay(id);
    overlay.lifecycle = 'archived';
    if (supersededBy) overlay.supersededBy = supersededBy;
    overlay.updatedAt = this.now();
  }

  expire(id: string): void {
    const overlay = this.ensureOverlay(id);
    overlay.lifecycle = 'expired';
    overlay.updatedAt = this.now();
  }

  /** Lifecycle state for one canonical id (undefined when untouched). */
  overlay(id: string): ConsolidationOverlay | undefined {
    return this.overlays.get(id);
  }

  /** Persist the overlay (resilient atomic write — Phase 22). */
  save(): void {
    // Retry + copy fallback + warn, never throw: a transient OneDrive lock
    // must not lose consolidation overlays or break the memory pipeline.
    atomicWriteJsonSync(this.dataPath, { records: Object.fromEntries(this.overlays) });
  }

  // ---------------------------------------------------- consolidated view

  /**
   * Deduped + lifecycle-applied records (optionally session-scoped). Near-
   * duplicates in knowledge sources are merged (the stronger record survives,
   * the weaker is archived with supersededBy); exact id duplicates collapse.
   */
  consolidate(sessionId?: string): ConsolidatedRecord[] {
    const byId = new Map<string, ConsolidatedRecord>();
    for (const record of this.catalog.records({ sessionId })) {
      this.sourceCache.set(record.id, record);
      if (byId.has(record.id)) continue;
      byId.set(record.id, this.applyOverlay(record));
    }

    // Near-duplicate merge by source+type+normalized content.
    const byKey = new Map<string, ConsolidatedRecord>();
    const merged: ConsolidatedRecord[] = [];
    for (const record of byId.values()) {
      if (!MERGE_SOURCES.has(record.source)) {
        merged.push(record);
        continue;
      }
      const key = `${record.source}|${record.type}|${normalizeContent(record.content)}`;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, record);
        merged.push(record);
        continue;
      }
      const keep = recordStrength(record) >= recordStrength(existing) ? record : existing;
      const drop = keep === record ? existing : record;
      byKey.set(key, keep);
      keep.mergedFrom = [...new Set([...(keep.mergedFrom || []), drop.id])];
      this.archive(drop.id, keep.id);
      if (keep === record) {
        // The newer record wins — it wasn't in the output yet, so replace the
        // old slot with the survivor (the dropped record stays archived).
        const idx = merged.indexOf(existing);
        if (idx >= 0) merged[idx] = keep;
        else merged.push(keep);
      }
      // Else the existing record keeps its slot; the weaker newcomer is
      // archived and not emitted (retrieval excludes archived anyway).
    }

    // Lifecycle transitions: promotion (candidate -> active) and expiry.
    for (const record of merged) {
      const overlay = this.overlays.get(record.id);
      if (!overlay) continue;
      const staleMs = this.ttlDays * 24 * 60 * 60 * 1000;
      const lastActivity = overlay.lastAccessedAt ?? overlay.updatedAt;
      if (
        (overlay.lifecycle === 'active' || overlay.lifecycle === 'candidate') &&
        staleMs > 0 &&
        this.now() - lastActivity > staleMs
      ) {
        overlay.lifecycle = 'expired';
        overlay.updatedAt = this.now();
      } else if (
        overlay.lifecycle === 'candidate' &&
        (overlay.importance >= this.promotionImportance || overlay.accessCount >= this.promotionAccessThreshold)
      ) {
        overlay.lifecycle = 'active';
        overlay.updatedAt = this.now();
      }
      record.lifecycle = overlay.lifecycle;
    }

    return merged.sort((a, b) =>
      (LIFECYCLE_ORDER[a.lifecycle] - LIFECYCLE_ORDER[b.lifecycle]) ||
      (b.importance - a.importance) ||
      (b.updatedAt - a.updatedAt)
    );
  }

  /** Ranked retrieval over the consolidated view (archived/expired excluded). */
  retrieve(query: string, opts: RetrieveOptions = {}): RetrievedMemory[] {
    const candidates = this.consolidate(opts.sessionId)
      .filter(r => r.lifecycle !== 'archived' && r.lifecycle !== 'expired')
      .map(record => ({ record, relevance: record.semanticScore ?? relevanceOf(query, record.content) }));
    return scoreRecords(candidates, opts);
  }

  // -------------------------------------------------------------- internals

  private applyOverlay(record: MemoryRecord): ConsolidatedRecord {
    const overlay = this.overlays.get(record.id);
    const mergedFrom = overlay?.mergedFrom ? [...overlay.mergedFrom] : [];
    if (!overlay) {
      const preProven = record.confidence >= this.activeConfidence && record.importance >= this.activeImportance;
      return { ...record, lifecycle: preProven ? 'active' : 'candidate', mergedFrom };
    }
    const metadata: Record<string, unknown> = { ...(record.metadata || {}) };
    if (overlay.mergedFrom?.length) metadata.mergedFrom = [...overlay.mergedFrom];
    if (overlay.supersededBy) metadata.supersededBy = overlay.supersededBy;
    return {
      ...record,
      lifecycle: overlay.lifecycle,
      importance: clampImportance(overlay.importance),
      confidence: clamp01(overlay.confidence),
      accessCount: overlay.accessCount,
      lastAccessedAt: overlay.lastAccessedAt ?? record.lastAccessedAt,
      updatedAt: overlay.updatedAt,
      metadata,
      mergedFrom
    };
  }

  private ensureOverlay(id: string): ConsolidationOverlay {
    const existing = this.overlays.get(id);
    if (existing) return existing;
    const source = this.catalog.get(id) ?? this.sourceCache.get(id);
    const overlay: ConsolidationOverlay = {
      lifecycle: this.initialLifecycle(source),
      importance: source?.importance ?? 2,
      confidence: source?.confidence ?? 0.5,
      accessCount: 0,
      successFeedback: 0,
      failureFeedback: 0,
      updatedAt: this.now()
    };
    this.overlays.set(id, overlay);
    return overlay;
  }

  private initialLifecycle(source?: MemoryRecord): MemoryLifecycle {
    if (!source) return 'candidate';
    return source.confidence >= this.activeConfidence && source.importance >= this.activeImportance
      ? 'active'
      : 'candidate';
  }

  private load(): void {
    if (!fs.existsSync(this.dataPath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.dataPath, 'utf-8'));
      const records = parsed?.records && typeof parsed.records === 'object' ? parsed.records : {};
      for (const [id, value] of Object.entries(records)) {
        const raw = value as any;
        if (!raw || typeof raw !== 'object') continue;
        this.overlays.set(id, {
          lifecycle: ['active', 'candidate', 'archived', 'expired'].includes(raw.lifecycle) ? raw.lifecycle : 'candidate',
          importance: clampImportance(Number(raw.importance) || 0),
          confidence: clamp01(Number(raw.confidence) || 0),
          accessCount: Math.max(0, Math.floor(Number(raw.accessCount) || 0)),
          lastAccessedAt: raw.lastAccessedAt ? Number(raw.lastAccessedAt) : undefined,
          successFeedback: Math.max(0, Math.floor(Number(raw.successFeedback) || 0)),
          failureFeedback: Math.max(0, Math.floor(Number(raw.failureFeedback) || 0)),
          ...(Array.isArray(raw.mergedFrom) ? { mergedFrom: raw.mergedFrom.map((s: unknown) => String(s)) } : {}),
          ...(raw.supersededBy ? { supersededBy: String(raw.supersededBy) } : {}),
          updatedAt: Number(raw.updatedAt) || Date.now()
        });
      }
    } catch (err: any) {
      console.warn('[MemoryConsolidation] load failed:', err?.message || err);
    }
  }
}
