/**
 * Smoke test — architecture review Move 1: typed, validated config.
 *
 * Proves the fail-loud guarantee: a typo in an engine knob is a named error
 * (and the invalid key is stripped), while valid keys, permissive agent keys
 * and non-engine sections pass through untouched.
 */

import * as assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  ConfigValidationError,
  loadHermesConfig,
  strictValidateConfig,
  validateConfig
} from '../src/core/config';
import { ContextEngine } from '../src/core/context';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function section(label: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    console.error(`  ✗ ${label}`);
    throw err;
  }
}

// ---- 1. Clean config: zero errors, keys preserved ----
section('clean config passes', () => {
  const result = validateConfig({
    model: 'OpenRouter',
    policy: {
      enabled: true,
      destructiveCommands: 'ask',
      approval: { defaultOutcome: 'deny' },
      allowedTools: ['shell']
    },
    agent: {
      maxTurns: 100,
      unlimitedTools: true,
      autoContinue: { maxBatches: 2 },
      context: {
        maxTokens: 16000,
        repository: {
          enabled: true, persistent: true, maxFiles: 8, dataRoot: '/tmp/x',
          goalHints: { enabled: true, maxFiles: 3 },
          warm: { enabled: true, throttleMs: 2000 },
          telemetry: { enabled: true }
        },
        summarize: { enabled: false }
      },
      repetitionGuard: { maxRepeatedToolBatches: 3 }
    },
    checkpoints: { enabled: true, required: false, automaticBeforePatch: true, maxPerWorkspace: 100 },
    learning: { enabled: true }
  });
  assert.strictEqual(result.errors.length, 0, `expected no errors, got: ${result.errors.join('; ')}`);
  assert.strictEqual(result.config.policy?.destructiveCommands, 'ask');
  assert.strictEqual(result.config.policy?.approval?.defaultOutcome, 'deny');
  assert.deepStrictEqual(result.config.policy?.allowedTools, ['shell']);
  assert.strictEqual(result.config.agent?.maxTurns, 100);
  assert.strictEqual(result.config.agent?.autoContinue?.maxBatches, 2);
  assert.strictEqual(result.config.agent?.context?.repository?.dataRoot, '/tmp/x');
  assert.strictEqual(result.config.agent?.context?.repository?.goalHints?.maxFiles, 3);
  assert.strictEqual(result.config.agent?.context?.repository?.warm?.throttleMs, 2000);
  assert.strictEqual(result.config.checkpoints?.maxPerWorkspace, 100, 'permissive checkpoint key kept');
  assert.deepStrictEqual(result.config.learning, { enabled: true }, 'non-engine section passes through');
  assert.deepStrictEqual(
    (result.config.agent as any).repetitionGuard,
    { maxRepeatedToolBatches: 3 },
    'unknown agent key passes through'
  );
});

// ---- 2. Typo in a strict section: named error + stripped key ----
section('policy typo fails loudly', () => {
  const result = validateConfig({
    policy: {
      destructivCommands: 'ask',
      destructiveCommands: 'deny',
      enabled: true
    }
  });
  const error = result.errors.find((e) => e.includes('policy.destructivCommands'));
  assert.ok(error, `expected error naming policy.destructivCommands, got: ${result.errors.join('; ')}`);
  assert.ok(result.invalidKeys.includes('policy.destructivCommands'));
  assert.strictEqual((result.config.policy as any).destructivCommands, undefined, 'typo stripped');
  assert.strictEqual(result.config.policy?.destructiveCommands, 'deny', 'valid sibling kept');
  assert.strictEqual(result.config.policy?.enabled, true, 'valid sibling kept');
});

// ---- 3. Wrong type in a strict section ----
section('policy wrong type flagged', () => {
  const result = validateConfig({ policy: { destructiveCommands: 42 } });
  const error = result.errors.find((e) => e.includes('policy.destructiveCommands'));
  assert.ok(error, 'type error reported');
  assert.strictEqual((result.config.policy as any).destructiveCommands, undefined, 'bad value stripped');
});

// ---- 4. agent.context typo: named error, siblings preserved ----
section('agent.context typo fails loudly', () => {
  const result = validateConfig({
    agent: {
      context: {
        repositor: { enabled: true },
        repository: { enabled: true, persistent: false }
      }
    }
  });
  const error = result.errors.find((e) => e.includes('agent.context.repositor'));
  assert.ok(error, `expected agent.context.repositor error, got: ${result.errors.join('; ')}`);
  assert.strictEqual((result.config.agent?.context as any).repositor, undefined, 'typo stripped');
  assert.deepStrictEqual(result.config.agent?.context?.repository, { enabled: true, persistent: false }, 'valid sibling kept');
});

