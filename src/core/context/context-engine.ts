/**
 * ContextEngine — Hermes Evolution Phase 7.
 *
 * The orchestrator for budgeted, relevance-based context construction:
 *
 *   Task goal
 *     |
 *     +--> relevant memory (history)     -> section (priority)
 *     +--> previous decisions            -> section
 *     +--> project prompt                -> section
 *     +--> repository index (top files)  -> section
 *     +--> relevant tools                -> section
 *     +--> long-term notes               -> section
 *     |
 *   Context budget (tokens)
 *     |
 *   ContextPackage  (ordered, budgeted, observable)
 *
 * The engine is host-agnostic. AgentRunner can use renderHistory() for a
 * byte-identical drop-in of its current history renderer, or build() for the
 * full pipeline (repository context, tool relevance, summarization) behind
 * configuration.
 */

import { buildContextPackage, ContextMemory, ContextSourceInput, ContextTool } from './context-builder';
import { estimateTokens, truncateChars } from './context-budget';
import { Summarizer } from './summarizer';
import { selectRelevant } from './relevance';
import {
  indexWorkspace,
  matchFiles,
  renderRepositoryContext,
  RepositoryContextOptions,
  RepositoryIndex
} from './repository-context';
import {
  getRepositoryIndex,
  matchBySymbols,
  PersistentIndexOptions,
  PersistentRepositoryIndex,
  refreshRepositoryIndex,
  renderGoalFileHints,
  resolveSymbols as resolveIndexSymbols,
  saveRepositoryIndex,
  SymbolResolution
} from './repo-index';

export interface ContextEngineConfig {
  /** Token budget for the assembled context. Default 32000. */
  maxTokens?: number;
  /** Repository context: surfaced when enabled and a workspace exists. */
  repository?: { enabled?: boolean; persistent?: boolean; maxFiles?: number; maxDepth?: number; maxListed?: number; dataRoot?: string; goalHints?: { enabled?: boolean; maxFiles?: number }; warm?: { enabled?: boolean; throttleMs?: number } };
  /** Summarize long sections via an injectable model. */
  summarize?: { enabled?: boolean; maxChars?: number };
  /** Cap history render truncation (chars per memory). Default 20000. */
  truncateChars?: number;
}

export interface ContextEngineOptions {
  /** Model-backed summarizer; used when config.summarize.enabled is true. */
  summarizer?: Summarizer;
  config?: ContextEngineConfig;
  /** Pre-built repository index (tests/hosts can inject one). */
  repositoryIndex?: RepositoryIndex;
}

export interface HistoryRenderOptions {
  missionMarker?: string;
  truncateChars?: number;
}

export class ContextEngine {
  private readonly summarizer?: Summarizer;
  private readonly config: ContextEngineConfig;
  private readonly injectedIndex?: RepositoryIndex;
  private readonly indexCache = new Map<string, RepositoryIndex>();
  private readonly lastWarm = new Map<string, number>();

  constructor(options: ContextEngineOptions = {}) {
    this.summarizer = options.summarizer;
    this.config = options.config || {};
    this.injectedIndex = options.repositoryIndex;
  }

  /** Full pipeline: sources -> sections -> budget -> ContextPackage. */
  async build(input: ContextSourceInput, overrides: { maxTokens?: number } = {}): Promise<Awaited<ReturnType<typeof buildContextPackage>>> {
    const maxTokens = overrides.maxTokens ?? this.config.maxTokens ?? 32_000;
    return buildContextPackage(input, {
      maxTokens,
      summarizer: this.config.summarize?.enabled ? this.summarizer : undefined
    });
  }

  /**
   * Render memories exactly like AgentRunner's legacy history renderer
   * (role labels + 20k-char truncation) so hosts can adopt the engine without
   * changing prompt output. `missionMarker` marks the current mission's user
   * message (metadata `__missionMarker`).
   */
  renderHistory(memories: ContextMemory[], options: HistoryRenderOptions = {}): string {
    const cap = options.truncateChars ?? this.config.truncateChars ?? 20_000;
    return memories
      .map((m) => {
        const content = truncateChars(m.content, cap);
        const isMission = m.missionMarker === true || (options.missionMarker !== undefined && (m as any).__missionMarker === options.missionMarker);
        if (m.role === 'user') return isMission ? `User (Current Mission): ${content}` : `User: ${content}`;
        if (m.role === 'assistant') return `Assistant: ${content}`;
        return `System: ${content}`;
      })
      .join('\n');
  }

  /**
   * Repository index for a workspace (cached per root). Prefers the Phase 8
   * persistent, symbol-aware index (load -> incremental refresh -> save);
   * falls back to the lightweight Phase 7 index when persistence is disabled
   * or unavailable.
   */
  indexRepository(root: string): RepositoryIndex | undefined {
    if (this.injectedIndex) return this.injectedIndex;
    if (!root) return undefined;
    const cached = this.indexCache.get(root);
    if (cached) return cached;
    let index: RepositoryIndex | undefined;
    try {
      if (this.config.repository?.persistent !== false) {
        index = getRepositoryIndex(root, this.persistentOptions(), this.dataRoot());
      } else {
        index = indexWorkspace(root, this.repositoryOptions());
      }
    } catch {
      try {
        index = indexWorkspace(root, this.repositoryOptions());
      } catch {
        return undefined;
      }
    }
    if (index) this.indexCache.set(root, index);
    return index;
  }

