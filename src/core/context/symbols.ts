/**
 * Deeper symbol intelligence — Hermes Evolution Phase 18 Move 6.
 *
 * The audit's G5 gap: symbol extraction is regex-shallow — four kinds, no
 * references, no callers/callees/implementations. Move 6 is the
 * evidence-based decision between two increments:
 *
 *   parser              — a real AST parser for ONE language family, feeding
 *                         precise callers/callees
 *   usage-reference map — word-boundary identifier references over the
 *                         existing extraction, universal across families
 *
 * The decision is data-driven (`symbolIntelligenceEvidence`): a real parser
 * only wins for a single-family TypeScript corpus (the only family with an
 * in-tree parser available, `typescript`). Any mixed corpus — or a dominant
 * family without an in-tree parser — gets the usage-reference map, the only
 * option that covers every family with zero new dependencies and no second
 * index authority. The map's data lives in the persisted index built by
 * repo-index.ts (`identifiers` / `implementedSymbols` per file, derived
 * `symbolReferences` / `implementations` at index level); this module only
 * QUERIES it (callers / callees / implementations) and reports the evidence.
 * Same tolerant "not a compiler" philosophy as the rest of the index:
 * references are bounded, deduped, sorted, and may include noise.
 */

import type { PersistentRepositoryIndex } from './repo-index';
import { hasOwnKey, symbolFamily } from './repo-index';

export interface SymbolUsageOptions {
  /** Cap results. Default 50. */
  limit?: number;
}

/** A file that references (or implements) a symbol, with its flags. */
export interface SymbolReference {
  path: string;
  isTest: boolean;
  isConfig: boolean;
}

/** One symbol a file references, with the files that define it. */
export interface SymbolCallee {
  symbol: string;
  definingFiles: SymbolReference[];
}

