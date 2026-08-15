/**
 * ArchitectureSkill — describe a repository's architecture.
 *
 * Answers "what is this repository's architecture?" using the persistent
 * repository index's convention-based classification (Phase 18 Move 5):
 * entry points, services/APIs, workers/queues, databases, test
 * infrastructure, integrations, and configuration surfaces. Force-warms so
 * an explicit query never reads a stale index, mirroring SymbolSkill.
 */

import { Skill } from '../core/skills';
import { projectContextFromParams } from './workspace-guard';
import { ContextEngine, contextEngine, renderArchitectureProfile } from '../core/context';

export interface ArchitectureSkillOptions {
  contextEngine?: ContextEngine;
}

export class ArchitectureSkill implements Skill {
  name = 'architecture';
  description = 'Describe the architecture of a repository: entry points, services/APIs, workers/queues, databases, test infrastructure, integrations, and configuration surfaces — a convention-based, heuristic pass over the persistent repository index. Returns the classified buckets and a rendered overview.';
  capabilities = ['architecture_discovery'];

  inputSchema = {
    type: 'object',
    properties: {
      maxPerBucket: { type: 'number', description: 'Cap files listed per bucket in the rendered overview (default 8)' }
    }
  };

  private readonly engine: ContextEngine;

  constructor(options: ArchitectureSkillOptions = {}) {
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

    try {
      // Phase 9 discipline: force an on-demand refresh so an explicit query
      // never reads a stale index (files may have changed since last turn).
      this.engine.refreshRepository(projectContext || root, { force: true, sessionId: params?.__sessionId });
      const profile = this.engine.architecture(root);
      if (!profile) {
        return {
          path: root,
          note: 'No persistent repository index for this workspace yet — run a mission with the repository section enabled (or a /warmth refresh) to build it.'
        };
      }
      const cap = (files: Array<{ path: string }>): Array<{ path: string }> => files.slice(0, 8);
      return {
        path: root,
        profile: {
          fileCount: profile.fileCount,
          languages: profile.languages,
          entryPoints: cap(profile.entryPoints),
          services: cap(profile.services),
          workers: cap(profile.workers),
          databases: cap(profile.databases),
          integrations: cap(profile.integrations),
          testFiles: cap(profile.testFiles),
          testConfigs: cap(profile.testConfigs),
          configFiles: cap(profile.configFiles)
        },
        section: renderArchitectureProfile(profile, { maxPerBucket: params?.maxPerBucket ?? 8 })
      };
    } catch (err: any) {
      return { error: `Architecture discovery failed: ${err?.message || err}` };
    }
  }
}