// ---- 5. agent knobs type-checked; unknown agent keys pass through ----
section('agent knobs type-checked, others pass through', () => {
  const result = validateConfig({
    agent: {
      maxTurns: 'many',
      maxNativeTools: 60,
      maxMcpToolsPerServer: 'lots',
      unlimitedTools: true,
      autoContinue: { maxBatches: 'five' },
      repetitionGuard: { maxRepeatedToolBatches: 3 }
    }
  });
  assert.ok(result.errors.some((e) => e.includes('agent.maxTurns')), 'agent.maxTurns type error');
  assert.ok(result.errors.some((e) => e.includes('agent.maxMcpToolsPerServer')), 'agent.maxMcpToolsPerServer type error');
  assert.ok(result.errors.some((e) => e.includes('agent.autoContinue.maxBatches')), 'autoContinue.maxBatches type error');
  assert.strictEqual(result.config.agent?.maxTurns, undefined, 'bad maxTurns stripped');
  assert.strictEqual(result.config.agent?.maxNativeTools, 60, 'valid knob kept');
  assert.strictEqual(result.config.agent?.unlimitedTools, true, 'valid knob kept');
  assert.deepStrictEqual(
    (result.config.agent as any).repetitionGuard,
    { maxRepeatedToolBatches: 3 },
    'unknown agent key untouched'
  );
});

// ---- 6. Non-engine sections and bad enums ----
section('permissive top level + bad enum flagged', () => {
  const result = validateConfig({
    learning: { enabled: true, mode: 'medium' },
    backgroundWorker: { enabled: true, maxConcurrentGoals: 1 },
    policy: { destructiveCommands: 'ALWAYS' }
  });
  assert.deepStrictEqual(result.config.learning, { enabled: true, mode: 'medium' }, 'learning untouched');
  assert.deepStrictEqual(result.config.backgroundWorker, { enabled: true, maxConcurrentGoals: 1 }, 'backgroundWorker untouched');
  assert.ok(result.errors.some((e) => e.includes('policy.destructiveCommands') && e.includes('allow, ask, deny')), 'bad enum flagged');
  assert.strictEqual((result.config.policy as any).destructiveCommands, undefined, 'bad enum stripped');
});

// ---- 7. strictValidateConfig throws with all errors ----
section('strictValidateConfig throws ConfigValidationError', () => {
  assert.throws(
    () => strictValidateConfig({ policy: { destructivCommands: 'ask' }, agent: { context: { repositor: {} } } }),
    (err: unknown) => {
      assert.ok(err instanceof ConfigValidationError, 'throws ConfigValidationError');
      const messages = (err as ConfigValidationError).errors;
      assert.ok(messages.some((m) => m.includes('policy.destructivCommands')), 'lists policy typo');
      assert.ok(messages.some((m) => m.includes('agent.context.repositor')), 'lists context typo');
      return true;
    }
  );
});

// ---- 8. loadHermesConfig: file load, loud logging, strip + cache ----
section('loadHermesConfig file round-trip', () => {
  const dir = tmpDir('hermes-config-smoke-');
  const file = path.join(dir, 'config.json');
  try {
    // Valid file -> clean load.
    fs.writeFileSync(file, JSON.stringify({ model: 'mock', policy: { destructiveCommands: 'ask' } }));
    const clean = loadHermesConfig(file);
    assert.strictEqual(clean.policy?.destructiveCommands, 'ask');

    // Same mtime/size -> cached, no re-validation.
    const cached = loadHermesConfig(file);
    assert.strictEqual(cached, clean, 'cache hit returns same object');

    // Typo file -> errors logged loudly and the key stripped.
    fs.writeFileSync(file, JSON.stringify({ policy: { destructivCommands: 'ask', destructiveCommands: 'deny' } }));
    const logged: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { logged.push(String(args[0])); };
    let result: ReturnType<typeof loadHermesConfig> | undefined;
    try {
      result = loadHermesConfig(file);
    } finally {
      console.error = originalError;
    }
    assert.ok(logged.some((line) => line.includes('[HermesConfig]') && line.includes('policy.destructivCommands')), 'typo logged loudly');
    assert.strictEqual((result!.policy as any).destructivCommands, undefined, 'typo stripped from loaded config');
    assert.strictEqual(result!.policy?.destructiveCommands, 'deny', 'valid sibling loaded');

    // Missing file -> defaults.
    assert.deepStrictEqual(loadHermesConfig(path.join(dir, 'missing.json')), { model: 'mock' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 9. ContextEngine consumes the validated config (R5) ----
section('ContextEngine receives validated config', () => {
  const dir = tmpDir('hermes-config-engine-');
  try {
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export function authenticate() {}\n');
    fs.writeFileSync(path.join(repo, 'src', 'b.ts'), 'export function charge() {}\n');
    fs.writeFileSync(path.join(repo, 'src', 'c.ts'), 'export function log() {}\n');
    fs.writeFileSync(path.join(repo, 'src', 'd.ts'), 'export function ping() {}\n');
    const dataRoot = path.join(dir, 'data');
    const validated = validateConfig({
      agent: { context: { repository: { enabled: true, dataRoot, goalHints: { enabled: true, maxFiles: 2 } } } }
    }).config;
    const engine = new ContextEngine({ config: validated.agent?.context });
    const hints = engine.goalFilesSection(repo, 'fix authenticate');
    const lines = hints.split('\n').filter((l) => l.includes('src/'));
    assert.ok(lines.length <= 2, `goalHints.maxFiles=2 honored (got ${lines.length})`);
    assert.ok(hints.includes('a.ts'), 'top match present');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log(JSON.stringify({
  cleanConfig: true,
  policyTypo: true,
  policyType: true,
  contextTypo: true,
  agentKnobs: true,
  permissiveTop: true,
  strictThrows: true,
  fileLoad: true,
  engineConfig: true
}));
