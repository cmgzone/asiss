/**
 * Hermes typed config — architecture review Move 1.
 *
 * Replaces the structural `loadConfig(): any` reads with a validated load.
 * The promise: a typo in an engine knob is a loud, named error at load time,
 * never a silent behavior change.
 *
 * Strictness is scoped to the engine surface (the ~20 knobs the five engines
 * and AgentRunner read structurally):
 *
 *   - `policy`           STRICT    (full PolicyConfig schema; unknown keys error)
 *   - `agent.context`    STRICT    (full ContextEngineConfig schema; unknown keys error)
 *   - `agent`            PERMISSIVE (engine knobs type-checked; other agent keys pass through)
 *   - `checkpoints`      PERMISSIVE (booleans the ToolEngine reads type-checked; rest passes through)
 *   - everything else    PASS-THROUGH (other sections are owned by other consumers)
 *
 * `validateConfig` never throws: it returns the sanitized config plus every
 * error it found. Invalid/unknown keys are *stripped* so a half-typed value
 * never reaches an engine; `strictValidateConfig` throws for tests and any
 * host that wants a hard failure. `loadHermesConfig` reads config.json,
 * validates, and logs all errors loudly (once per file change).
 */

import fs from 'fs';

import type { PolicyConfig } from './policy/policy-types';
import type { ContextEngineConfig } from './context/context-engine';

/** Top-level config shape. Non-engine sections pass through as `unknown`. */
export interface HermesConfig {
  model?: string;
  channels?: string[];
  agent?: {
    maxTurns?: number;
    unlimitedTools?: boolean;
    maxNativeTools?: number;
    maxMcpToolsPerServer?: number;
    autoContinue?: { enabled?: boolean; maxBatches?: number; notify?: boolean };
    context?: ContextEngineConfig;
    [key: string]: unknown;
  };
  policy?: PolicyConfig;
  checkpoints?: {
    enabled?: boolean;
    required?: boolean;
    automaticBeforePatch?: boolean;
    automaticBeforeDestructiveShell?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ConfigValidationResult {
  /** Sanitized config: invalid/unknown engine keys stripped, everything else intact. */
  config: HermesConfig;
  /** Human-readable problems, one per key. Empty when the config is clean. */
  errors: string[];
  /** Keys that were removed because they were unknown or mistyped. */
  invalidKeys: string[];
}

export class ConfigValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Invalid Hermes configuration:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
    this.name = 'ConfigValidationError';
  }
}

const POLICY_MODES = new Set(['allow', 'ask', 'deny']);
const DEFAULT_OUTCOMES = new Set(['allow', 'deny']);

interface FieldRule {
  key: string;
  kind: 'boolean' | 'number' | 'string' | 'string-array' | 'modes' | 'object';
  modes?: Set<string>;
  /** For kind 'object': strict rules for the nested fields. */
  nested?: FieldRule[];
}

const POLICY_FIELDS: FieldRule[] = [
  { key: 'enabled', kind: 'boolean' },
  { key: 'workspaceGuard', kind: 'boolean' },
  { key: 'destructiveCommands', kind: 'modes', modes: POLICY_MODES },
  { key: 'secretScan', kind: 'modes', modes: POLICY_MODES },
  { key: 'networkTools', kind: 'modes', modes: POLICY_MODES },
  { key: 'fileWrites', kind: 'modes', modes: POLICY_MODES },
  { key: 'elevatedCommands', kind: 'modes', modes: POLICY_MODES },
  { key: 'allowedTools', kind: 'string-array' },
  { key: 'deniedTools', kind: 'string-array' },
  { key: 'enforceAllowDeny', kind: 'boolean' },
  { key: 'escalateAskOnHighRisk', kind: 'boolean' }
];

const CONTEXT_FIELDS: FieldRule[] = [
  { key: 'maxTokens', kind: 'number' },
  { key: 'truncateChars', kind: 'number' }
];

const CONTEXT_REPOSITORY_FIELDS: FieldRule[] = [
  { key: 'enabled', kind: 'boolean' },
  { key: 'persistent', kind: 'boolean' },
  { key: 'maxFiles', kind: 'number' },
  { key: 'maxDepth', kind: 'number' },
  { key: 'maxListed', kind: 'number' },
  { key: 'dataRoot', kind: 'string' }
];

const AGENT_ENGINE_KNOBS: FieldRule[] = [
  { key: 'maxTurns', kind: 'number' },
  { key: 'unlimitedTools', kind: 'boolean' },
  { key: 'maxNativeTools', kind: 'number' },
  { key: 'maxMcpToolsPerServer', kind: 'number' }
];