  /**
   * Phase 9 warm: refresh the repository index for a workspace on demand.
   * Incremental for the persistent index (only files whose mtime/size changed
   * are re-parsed, then re-saved); rebuilds the lightweight index. Throttled
   * per root (default 5s) unless `force` — callers like the symbol skill pass
   * force so an explicit query never reads a stale index. Returns true when a
   * refresh actually ran.
   */
  refreshRepository(root: string, options: { force?: boolean } = {}): boolean {
    if (!root) return false;
    const warm = this.config.repository?.warm;
    if (warm?.enabled === false) return false;
    const throttleMs = warm?.throttleMs ?? 5000;
    const now = Date.now();
    if (!options.force && now - (this.lastWarm.get(root) || 0) < throttleMs) return false;
    this.lastWarm.set(root, now);

    const index = this.indexCache.get(root);
    if (index && isPersistentIndex(index)) {
      try {
        const refreshed = refreshRepositoryIndex(index, root, this.persistentOptions());
        saveRepositoryIndex(refreshed, this.dataRoot());
        this.indexCache.set(root, refreshed);
        return true;
      } catch {
        return false;
      }
    }
    if (index) {
      try {
        this.indexCache.set(root, indexWorkspace(root, this.repositoryOptions()));
        return true;
      } catch {
        return false;
      }
    }
    // Nothing cached: the normal build path loads/persists a fresh index.
    return Boolean(this.indexRepository(root));
  }

  /**
   * Rendered repository context block for a workspace + goal. When goal hints
   * are enabled (the default once the repository section is on), the plain
   * path-matched file list is replaced by the per-goal symbol-aware hint.
   */
  repositorySection(root: string, goal: string): string {
    const index = this.indexRepository(root);
    if (!index) return '';
    const cfg = this.config.repository || {};
    if (cfg.goalHints?.enabled === false) {
      return renderRepositoryContext(index, goal, { maxListed: cfg.maxListed ?? 40 });
    }
    const staticText = renderRepositoryContext(index, goal, { relevantFiles: [], maxListed: cfg.maxListed ?? 40 });
    const hints = this.goalFilesSection(root, goal);
    return hints ? `${staticText}

${hints}` : staticText;
  }

  /**
   * Resolve bare symbol references in a goal ("fix authenticate()") to the
   * files that export them, via the persistent index's exportedSymbols map.
   * Returns [] for lightweight indexes or when nothing resolves.
   */
  resolveSymbols(root: string, goal: string, limit = 8): SymbolResolution[] {
    const index = this.indexRepository(root);
    if (!index || !isPersistentIndex(index)) return [];
    return resolveIndexSymbols(index, goal, limit);
  }

  /** Per-goal "files relevant to the current goal" hint (symbol-aware). */
  goalFilesSection(root: string, goal: string): string {
    const index = this.indexRepository(root);
    if (!index) return '';
    return renderGoalFileHints(index, goal, { maxFiles: this.config.repository?.goalHints?.maxFiles ?? 8 });
  }

  /** Relevant files for the goal: symbol-aware when the index is persistent. */
  relevantFiles(root: string, goal: string, limit = 12) {
    const index = this.indexRepository(root);
    if (!index) return [];
    if (isPersistentIndex(index)) return matchBySymbols(index, goal, limit);
    return matchFiles(index, goal, limit);
  }

  /** Tool relevance: keep the tools most relevant to the goal (opt-in). */
  selectTools(tools: ContextTool[], goal: string, limit?: number): ContextTool[] {
    const cap = limit ?? Math.max(8, Math.ceil(tools.length * 0.5));
    if (!goal) return tools.slice(0, cap);
    const selected = selectRelevant(tools, goal, cap, (t) => `${t.name} ${t.description || ''}`);
    return selected.length > 0 ? selected : tools.slice(0, cap);
  }

  /** Token estimate for a text (observability / Phase 18 telemetry). */
  estimateTokens(text: string): number {
    return estimateTokens(text);
  }

  private repositoryOptions(): RepositoryContextOptions {
    const repo = this.config.repository || {};
    return {
      maxFiles: repo.maxFiles,
      maxDepth: repo.maxDepth
    };
  }

  private persistentOptions(): PersistentIndexOptions {
    return this.repositoryOptions();
  }

  private dataRoot(): string | undefined {
    return this.config.repository?.dataRoot;
  }
}

/** True when the index carries the Phase 8 symbol/import enrichment. */
function isPersistentIndex(index: RepositoryIndex): index is PersistentRepositoryIndex {
  return (index as PersistentRepositoryIndex).version !== undefined;
}

/** Process-wide default ContextEngine (pure defaults: no summarization model). */
export const contextEngine = new ContextEngine();