function toReferences(index: PersistentRepositoryIndex, paths: string[], limit: number): SymbolReference[] {
  const byPath = new Map(index.files.map((f) => [f.path, f]));
  const out: SymbolReference[] = [];
  for (const p of paths) {
    const file = byPath.get(p);
    out.push({ path: p, isTest: Boolean(file?.isTest), isConfig: Boolean(file?.isConfig) });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Files that reference a symbol (external callers/users) — the persisted
 * `symbolReferences` map, excluding files that define the symbol itself.
 * Sorted by path, deduped, capped. Empty for unknown symbols or
 * lightweight indexes.
 */
export function findCallers(
  index: PersistentRepositoryIndex,
  symbol: string,
  options: SymbolUsageOptions = {}
): SymbolReference[] {
  const limit = options.limit ?? 50;
  const map = index.symbolReferences || {};
  const paths = (hasOwnKey(map, symbol) ? map[symbol] : []).slice().sort((a, b) => a.localeCompare(b));
  return toReferences(index, paths.slice(0, limit), limit);
}

/**
 * Files that implement or extend a symbol (`implements X` / `extends Y`) —
 * the persisted `implementations` map (repo-defined symbols only). Sorted
 * by path, deduped, capped. Empty for unknown symbols or lightweight
 * indexes.
 */
export function findImplementations(
  index: PersistentRepositoryIndex,
  symbol: string,
  options: SymbolUsageOptions = {}
): SymbolReference[] {
  const limit = options.limit ?? 50;
  const map = index.implementations || {};
  const paths = (hasOwnKey(map, symbol) ? map[symbol] : []).slice().sort((a, b) => a.localeCompare(b));
  return toReferences(index, paths.slice(0, limit), limit);
}

/**
 * Symbols a file references that are defined ELSEWHERE in the repo — the
 * file's bounded `identifiers` intersected with `exportedSymbols`, minus
 * its own definitions. Each entry carries the defining files (the callee
 * definitions). Sorted by symbol name, capped. Empty for unknown files,
 * files with no references, or lightweight indexes. Bounded: files past
 * the identifier cap report partial callees (tolerant, documented).
 */
export function findCallees(
  index: PersistentRepositoryIndex,
  filePath: string,
  options: SymbolUsageOptions = {}
): SymbolCallee[] {
  const limit = options.limit ?? 50;
  const file = index.files.find((f) => f.path === filePath);
  if (!file) return [];
  const own = new Set(file.symbols.map((s) => s.name));
  const out: SymbolCallee[] = [];
  for (const id of file.identifiers || []) {
    if (own.has(id) || !hasOwnKey(index.exportedSymbols, id)) continue;
    const defining = index.exportedSymbols[id];
    if (!defining || defining.length === 0) continue;
    out.push({
      symbol: id,
      definingFiles: toReferences(index, [...defining].sort((a, b) => a.localeCompare(b)), limit)
    });
    if (out.length >= limit) break;
  }
  return out.sort((a, b) => a.symbol.localeCompare(b.symbol)).slice(0, limit);
}

/** ------------------------------------------------------------------ */
/* The evidence pass — parser vs usage-reference map, decided on data.  */
/** ------------------------------------------------------------------ */

export type SymbolIntelligenceDecision = 'parser' | 'usage-reference-map';

export interface SymbolFamilyEvidence {
  family: string;
  files: number;
  symbols: number;
  avgSymbolsPerFile: number;
}

export interface SymbolIntelligenceEvidence {
  root: string;
  totalFiles: number;
  totalSymbols: number;
  /** Families ranked by file count (desc), with symbol density. */
  families: SymbolFamilyEvidence[];
  dominantFamily: string | null;
  dominantShare: number;
  /** True when the dominant family is TypeScript (only family with an in-tree parser). */
  parserAvailable: boolean;
  /** True when non-dominant families still carry indexed symbols (a one-family parser would miss them). */
  crossFamilySymbols: boolean;
  /** Usage-reference edges the map would produce (identifiers hitting repo-defined symbols). */
  referenceEdges: number;
  /** Bytes a real TS parse would re-read on every build/refresh. */
  parserCostBytes: number;
  decision: SymbolIntelligenceDecision;
  rationale: string;
}

/** Count usage-reference edges: file identifiers that hit repo-defined symbols. */
function referenceEdgeCount(index: PersistentRepositoryIndex): number {
  let edges = 0;
  for (const file of index.files) {
    if (!file.identifiers || file.identifiers.length === 0) continue;
    const own = new Set(file.symbols.map((s) => s.name));
    for (const id of file.identifiers) {
      if (!own.has(id) && hasOwnKey(index.exportedSymbols, id)) edges += 1;
    }
  }
  return edges;
}

/**
 * Measure the corpus and decide the deeper-symbol increment:
 *
 *   - no dominant family (largest < 50% of files)  -> usage-reference map
 *   - dominant family has no in-tree parser        -> usage-reference map
 *   - dominant family is TS but other families
 *     still carry symbols                          -> usage-reference map
 *   - single-family TypeScript corpus              -> parser is viable
 *
 * The reference map is implemented regardless (AUDIT_9 G5: "do not build a
 * second index authority") — this decides WHAT the evidence justifies, so
 * a future single-family TS corpus knows a parser is the next increment.
 */
export function symbolIntelligenceEvidence(index: PersistentRepositoryIndex): SymbolIntelligenceEvidence {
  const perFamily = new Map<string, SymbolFamilyEvidence>();
  let totalSymbols = 0;
  let parserCostBytes = 0;
  for (const file of index.files) {
    const family = symbolFamily(file.extension);
    let entry = perFamily.get(family);
    if (!entry) {
      entry = { family, files: 0, symbols: 0, avgSymbolsPerFile: 0 };
      perFamily.set(family, entry);
    }
    entry.files += 1;
    entry.symbols += file.symbols.length;
    totalSymbols += file.symbols.length;
    if (family === 'typescript') parserCostBytes += file.size;
  }
  const families = [...perFamily.values()]
    .sort((a, b) => b.files - a.files || a.family.localeCompare(b.family))
    .map((f) => ({ ...f, avgSymbolsPerFile: f.files ? Math.round((f.symbols / f.files) * 10) / 10 : 0 }));

  const totalFiles = index.fileCount;
  const dominant = families[0] || null;
  const dominantShare = dominant && totalFiles > 0 ? dominant.files / totalFiles : 0;
  const parserAvailable = dominant?.family === 'typescript';
  const crossFamilySymbols = families.some((f) => f !== dominant && f.symbols > 0);

  let decision: SymbolIntelligenceDecision;
  let rationale: string;
  if (!dominant || dominantShare < 0.5) {
    decision = 'usage-reference-map';
    rationale = `No dominant language family — largest is ${dominant?.family || 'none'} at ${(dominantShare * 100).toFixed(0)}% of ${totalFiles} files. A one-family parser would cover under half the corpus; the usage-reference map covers every family.`;
  } else if (!parserAvailable) {
    decision = 'usage-reference-map';
    rationale = `${dominant.family} dominates at ${(dominantShare * 100).toFixed(0)}% but has no in-tree parser — importing one would add a dependency and a second index authority; the usage-reference map needs neither.`;
  } else if (crossFamilySymbols) {
    decision = 'usage-reference-map';
    rationale = `TypeScript dominates at ${(dominantShare * 100).toFixed(0)}% but other families still carry symbols — a TS-only parser would miss them; the word-boundary usage-reference map covers every family from the existing extraction.`;
  } else {
    decision = 'parser';
    rationale = `Single-family TypeScript corpus (${dominant.files} files, ${parserCostBytes} bytes of source) — a real parser is viable for precise callers/callees.`;
  }

  return {
    root: index.root,
    totalFiles,
    totalSymbols,
    families,
    dominantFamily: dominant?.family || null,
    dominantShare,
    parserAvailable,
    crossFamilySymbols,
    referenceEdges: referenceEdgeCount(index),
    parserCostBytes,
    decision,
    rationale
  };
}

/** Human-readable evidence summary (renders into context/docs). */
export function renderSymbolIntelligenceEvidence(evidence: SymbolIntelligenceEvidence): string {
  const lines = [
    `Symbol intelligence evidence for ${evidence.root}:`,
    `- ${evidence.totalFiles} files, ${evidence.totalSymbols} symbols, ${evidence.referenceEdges} usage-reference edges`,
    `- families: ${evidence.families.map((f) => `${f.family} (${f.files} files, ${f.symbols} symbols)`).join(', ')}`,
    `- decision: ${evidence.decision} — ${evidence.rationale}`
  ];
  return lines.join('\n');
}
