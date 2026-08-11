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
import { ContextEngine, detectTestCommand, matchedTestFiles, resolveSymbols, runGoalTests, stemOf, warmOnToolEvents } from '../src/core/context';
import { TaskEventBus } from '../src/core/task';
import { SymbolSkill } from '../src/skills/symbol';
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

async function main(): Promise<void> {
  // ---- 10. Bare-symbol resolution + /symbol skill ----
  {
    const root = tmpRepo('repo-index-10-');
    const dataRoot = tmpRepo('repo-data-10-');
    try {
      write(root, 'src/auth/auth.ts', 'export function authenticate(u: string) { return true; }\nexport class AuthService {}\n');
      write(root, 'src/app.ts', "import { authenticate } from './auth/auth';\nexport function main() { authenticate('u'); }\n");
      write(root, 'README.md', '# demo\n');
      const engine = new ContextEngine({ config: { repository: { dataRoot } } });
      const index = engine.indexRepository(root) as any;

      // resolveSymbols: "fix authenticate()" -> the defining file.
      const resolved = resolveSymbols(index, 'fix authenticate()');
      assert.strictEqual(resolved.length, 1, 'authenticate resolves');
      assert.strictEqual(resolved[0].symbol, 'authenticate', 'resolved symbol name');
      assert.deepStrictEqual(resolved[0].files.map((f: any) => f.path), ['src/auth/auth.ts'], 'resolved to defining file');

      // Case-insensitive fallback: AUTHENTICATE resolves to authenticate.
      const ci = resolveSymbols(index, 'AUTHENTICATE failed again');
      assert.ok(ci.some((r) => r.symbol === 'AUTHENTICATE' && r.files.some((f: any) => f.path === 'src/auth/auth.ts')), 'case-insensitive lookup');

      // Class symbol resolves with its kind.
      const cls = resolveSymbols(index, 'AuthService is broken');
      assert.strictEqual(cls[0].key, 'AuthService', 'class resolves');

      // No match -> empty (not noise).
      assert.strictEqual(resolveSymbols(index, 'zzz qqq none').length, 0, 'no resolution for unrelated goal');

      // ContextEngine wrapper mirrors the module function.
      const viaEngine = engine.resolveSymbols(root, 'fix authenticate()');
      assert.strictEqual(viaEngine.length, 1, 'engine.resolveSymbols works');

      // SymbolSkill end-to-end (hermetic engine injected).
      const skill = new SymbolSkill({ contextEngine: engine });
      const result = await skill.execute({ goal: 'fix authenticate()', __workspacePath: root });
      assert.strictEqual(result.count, 1, 'skill resolves one symbol');
      assert.strictEqual(result.results[0].symbol, 'authenticate', 'skill symbol');
      const entry = result.results[0].files[0];
      assert.strictEqual(entry.path, 'src/auth/auth.ts', 'skill file path');
      assert.strictEqual(entry.kind, 'function', 'skill symbol kind');
      assert.ok(typeof entry.line === 'number', 'skill line present');

      // Skill by explicit symbol name.
      const byName = await skill.execute({ symbol: 'AuthService', __workspacePath: root });
      assert.strictEqual(byName.count, 1, 'skill resolves by name');
      assert.strictEqual(byName.results[0].files[0].kind, 'class', 'class kind via skill');

      // Skill with no match reports count 0 + note, not an error.
      const miss = await skill.execute({ symbol: 'NopeNope', __workspacePath: root });
      assert.strictEqual(miss.count, 0, 'skill no-match count');
      assert.ok(miss.note, 'skill no-match note');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  }


  // ---- 11. Phase 9 warm: on-demand index refresh ----
  {
    const root = tmpRepo('repo-index-11-');
    const dataRoot = tmpRepo('repo-data-11-');
    try {
      const auth = write(root, 'src/auth/auth.ts', 'export function authenticate(u: string) { return true; }\n');
      write(root, 'src/app.ts', "export function main() { return 1; }\n");
      const engine = new ContextEngine({ config: { repository: { dataRoot, warm: { throttleMs: 60000 } } } });

      // Build (caches) the index, then add a NEW exported symbol to auth.ts.
      engine.indexRepository(root);
      assert.ok(!engine.resolveSymbols(root, 'logout').length, 'logout unknown before refresh');
      // Establish the warm baseline.
      assert.strictEqual(engine.refreshRepository(root, { force: true }), true, 'baseline warm ran');
      fs.appendFileSync(auth, '\nexport function logout() { return true; }\n');

      // Throttled refresh is a no-op within the window.
      assert.strictEqual(engine.refreshRepository(root), false, 'throttled refresh skipped');

      // Forced refresh re-parses the changed file and updates the cache.
      assert.strictEqual(engine.refreshRepository(root, { force: true }), true, 'forced refresh ran');
      const after = engine.resolveSymbols(root, 'logout');
      assert.strictEqual(after.length, 1, 'logout resolves after warm refresh');
      assert.strictEqual(after[0].files[0].path, 'src/auth/auth.ts', 'logout in the right file');

      // The persisted index on disk was updated too (next load sees it).
      const loaded = loadRepositoryIndex(root, dataRoot)!;
      assert.ok(loaded.exportedSymbols['logout'], 'persisted index refreshed on disk');

      // warm.enabled === false fully disables refresh.
      const cold = new ContextEngine({ config: { repository: { dataRoot, warm: { enabled: false } } } });
      cold.indexRepository(root);
      const authPath = path.join(root, 'src/app.ts');
      fs.appendFileSync(authPath, '\nexport function helper() { return 2; }\n');
      assert.strictEqual(cold.refreshRepository(root, { force: true }), false, 'warm disabled -> no refresh');
      assert.ok(!cold.resolveSymbols(root, 'helper').length, 'cache stays stale when warm disabled');

      // Lightweight index (persistent: false) rebuilds on refresh.
      const light = new ContextEngine({ config: { repository: { persistent: false, dataRoot } } });
      light.indexRepository(root);
      write(root, 'src/new.ts', 'export function fresh() { return 3; }\n');
      assert.strictEqual(light.refreshRepository(root, { force: true }), true, 'lightweight refresh ran');
      assert.ok(light.relevantFiles(root, 'fresh', 4).some((f: any) => f.path === 'src/new.ts'), 'new file picked up by lightweight refresh');

      // SymbolSkill self-refreshes: after the file changed, a query finds it.
      write(root, 'src/api.ts', 'export function session() { return "s"; }\n');
      const skill = new SymbolSkill({ contextEngine: engine });
      const res = await skill.execute({ symbol: 'session', __workspacePath: root });
      assert.strictEqual(res.count, 1, 'skill sees fresh symbols without explicit warm');
      assert.strictEqual(res.results[0].files[0].path, 'src/api.ts', 'skill resolves the new file');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  }


  // ---- 12. Warmth telemetry (Phase 9) ----
  {
    const root = tmpRepo('repo-index-12-');
    const dataRoot = tmpRepo('repo-data-12-');
    try {
      const bus = new TaskEventBus();
      const events: any[] = [];
      bus.on('*', (e) => { events.push(e); });
      const engine = new ContextEngine({ bus, config: { repository: { dataRoot, warm: { throttleMs: 60000 } } } });

      write(root, 'src/auth/auth.ts', 'export function authenticate(u: string) { return true; }\n');
      engine.indexRepository(root);
      fs.appendFileSync(path.join(root, 'src/auth/auth.ts'), 'export function logout() { return true; }\n');

      const ran = engine.refreshRepository(root, { force: true, sessionId: 's-1', taskId: 't-1' });
      assert.strictEqual(ran, true, 'refresh ran');
      const evt = events.find((e: any) => e.name === 'RepositoryIndexRefreshed');
      assert.ok(evt, 'warmth event emitted');
      assert.strictEqual(evt.taskId, 't-1', 'event carries task attribution');
      assert.strictEqual(evt.data.sessionId, 's-1', 'event carries session attribution');
      assert.strictEqual(evt.data.root, root, 'event carries root');
      assert.strictEqual(evt.data.filesReParsed, 1, 'reparsed count reported');
      assert.ok(evt.data.symbolsRefreshed >= 1, 'symbols refreshed reported');
      assert.ok(evt.data.fileCount >= 1, 'file count reported');

      const warmth = engine.indexWarmth(root)!;
      assert.strictEqual(warmth.sessionId, 's-1', 'warmth snapshot recorded');
      assert.ok(Date.now() - warmth.lastRefreshedAt < 5000, 'warmth timestamp fresh');

      // Unchanged refresh reports filesReParsed 0 (checked, nothing changed).
      events.length = 0;
      engine.refreshRepository(root, { force: true, sessionId: 's-1' });
      const idle = events.find((e: any) => e.name === 'RepositoryIndexRefreshed');
      assert.strictEqual(idle.data.filesReParsed, 0, 'idle refresh reports 0 re-parsed');
      assert.strictEqual(idle.data.symbolsRefreshed, 0, 'idle refresh reports 0 symbols');

      // Telemetry opt-out suppresses the event but still warms.
      const quiet = new ContextEngine({ bus, config: { repository: { dataRoot, telemetry: { enabled: false } } } });
      quiet.indexRepository(root);
      const n0 = events.length;
      assert.strictEqual(quiet.refreshRepository(root, { force: true }), true, 'opt-out still refreshes');
      assert.strictEqual(events.length, n0, 'telemetry opt-out suppresses events');
      assert.ok(quiet.indexWarmth(root), 'warmth still recorded when telemetry off');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  }


  // ---- 13. Event-driven warm index (Phase 9) ----
  {
    const root = tmpRepo('repo-index-13-');
    const dataRoot = tmpRepo('repo-data-13-');
    try {
      const bus = new TaskEventBus();
      const engine = new ContextEngine({ bus, config: { repository: { dataRoot } } });
      write(root, 'src/auth/auth.ts', 'export function authenticate() {}\n');
      engine.indexRepository(root);

      const close = warmOnToolEvents(bus, root, engine, { debounceMs: 20, sessionId: 's-1' });

      // Non-mutating tool: no refresh.
      await bus.emit({ name: 'ToolCompleted', taskId: 't-1', timestamp: Date.now(), data: { tool: 'web_search' } });
      await sleep(60);
      assert.strictEqual(engine.indexWarmth(root), undefined, 'non-mutating tool does not warm');

      // Mutating tool completion: refresh fires after the debounce.
      fs.appendFileSync(path.join(root, 'src/auth/auth.ts'), 'export function logout() {}\n');
      await bus.emit({ name: 'ToolCompleted', taskId: 't-1', timestamp: Date.now(), data: { tool: 'apply_patch' } });
      await sleep(60);
      const warmth = engine.indexWarmth(root);
      assert.ok(warmth, 'mutating tool warms the index');
      assert.strictEqual(warmth!.sessionId, 's-1', 'watcher attributes session');
      assert.ok(warmth!.filesReParsed >= 1, 'reparsed file counted');
      assert.strictEqual(engine.resolveSymbols(root, 'logout').length, 1, 'new symbol visible after event warm');

      // ToolFailed also warms (a failed patch may still have written files).
      fs.appendFileSync(path.join(root, 'src/auth/auth.ts'), 'export function session() {}\n');
      await bus.emit({ name: 'ToolFailed', taskId: 't-1', timestamp: Date.now(), data: { tool: 'apply_patch', error: 'oops' } });
      await sleep(60);
      assert.strictEqual(engine.resolveSymbols(root, 'session').length, 1, 'ToolFailed warms too');

      // Unsubscribe stops warming and cancels the pending debounce.
      close();
      const before = engine.indexWarmth(root)?.lastRefreshedAt;
      fs.appendFileSync(path.join(root, 'src/auth/auth.ts'), 'export function fresh() {}\n');
      await bus.emit({ name: 'ToolCompleted', taskId: 't-1', timestamp: Date.now(), data: { tool: 'apply_patch' } });
      await sleep(60);
      assert.strictEqual(engine.indexWarmth(root)?.lastRefreshedAt, before, 'unsubscribe stops warming');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  }


  // ---- 14. Verify-then-retry helpers (Phase 11) ----
  {
    const root = tmpRepo('repo-index-14-');
    const dataRoot = tmpRepo('repo-data-14-');
    try {
      // stemOf strips extensions and test markers across languages.
      assert.strictEqual(stemOf('src/auth/auth.ts'), 'auth', 'stem of source file');
      assert.strictEqual(stemOf('src/auth/auth.test.ts'), 'auth', 'stem of ts test');
      assert.strictEqual(stemOf('src/auth/auth_test.py'), 'auth', 'stem of python test');

      // matchedTestFiles: sibling tests + goal-surfaced tests, cross-language.
      write(root, 'src/auth/auth.ts', 'export function authenticate() {}\n');
      write(root, 'src/auth/auth.test.js', "const { test } = require('node:test');\ntest('auth', () => {});\n");
      write(root, 'src/payments/billing.ts', 'export function charge() {}\n');
      write(root, 'src/payments/billing.test.ts', 'export function x() {}\n');
      write(root, 'src/payments/billing_test.py', 'def test_charge():\n    pass\n');
      const engine = new ContextEngine({ config: { repository: { dataRoot } } });
      const index = engine.indexRepository(root) as any;
      const matched = engine.relevantFiles(root, 'fix authentication', 8) as any[];
      const tests = matchedTestFiles(index, 'fix authentication', matched, 4).map((f: any) => f.path);
      assert.ok(tests.includes('src/auth/auth.test.js'), 'sibling test matched for auth source');
      assert.ok(!tests.includes('src/payments/billing.test.ts'), 'unrelated test not matched');
      assert.strictEqual(stemOf('src/payments/billing_test.py'), 'billing', 'python sibling stem');

      // detectTestCommand: node:test without deps; jest requires the dependency.
      const nodeTest = detectTestCommand(root, index.files.filter((f: any) => f.path === 'src/auth/auth.test.js'));
      assert.strictEqual(nodeTest?.engine, 'node:test', 'node:test detected');
      assert.ok(String(nodeTest?.command).includes('node --test'), 'node --test command');
      const pyTest = detectTestCommand(root, index.files.filter((f: any) => f.path === 'src/payments/billing_test.py'));
      assert.strictEqual(pyTest?.engine, 'pytest', 'pytest detected');
      assert.strictEqual(detectTestCommand(root, []), null, 'no files -> no command');

      // runGoalTests executes the matched node:test and reports the outcome.
      const passing = await runGoalTests(root, [index.files.find((f: any) => f.path === 'src/auth/auth.test.js')], { timeoutMs: 20000 });
      assert.strictEqual(passing.ran, true, 'test run executed');
      assert.strictEqual(passing.exitCode, 0, 'passing test exit 0');
      assert.ok(String(passing.output).includes('pass'), 'test output captured');

      // A failing test reports a nonzero exit without throwing.
      write(root, 'src/fail.test.js', "const { test } = require('node:test');\ntest('boom', () => { throw new Error('nope'); });\n");
      engine.refreshRepository(root, { force: true });
      const failFile = engine.indexRepository(root)!.files.find((f: any) => f.path === 'src/fail.test.js')!;
      const failing = await runGoalTests(root, [failFile], { timeoutMs: 20000 });
      assert.strictEqual(failing.ran, true, 'failing run executed');
      assert.notStrictEqual(failing.exitCode, 0, 'failing test nonzero exit');
      assert.ok(String(failing.output).length > 0, 'failure output captured');
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
    goalHints: true,
    symbolResolution: true,
    warmRefresh: true,
    warmthTelemetry: true,
    eventWarming: true,
    verifyThenRetry: true
  }));
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