const CHECKPOINT_BOOLEANS = ['enabled', 'required', 'automaticBeforePatch', 'automaticBeforeDestructiveShell'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkField(section: string, value: unknown, rule: FieldRule, errors: string[], invalidKeys: string[]): void {
  const path = `${section}.${rule.key}`;
  switch (rule.kind) {
    case 'boolean':
      if (typeof value !== 'boolean') {
        errors.push(`${path}: expected a boolean, got ${describe(value)}`);
        invalidKeys.push(path);
      }
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push(`${path}: expected a number, got ${describe(value)}`);
        invalidKeys.push(path);
      }
      break;
    case 'string':
      if (typeof value !== 'string') {
        errors.push(`${path}: expected a string, got ${describe(value)}`);
        invalidKeys.push(path);
      }
      break;
    case 'string-array':
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        errors.push(`${path}: expected an array of strings, got ${describe(value)}`);
        invalidKeys.push(path);
      }
      break;
    case 'modes': {
      if (typeof value !== 'string' || !rule.modes!.has(value)) {
        errors.push(`${path}: expected one of [${Array.from(rule.modes!).join(', ')}], got ${describe(value)}`);
        invalidKeys.push(path);
      }
      break;
    }
  }
}

function sanitizeSection(
  section: string,
  raw: unknown,
  rules: FieldRule[]
): { clean: Record<string, unknown> | undefined; errors: string[]; invalidKeys: string[] } {
  const errors: string[] = [];
  const invalidKeys: string[] = [];
  if (raw === undefined) return { clean: undefined, errors, invalidKeys };
  if (!isPlainObject(raw)) {
    errors.push(`${section}: expected an object, got ${describe(raw)}`);
    invalidKeys.push(section);
    return { clean: undefined, errors, invalidKeys };
  }
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const rule = rules.find((r) => r.key === key);
    if (rule && rule.kind === 'object' && rule.nested) {
      if (!isPlainObject(value)) {
        errors.push(`${section}.${key}: expected an object, got ${describe(value)}`);
        invalidKeys.push(`${section}.${key}`);
        continue;
      }
      const inner = sanitizeSection(`${section}.${key}`, value, rule.nested);
      errors.push(...inner.errors);
      invalidKeys.push(...inner.invalidKeys);
      if (Object.keys(inner.clean || {}).length > 0) clean[key] = inner.clean;
      continue;
    }
    if (rule) {
      checkField(section, value, rule, errors, invalidKeys);
      if (value !== undefined && !invalidKeys.includes(`${section}.${key}`)) clean[key] = value;
      continue;
    }
    errors.push(`${section}.${key}: unknown key (did you mean a key listed in docs/hermes/ARCHITECTURE_REVIEW.md?)`);
    invalidKeys.push(`${section}.${key}`);
  }
  return { clean, errors, invalidKeys };
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `\`${typeof value === 'string' ? value : JSON.stringify(value)}\``;
}

/**
 * Validate and sanitize a raw config object. Never throws. Invalid/unknown
 * keys inside the strict engine sections are reported and stripped; every
 * other section passes through untouched.
 */
