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

import { TaskEventBus, taskEventBus } from '../task/task-events';
import { analyzeChangeImpact, ChangeImpact, ChangeImpactOptions, emptyChangeImpact } from './change-impact';
import {
  findCallers,
  findCallees,
  findImplementations,
  symbolIntelligenceEvidence as measureSymbolIntelligence,
  SymbolCallee,
  SymbolIntelligenceEvidence,
  SymbolReference,
  SymbolUsageOptions
} from './symbols';
import {
  ArchitectureProfile,
  ArchitectureRenderOptions,
  discoverArchitecture,
  renderArchitectureProfile
} from './architecture';
import { buildContextPackage, ContextMemory, ContextPackage, ContextSourceInput, ContextTool } from './context-builder';
import { estimateTokens, truncateChars } from './context-budget';
import { emptyMinimalContext, MinimalContext, MinimalContextOptions, renderMinimalContext, selectMinimalContext } from './minimal-context';
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
  DependentsOptions,
  Dependent,
  findDependents,
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
  repository?: { enabled?: boolean; persistent?: boolean; maxFiles?: number; maxDepth?: number; maxListed?: number; dataRoot?: string; goalHints?: { enabled?: boolean; maxFiles?: number }; minimal?: { enabled?: boolean; maxBytes?: number; maxFiles?: number }; warm?: { enabled?: boolean; throttleMs?: number }; telemetry?: { enabled?: boolean } };
  /** Summarize long sections via an injectable model. */
  summarize?: { enabled?: boolean; maxChars?: number };
  /** Cap history render truncation (chars per memory). Default 20000. */
  truncateChars?: number;
}

export interface ContextEngineOptions {
  /** Model-backed summarizer; used when config.summarize.enabled is true. */
  summarizer?: Summarizer;
  /** Event bus for warmth telemetry (defaults to the process-wide bus). */
  bus?: TaskEventBus;
  config?: ContextEngineConfig;
  /** Pre-built repository index (tests/hosts can inject one). */
  repositoryIndex?: RepositoryIndex;
}

export interface HistoryRenderOptions {
  missionMarker?: string;
  truncateChars?: number;
}

/**
 * Phase 12 D1: pieces the host currently assembles inline for the mission
 * system prompt + body. Each block is pre-rendered by the host (workspace /
 * time / user / project read host state); the engine owns the assembly and
 * runs the same sources through build() for the budgeted package.
 */
export interface MissionPromptInput {
  /** Base system prompt with {{AGENT_NAME}} already substituted. */
  baseSystemPrompt: string;
  /** Pre-rendered workspace prompt block (may be ''). */
  workspacePrompt: string;
  /** Pre-rendered time prompt block. */
  timePrompt: string;
  /** Greeting line, e.g. 'You are speaking with Alice.' */
  userLine: string;
  /** Pre-rendered project prompt block (may be ''). */
  projectPrompt: string;
  /** Pre-rendered repository section (may be ''). */
  repositorySection?: string;
  /** Scratchpad notes summary (may be ''). */
  notes?: string;
  /** Conversation history for the mission body. */
  history: ContextMemory[];
  /** Mission instruction line ('Begin the current mission...' / 'Continue...'). */
  missionInstruction: string;
  /** Optional extra system context block (e.g. /sys output). */
  systemContext?: string;
  /** Goal text (used by the context package). */
  goal: string;
  /** Token budget for the context package (defaults to config.maxTokens). */
  maxTokens?: number;
}

export interface MissionPromptResult {
  /** Assembled system prompt — byte-identical to AgentRunner's inline code. */
  systemPrompt: string;
  /** Assembled mission body prompt — byte-identical to AgentRunner's template. */
  prompt: string;
  /** Budgeted context package from build() — observability, unused by default. */
  package: ContextPackage;
}

/** Warmth snapshot for one workspace root (Phase 9 telemetry). */
export interface RepositoryWarmth {
  root: string;
  /** When the index was last refreshed (ms epoch). */
  lastRefreshedAt: number;
  /** Files re-parsed during that refresh (0 = checked, nothing changed). */
  filesReParsed: number;
  /** Symbols found in the re-parsed files. */
  symbolsRefreshed: number;
  /** Total indexed files after the refresh. */
  fileCount: number;
  sessionId?: string;
  taskId?: string;
}

