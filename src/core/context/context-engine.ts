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

export interface ContextEngineConfig {
  /** Token budget for the assembled context. Default 32000. */
  maxTokens?: number;
  /** Repository context: surfaced when enabled and a workspace exists. */
  repository?: { enabled?: boolean; maxFiles?: number; maxDepth?: number; maxListed?: number };
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

  /** Repository index for a workspace (cached per root). */
  indexRepository(root: string): RepositoryIndex | undefined {
    if (this.injectedIndex) return this.injectedIndex;
    if (!root) return undefined;
    const cached = this.indexCache.get(root);
    if (cached) return cached;
    try {
      const index = indexWorkspace(root, this.repositoryOptions());
      this.indexCache.set(root, index);
      return index;
    } catch {
      return undefined;
    }
  }

  /** Rendered repository context block for a workspace + goal. */
  repositorySection(root: string, goal: string): string {
    const index = this.indexRepository(root);
    if (!index) return '';
    return renderRepositoryContext(index, goal, { maxListed: this.config.repository?.maxListed ?? 40 });
  }

  /** Relevant files for the goal (Phase 8 builds on this). */
  relevantFiles(root: string, goal: string, limit = 12) {
    const index = this.indexRepository(root);
    if (!index) return [];
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
}

/** Process-wide default ContextEngine (pure defaults: no summarization model). */
export const contextEngine = new ContextEngine();