export function validateConfig(raw: unknown): ConfigValidationResult {
  const errors: string[] = [];
  const invalidKeys: string[] = [];
  const config: HermesConfig = isPlainObject(raw) ? { ...raw } : { model: 'mock' };

  if (!isPlainObject(raw)) {
    errors.push('config: expected a JSON object at the top level');
    invalidKeys.push('config');
    return { config, errors, invalidKeys };
  }

  // ---- p
  // ---- policy: STRICT ----
  const policy = sanitizeSection('policy', raw.policy, [
    ...POLICY_FIELDS,
    { key: 'approval', kind: 'object', nested: [{ key: 'defaultOutcome', kind: 'modes', modes: DEFAULT_OUTCOMES }] }
  ]);
  errors.push(...policy.errors);
  invalidKeys.push(...policy.invalidKeys);
  if (policy.clean) config.policy = policy.clean as PolicyConfig;

  // ---- agent.context: STRICT ----
  const agentRaw = raw.agent;
  let contextClean: Record<string, unknown> | undefined;
  if (isPlainObject(agentRaw)) {
    const context = sanitizeSection('agent.context', agentRaw.context, [
      ...CONTEXT_FIELDS,
      { key: 'repository', kind: 'object', nested: [
        ...CONTEXT_REPOSITORY_FIELDS,
        { key: 'goalHints', kind: 'object', nested: [{ key: 'enabled', kind: 'boolean' }, { key: 'maxFiles', kind: 'number' }] },
        { key: 'minimal', kind: 'object', nested: [{ key: 'enabled', kind: 'boolean' }, { key: 'maxBytes', kind: 'number' }, { key: 'maxFiles', kind: 'number' }] },
        { key: 'warm', kind: 'object', nested: [{ key: 'enabled', kind: 'boolean' }, { key: 'throttleMs', kind: 'number' }] },
        { key: 'telemetry', kind: 'object', nested: [{ key: 'enabled', kind: 'boolean' }] }
      ] },
      { key: 'summarize', kind: 'object', nested: [{ key: 'enabled', kind: 'boolean' }, { key: 'maxChars', kind: 'number' }] },
      { key: 'plan', kind: 'object', nested: [{ key: 'enabled', kind: 'boolean' }] }
    ]);
    errors.push(...context.errors);
    invalidKeys.push(...context.invalidKeys);
    contextClean = context.clean;
  }

  // ---- agent: PERMISSIVE (engine knobs type-checked; rest passes through) ----
  const agent: Record<string, unknown> = isPlainObject(agentRaw) ? { ...agentRaw } : {};
  for (const rule of AGENT_ENGINE_KNOBS) {
    if (rule.key in agent && agent[rule.key] !== undefined) {
      checkField('agent', agent[rule.key], rule, errors, invalidKeys);
      if (invalidKeys.includes(`agent.${rule.key}`)) delete agent[rule.key];
    }
  }
  if (isPlainObject(agent.autoContinue) && agent.autoContinue.maxBatches !== undefined) {
    checkField('agent.autoContinue', agent.autoContinue.maxBatches, { key: 'maxBatches', kind: 'number' }, errors, invalidKeys);
    if (invalidKeys.includes('agent.autoContinue.maxBatches')) delete agent.autoContinue.maxBatches;
  }
  if (contextClean !== undefined && contextClean !== null) agent.context = contextClean;
  if (Object.keys(agent).length > 0) config.agent = agent as HermesConfig['agent'];

  // ---- checkpoints: PERMISSIVE ----
  const checkpointsRaw = raw.checkpoints;
  if (isPlainObject(checkpointsRaw)) {
    const checkpoints: Record<string, unknown> = { ...checkpointsRaw };
    for (const key of CHECKPOINT_BOOLEANS) {
      if (key in checkpoints && checkpoints[key] !== undefined) {
        checkField('checkpoints', checkpoints[key], { key, kind: 'boolean' }, errors, invalidKeys);
        if (invalidKeys.includes(`checkpoints.${key}`)) delete checkpoints[key];
      }
    }
    config.checkpoints = checkpoints as HermesConfig['checkpoints'];
  }

  return { config, errors, invalidKeys };
}

/** Strict variant: throws ConfigValidationError when any error is found. */
export function strictValidateConfig(raw: unknown): HermesConfig {
  const result = validateConfig(raw);
  if (result.errors.length > 0) throw new ConfigValidationError(result.errors);
  return result.config;
}

const cache: { filePath: string; mtimeMs: number; size: number; config: HermesConfig; lastError: string } = {
  filePath: '', mtimeMs: -1, size: -1, config: { model: 'mock' }, lastError: ''
};

/**
 * Load + validate the app config. Reads `config.json` when present (falling
 * back to `{ model: 'mock' }`), validates the engine sections, logs every
 * problem loudly (once per file change), and returns the sanitized config so
 * a half-typed value never reaches an engine. Re-validates only when the file
 * changes (mtime/size), preserving the app's live-config-edit behavior.
 */
export function loadHermesConfig(filePath = 'config.json'): HermesConfig {
  let raw: unknown = { model: 'mock' };
  let mtimeMs = 0;
  let size = 0;
  if (fs.existsSync(filePath)) {
    try {
      const stat = fs.statSync(filePath);
      mtimeMs = stat.mtimeMs;
      size = stat.size;
      raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (e) {
      console.error('[HermesConfig] config.json is invalid JSON; falling back to defaults.', e);
      return { model: 'mock' };
    }
  } else {
    return { model: 'mock' };
  }

  if (cache.filePath === filePath && cache.mtimeMs === mtimeMs && cache.size === size) return cache.config;

  const result = validateConfig(raw);
  const errorText = result.errors.join('\n');
  if (result.errors.length > 0 && errorText !== cache.lastError) {
    console.error('[HermesConfig] Configuration errors found (invalid keys were stripped; fix config.json):\n' + result.errors.map((e) => `  - ${e}`).join('\n'));
    cache.lastError = errorText;
  }
  cache.filePath = filePath;
  cache.mtimeMs = mtimeMs;
  cache.size = size;
  cache.config = result.config;
  return result.config;
}
