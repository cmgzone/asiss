/**
 * Repository index smoke test — Hermes Evolution Phase 8.
 *
 * Offline: guards the persistent, symbol-aware repository index built on the
 * Phase 7 ContextEngine. No model API, no real workspace — everything runs in
 * a hermetic temp dir (GITU_DATA_ROOT + per-test temp repos).
 *
 * Covers:
 *   1. Symbol extraction (TS/Python/Go) with kinds and line numbers
 *   2. Import extraction (named/default/side-effect/require, Python, Go)
 *   3. Test + config classification (paths and content sniffing)
 *   4. Full persistent index: exportedSymbols + importers + flags
 *   5. Symbol-aware matching: goal -> files (incl. test/config bonuses)
 *   6. Disk round-trip (save/load/corrupt) under a hermetic data root
 *   7. Incremental refresh: only changed files re-parsed (identity check)
 *   8. ContextEngine integration: persistent default, light fallback opt-out
 *
 * Run with: npx ts-node scripts/smoke-repo-index.ts
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ContextEngine } from '../src/core/context';
import {
  buildPersistentIndex,
  extractImports,
  extractSymbols,
  getRepositoryIndex,
  isConfigFile,
  isTestFile,
  loadRepositoryIndex,
  matchBySymbols,
  refreshRepositoryIndex,
  saveRepositoryIndex
} from '../src/core/context';

function tmpRepo(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(root: string, rel: string, content: string): string {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

// ---------------------------------------------------------------------
// 1. Symbol extraction
// ---------------------------------------------------------------------
{
  const ts = `
import { x } from './util';
export function authenticate(user: string): boolean { return true; }
export async function refreshToken() { return 't'; }
export class AuthService { login() {} }
export interface AuthResult { ok: boolean }
export type AuthMode = 'basic' | 'sso';
const helper = () => 1;
`;
  const syms = extractSymbols(ts, '.ts');
  const names = syms.map((s) => `${s.kind}:${s.name}`);
  for (const expect of ['function:authenticate', 'function:refreshToken', 'class:AuthService', 'interface:AuthResult', 'type:AuthMode']) {
    assert.ok(names.includes(expect), `ts symbol ${expect} extracted`);
  }
  const auth = syms.find((s) => s.name === 'authenticate')!;
  assert.ok(auth.line >= 2, `line number recorded (${auth.line})`);
  assert.ok(!names.includes('function:helper'), 'non-exported const arrow not flagged as export fn');

  const py = 'import os\n\ndef verify_login(token):\n    pass\n\nclass Session:\n    pass\n';
  const pyNames = extractSymbols(py, '.py').map((s) => `${s.kind}:${s.name}`);
  assert.ok(pyNames.includes('function:verify_login') && pyNames.includes('class:Session'), 'python symbols');

  const go = 'package main\n\nfunc main() {}\nfunc (s *Server) Start() {}\ntype Handler struct {}\n';
  const goNames = extractSymbols(go, '.go').map((s) => `${s.kind}:${s.name}`);
  assert.ok(goNames.includes('function:main') && goNames.includes('function:Start'), 'go funcs');
  assert.ok(goNames.includes('type:Handler'), 'go type');

  const rs = 'pub fn login() {}\nstruct Config {}\n';
  const rsNames = extractSymbols(rs, '.rs').map((s) => `${s.kind}:${s.name}`);
  assert.ok(rsNames.includes('function:login') && rsNames.includes('type:Config'), 'rust symbols');
}

// ---------------------------------------------------------------------
// 2. Import extraction
// ---------------------------------------------------------------------
{
  const ts = `
import auth, { login, logout as signOut } from './auth';
import type { Config } from './config';
import './polyfill';
const helper = require('./util');
`;
  const { imports, importedNames } = extractImports(ts, '.ts');
  assert.ok(imports.includes('./auth') && imports.includes('./config') && imports.includes('./polyfill') && imports.includes('./util'), 'ts import specifiers');
  assert.ok(importedNames.includes('login') && importedNames.includes('signOut') === false, 'aliases not treated as names');
  assert.ok(importedNames.includes('auth') && importedNames.includes('Config'), 'default + type names');

  const py = 'import os\nfrom flask import Flask, session as sess\n';
  const pi = extractImports(py, '.py');
  assert.ok(pi.imports.includes('os') && pi.imports.includes('flask'), 'python modules');
  assert.ok(pi.importedNames.includes('Flask') && pi.importedNames.includes('session'), 'python names');

  const go = 'import (\n  "fmt"\n  "os"\n)\n';
  assert.ok(extractImports(go, '.go').imports.includes('fmt') && extractImports(go, '.go').imports.includes('os'), 'go imports');
}

// ---------------------------------------------------------------------
// 3. Test + config classification
// ---------------------------------------------------------------------
{
  assert.ok(isTestFile('src/auth.test.ts'), 'basename test');
  assert.ok(isTestFile('tests/auth.ts'), 'tests dir');
  assert.ok(isTestFile('src/auth_test.py'), 'python suffix');
  assert.ok(isTestFile('src/auth_spec.rb'), 'spec suffix');
  assert.ok(isTestFile('src/whatever.ts', 'describe("auth", () => { it("works", () => {}) })'), 'content sniff');
  assert.ok(!isTestFile('src/auth.ts'), 'plain source not a test');
  assert.ok(!isTestFile('src/auth.ts', 'const x = 1;'), 'no false content sniff');

  assert.ok(isConfigFile('package.json'), 'package.json');
  assert.ok(isConfigFile('vite.config.ts'), 'vite config');
  assert.ok(isConfigFile('tsconfig.json'), 'tsconfig');
  assert.ok(isConfigFile('Dockerfile'), 'Dockerfile');
  assert.ok(isConfigFile('.eslintrc.json'), 'eslintrc');
  assert.ok(!isConfigFile('src/auth.ts'), 'source not config');
  assert.ok(!isConfigFile('README.md'), 'readme not config');
}

// ---------------------------------------------------------------------
// 4. Full persistent index: exportedSymbols + importers + flags
// ---------------------------------------------------------------------
{
  const root = tmpRepo('repo-index-4-');
  try {
    write(root, 'src/auth/auth.ts', 'export function authenticate(u: string): boolean { return true; }\nexport function refreshToken() { return "t"; }\n');
    write(root, 'src/app.ts', "import { authenticate } from './auth/auth';\nexport function main() { authenticate('u'); }\n");
    write(root, 'src/auth/auth.test.ts', 'import { authenticate } from "./auth";\ntest("authenticates", () => { expect(authenticate("u")).toBe(true); });\n');
    write(root, 'package.json', '{"name": "demo", "scripts": {"test": "jest"}}\n');
    write(root, 'README.md', '# demo\n');
    const index = buildPersistentIndex(root);
    assert.strictEqual(index.version, 1, 'version stamped');
    assert.strictEqual(index.fileCount, 5, 'all 5 files indexed');
    const auth = index.files.find((f) => f.path === 'src/auth/auth.ts')!;
    assert.ok(auth.symbols.some((s) => s.name === 'authenticate'), 'auth symbol extracted');
    assert.ok(!auth.isTest && !auth.isConfig, 'auth file classified');
    assert.deepStrictEqual(index.exportedSymbols['authenticate'], ['src/auth/auth.ts'], 'exportedSymbols map');
    assert.deepStrictEqual(index.exportedSymbols['main'], ['src/app.ts'], 'main exported');
    assert.ok(index.importers['./auth/auth'].includes('src/app.ts'), 'importers graph');
    const test = index.files.find((f) => f.path === 'src/auth/auth.test.ts')!;
    assert.ok(test.isTest, 'test file flagged');
    const pkg = index.files.find((f) => f.path === 'package.json')!;
    assert.ok(pkg.isConfig, 'package.json flagged config');
    const readme = index.files.find((f) => f.path === 'README.md')!;
    assert.ok(!readme.isTest && !readme.isConfig, 'readme neutral');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------
// 5. Symbol-aware matching: goal -> files (test/config bonuses)
// ---------------------------------------------------------------------
{
  const root = tmpRepo('repo-index-5-');
  try {
    write(root, 'src/auth/auth.ts', 'export function authenticate(u: string): boolean { return true; }\n');
    write(root, 'src/payments/billing.ts', 'export function charge(amount: number): void {}\n');
    write(root, 'src/auth/auth.test.ts', 'test("authenticates", () => {});\n');
    write(root, 'Dockerfile', 'FROM node:20\n');
    write(root, 'src/payments/billing.test.ts', 'test("charges", () => {});\n');
    const index = buildPersistentIndex(root);

    const authFiles = matchBySymbols(index, 'fix authentication', 4).map((f) => f.path);
    assert.ok(authFiles.includes('src/auth/auth.ts'), 'symbol + path hit ranks auth.ts');
    assert.ok(!authFiles.includes('src/payments/billing.test.ts') || authFiles.indexOf('src/auth/auth.ts') < authFiles.indexOf('src/payments/billing.test.ts'), 'feature goal prefers source over test');

    const testFiles = matchBySymbols(index, 'add tests verifying login works', 4).map((f) => f.path);
    assert.ok(testFiles.includes('src/auth/auth.test.ts'), 'test goal surfaces the test file');
    assert.ok(testFiles.indexOf('src/auth/auth.test.ts') < testFiles.indexOf('src/auth/auth.ts'), 'test bonus outranks source');

    const deployFiles = matchBySymbols(index, 'set up docker deploy config', 4).map((f) => f.path);
    assert.ok(deployFiles.includes('Dockerfile'), 'config goal surfaces Dockerfile');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------
// 6. Disk round-trip under a hermetic data root
// ---------------------------------------------------------------------
{
  const root = tmpRepo('repo-index-6-');
  const dataRoot = tmpRepo('repo-data-6-');
  try {
    write(root, 'src/auth/auth.ts', 'export function authenticate() { return true; }\n');
    const built = buildPersistentIndex(root);
    const savedAt = saveRepositoryIndex(built, dataRoot);
    assert.ok(fs.existsSync(savedAt), 'index persisted to disk');
    const loaded = loadRepositoryIndex(root, dataRoot)!;
    assert.strictEqual(loaded.fileCount, built.fileCount, 'round-trip file count');
    assert.deepStrictEqual(loaded.exportedSymbols['authenticate'], ['src/auth/auth.ts'], 'round-trip exportedSymbols');
    assert.strictEqual(loaded.files[0].mtimeMs, built.files[0].mtimeMs, 'round-trip mtime');

    // getRepositoryIndex reuses the persisted file (no rebuild).
    const viaGet = getRepositoryIndex(root, {}, dataRoot);
    assert.strictEqual(viaGet.fileCount, 1, 'getRepositoryIndex loaded persisted');
    assert.deepStrictEqual(viaGet.exportedSymbols['authenticate'], ['src/auth/auth.ts'], 'persisted symbols intact');

    // Corrupt file -> load returns undefined, getRepositoryIndex rebuilds.
    fs.writeFileSync(savedAt, '{ not json');
    assert.strictEqual(loadRepositoryIndex(root, dataRoot), undefined, 'corrupt index rejected');
    const rebuilt = getRepositoryIndex(root, {}, dataRoot);
    assert.strictEqual(rebuilt.fileCount, 1, 'rebuilt after corruption');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------
// 7. Incremental refresh: only changed files re-parsed
// ---------------------------------------------------------------------
{
  const root = tmpRepo('repo-index-7-');
  try {
    const a = write(root, 'src/a.ts', 'export function alpha() { return 1; }\n');
    write(root, 'src/b.ts', 'export function beta() { return 2; }\n');
    const first = buildPersistentIndex(root);
    const fileA = first.files.find((f) => f.path === 'src/a.ts')!;
    const fileB = first.files.find((f) => f.path === 'src/b.ts')!;
    assert.ok(fileA.symbols.some((s) => s.name === 'alpha'), 'alpha indexed');

    // Same size, same mtime -> untouched. Change content and mtime for a.ts.
    const old = fs.readFileSync(a, 'utf8');
    fs.writeFileSync(a, old + '\n');
    fs.utimesSync(a, new Date(), new Date(Date.now() + 60_000));
    // b.ts stays untouched: its entry must be reused by identity.

    const second = refreshRepositoryIndex(first, root);
    const secondA = second.files.find((f) => f.path === 'src/a.ts')!;
    const secondB = second.files.find((f) => f.path === 'src/b.ts')!;
    assert.notStrictEqual(secondA, fileA, 'changed file re-parsed (new object)');
    assert.strictEqual(secondB, fileB, 'unchanged file reused by identity');
    assert.deepStrictEqual(
      second.files.map((f) => f.path).sort(),
      first.files.map((f) => f.path).sort(),
      'refresh keeps file set'
    );
    // A newly added file is picked up.
    write(root, 'src/c.ts', 'export function gamma() { return 3; }\n');
    const third = refreshRepositoryIndex(second, root);
    assert.ok(third.files.some((f) => f.path === 'src/c.ts'), 'new file discovered on refresh');
    // A deleted file is dropped.
    fs.rmSync(path.join(root, 'src/c.ts'));
    const fourth = refreshRepositoryIndex(third, root);
    assert.ok(!fourth.files.some((f) => f.path === 'src/c.ts'), 'deleted file dropped on refresh');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------
// 8. ContextEngine integration: persistent default, light fallback
// ---------------------------------------------------------------------
{
  const root = tmpRepo('repo-index-8-');
  const dataRoot = tmpRepo('repo-data-8-');
  try {
    write(root, 'src/auth/auth.ts', 'export function authenticate() { return true; }\n');
    write(root, 'src/auth/auth.test.ts', 'test("auth works", () => {});\n');
    const engine = new ContextEngine({ config: { repository: { dataRoot } } });
    const index = engine.indexRepository(root) as any;
    assert.strictEqual(index.version
    , 1, 'engine uses persistent index by default');
    const relevant = engine.relevantFiles(root, 'verify authentication', 4).map((f: any) => f.path);
    assert.ok(relevant.includes('src/auth/auth.test.ts'), 'engine matching is symbol-aware');
    assert.ok(fs.existsSync(path.join(dataRoot, 'repo-index')), 'index written under configured data root');

    const light = new ContextEngine({ config: { repository: { persistent: false, dataRoot } } });
    const lightIndex = light.indexRepository(root) as any;
    assert.strictEqual(lightIndex.version, undefined, 'persistent:false falls back to lightweight index');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------
// 9. Per-goal file hints in the mission prompt section
// ---------------------------------------------------------------------
{
  const root = tmpRepo('repo-index-9-');
  const dataRoot = tmpRepo('repo-data-9-');
  try {
    write(root, 'src/auth/auth.ts', 'export function authenticate(u: string) { return true; }\nexport function refreshToken() { return "t"; }\n');
    write(root, 'src/payments/billing.ts', 'export function charge(amount: number) {}\n');
    write(root, 'src/auth/auth.test.ts', 'test("authenticates", () => {});\n');
    const engine = new ContextEngine({ config: { repository: { dataRoot } } });

    // Default: repository section renders the static block + the per-goal
    // symbol-aware hint with reasons; the plain list is replaced.
    const section = engine.repositorySection(root, 'fix the authentication bug');
    assert.ok(section.includes('Files relevant to the current goal:'), 'hint header present by default');
    assert.ok(section.includes('- src/auth/auth.ts (exports authenticate, refreshToken)'), 'hint carries symbol reasons');
    const testSection = engine.repositorySection(root, 'verify login works with tests');
    assert.ok(testSection.includes('- src/auth/auth.test.ts (tests)'), 'hint carries test classification on test goals');
    assert.ok(!section.includes('Files most relevant to the current goal:'), 'plain list replaced by hint');

    // Test goal: the test file surfaces via goalFilesSection with reasons.
    const hint = engine.goalFilesSection(root, 'verify login works with tests');
    assert.ok(hint.includes('src/auth/auth.test.ts'), 'test goal surfaces test file in hint');
    assert.ok(hint.indexOf('src/auth/auth.test.ts') < hint.indexOf('src/auth/auth.ts'), 'test file ranks above source for test goal');

    // Opt-out: goalHints.enabled === false restores the plain path list.
    const plain = new ContextEngine({ config: { repository: { dataRoot, goalHints: { enabled: false } } } });
    const plainSection = plain.repositorySection(root, 'fix the authentication bug');
    assert.ok(plainSection.includes('Files most relevant to the current goal:'), 'plain list restored on opt-out');
    assert.ok(!plainSection.includes('Files relevant to the current goal:'), 'hint suppressed on opt-out');

    // Non-matching goal -> no hint block at all.
    const empty = engine.repositorySection(root, 'zzz nonexistent topic qqq');
    assert.ok(!empty.includes('Files relevant to the current goal:'), 'no hint when nothing matches');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
}

console.log(JSON.stringify({
  symbols: true,
  imports: true,
  classification: true,
  fullIndex: true,
  symbolMatching: true,
  roundTrip: true,
  incrementalRefresh: true,
  engineIntegration: true,
  goalHints: true
}));

main();

function main(): void {
  // All sections run synchronously above; nothing async needed.
}
