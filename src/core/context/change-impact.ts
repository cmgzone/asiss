/**
 * Change-impact analysis — Hermes Evolution Phase 18 Move 3.
 *
 * Given a changed file (or module), answer the audit's chain:
 *
 *   target → dependents → affected APIs/modules → related tests
 *                                                    ↓
 *                                            regression surface
 *
 * Built on the Move 2 dependents API (`findDependents` over the persisted
 * `importers` reverse index) and reusing the verify-then-retry test-matching
 * rules (stemOf sibling tests + goal stem overlap) — deliberately NO new
 * index authority, no rebuild semantics, same tolerant "not a compiler"
 * philosophy as the rest of the repository index.
 */

import { stemOverlap } from './relevance';
import { IndexedFile } from './repository-context';
import { Dependent, findDependents, IndexedFileDetail, PersistentRepositoryIndex } from './repo-index';
import { stemOf } from './verify-then-retry';

export interface ImpactedFile extends Dependent {
  /** Import hops from the target: 1 = direct dependent, 2 = transitive. */
  depth: number;
  /** Symbols this impacted file exports (the consuming API surface). */
  exportedSymbols: string[];
}

export interface ChangeImpactOptions {
  /** Include transitive dependents (the dependency closure). Default false. */
  transitive?: boolean;
  /** Cap impacted files considered. Default 50. */
  limit?: number;
  /** Optional goal to bias test selection (reuses the goal stem-overlap rule). */
  goal?: string;
  /** Cap the regression surface (tests). Default 8. */
  testLimit?: number;
  /** Cap exported symbols listed per file. Default 32. */
  symbolLimit?: number;
}

export interface ChangeImpact {
  /** The changed file/module as queried (root-relative path). */
  target: string;
  /** Symbols the target exports — the affected API surface. */
  exportedSymbols: string[];
  /** Impacted files, direct (depth 1) before transitive, sorted by path. */
  dependents: ImpactedFile[];
  /** Tests most likely to break, ranked by impacted-file coverage + goal. */
  regressionSurface: IndexedFile[];
  /** Human-readable summary (renders into context/skills). */
  detail: string;
}

export function emptyChangeImpact(target: string): ChangeImpact {
  return {
    target,
    exportedSymbols: [],
    dependents: [],
    regressionSurface: [],
    detail: `Change impact for ${target}: no persistent index or no dependents found.`
  };
}

/**
 * The dependency closure with hop depth. Reuses the Move 2 dependents API
 * level by level: direct dependents first (depth 1), then dependents of
 * dependents (depth 2+) when `transitive` is set, capped and deduped.
 */
function dependentClosure(
  index: PersistentRepositoryIndex,
  target: string,
  limit: number,
  symbolLimit: number,
  transitive: boolean
): ImpactedFile[] {
  const byPath = new Map(index.files.map((f) => [f.path, f]));
  const out: ImpactedFile[] = [];
  const seen = new Set<string>([target]);
  let frontier: string[] = [target];
  let depth = 1;
  while (frontier.length > 0 && out.length < limit && (transitive || depth === 1)) {
    const next: string[] = [];
    for (const current of frontier) {
      for (const d of findDependents(index, current, { limit: limit - out.length })) {
        if (seen.has(d.path)) continue;
        seen.add(d.path);
        const file = byPath.get(d.path);
        out.push({
          ...d,
          depth,
          exportedSymbols: (file?.symbols || []).map((s) => s.name).slice(0, symbolLimit)
        });
        next.push(d.path);
      }
    }
    frontier = next;
    depth += 1;
  }
  return out.sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));
}

/**
 * Tests most likely to break when `target` changes: sibling tests of the
 * target itself plus every impacted NON-test file (the matchedTestFiles
 * sibling rule — stemOf equality), ranked by how many impacted files each
 * test covers; when `goal` is given, goal-surfaced tests (the same
 * stem-overlap rule matchedTestFiles uses) are added with equal weight.
 */
function regressionSurfaceOf(
  index: PersistentRepositoryIndex,
  target: string,
  impacted: ImpactedFile[],
  goal: string | undefined,
  testLimit: number
): IndexedFile[] {
  // Sibling stems: the changed file first, then each impacted source file.
  const stems = new Map<string, number>();
  const bump = (stem: string): void => {
    stems.set(stem, (stems.get(stem) || 0) + 1);
  };
  bump(stemOf(target));
  for (const dep of impacted) {
    if (!dep.isTest) bump(stemOf(dep.path));
  }

  const tests = index.files.filter((f): f is IndexedFileDetail => (f as IndexedFileDetail).isTest === true);
  const scored: Array<{ file: IndexedFile; score: number }> = [];
  for (const test of tests) {
    const stem = stemOf(test.path);
    let score = stems.get(stem) || 0;
    if (goal) score += stemOverlap(goal, test.path) > 0 ? 1 : 0;
    if (score > 0) scored.push({ file: test, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path))
    .slice(0, testLimit)
    .map((s) => s.file);
}

function renderDetail(
  target: string,
  exportedSymbols: string[],
  dependents: ImpactedFile[],
  regressionSurface: IndexedFile[],
  transitive: boolean
): string {
  const lines: string[] = [`Change impact for ${target}:`];
  if (exportedSymbols.length > 0) lines.push(`- exports: ${exportedSymbols.join(', ')}`);
  if (dependents.length === 0) {
    lines.push('- no dependents found');
  } else {
    const direct = dependents.filter((d) => d.depth === 1).length;
    lines.push(`- ${dependents.length} impacted file(s) (${direct} direct${transitive ? ', transitive closure' : ''})`);
    for (const d of dependents.slice(0, 12)) {
      lines.push(`  - ${d.path} (${d.specifier || '?'}, depth ${d.depth}${d.isTest ? ', test' : ''})`);
    }
  }
  if (regressionSurface.length > 0) {
    lines.push(`- regression surface (${regressionSurface.length} tests):`);
    for (const t of regressionSurface.slice(0, 8)) lines.push(`  - ${t.path}`);
  } else {
    lines.push('- no matched regression tests');
  }
  return lines.join('\n');
}

/**
 * Full change-impact for a changed file/module against the persistent index:
 * the target's exported API surface, the dependency closure (direct first),
 * and the ranked regression surface of sibling + goal tests. Empty impact
 * when the target is unknown or the index carries no dependents data.
 */
export function analyzeChangeImpact(
  index: PersistentRepositoryIndex,
  target: string,
  options: ChangeImpactOptions = {}
): ChangeImpact {
  const limit = options.limit ?? 50;
  const symbolLimit = options.symbolLimit ?? 32;
  const testLimit = options.testLimit ?? 8;
  const targetFile = index.files.find((f) => f.path === target);
  if (!targetFile) return emptyChangeImpact(target);

  const exportedSymbols = targetFile.symbols.map((s) => s.name).slice(0, symbolLimit);
  const dependents = dependentClosure(index, target, limit, symbolLimit, options.transitive === true);
  const regressionSurface = regressionSurfaceOf(index, target, dependents, options.goal, testLimit);
  return {
    target,
    exportedSymbols,
    dependents,
    regressionSurface,
    detail: renderDetail(target, exportedSymbols, dependents, regressionSurface, options.transitive === true)
  };
}
