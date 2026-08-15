/**
 * MinimalContextSkill — compute the smallest dependency-closed context.
 *
 * Answers "what files do I need for this goal?" / "what's the closure
 * around this file?" using the Phase 18 Move 7b selector: goal → seeds →
 * imported/importing modules → related tests, bounded by a byte/file budget,
 * with the closure status (dependency-closed or truncated). Force-warms so
 * an explicit query never reads a stale index, mirroring SymbolSkill /
 * WarmthSkill / ArchitectureSkill.
 */

import { Skill } from '../core/skills';
import { projectContextFromParams } from './workspace-guard';
import { ContextEngine, contextEngine, renderMinimalContext } from '../core/context';

export interface MinimalContextSkillOptions {
  contextEngine?: ContextEngine;
}

export class MinimalContextSkill implements Skill {
  name = 'minimal_context';
  description = 'Compute the minimal dependency-closed context for a goal or a single file: the smallest budgeted set of relevant files plus the modules they import and the modules that import them, plus related tests, with the closure status (dependency-closed or truncated by budget). Provide goal (e.g. "fix the authentication flow") or file (a root-relative path like "src/auth/auth.ts"). Uses the persistent repository index — structured and instant, prefer over shell greps when you need the dependency closure around a change.';
  capabilities = ['context_closure'];

  inputSchema = {
    type: 'object',
    properties: {
      goal: { type: 'string', description: 'Goal phrase to resolve seeds from (e.g. "fix the authentication flow")' },
      file: { type: 'string', description: 'Root-relative file path to expand the dependency closure around (e.g. "src/auth/auth.ts") — exclusive with goal' },
      maxBytes: { type: 'number', description: 'Byte budget for the selected source set (default 98304)' },
      maxFiles: { type: 'number', description: 'Hard cap on selected files (default 40)' }
    }
  };

  private readonly engine: ContextEngine;

  constructor(options: MinimalContextSkillOptions = {}) {
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
    const goal = typeof params?.goal === 'string' && params.goal.trim() ? params.goal.trim() : '';
    const file = typeof params?.file === 'string' && params.file.trim() ? params.file.trim() : '';
    if (!goal && !file) return { error: 'Provide a goal phrase or a root-relative file path.' };

    try {
      // Phase 9 discipline: force an on-demand refresh so an explicit query
      // never reads a stale index (files may have changed since last turn).
      this.engine.refreshRepository(projectContext || root, { force: true, sessionId: params?.__sessionId });
      const context = this.engine.minimalContext(root, goal, {
        seedFiles: file ? [file] : undefined,
        maxBytes: typeof params?.maxBytes === 'number' ? params.maxBytes : undefined,
        maxFiles: typeof params?.maxFiles === 'number' ? params.maxFiles : undefined
      });
      if (context.files.length === 0) {
        return {
          path: root,
          goal: goal || undefined,
          file: file || undefined,
          note: 'No persistent repository index for this workspace yet (build one with a mission or a /warmth refresh), or nothing matched the goal/file.'
        };
      }
      return {
        path: root,
        goal: goal || undefined,
        file: file || undefined,
        context: {
          seeds: context.seeds,
          files: context.files,
          totalBytes: context.totalBytes,
          totalTokens: context.totalTokens,
          externalModules: context.externalModules,
          closed: context.closed,
          truncated: context.truncated
        },
        section: renderMinimalContext(context)
      };
    } catch (err: any) {
      return { error: `Minimal context failed: ${err?.message || err}` };
    }
  }
}