export class ContextEngine {
  private readonly summarizer?: Summarizer;
  private readonly config: ContextEngineConfig;
  private readonly injectedIndex?: RepositoryIndex;
  private readonly bus: TaskEventBus;
  private readonly indexCache = new Map<string, RepositoryIndex>();
  private readonly lastWarm = new Map<string, number>();
  private readonly warmth = new Map<string, RepositoryWarmth>();

  constructor(options: ContextEngineOptions = {}) {
    this.summarizer = options.summarizer;
    this.config = options.config || {};
    this.injectedIndex = options.repositoryIndex;
    this.bus = options.bus || taskEventBus;
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
   * Phase 12 D1: assemble the mission prompt the way AgentRunner does inline
   * (base + workspace + time + user + project + repository + notes, then the
   * conversation body with history) so the host's inline assembly becomes a
   * call into the engine. Byte-identical default output — same drop-in
   * discipline as renderHistory. The same sources are ALSO run through
   * build() so the budgeted, sectioned pipeline genuinely participates
   * (sections/tokens/warnings are available to a later phase without
   * changing default output).
   */
  async buildMissionPrompt(input: MissionPromptInput): Promise<MissionPromptResult> {
    // Byte-identical reproduction of AgentRunner's inline assembly:
    //   systemPrompt = base + workspace + '\n\n' + time + '\n\n' + userLine
    //                + project + ('\n\n' + repository) + ('\n\n' + notes)
    let systemPrompt = input.baseSystemPrompt;
    systemPrompt += input.workspacePrompt;
    systemPrompt += `\n\n${input.timePrompt}`;
    systemPrompt += `\n\n${input.userLine}`;
    systemPrompt += input.projectPrompt;
    if (input.repositorySection) systemPrompt += `\n\n${input.repositorySection}`;
    if (input.notes) systemPrompt += `\n\n${input.notes}`;

    // Byte-identical reproduction of AgentRunner's mission body template:
    //   \nConversation and current mission:\n${history}\n\n${instruction}
    //   \n${context ? '\nSystem Context: ' + context : ''}\n
    const historyText = this.renderHistory(input.history, {
      truncateChars: this.config.truncateChars ?? 20000
    });
    const prompt = `\nConversation and current mission:\n${historyText}\n\n${input.missionInstruction}\n${input.systemContext ? `\nSystem Context: ${input.systemContext}` : ''}\n`;

    const pkg = await this.build(
      {
        goal: input.goal,
        history: input.history,
        project: input.projectPrompt || undefined,
        repository: input.repositorySection || undefined,
        notes: input.notes || undefined
      },
      { maxTokens: input.maxTokens }
    );

    return { systemPrompt, prompt, package: pkg };
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
   * force so an explicit query never reads a stale index. Warmth stats are
   * recorded per root and emitted as a RepositoryIndexRefreshed event (opt-out
   * via repository.telemetry.enabled). Returns true when a refresh actually ran.
   */
  refreshRepository(
    root: string,
    options: { force?: boolean; sessionId?: string; taskId?: string } = {}
  ): boolean {
    if (!root) return false;
    const warm = this.config.repository?.warm;
    if (warm?.enabled === false) return false;
    const throttleMs = warm?.throttleMs ?? 5000;
    const now = Date.now();
    if (!options.force && now - (this.lastWarm.get(root) || 0) < throttleMs) return false;
    this.lastWarm.set(root, now);

    const index = this.indexCache.get(root);
    let stats: { filesReParsed: number; symbolsRefreshed: number; fileCount: number };
    if (index && isPersistentIndex(index)) {
      try {
        const before = index.files;
        const refreshed = refreshRepositoryIndex(index, root, this.persistentOptions());
        saveRepositoryIndex(refreshed, this.dataRoot());
        this.indexCache.set(root, refreshed);
        const reparsed = refreshed.files.filter((f) => !before.includes(f));
        stats = {
          filesReParsed: reparsed.length,
          symbolsRefreshed: reparsed.reduce((n, f) => n + f.symbols.length, 0),
          fileCount: refreshed.fileCount
        };
      } catch {
        return false;
      }
    } else if (index) {
      try {
        const rebuilt = indexWorkspace(root, this.repositoryOptions());
        this.indexCache.set(root, rebuilt);
        stats = { filesReParsed: rebuilt.fileCount, symbolsRefreshed: 0, fileCount: rebuilt.fileCount };
      } catch {
        return false;
      }
    } else {
      const built = this.indexRepository(root);
      if (!built) return false;
      stats = { filesReParsed: built.fileCount, symbolsRefreshed: 0, fileCount: built.fileCount };
    }

    // Phase 9 telemetry: record warmth and emit so audit can tell whether a
    // later decision was made against a fresh index.
    const warmth: RepositoryWarmth = {
      root,
      lastRefreshedAt: now,
      filesReParsed: stats.filesReParsed,
      symbolsRefreshed: stats.symbolsRefreshed,
      fileCount: stats.fileCount,
      sessionId: options.sessionId,
      taskId: options.taskId
    };
    this.warmth.set(root, warmth);
    if (this.config.repository?.telemetry?.enabled !== false) {
      void this.emitWarmthEvent(warmth);
    }
    return true;
  }

  /** Latest warmth snapshot for a workspace root (undefined if never warmed). */
  indexWarmth(root: string): RepositoryWarmth | undefined {
    return this.warmth.get(root);
  }

  private async emitWarmthEvent(warmth: RepositoryWarmth): Promise<void> {
    try {
      await this.bus.emit({
        name: 'RepositoryIndexRefreshed',
        taskId: warmth.taskId || '',
        timestamp: warmth.lastRefreshedAt,
        data: {
          root: warmth.root,
          fileCount: warmth.fileCount,
          filesReParsed: warmth.filesReParsed,
          symbolsRefreshed: warmth.symbolsRefreshed,
          sessionId: warmth.sessionId
        }
      });
    } catch (error) {
      console.warn('[ContextEngine] warmth telemetry failed:', error);
    }
  }

  /**
   * Rendered repository context block for a workspace + goal. When goal hints
   * are enabled (the default once the repository section is on), the plain
   * path-matched file list is replaced — for PERSISTENT indexes by the Phase
   * 18 Move 7b minimal dependency-closed context (the smallest budgeted
   * closure: seeds → imported/importing modules → tests), falling back to the
   * per-goal symbol-aware hint for lightweight indexes, no matches, or when
   * the `minimal.enabled === false` opt-out is set. `goalHints.maxFiles`
   * seeds the context; `minimal.maxBytes` / `minimal.maxFiles` cap it.
   */
  repositorySection(root: string, goal: string): string {
    const index = this.indexRepository(root);
    if (!index) return '';
    const cfg = this.config.repository || {};
    if (cfg.goalHints?.enabled === false) {
      return renderRepositoryContext(index, goal, { maxListed: cfg.maxListed ?? 40 });
    }
    const staticText = renderRepositoryContext(index, goal, { relevantFiles: [], maxListed: cfg.maxListed ?? 40 });
    const hints =
      isPersistentIndex(index) && cfg.minimal?.enabled !== false
        ? this.minimalContextSection(root, goal, this.minimalContextOptions(cfg))
        : this.goalFilesSection(root, goal);
    return hints ? `${staticText}\n\n${hints}` : staticText;
  }

  /** Map the repository config onto the minimal-context selector options. */
  private minimalContextOptions(cfg: NonNullable<ContextEngineConfig['repository']>): MinimalContextOptions {
    return {
      seedLimit: cfg.goalHints?.maxFiles ?? 6,
      maxBytes: cfg.minimal?.maxBytes,
      maxFiles: cfg.minimal?.maxFiles
    };
  }

  /**
   * Phase 18 Move 7b — the rendered minimal dependency-closed context for a
   * goal: seeds, imported/importing modules, and related tests under the
   * byte/file budget, with the closure status. Persistent indexes only;
   * '' when the index is lightweight or nothing matches (callers fall back
   * to the plain goal-file hints).
   */
  minimalContextSection(root: string, goal: string, options: MinimalContextOptions = {}): string {
    return renderMinimalContext(this.minimalContext(root, goal, options));
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

  /**
   * Phase 18 Move 2 — reverse dependency lookup: files that import the
   * target (file path or module). Uses the persistent index's `importers`
   * map — persisted since Phase 8 but never queried — resolved per
   * importing file (relative specifiers against the importer's directory,
   * bare specifiers matched tolerantly by basename/path). `transitive`
   * walks dependents of dependents (the dependency closure Change-impact
   * Move 3 builds on). Empty for lightweight indexes or no dependents.
   */
  dependents(root: string, target: string, options: DependentsOptions = {}): Dependent[] {
    const index = this.indexRepository(root);
    if (!index || !isPersistentIndex(index)) return [];
    return findDependents(index, target, options);
  }

  /**
   * Phase 18 Move 3 — change-impact analysis for a changed file/module:
   * the target's exported API surface, the dependency closure (direct
   * first, then transitive when requested), and the ranked regression
   * surface of sibling + goal tests. Built on the Move 2 dependents API;
   * empty impact for lightweight indexes or unknown targets.
   */
  changeImpact(root: string, target: string, options: ChangeImpactOptions = {}): ChangeImpact {
    const index = this.indexRepository(root);
    if (!index || !isPersistentIndex(index)) return emptyChangeImpact(target);
    return analyzeChangeImpact(index, target, options);
  }

  /**
   * Phase 18 Move 5 — convention-based architecture discovery for a
   * workspace: entry points, services/APIs, workers/queues, databases,
   * test infrastructure, integrations, and config surfaces — classified
   * from the persistent index (paths, isTest/isConfig, exported symbols).
   * Undefined for lightweight indexes.
   */
  architecture(root: string): ArchitectureProfile | undefined {
    const index = this.indexRepository(root);
    if (!index || !isPersistentIndex(index)) return undefined;
    return discoverArchitecture(index);
  }

  /** Rendered architecture overview for a workspace ('' when no index). */
  architectureSection(root: string, options: ArchitectureRenderOptions = {}): string {
    const profile = this.architecture(root);
    return profile ? renderArchitectureProfile(profile, options) : '';
  }

  /**
   * Phase 18 Move 7b — the minimal dependency-closed context for a goal:
   * goal → symbols (seeds) → importing/imported modules (both directions of
   * the dependency closure) → related tests, bounded by a byte budget +
   * file cap with smallest-first admission. `closed` is true only when the
   * budget let the closure finish; bare packages are reported as external
   * leaves. Empty for lightweight indexes.
   */
  minimalContext(root: string, goal: string, options: MinimalContextOptions = {}): MinimalContext {
    const index = this.indexRepository(root);
    if (!index || !isPersistentIndex(index)) return emptyMinimalContext(goal);
    return selectMinimalContext(index, goal, options);
  }

  /**
   * Phase 18 Move 6 — files that call/reference a symbol (external callers,
   * excluding files that define it). The persisted `symbolReferences` map
   * (bounded word-boundary identifier references). Empty for lightweight
   * indexes or unknown symbols.
   */
  callersOf(root: string, symbol: string, options: SymbolUsageOptions = {}): SymbolReference[] {
    const index = this.indexRepository(root);
    if (!index || !isPersistentIndex(index)) return [];
    return findCallers(index, symbol, options);
  }

  /**
   * Phase 18 Move 6 — symbols a file references that are defined elsewhere
   * (its callees). Each entry carries the defining files. Empty for
   * lightweight indexes or unknown files.
   */
  calleesOf(root: string, filePath: string, options: SymbolUsageOptions = {}): SymbolCallee[] {
    const index = this.indexRepository(root);
    if (!index || !isPersistentIndex(index)) return [];
    return findCallees(index, filePath, options);
  }

  /**
   * Phase 18 Move 6 — files that implement or extend a symbol
   * (`implements X` / `extends Y`), repo-defined symbols only. Empty for
   * lightweight indexes or unknown symbols.
   */
  implementationsOf(root: string, symbol: string, options: SymbolUsageOptions = {}): SymbolReference[] {
    const index = this.indexRepository(root);
    if (!index || !isPersistentIndex(index)) return [];
    return findImplementations(index, symbol, options);
  }

  /**
   * Phase 18 Move 6 — the evidence pass that decided parser vs
   * usage-reference map for this workspace (per-family density, dominance,
   * parser availability, and the decision + rationale). Undefined for
   * lightweight indexes.
   */
  symbolIntelligenceEvidence(root: string): SymbolIntelligenceEvidence | undefined {
    const index = this.indexRepository(root);
    if (!index || !isPersistentIndex(index)) return undefined;
    return measureSymbolIntelligence(index);
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
