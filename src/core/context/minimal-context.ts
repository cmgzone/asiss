/**
 * Minimal dependency-closed context — Hermes Evolution Phase 18 Move 7b (G7).
 *
 * The audit's G7 gap: "relevant context" was `matchBySymbols` ranking + the
 * token budget — no selection of the smallest dependency-closed set. This
 * module walks the audit's chain — goal → symbols (seeds) → importing /
 * imported modules (the dependency closure over the Move 2 dependents API
 * plus the per-file imports graph) → related tests — and returns the
 * budgeted, dependency-closed context the Phase 18 row names.
 *
 * Closure semantics: the returned set is *closed* when every in-repo module
 * referenced by an included file (both directions: what it imports, what
 * imports it) is itself included. Bare specifiers (packages/aliases) resolve
 * to nothing in-repo and are reported as `externalModules` — legitimate
 * leaves, not missing closure. Bounded by a byte budget + file cap with
 * smallest-first admission, so large unrelated files never displace the
 * dependency spine. No new index authority: everything comes from the
 * persisted index (matchBySymbols, findDependents, resolveImportTarget) and
 * the existing test-matching rules (matchedTestFiles).
 */

import { estimateTokens } from './context-budget';
import {
  findDependents,
  hasGoalSignalForFile,
  IndexedFileDetail,
  matchBySymbols,
  normPath,
  PersistentRepositoryIndex,
  resolveImportTarget
} from './repo-index';
import { matchedTestFiles } from './verify-then-retry';

export type MinimalContextRole = 'seed' | 'dependency' | 'dependent' | 'test';

export interface MinimalContextFile {
  path: string;
  size: number;
  isTest: boolean;
  isConfig: boolean;
  role: MinimalContextRole;
  /** BFS depth from the seeds: 0 = seed, 1 = direct, 2+ = transitive. */
  depth: number;
}

export interface MinimalContextOptions {
  /** Byte budget for the returned source. Default 96 KB. */
  maxBytes?: number;
  /** Hard cap on returned files. Default 40. */
  maxFiles?: number;
  /** Seeds from the symbol matcher. Default 6. */
  seedLimit?: number;
  /** Cap related tests. Default 8. */
  testLimit?: number;
  /** Walk importing modules (dependents). Default true. */
  includeDependents?: boolean;
  /** Walk imported modules. Default true. */
  includeImports?: boolean;
  /** Append goal/sibling tests. Default true. */
  includeTests?: boolean;
  /**
   * Explicit seed file paths (instead of goal matching) — the dependency
   * closure around ONE file, e.g. "what must change with auth.ts?". Unknown
   * paths are skipped; when all are unknown the context is empty. Exclusive
   * with goal-derived seeds.
   */
  seedFiles?: string[];
}

export interface MinimalContext {
  goal: string;
  /** The selected set: seeds, then dependencies, then dependents, then tests. */
  files: MinimalContextFile[];
  /** The seed file paths (goal → symbols). */
  seeds: string[];
  totalBytes: number;
  /** Estimate at the codebase rate (~4 chars per token). */
  totalTokens: number;
  /** Bare package/alias specifiers left outside the closure (external leaves). */
  externalModules: string[];
  /** True when every in-repo reference of the included files is included. */
  closed: boolean;
  /** True when the byte/file budget cut the closure short. */
  truncated: boolean;
}

const ROLE_RANK: Record<MinimalContextRole, number> = { seed: 0, dependency: 1, dependent: 2, test: 3 };

/** Empty result for lightweight indexes / unknown roots. */
export function emptyMinimalContext(goal: string): MinimalContext {
  return { goal, files: [], seeds: [], totalBytes: 0, totalTokens: 0, externalModules: [], closed: false, truncated: false };
}

/**
 * Select the smallest budgeted, dependency-closed set for a goal. Seeds are
 * always included (they are the point); anything else is admitted
 * smallest-first while the byte budget and file cap allow. `closed` is only
 * true when the budget let the closure finish.
 */
