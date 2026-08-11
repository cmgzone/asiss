/**
 * SymbolSkill — resolve bare symbol references to defining files.
 *
 * Answers "where does authenticate live?" / "fix authenticate()" using the
 * persistent repository index's exportedSymbols map (Phase 8). Prefer this
 * over shell grep when the question is about a symbol's definition: it is
 * structured, instant, and carries the symbol kind and line.
 */

import { Skill } from '../core/skills';
import { ContextEngine, contextEngine } from '../core/context';

export interface SymbolSkillOptions {
  contextEngine?: ContextEngine;
}

export class SymbolSkill implements Skill {
  name = 'symbol';
  description = 'Find where a symbol (function, class, interface, or type) is defined in the repository. Provide the exact symbol name (e.g. "authenticate") or a goal phrase containing it (e.g. "fix authenticate()"); returns the defining files with the symbol kind and line. Uses the persistent repository index — fast and structured, prefer over shell grep for definition lookups.';
  capabilities = ['symbol_resolution'];

  inputSchema = {
    type: 'object',
    properties: {
      symbol: { type: 'string', description: 'Exact symbol name to resolve (e.g. authenticate, AuthService)' },
      goal: { type: 'string', description: 'Goal phrase containing symbol references to resolve (e.g. "fix authenticate()")' },
      limit: { type: 'number', description: 'Max files per symbol (default 5)' }
    }
  };

  private readonly engine: ContextEngine;

  constructor(options: SymbolSkillOptions = {}) {
    this.engine = options.contextEngine || contextEngine;
  }

  async execute(params: any): Promise<any> {
    const explicit = typeof params?.symbol === 'string' && params.symbol.trim() ? params.symbol.trim() : '';
    const goal = typeof params?.goal === 'string' && params.goal.trim() ? params.goal.trim() : '';
    const root =
      typeof params?.__workspacePath === 'string' && params.__workspacePath.trim()
        ? params.__workspacePath
        : process.cwd();
    const limit = Math.min(20, Math.max(1, typeof params?.limit === 'number' ? params.limit : 5));
    const query = explicit ? `resolve ${explicit}` : goal;
    if (!query.trim()) return { error: 'Provide a symbol name or a goal phrase containing it.' };

    try {
      // Phase 9: force an on-demand refresh so an explicit query never reads
      // a stale index (files may have changed since the last mission turn).
      this.engine.refreshRepository(root, { force: true });
      const resolved = this.engine.resolveSymbols(root, query, limit);
      if (resolved.length === 0) {
        return {
          symbol: explicit || undefined,
          goal: goal || undefined,
          path: root,
          count: 0,
          note: 'No exported symbol matched. The persistent index may need building (first run) or the symbol may be local/private.'
        };
      }
      return {
        symbol: explicit || undefined,
        goal: goal || undefined,
        path: root,
        count: resolved.length,
        results: resolved.map((r) => ({
          symbol: r.symbol,
          files: r.files.map((f) => {
            const sym = f.symbols.find((s) => s.name === r.key);
            return {
              path: f.path,
              kind: sym?.kind || 'symbol',
              line: sym?.line,
              isTest: f.isTest,
              isConfig: f.isConfig
            };
          })
        }))
      };
    } catch (err: any) {
      return { error: `Symbol resolution failed: ${err?.message || err}` };
    }
  }
}
