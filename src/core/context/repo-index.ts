/**
 * Repository intelligence — Hermes Evolution Phase 8.
 *
 * A persistent, symbol-aware repository index on top of Phase 7's lightweight
 * per-build index. For each source file we extract symbols (functions,
 * classes, interfaces, types), imports (a module graph), and test/config
 * classification, then persist the whole index to disk under the standard
 * data root and refresh it incrementally — only files whose mtime or size
 * changed are re-parsed. Coding tasks then resolve directly to the relevant
 * files: "fix authentication" -> src/auth/*, middleware/auth.ts, tests/auth/*.
 *
 * The extraction is deliberately dependency-free, regex-based and tolerant:
 * it is a scoring signal for context selection, not a compiler. It never
 * throws on unreadable or huge files (they just carry no symbols).
 *
 * Phase 18 Move 6 (deeper symbol intelligence) extends the same discipline:
 * each file carries a bounded `identifiers` list (the usage-reference signal)
 * and its `implementedSymbols`; finalize derives the index-level
 * `symbolReferences` (symbol -> files that reference it) and `implementations`
 * (symbol -> files that implement/extends it) maps. The evidence-based
 * decision between a real parser and this usage-reference map is documented
 * in symbols.ts — the map won because it covers every language family with
 * zero new dependencies and stays incremental-refresh compatible.
 */

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { relevanceScore, significantTokens, stemOverlap } from './relevance';
import {
  fileRelevance,
  IndexedFile,
  indexWorkspace,
  matchFiles,
  RepositoryContextOptions,
  RepositoryIndex
} from './repository-context';

export type SymbolKind = 'function' | 'class' | 'interface' | 'type';

export interface SymbolRef {
  kind: SymbolKind;
  name: string;
  line: number;
}

/** An indexed file enriched with symbols, imports and classification. */
export interface IndexedFileDetail extends IndexedFile {
  symbols: SymbolRef[];
  /** Module specifiers this file imports (for the import graph). */
  imports: string[];
  /** Named things pulled in (defaults + named imports) — matching signal. */
  importedNames: string[];
  /** Distinct identifiers in content (bounded) — the Phase 18 Move 6 usage-reference signal. */
  identifiers: string[];
  /** Symbols this file implements/extends (implements X / extends Y, bounded). */
  implementedSymbols: string[];
  isTest: boolean;
  isConfig: boolean;
  /** File mtime, used for incremental refresh. */
  mtimeMs: number;
}

export interface PersistentRepositoryIndex extends RepositoryIndex {
  files: IndexedFileDetail[];
  version: number;
  /** Symbol name -> file paths that define it. */
  exportedSymbols: Record<string, string[]>;
  /** Module specifier -> file paths that import it. */
  importers: Record<string, string[]>;
  /** Symbol name -> file paths that reference it (external, excluding definers). */
  symbolReferences: Record<string, string[]>;
  /** Symbol name -> file paths that implement/extends it (repo-defined symbols only). */
  implementations: Record<string, string[]>;
}

export interface PersistentIndexOptions extends RepositoryContextOptions {
  /** Skip content extraction for files larger than this (bytes). Default 512 KB. */
  maxFileBytes?: number;
}

/** ------------------------------------------------------------------ */
/* Language-aware symbol extraction (bounded, never throws).            */
/** ------------------------------------------------------------------ */

const TS_FAMILY = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const PY_FAMILY = new Set(['.py', '.pyw']);
const GO_FAMILY = new Set(['.go']);
const RS_FAMILY = new Set(['.rs']);
const JVM_DOTNET = new Set(['.java', '.kt', '.kts', '.cs', '.scala']);

/** The language family an extension belongs to (evidence / grouping). */
export function symbolFamily(extension: string): string {
  if (TS_FAMILY.has(extension)) return 'typescript';
  if (PY_FAMILY.has(extension)) return 'python';
  if (GO_FAMILY.has(extension)) return 'go';
  if (RS_FAMILY.has(extension)) return 'rust';
  if (JVM_DOTNET.has(extension)) return 'jvm-dotnet';
  return 'other';
}