export function selectMinimalContext(
  index: PersistentRepositoryIndex,
  goal: string,
  options: MinimalContextOptions = {}
): MinimalContext {
  const maxBytes = options.maxBytes ?? 96 * 1024;
  const maxFiles = options.maxFiles ?? 40;
  const seedLimit = options.seedLimit ?? 6;
  const testLimit = options.testLimit ?? 8;
  const includeDependents = options.includeDependents !== false;
  const includeImports = options.includeImports !== false;

  const byPath = new Map(index.files.map((f) => [f.path, f]));
  const byNorm = new Map<string, string>();
  for (const f of index.files) {
    const n = normPath(f.path);
    if (!byNorm.has(n)) byNorm.set(n, f.path);
  }

  // Only real goal signal counts as a seed — the matcher's depth bonus must
  // not drag unrelated files in (the same gate the hint renderer uses).
  // Explicit seedFiles bypass matching (the caller named the file directly)
  // and are capped by the same seedLimit.
  const explicitSeeds = Array.isArray(options.seedFiles)
    ? options.seedFiles.map((p) => byPath.get(p)).filter((f): f is IndexedFileDetail => Boolean(f))
    : [];
  const seeds =
    explicitSeeds.length > 0
      ? explicitSeeds.slice(0, seedLimit)
      : matchBySymbols(index, goal, seedLimit).filter((f) => hasGoalSignalForFile(f, goal));
  if (seeds.length === 0) return emptyMinimalContext(goal);

  const inSet = new Map<string, MinimalContextFile>();
  const external = new Set<string>();
  let bytes = 0;
  let truncated = false;

  const add = (file: IndexedFileDetail, role: MinimalContextRole, depth: number): boolean => {
    if (inSet.has(file.path)) return false;
    if (inSet.size >= maxFiles) {
      truncated = true;
      return false;
    }
    if (inSet.size > 0 && bytes + file.size > maxBytes) {
      truncated = true;
      return false;
    }
    inSet.set(file.path, {
      path: file.path,
      size: file.size,
      isTest: file.isTest,
      isConfig: file.isConfig,
      role,
      depth
    });
    bytes += file.size;
    return true;
  };

  for (const seed of seeds) add(seed, 'seed', 0);

  // BFS over the dependency graph, both directions, smallest-first admission.
  const queue: Array<{ path: string; depth: number }> = seeds.map((s) => ({ path: s.path, depth: 0 }));
  let qi = 0;
  while (qi < queue.length && inSet.size < maxFiles) {
    const { path: current, depth } = queue[qi++];
    const file = byPath.get(current);
    if (!file) continue;
    const nextDepth = depth + 1;
    const candidates: Array<{ f: IndexedFileDetail; role: 'dependency' | 'dependent' }> = [];
    if (includeImports) {
      for (const spec of file.imports) {
        const resolved = resolveImportTarget(file.path, spec);
        if (!resolved) {
          external.add(spec);
          continue;
        }
        const targetPath = byNorm.get(resolved) || byNorm.get(`${resolved}/index`);
        const target = targetPath ? byPath.get(targetPath) : undefined;
        if (target && !inSet.has(target.path)) candidates.push({ f: target, role: 'dependency' });
      }
    }
    if (includeDependents) {
      for (const dep of findDependents(index, current, { limit: 24 })) {
        const d = byPath.get(dep.path);
        if (d && !inSet.has(d.path)) candidates.push({ f: d, role: 'dependent' });
      }
    }
    candidates.sort((a, b) => a.f.size - b.f.size);
    for (const c of candidates) {
      if (add(c.f, c.role, nextDepth)) queue.push({ path: c.f.path, depth: nextDepth });
      if (inSet.size >= maxFiles) break;
    }
  }

  // Closure check: every in-repo reference of an included file is included.
  let closed = true;
  for (const entry of inSet.values()) {
    const file = byPath.get(entry.path);
    if (!file) continue;
    for (const spec of file.imports) {
      const resolved = resolveImportTarget(file.path, spec);
      if (!resolved) continue;
      const targetPath = byNorm.get(resolved) || byNorm.get(`${resolved}/index`);
      if (targetPath && !inSet.has(targetPath)) {
        closed = false;
        break;
      }
    }
    if (!closed) break;
  }

  // Related tests: goal-surfaced + sibling tests of included non-test files
  // (the signal-gated matchedTestFiles rule — no depth-bonus noise).
  if (options.includeTests !== false) {
    const nonTests = [...inSet.values()]
      .filter((e) => !e.isTest)
      .map((e) => byPath.get(e.path))
      .filter((f): f is IndexedFileDetail => Boolean(f));
    for (const test of matchedTestFiles(index, goal, nonTests, testLimit)) {
      if (inSet.has(test.path)) continue;
      const detail = byPath.get(test.path);
      if (!detail) continue;
      if (!add(detail, 'test', 1)) break;
    }
  }

  const files = [...inSet.values()].sort(
    (a, b) => ROLE_RANK[a.role] - ROLE_RANK[b.role] || a.path.localeCompare(b.path)
  );

  return {
    goal,
    files,
    seeds: seeds.map((s) => s.path),
    totalBytes: bytes,
    totalTokens: Math.round(bytes / 4),
    externalModules: [...external].sort(),
    closed,
    truncated
  };
}

/** Human-readable section for the mission prompt. */
export function renderMinimalContext(ctx: MinimalContext): string {
  if (ctx.files.length === 0) return '';
  const byRole: Record<MinimalContextRole, string[]> = { seed: [], dependency: [], dependent: [], test: [] };
  for (const f of ctx.files) byRole[f.role].push(f.path);
  const lines = [`Minimal dependency-closed context for: ${ctx.goal}`];
  if (byRole.seed.length) lines.push(`Relevant files: ${byRole.seed.join(', ')}`);
  if (byRole.dependency.length) lines.push(`Imported modules: ${byRole.dependency.join(', ')}`);
  if (byRole.dependent.length) lines.push(`Importing modules: ${byRole.dependent.join(', ')}`);
  if (byRole.test.length) lines.push(`Related tests: ${byRole.test.join(', ')}`);
  lines.push(
    `Total: ${ctx.totalBytes} bytes (~${ctx.totalTokens} tokens), ${ctx.files.length} files — ${ctx.closed ? 'dependency-closed' : 'closure truncated'}${ctx.truncated ? ' (budget-limited)' : ''}`
  );
  if (ctx.externalModules.length) lines.push(`External modules (not in repo): ${ctx.externalModules.join(', ')}`);
  return lines.join('\n');
}
