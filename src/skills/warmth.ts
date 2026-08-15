/**
 * WarmthSkill — answer how fresh the repository index is.
 *
 * Lets Hermes reason about its own repository intelligence:
 *   "Is the repository index fresh?"
 *   "What changed in the last refresh?"
 *   "Refresh the symbols for this workspace."
 *
 * Reads the per-root warmth snapshots recorded by ContextEngine (Phase 9
 * telemetry) and can trigger a forced incremental refresh on demand.
 */

import { Skill } from '../core/skills';
import { projectContextFromParams } from './workspace-guard';
import { ContextEngine, contextEngine } from '../core/context';

export interface WarmthSkillOptions {
  contextEngine?: ContextEngine;
}

export class WarmthSkill implements Skill {
  name = 'warmth';
  description = 'Report how fresh the repository index is: when it was last refreshed, how many files/symbols changed, and whether the index is fresh, recent, or stale. Actions: status (default), refresh (force an incremental re-index and report what changed).';
  capabilities = ['index_warmth'];

  inputSchema = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['status', 'refresh'],
        description: 'status (default) reports freshness; refresh forces an incremental re-index'
      }
    }
  };

  private readonly engine: ContextEngine;

  constructor(options: WarmthSkillOptions = {}) {
    this.engine = options.contextEngine || contextEngine;
  }

  async execute(params: any): Promise<any> {
    // Phase 23 — bound calls carry the canonical ProjectContext; the index is
    // project-owned. Unbound calls fall back to the legacy workspace/root.
    const projectContext = projectContextFromParams(params);
    const root =
      projectContext?.workspaceRoot
      || (typeof params?.__workspacePath === 'string' && params.__workspacePath.trim()
        ? params.__workspacePath
        : process.cwd()); // phase23-ok: unbound (no attached project) legacy fallback
    const action = params?.action === 'refresh' ? 'refresh' : 'status';

    try {
      if (action === 'refresh') {
        this.engine.refreshRepository(projectContext || root, { force: true, sessionId: params?.__sessionId });
      }
      const warmth = this.engine.indexWarmth(root);
      if (!warmth) {
        return {
          action,
          path: root,
          freshness: 'never_warmed',
          note: 'The repository index has not been built for this workspace yet. Run the refresh action (or a mission with the repository section enabled) to index it.'
        };
      }
      const ageMs = Date.now() - warmth.lastRefreshedAt;
      const freshness = ageMs < 30_000 ? 'fresh' : ageMs < 600_000 ? 'recent' : 'stale';
      return {
        action,
        path: root,
        freshness,
        lastRefreshMsAgo: ageMs,
        fileCount: warmth.fileCount,
        filesReParsed: warmth.filesReParsed,
        symbolsRefreshed: warmth.symbolsRefreshed,
        sessionId: warmth.sessionId,
        note: freshness === 'stale'
          ? 'The index is older than 10 minutes; run the refresh action to re-index.'
          : undefined
      };
    } catch (err: any) {
      return { error: `Warmth check failed: ${err?.message || err}` };
    }
  }
}
