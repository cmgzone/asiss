/**
 * ContextEngine smoke test — Hermes Evolution Phase 7.
 *
 * Offline (no model API): guards budgeted, relevance-based context
 * construction:
 *   goal -> relevant memory/decisions/files/tools -> budget -> model
 *
 * Covers:
 *   1. relevance: keyword scoring + selection with recency tie-breaking
 *   2. budget: priority-ordered fitToBudget, head+tail trim, dropped sections
 *   3. summarizer: fallback truncation, model-backed summarization + cache,
 *      repeated-line collapsing
 *   4. repository context: indexing (noise excluded), goal-matched files,
 *      rendered block
 *   5. ContextEngine.build: full pipeline, section ordering, token totals,
 *      budget warnings
 *   6. renderHistory: byte-identical role labels + truncation (AgentRunner
 *      drop-in)
 *   7. selectTools: tool relevance filter
 *
 * Run with: npx ts-node scripts/smoke-context.ts
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  selectRelevant,
  selectRelevantWithRecency,
  relevanceScore,
  fitToBudget,
  trimToTokens,
  truncateChars,
  estimateTokens,
  Summarizer,
  indexWorkspace,
  matchFiles,
  renderRepositoryContext,
  ContextEngine,
  historyLabel
} from '../src/core/context';

async function main() {
  // ---- 1. Relevance ----
  {
    assert.ok(relevanceScore('fix authentication login', 'fix the authentication flow') > 0, 'overlapping tokens score');
    assert.strictEqual(relevanceScore('quantum physics', 'cooking recipes'), 0, 'no overlap scores zero');
    const items = ['auth login bug', 'shopping cart total', 'authentication fix needed'];
    const top = selectRelevant(items, 'fix the login authentication bug', 2, (s) => s);
    assert.deepStrictEqual(top, ['auth login bug', 'authentication fix needed'], 'relevant items ranked first');

    const ordered = ['first unrelated', 'middle auth bug', 'last auth bug'];
    const withRecency = selectRelevantWithRecency(ordered, 'auth bug', 1, (s) => s, (s) => ordered.indexOf(s));
    assert.strictEqual(withRecency[0], 'last auth bug', 'recency breaks ties');
  }

  // ---- 2. Budget ----
  {
    const sections = [
      { name: 'mission', text: 'A'.repeat(4000), priority: 60 },
      { name: 'tools', text: 'B'.repeat(4000), priority: 20 },
      { name: 'notes', text: 'C'.repeat(4000), priority: 10 }
    ];
    const tight = fitToBudget(sections, 1200);
    assert.ok(tight.totalTokens <= 1200, 'total fits the budget');
    assert.strictEqual(tight.sections.find((s) => s.name === 'mission')!.dropped, false, 'high priority survives');
    const dropped = tight.sections.find((s) => s.name === 'notes')!;
    assert.strictEqual(dropped.dropped, true, 'lowest priority dropped first');
    const tools = tight.sections.find((s) => s.name === 'tools')!;
    assert.ok(tools.text.length < 4000, 'mid priority trimmed');

    const trimmed = trimToTokens('X'.repeat(2000), 100);
    assert.ok(trimmed.length < 2000, 'trim shortens');
    assert.ok(trimmed.includes('context trimmed'), 'trim marker present');
    assert.strictEqual(trimmed.slice(0, 20), 'X'.repeat(20), 'head kept');

    assert.strictEqual(truncateChars('abc', 2).includes('[Truncated'), true, 'hard truncation marker');
    assert.ok(estimateTokens('a'.repeat(400)) >= 100, 'token estimation ~4 chars per token');
  }

  // ---- 3. Summarizer ----
  {
    const summarizer = new Summarizer({ minChars: 200, maxChars: 100 });
    const long = 'fact '.repeat(200);
    const fallback = await summarizer.summarize(long);
    assert.ok(fallback.length < long.length, 'fallback truncates long text');
    assert.ok(fallback.includes('[summarized'), 'fallback marker present');

    let calls = 0;
    const modelSummarizer = new Summarizer({
      minChars: 200,
      maxChars: 100,
      summarize: async (text) => { calls += 1; return `SUMMARY(${text.length})`; }
    });
    const s1 = await modelSummarizer.summarize('long enough '.repeat(30));
    const s2 = await modelSummarizer.summarize('long enough '.repeat(30));
    assert.strictEqual(calls, 1, 'cache prevents re-summarizing identical input');
    assert.strictEqual(s1, s2, 'cached summary returned');

    const collapsed = Summarizer.collapseRepeated('a\na\na\na\na\nb\nb\nb\n');
    assert.strictEqual(collapsed, 'a\na\na\nb\nb\nb\n', 'repeated lines collapsed to maxRepeats');
  }

  // ---- 4. Repository context ----
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitu-smoke-context-'));
    try {
      fs.mkdirSync(path.join(root, 'src', 'auth'), { recursive: true });
      fs.mkdirSync(path.join(root, 'src', 'api'), { recursive: true });
      fs.mkdirSync(path.join(root, 'src', 'middleware'), { recursive: true });
      fs.mkdirSync(path.join(root, 'tests', 'auth'), { recursive: true });
      fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
      fs.mkdirSync(path.join(root, 'node_modules', 'big-dep'), { recursive: true });
      fs.writeFileSync(path.join(root, 'src', 'auth', 'auth.ts'), 'export const login = () => {};\n');
      fs.writeFileSync(path.join(root, 'src', 'api', 'login.ts'), 'export const loginApi = () => {};\n');
      fs.writeFileSync(path.join(root, 'src', 'middleware', 'auth.ts'), 'export const guard = () => {};\n');
      fs.writeFileSync(path.join(root, 'tests', 'auth', 'auth.test.ts'), "import { login } from '../../src/auth/auth';\n");
      fs.writeFileSync(path.join(root, 'node_modules', 'big-dep', 'index.js'), 'noise\n');
      fs.writeFileSync(path.join(root, 'src', 'auth', 'logo.png'), 'not text');

      const index = indexWorkspace(root);
      assert.strictEqual(index.fileCount, 4, 'noise (node_modules, images) excluded');
      assert.ok(index.languages['.ts'] >= 4, 'language breakdown recorded');

      const matches = matchFiles(index, 'fix the login authentication bug', 5);
      const paths = matches.map((f) => f.path);
      assert.ok(paths.includes('src/auth/auth.ts'), 'goal-matched auth file surfaced');
      assert.ok(paths.includes('src/api/login.ts'), 'goal-matched login file surfaced');
      assert.ok(paths.includes('tests/auth/auth.test.ts'), 'goal-matched test surfaced');

      const rendered = renderRepositoryContext(index, 'fix the login authentication bug');
      assert.ok(rendered.includes('Files most relevant to the current goal:'), 'render labels relevant files');
      assert.ok(rendered.includes('src/auth/auth.ts'), 'render lists matched file');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ---- 5. ContextEngine.build: full pipeline ----
  {
    const engine = new ContextEngine();
    const pkg = await engine.build({
      goal: 'fix authentication',
      history: [
        { role: 'user', content: 'Please fix authentication', missionMarker: true },
        { role: 'assistant', content: 'I will inspect the auth code.' },
        { role: 'system', content: "Tool 'read_file' Output: {\"ok\":true}" }
      ],
      tools: [
        { name: 'apply_patch', description: 'edit files' },
        { name: 'web_search', description: 'search the web' }
      ],
      project: 'Project: test project',
      repository: 'Repository context:\n- 4 files',
      decisions: ['User approved apply_patch (approval 1)'],
      notes: 'Scratchpad: auth is in src/auth/auth.ts'
    });
    assert.ok(pkg.totalTokens > 0, 'package has tokens');
    assert.ok(pkg.text.includes('User (Current Mission): Please fix authentication'), 'mission labeled in text');
    assert.ok(pkg.text.includes('Repository context:'), 'repository section present');
    assert.strictEqual(pkg.sections[0].name, 'history', 'history is the highest-priority section');
    assert.ok(pkg.sections.some((s) => s.name === 'tools'), 'tools section present');
    assert.ok(pkg.inputTokens >= pkg.totalTokens, 'budget never grows the input');

    // Tight budget drops low-priority sections and warns.
    const tight = await engine.build(
      { goal: 'x', history: [{ role: 'user', content: 'm'.repeat(20000) }], tools: [{ name: 'web_search', description: 'y' }] },
      { maxTokens: 200 }
    );
    assert.ok(tight.totalTokens <= 200, 'tight budget respected');
    assert.ok(tight.warnings.length > 0, 'budget warnings recorded');
  }

  // ---- 6. renderHistory: byte-identical drop-in ----
  {
    const engine = new ContextEngine();
    const memories = [
      { role: 'user' as const, content: 'do the thing', missionMarker: true },
      { role: 'assistant' as const, content: 'ok' },
      { role: 'system' as const, content: 'tool output' }
    ];
    const rendered = engine.renderHistory(memories, { truncateChars: 20000 });
    assert.strictEqual(
      rendered,
      'User (Current Mission): do the thing\nAssistant: ok\nSystem: tool output',
      'labels match the AgentRunner renderer'
    );
    assert.strictEqual(historyLabel('user', false), 'User');
    assert.strictEqual(historyLabel('user', true), 'User (Current Mission)');
    assert.strictEqual(historyLabel('assistant', false), 'Assistant');
    assert.strictEqual(historyLabel('system', false), 'System');
    const long = engine.renderHistory([{ role: 'user' as const, content: 'z'.repeat(30000) }], { truncateChars: 100 });
    assert.ok(long.includes('[Truncated'), 'truncation marker identical to legacy');
  }

  // ---- 7. selectTools ----
  {
    const engine = new ContextEngine();
    const tools = [
      { name: 'web_search', description: 'search the web for sources' },
      { name: 'apply_patch', description: 'edit workspace files' },
      { name: 'playwright', description: 'drive a browser' },
      { name: 'shell', description: 'run commands' }
    ];
    const selected = engine.selectTools(tools, 'edit the file and run the tests');
    assert.ok(selected.some((t) => t.name === 'apply_patch'), 'relevant tool kept');
    assert.ok(selected.some((t) => t.name === 'shell'), 'relevant tool kept');
    assert.ok(!selected.some((t) => t.name === 'web_search'), 'irrelevant tool filtered');
  }

  console.log(JSON.stringify({
    relevance: true,
    budget: true,
    summarizer: true,
    repositoryContext: true,
    engineBuild: true,
    renderHistory: true,
    toolRelevance: true
  }));
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