/**
 * Persistent index format version. Bumped when the derived shape changes
 * (Phase 18 Move 6 added identifiers/implementedSymbols per file and the
 * symbolReferences/implementations maps) — old persisted indexes fail the
 * load check and are rebuilt once, the index's existing invalidation path.
 */
const INDEX_VERSION = 2;

function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function collectMatches(content: string, patterns: RegExp[], kind: SymbolKind): SymbolRef[] {
  const seen = new Set<string>();
  const out: SymbolRef[] = [];
  for (const pattern of patterns) {
    const re = new RegExp(pattern.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const name = m[1]?.trim();
      if (!name || !/^[A-Za-z_$][\w$]*$/.test(name)) continue;
      const key = `${kind}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind, name, line: lineOf(content, m.index) });
      if (out.length >= 256) return out;
    }
  }
  return out;
}

/** Extract top-level-ish symbol names for a source file by extension. */
export function extractSymbols(content: string, extension: string): SymbolRef[] {
  if (!content) return [];
  if (TS_FAMILY.has(extension)) {
    const fn = [
      /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
      /export\s+(?:async\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
      /\b(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/,
      /\b(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/,
      /\b(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/
    ];
    return [
      ...collectMatches(content, fn.slice(0, 2), 'function'),
      ...collectMatches(content, fn.slice(2, 3), 'class'),
      ...collectMatches(content, fn.slice(3, 4), 'interface'),
      ...collectMatches(content, fn.slice(4), 'type')
    ];
  }
  if (PY_FAMILY.has(extension)) {
    return [
      ...collectMatches(content, [/\b(?:async\s+)?def\s+([A-Za-z_]\w*)/], 'function'),
      ...collectMatches(content, [/\bclass\s+([A-Za-z_]\w*)/], 'class')
    ];
  }
  if (GO_FAMILY.has(extension)) {
    return [
      ...collectMatches(content, [/\bfunc\s+(?:\([^)]*\)\s+)?([A-Za-z_]\w*)/], 'function'),
      ...collectMatches(content, [/\btype\s+([A-Za-z_]\w*)\s+(?:struct|interface)/], 'type')
    ];
  }
  if (RS_FAMILY.has(extension)) {
    return [
      ...collectMatches(content, [/\bfn\s+([a-z_]\w*)/], 'function'),
      ...collectMatches(content, [/\b(?:struct|enum|trait)\s+([A-Z][A-Za-z0-9_]*)/], 'type')
    ];
  }
  if (JVM_DOTNET.has(extension)) {
    return [
      ...collectMatches(content, [/\b(?:public|private|protected|internal)\s+(?:static\s+|final\s+|abstract\s+|sealed\s+)*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/], 'class'),
      ...collectMatches(content, [/\bclass\s+([A-Za-z_]\w*)/], 'class')
    ];
  }
  // Generic fallback: any language using fn/func/def/function.
  return collectMatches(content, [/\b(?:fn|func|def|function)\s+([A-Za-z_]\w*)/], 'function');
}

/** ------------------------------------------------------------------ */
/* Usage-reference signals — Phase 18 Move 6.                           */
/** ------------------------------------------------------------------ */

const MAX_IDENTIFIERS_PER_FILE = 512;
const MAX_IMPLEMENTED_PER_FILE = 16;

/**
 * True when `key` is a DIRECT own property of a plain-object record map.
 * The maps use `{}` so inherited Object.prototype members (constructor,
 * toString, hasOwnProperty, ...) are reachable via plain `map[key]` — a
 * repo can legitimately mention such identifiers, so membership checks
 * must not treat inherited members as real entries. Exposed for the query
 * layer (symbols.ts) to use the same guard.
 */
export function hasOwnKey(map: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(map, key);
}

/** Distinct word-boundary identifiers in content (bounded, deduped). */
export function collectIdentifiers(content: string): string[] {
  if (!content) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  const re = /[A-Za-z_$][\w$]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (seen.has(m[0])) continue;
    seen.add(m[0]);
    out.push(m[0]);
    if (out.length >= MAX_IDENTIFIERS_PER_FILE) break;
  }
  return out;
}

/**
 * Symbols a file implements/extends (`implements X` / `extends Y`), for the
 * TS and JVM/.NET families where the syntax is meaningful. Bounded and
 * tolerant like the rest of the extraction (generic constraints like
 * `extends string` are captured and filtered later by the index's own
 * exportedSymbols keys).
 */
export function extractImplemented(content: string, extension: string): string[] {
  if (!content) return [];
  if (!TS_FAMILY.has(extension) && !JVM_DOTNET.has(extension)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  const re = /\b(?:implements|extends)\s+([A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    for (const name of m[1].split(',')) {
      const n = name.trim();
      if (!n || seen.has(n)) continue;
      seen.add(n);
      out.push(n);
      if (out.length >= MAX_IMPLEMENTED_PER_FILE) return out;
    }
  }
  return out;
}

/** Extract imported module specifiers (module graph) + imported names. */
export function extractImports(content: string, extension: string): { imports: string[]; importedNames: string[] } {
  if (!content) return { imports: [], importedNames: [] };
  const imports: string[] = [];
  const importedNames: string[] = [];
  const push = (list: string[], value: string): void => {
    const v = value.trim();
    if (v && !list.includes(v) && list.length < 64) list.push(v);
  };

  if (TS_FAMILY.has(extension)) {
    // Capture the whole specifier part (handles `auth, { login, logout }`),
    // then parse the {named} group and default import separately.
    const fromRe = /import\s+(?:type\s+)?([^'";\n]+?)\s+from\s+['"]([^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = fromRe.exec(content)) !== null) {
      push(imports, m[2]);
      const spec = m[1];
      const brace = spec.indexOf('{');
      const braceEnd = spec.indexOf('}');
      if (brace >= 0 && braceEnd > brace) {
        const named = spec
          .slice(brace + 1, braceEnd)
          .split(',')
          .map((n) => n.trim().split(/\s+as\s+/)[0].trim())
          .filter(Boolean);
        for (const n of named) push(importedNames, n);
        const head = spec.slice(0, brace).replace(/^type\s+/, '').trim().replace(/,\s*$/, '');
        if (head) push(importedNames, head.split(/\s+/)[0]);
      } else {
        const first = spec.trim().split(/\s+/)[0];
        if (first && first !== '*') push(importedNames, first);
      }
    }
    const sideRe = /import\s+['"]([^'"]+)['"]/g;
    while ((m = sideRe.exec(content)) !== null) push(imports, m[1]);
    const reqRe = /require\(['"]([^'"]+)['"]\)/g;
    while ((m = reqRe.exec(content)) !== null) push(imports, m[1]);
  } else if (PY_FAMILY.has(extension)) {
    const fromRe = /^\s*from\s+([\w.]+)\s+import\s+(.+)$/gm;
    let m: RegExpExecArray | null;
    while ((m = fromRe.exec(content)) !== null) {
      push(imports, m[1]);
      for (const n of m[2].split(',')) {
        const name = n.trim().split(/\s+as\s+/)[0].trim();
        if (name && name !== '(') push(importedNames, name);
      }
    }
    const impRe = /^\s*import\s+([\w.]+)(?:\s+as\s+(\w+))?/gm;
    while ((m = impRe.exec(content)) !== null) {
      push(imports, m[1].split('.')[0]);
      if (m[2]) push(importedNames, m[2]);
    }
  } else if (GO_FAMILY.has(extension)) {
    const blockRe = /import\s*\(([^)]*)\)/g;
    let m: RegExpExecArray | null;
    while ((m = blockRe.exec(content)) !== null) {
      const specRe = /["'`]([^"'`]+)["'`]/g;
      let s: RegExpExecArray | null;
      while ((s = specRe.exec(m[1])) !== null) push(imports, s[1]);
    }
    const singleRe = /import\s+["'`]([^"'`]+)["'`]/g;
    while ((m = singleRe.exec(content)) !== null) push(imports, m[1]);
  } else if (RS_FAMILY.has(extension)) {
    const useRe = /\buse\s+([\w:]+)/g;
    let m: RegExpExecArray | null;
    while ((m = useRe.exec(content)) !== null) push(imports, m[1].split('::')[0]);
  }

  return { imports, importedNames };
}
/** ------------------------------------------------------------------ */
/* Test / config classification.                                        */
/** ------------------------------------------------------------------ */

const TEST_PATH = /(?:^|\/)(?:test|tests|__tests__|spec|specs|testing)(?:\/|$)/;
const TEST_BASENAME = /\.(?:test|spec)[.\w]*$/i;
const TEST_PREFIX = /(?:^|_|\.)(?:test|spec)\./i;

export function isTestFile(relPath: string, content = ''): boolean {
  const lower = relPath.toLowerCase();
  if (TEST_PATH.test(lower) || TEST_BASENAME.test(lower) || TEST_PREFIX.test(lower)) return true;
  if (!content) return false;
  const head = content.slice(0, 2000);
  return /\b(?:describe|it|specify)\s*\(/.test(head) ||
    /\btest\s*\(/.test(head) ||
    /@Test\b/.test(head) ||
    /\b(?:pytest|unittest)\b/.test(head) ||
    /#\[test\]/.test(head);
}

const CONFIG_BASENAMES = new Set([
  'package.json', 'tsconfig.json', 'jest.config.js', 'jest.config.ts', 'vitest.config.ts',
  'webpack.config.js', 'vite.config.ts', 'rollup.config.js', 'next.config.js', 'nuxt.config.ts',
  'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'Cargo.toml', 'pyproject.toml',
  'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'gemfile', 'composer.json',
  'makefile', 'dockerfile', '.editorconfig', '.eslintrc', '.eslintrc.json', '.eslintrc.js',
  '.prettierrc', '.prettierrc.json', '.babelrc', '.babelrc.json'
]);

export function isConfigFile(relPath: string): boolean {
  const base = path.basename(relPath).toLowerCase();
  if (CONFIG_BASENAMES.has(base)) return true;
  if (base.startsWith('.eslintrc') || base.startsWith('.prettierrc') || base.startsWith('.babelrc')) return true;
  if (/(?:^|\.)config\.|\.config$/.test(base)) return true;
  return false;
}

/* Index construction, persistence, incremental refresh.                */
/** ------------------------------------------------------------------ */

function detailOf(file: IndexedFile, root: string, maxFileBytes: number): IndexedFileDetail {
  const full = path.join(root, file.path);
  let mtimeMs = 0;
  let content = '';
  try {
    const st = fs.statSync(full);
    mtimeMs = st.mtimeMs;
    if (st.size <= maxFileBytes) content = fs.readFileSync(full, 'utf8');
  } catch {
    /* unreadable file -> no content signals */
  }
  const { imports, importedNames } = extractImports(content, file.extension);
  return {
    ...file,
    symbols: extractSymbols(content, file.extension),
    identifiers: collectIdentifiers(content),
    implementedSymbols: extractImplemented(content, file.extension),
    imports,
    importedNames,
    isTest: isTestFile(file.path, content),
    isConfig: isConfigFile(file.path),
    mtimeMs
  };
}

/**
 * External usage-reference map — Phase 18 Move 6. Symbol -> files that
 * reference it (word-boundary identifier occurrences in OTHER files,
 * excluding files that define it), intersected with the index's own
 * exportedSymbols keys so only repo-defined symbols count (external
 * packages never pollute the map). Derived from each file's bounded
 * `identifiers` list, so incremental refresh reuses unchanged files' data
 * wholesale — same semantics as the importers graph.
 */
export function buildSymbolReferences(
  files: IndexedFileDetail[],
  exportedSymbols: Record<string, string[]>
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const file of files) {
    if (!file.identifiers || file.identifiers.length === 0) continue;
    const own = new Set(file.symbols.map((s) => s.name));
    for (const id of file.identifiers) {
      if (own.has(id) || !hasOwnKey(exportedSymbols, id)) continue;
      const list = hasOwnKey(out, id) ? out[id] : (out[id] = []);
      if (!list.includes(file.path)) list.push(file.path);
    }
  }
  return out;
}

/**
 * Implementation map — Phase 18 Move 6. Symbol -> files that implement or
 * extend it (`implements X` / `extends Y`), kept only for symbols the repo
 * itself defines (external bases like React.Component are filtered).
 */
export function buildImplementations(
  files: IndexedFileDetail[],
  exportedSymbols: Record<string, string[]>
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const file of files) {
    if (!file.implementedSymbols || file.implementedSymbols.length === 0) continue;
    for (const name of file.implementedSymbols) {
      if (!hasOwnKey(exportedSymbols, name)) continue;
      const list = hasOwnKey(out, name) ? out[name] : (out[name] = []);
      if (!list.includes(file.path)) list.push(file.path);
    }
  }
  return out;
}

function finalize(root: string, files: IndexedFileDetail[], indexedAt: number, version: number): PersistentRepositoryIndex {
  const languages: Record<string, number> = {};
  let totalBytes = 0;
  const exportedSymbols: Record<string, string[]> = {};
  const importers: Record<string, string[]> = {};
  for (const file of files) {
    languages[file.extension] = (languages[file.extension] || 0) + 1;
    totalBytes += file.size;
    for (const sym of file.symbols) {
      const list = hasOwnKey(exportedSymbols, sym.name) ? exportedSymbols[sym.name] : (exportedSymbols[sym.name] = []);
      if (!list.includes(file.path)) list.push(file.path);
    }
    for (const imp of file.imports) {
      const list = hasOwnKey(importers, imp) ? importers[imp] : (importers[imp] = []);
      if (!list.includes(file.path)) list.push(file.path);
    }
  }
  return {
    root,
    files,
    fileCount: files.length,
    totalBytes,
    languages,
    indexedAt,
    version,
    exportedSymbols,
    importers,
    symbolReferences: buildSymbolReferences(files, exportedSymbols),
    implementations: buildImplementations(files, exportedSymbols)
  };
}

/** Build a full persistent index for a workspace root. */
export function buildPersistentIndex(root: string, options: PersistentIndexOptions = {}): PersistentRepositoryIndex {
  const base = indexWorkspace(root, options);
  const maxBytes = options.maxFileBytes ?? 512 * 1024;
  const files = base.files.map((f) => detailOf(f, root, maxBytes));
  return finalize(root, files, Date.now(), INDEX_VERSION);
}

/** Re-parse only files whose mtime/size changed; drop files that vanished. */
export function refreshRepositoryIndex(
  index: PersistentRepositoryIndex,
  root: string,
  options: PersistentIndexOptions = {}
): PersistentRepositoryIndex {
  const byPath = new Map(index.files.map((f) => [f.path, f]));
  const base = indexWorkspace(root, options);
  const maxBytes = options.maxFileBytes ?? 512 * 1024;
  const next: IndexedFileDetail[] = [];
  for (const file of base.files) {
    const prev = byPath.get(file.path);
    const full = path.join(root, file.path);
    let mtimeMs = 0;
    let content = '';
    try {
      const st = fs.statSync(full);
      mtimeMs = st.mtimeMs;
      if (st.size <= maxBytes) content = fs.readFileSync(full, 'utf8');
    } catch {
      continue; // file disappeared mid-refresh
    }
    if (prev && prev.mtimeMs === mtimeMs && prev.size === file.size) {
      next.push(prev); // unchanged — reuse the parsed detail as-is
      continue;
    }
    next.push(detailOf(file, root, maxBytes));
  }
  return finalize(root, next, Date.now(), index.version);
}

function defaultDataRoot(): string {
  const oneDrive = String(process.env.OneDrive || process.env.ONEDRIVE || '').trim();
  return process.env.GITU_DATA_ROOT || path.join(oneDrive || path.join(os.homedir(), 'Documents'), 'Gitu Data');
}

/** On-disk location of the persistent index for a workspace root. */
export function repositoryIndexPath(root: string, dataRoot?: string): string {
  const hash = crypto.createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 16);
  return path.join(dataRoot || defaultDataRoot(), 'repo-index', `${hash}.json`);
}

/** Persist the index; returns the file path written. */
export function saveRepositoryIndex(index: PersistentRepositoryIndex, dataRoot?: string): string {
  const filePath = repositoryIndexPath(index.root, dataRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(index, null, 2));
  return filePath;
}

/** Load a previously persisted index (undefined when missing/corrupt). */
export function loadRepositoryIndex(root: string, dataRoot?: string): PersistentRepositoryIndex | undefined {
  const filePath = repositoryIndexPath(root, dataRoot);
  try {
    if (!fs.existsSync(filePath)) return undefined;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as PersistentRepositoryIndex;
    if (parsed.version !== INDEX_VERSION || !Array.isArray(parsed.files) || parsed.root !== root) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Load -> incrementally refresh -> save, or build fresh when nothing is
 * persisted. This is the entry point hosts use instead of indexWorkspace.
 */
export function getRepositoryIndex(
  root: string,
  options: PersistentIndexOptions = {},
  dataRoot?: string
): PersistentRepositoryIndex {
  const existing = loadRepositoryIndex(root, dataRoot);
  if (existing) {
    const refreshed = refreshRepositoryIndex(existing, root, options);
    saveRepositoryIndex(refreshed, dataRoot);
    return refreshed;
  }
  const built = buildPersistentIndex(root, options);
  saveRepositoryIndex(built, dataRoot);
  return built;
}

/** ------------------------------------------------------------------ */
/* Symbol-aware matching: resolve a goal to the files that matter.      */
/** ------------------------------------------------------------------ */

/**
 * Rank files by path relevance + symbol hits + import graph, with a bonus
 * for tests when the goal is about testing and a mild penalty for surfacing
 * tests during feature work. Returns only files with positive score.
 */
export function matchBySymbols(index: PersistentRepositoryIndex, goal: string, limit = 12): IndexedFileDetail[] {
  const lower = goal.toLowerCase();
  // Plural/gerund-tolerant: "tests", "verifying", "deployment" all count.
  const testGoal = /\b(?:tests?|specs?|verif\w*|cover\w*|assert\w*)\b/.test(lower);
  const configGoal = /\b(?:config\w*|setup\w*|build\w*|deploy\w*|docker\w*|package\w*|install\w*)\b/.test(lower);
  const scored = index.files.map((file) => {
    // Path relevance: exact overlap + stem hits (authentication ~ auth) +
    // depth bonus; symbols/imports add ranked signal on top.
    let score = fileRelevance(file, goal) + stemOverlap(goal, file.path);
    for (const sym of file.symbols) {
      const s = stemOverlap(goal, sym.name);
      if (s > 0) score += s * 1.2;
    }
    for (const name of file.importedNames) {
      const s = stemOverlap(goal, name);
      if (s > 0) score += s * 0.5;
    }
    for (const imp of file.imports) {
      const s = stemOverlap(goal, imp);
      if (s > 0) score += s * 0.3;
    }
  if (file.isTest) score += testGoal ? 0.4 : -0.15;
    if (file.isConfig) score += configGoal ? 0.3 : 0;
    return { file, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.file);
}

/** ------------------------------------------------------------------ */
/* Per-goal file hints for the mission prompt.                          */
/** ------------------------------------------------------------------ */

export interface GoalFileHintsOptions {
  /** Cap the hint list. Default 8. */
  maxFiles?: number;
}

function isPersistent(index: RepositoryIndex): index is PersistentRepositoryIndex {
  return (index as PersistentRepositoryIndex).version !== undefined;
}

/**
 * True when a single file carries real goal signal beyond the index's
 * depth bonus — a path/symbol/imported-name/import stem hit. Shared by the
 * hint renderer (whole-index) and the Move 7b minimal-context selector
 * (per-seed), so depth-bonus-only noise never enters either.
 */
export function hasGoalSignalForFile(file: IndexedFileDetail, goal: string): boolean {
  const tokens = significantTokens(goal);
  if (tokens.length === 0) return false;
  return (
    stemOverlap(goal, file.path) > 0 ||
    file.symbols.some((s) => stemOverlap(goal, s.name) > 0) ||
    file.importedNames.some((n) => stemOverlap(goal, n) > 0) ||
    file.imports.some((i) => stemOverlap(goal, i) > 0)
  );
}

/** True when any file in the index carries real goal signal. */
function hasGoalSignal(index: PersistentRepositoryIndex, goal: string): boolean {
  return index.files.some((file) => hasGoalSignalForFile(file, goal));
}

/**
 * Render a compact, per-goal "files relevant to the current goal" hint.
 * Persistent indexes get symbol/test/config justification per file; the
 * lightweight index falls back to a plain path list. Empty when nothing
 * matches — safe to drop from the prompt.
 */
export function renderGoalFileHints(index: RepositoryIndex, goal: string, options: GoalFileHintsOptions = {}): string {
  const max = options.maxFiles ?? 8;
  const lines = ['Files relevant to the current goal:'];
  if (isPersistent(index)) {
    if (!hasGoalSignal(index, goal)) return '';
    const files = matchBySymbols(index, goal, max);
    for (const file of files) {
      const syms = file.symbols.slice(0, 4).map((s) => s.name).join(', ');
      const why = file.isTest ? 'tests' : file.isConfig ? 'config' : syms ? `exports ${syms}` : '';
      lines.push(`- ${file.path}${why ? ` (${why})` : ''}`);
    }
    return lines.join('\n');
  }
  const files = matchFiles(index, goal, max);
  if (files.length === 0 || !files.some((f) => relevanceScore(goal, f.path) > 0)) return '';
  for (const file of files) lines.push(`- ${file.path}`);
  return lines.join('\n');
}

/** ------------------------------------------------------------------ */
/* Bare-symbol resolution via the exportedSymbols map.                  */
/** ------------------------------------------------------------------ */

const SYMBOL_IDENT = /[A-Za-z_$][\w$]{1,}/g;
const SYMBOL_STOP = new Set([
  'the', 'and', 'for', 'are', 'was', 'you', 'not', 'but', 'can', 'with',
  'from', 'have', 'will', 'your', 'please', 'this', 'that', 'fix', 'bug',
  'issue', 'error', 'code', 'function', 'class', 'method', 'test', 'tests',
  'make', 'add', 'update', 'remove', 'refactor', 'improve', 'broken',
  'does', 'why', 'how', 'what', 'where', 'is', 'it', 'to', 'of', 'in',
  'on', 'my', 'me', 'our', 'us', 'work', 'works', 'working', 'need', 'help'
]);

/** Identifiers in a goal that could be bare symbol references. */
export function goalSymbols(goal: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of String(goal || '').match(SYMBOL_IDENT) || []) {
    if (SYMBOL_STOP.has(m.toLowerCase())) continue;
    if (/^[a-z]{1,2}$/.test(m)) continue; // 1-2 char lowercase: function words
    if (seen.has(m)) continue;
    seen.add(m);
    out.push(m);
  }
  return out;
}

export interface SymbolResolution {
  /** The identifier as it appeared in the goal. */
  symbol: string;
  /** The canonical exportedSymbols key it resolved to (for kind lookup). */
  key: string;
  /** Defining files for the symbol. */
  files: IndexedFileDetail[];
}

/** ------------------------------------------------------------------ */
/* Reverse dependency lookup — Phase 18 Move 2.                         */
/* The persisted `importers` map (write-only since Phase 8) becomes a    */
/* queried capability: which files import the target module/file?        */
/** ------------------------------------------------------------------ */

export interface DependentsOptions {
  /** Include transitive dependents (dependents of dependents). Default false. */
  transitive?: boolean;
  /** Cap results. Default 50. */
  limit?: number;
}

/** One importing file, with the specifier as written and its flags. */
export interface Dependent {
  /** Root-relative path of the importing file. */
  path: string;
  /** The import specifier exactly as written in that file (e.g. `../auth/auth`). */
  specifier: string;
  isTest: boolean;
  isConfig: boolean;
}

/** Strip extension and /index suffix -> comparable normalized path. */
export function normPath(relPath: string): string {
  return relPath.replace(/\.[^.\\/]+$/, '').replace(/\/index$/, '');
}

/**
 * Resolve a RELATIVE import specifier against the importing file's
 * directory into a normalized root-relative path (no extension, /index
 * collapsed). Bare specifiers (packages/aliases) return null — they are
 * matched tolerantly by `bareMatches` instead.
 */
export function resolveImportTarget(importingPath: string, specifier: string): string | null {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null;
  const dir = path.posix.dirname(importingPath);
  const joined = path.posix.normalize(path.posix.join(dir, specifier));
  if (joined === '.' || joined.startsWith('../')) return null; // escapes the workspace
  return normPath(joined);
}

/** Tolerant bare-specifier match: package/alias name vs target forms. */
function bareMatches(specifier: string, target: string): boolean {
  const lower = specifier.toLowerCase();
  const base = path.posix.basename(target).replace(/\.[^.]+$/, '').toLowerCase();
  return lower === base || lower === normPath(target).toLowerCase() || lower === target.toLowerCase();
}

/**
 * Files that depend on a target (file path or module) via the persisted
 * `importers` reverse index. Relative specifiers are resolved against each
 * importing file's directory (so `../auth/auth` and `./auth/auth` from
 * different dirs both hit `src/auth/auth.ts`); bare specifiers match the
 * target's basename / path forms (tolerant, alias-style). Deduped, sorted
 * by path. Empty when nothing imports the target. Persistent index only.
 */
export function findDependents(
  index: PersistentRepositoryIndex,
  target: string,
  options: DependentsOptions = {}
): Dependent[] {
  const limit = options.limit ?? 50;
  const targetNorm = normPath(target);
  const direct = new Map<string, Dependent>();
  for (const [specifier, importingPaths] of Object.entries(index.importers)) {
    for (const importingPath of importingPaths) {
      if (direct.has(importingPath)) continue;
      const resolved = resolveImportTarget(importingPath, specifier);
      const matches = resolved
        ? resolved === targetNorm || resolved === `${targetNorm}/index`
        : bareMatches(specifier, target);
      if (!matches) continue;
      const file = index.files.find((f) => f.path === importingPath);
      direct.set(importingPath, {
        path: importingPath,
        specifier,
        isTest: Boolean(file?.isTest),
        isConfig: Boolean(file?.isConfig)
      });
    }
  }
  const ordered = [...direct.values()].sort((a, b) => a.path.localeCompare(b.path)).slice(0, limit);
  if (!options.transitive) return ordered;
  // BFS over direct dependents (each hop re-queries the same reverse index).
  const out = new Map<string, Dependent>();
  for (const d of ordered) out.set(d.path, d);
  const queue = ordered.map((d) => d.path);
  while (queue.length > 0 && out.size < limit) {
    const current = queue.shift()!;
    for (const d of findDependents(index, current, { limit: limit - out.size })) {
      if (out.has(d.path)) continue;
      out.set(d.path, d);
      queue.push(d.path);
      if (out.size >= limit) break;
    }
  }
  return [...out.values()].sort((a, b) => a.path.localeCompare(b.path)).slice(0, limit);
}

/**
 * Resolve bare symbol references in a goal to defining file paths via the
 * persistent index's exportedSymbols map: "fix authenticate()" ->
 * [{ symbol: 'authenticate', files: [src/auth/auth.ts] }]. Exact matches
 * first, case-insensitive fallback. Empty when nothing resolves.
 */
export function resolveSymbols(index: PersistentRepositoryIndex, goal: string, limit = 8): SymbolResolution[] {
  const byPath = new Map(index.files.map((f) => [f.path, f]));
  const lowerKeys = new Map<string, string[]>();
  const out: SymbolResolution[] = [];
  for (const name of goalSymbols(goal)) {
    const direct = hasOwnKey(index.exportedSymbols, name) ? index.exportedSymbols[name] : undefined;
    let keys = direct ? [name] : lowerKeys.get(name.toLowerCase());
    if (!direct && !keys) {
      keys = [];
      for (const key of Object.keys(index.exportedSymbols)) {
        if (key.toLowerCase() === name.toLowerCase()) keys.push(key);
      }
      lowerKeys.set(name.toLowerCase(), keys);
    }
    if (!keys || keys.length === 0) continue;
    const files = keys
      .flatMap((key) => (index.exportedSymbols[key] || []).map((p) => byPath.get(p)))
      .filter((f): f is IndexedFileDetail => Boolean(f))
      .slice(0, limit);
    if (files.length > 0) out.push({ symbol: name, key: keys[0], files });
  }
  return out;
}
