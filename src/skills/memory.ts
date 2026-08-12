import { Skill } from '../core/skills';
import { MemoryManager } from '../core/memory';
import { type RetrievedMemory, type UnifiedMemoryCatalog } from '../core/memory-unified/memory-catalog';
import { type MemoryConsolidation } from '../core/memory-unified/memory-consolidation';
import type { MemoryType } from '../core/memory-unified/memory-record';

/**
 * Phase 14 Move 4 (docs/hermes/MEMORY_AUDIT.md) — canonical unified retrieval.
 *
 * `retrieve` is the single retrieval entry point over the unified memory
 * layer (catalog + consolidation). `search` and `semantic_search` are thin
 * delegates over the same path (kept as compatibility wrappers so existing
 * callers keep working), and `get_recent` remains a raw session-history read.
 *
 * When no unified layer is wired (standalone use), search/semantic_search
 * fall back to the legacy MemoryManager paths unchanged.
 */
export interface MemorySkillUnified {
  catalog: UnifiedMemoryCatalog;
  /** When wired, retrieval reads through the consolidation layer (dedupe /
   *  merge applied, archived/expired excluded, lifecycle applied). */
  consolidation?: MemoryConsolidation;
}

export class MemorySkill implements Skill {
  name = 'memory';
  description = 'Unified memory retrieval over conversations, learned rules and task outcomes. retrieve returns scored records with a score breakdown; search is keyword-compatible and semantic_search uses semantic scores when embeddings are configured.';

  inputSchema = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['search', 'semantic_search', 'get_recent', 'retrieve'],
        description: 'Action to perform'
      },
      query: {
        type: 'string',
        description: 'Retrieval query (required for search, semantic_search and retrieve)'
      },
      sessionId: {
        type: 'string',
        description: 'Session ID to scope retrieval by (optional)'
      },
      limit: {
        type: 'number',
        description: 'Number of results to return (default: 5)'
      },
      source: {
        type: 'string',
        description: 'Restrict to one source store: conversation | learning | task (optional)'
      },
      types: {
        type: 'array',
        items: { type: 'string' },
        description: 'Memory types to include: working, episodic, semantic, procedural, project, task (optional)'
      },
      minScore: {
        type: 'number',
        description: 'Minimum total score for results (0..1, optional)'
      },
      minImportance: {
        type: 'number',
        description: 'Minimum importance 0-5 (optional)'
      },
      minConfidence: {
        type: 'number',
        description: 'Minimum confidence 0..1 (optional)'
      },
      taskId: {
        type: 'string',
        description: 'Restrict to memories of one canonical task (optional)'
      }
    },
    required: ['action']
  };

  private memory: MemoryManager;
  private unified?: MemorySkillUnified;

  constructor(memory: MemoryManager, unified?: MemorySkillUnified) {
    this.memory = memory;
    this.unified = unified;
  }

  async execute(args: any): Promise<any> {
    const { action, query, sessionId, limit = 5 } = args;

    if (action === 'retrieve') {
      if (!query) return { error: 'Query is required for retrieve' };
      if (!this.unified) return { error: 'retrieve requires the unified memory layer; use search or semantic_search instead' };
      return this.retrieve(args);
    }

    if (action === 'search') {
      if (!query) return { error: 'Query is required for search' };
      if (this.unified) {
        const hits = this.retrieveHits(args);
        return {
          mode: 'keyword',
          unified: true,
          count: hits.length,
          results: hits.map(toRow)
        };
      }
      const results = this.memory.search(query, limit);
      return {
        mode: 'keyword',
        count: results.length,
        results: results.map(r => ({
          timestamp: new Date(r.timestamp).toISOString(),
          role: r.role,
          content: r.content
        }))
      };
    }

    if (action === 'semantic_search') {
      if (!query) return { error: 'Query is required for semantic_search' };
      if (this.unified) {
        const hits = this.retrieveHits(args);
        const semantic = hits.some(h => typeof h.semanticScore === 'number');
        return {
          mode: semantic ? 'semantic' : 'lexical',
          unified: true,
          reason: semantic
            ? 'semantic scores from the source store used for relevance'
            : 'no semantic scores available; lexical relevance used',
          count: hits.length,
          results: hits.map(r => ({
            timestamp: new Date(r.createdAt).toISOString(),
            role: typeof r.metadata?.role === 'string' ? r.metadata.role : undefined,
            score: Number((r.scoreBreakdown?.semantic ?? r.scoreBreakdown?.lexical ?? r.score).toFixed(4)),
            content: r.content
          }))
        };
      }
      const search = await this.memory.semanticSearch(query, limit);
      return {
        mode: search.mode,
        reason: search.reason,
        count: search.count,
        results: search.results.map(r => ({
          timestamp: new Date(r.timestamp).toISOString(),
          role: r.role,
          score: typeof r.semanticScore === 'number' ? Number(r.semanticScore.toFixed(4)) : undefined,
          content: r.content
        }))
      };
    }

    if (action === 'get_recent') {
      if (!sessionId) return { error: 'Session ID is required for get_recent' };
      const results = this.memory.get(sessionId, limit);
      return {
        count: results.length,
        results: results.map(r => ({
          timestamp: new Date(r.timestamp).toISOString(),
          role: r.role,
          content: r.content
        }))
      };
    }

    return { error: 'Invalid action' };
  }

  // ------------------------------------------------------------ retrieve

  /** Canonical unified retrieval: records + score breakdown + filters. */
  private retrieve(args: any): any {
    const { query, sessionId, source, types, minScore, minImportance, minConfidence, taskId, limit = 5 } = args;
    const hits = this.retrieveHits(args);
    return {
      mode: 'unified',
      count: hits.length,
      query,
      filters: { sessionId, source, types, taskId, limit, minScore, minImportance, minConfidence },
      results: hits.map(r => ({
        id: r.id,
        type: r.type,
        source: r.source,
        scope: r.scope,
        importance: r.importance,
        confidence: r.confidence,
        lifecycle: r.lifecycle,
        score: Number(r.score.toFixed(4)),
        scoreBreakdown: r.scoreBreakdown,
        content: r.content,
        createdAt: new Date(r.createdAt).toISOString(),
        updatedAt: new Date(r.updatedAt).toISOString(),
        metadata: r.metadata
      }))
    };
  }

  /**
   * The single retrieval path: consolidation when wired (dedupe/merge +
   * lifecycle applied, archived/expired excluded), else the catalog. Post
   * filters: minScore and taskId.
   */
  private retrieveHits(args: any): RetrievedMemory[] {
    const { query, sessionId, source, types, minScore, minImportance, minConfidence, limit = 5, taskId } = args;
    const normalizedTypes: MemoryType[] | undefined =
      Array.isArray(types) ? types : typeof types === 'string' ? [types] : undefined;
    const target = this.unified?.consolidation ?? this.unified!.catalog;
    const hits = target.retrieve(query, {
      sessionId,
      source,
      types: normalizedTypes,
      limit: Math.max(1, Math.floor(Number(limit) || 5)),
      minImportance,
      minConfidence
    });
    return hits
      .filter(r => minScore === undefined || r.score >= Number(minScore))
      .filter(r => !taskId || r.metadata?.taskId === taskId);
  }
}

/** Legacy-shaped conversation row for the search compatibility wrappers. */
function toRow(r: RetrievedMemory): any {
  return {
    timestamp: new Date(r.createdAt).toISOString(),
    role: typeof r.metadata?.role === 'string' ? r.metadata.role : undefined,
    content: r.content
  };
}
