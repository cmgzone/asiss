/**
 * Phase 19 Move 7 — deterministic acceptance-criteria evaluation
 * (docs/hermes/AUDIT_10.md, G6/F8).
 *
 * `goal.acceptanceCriteria` ("Done means: …") has always been prompt DATA —
 * rendered into the mission context but never checked. This module turns
 * criteria that LOOK like assertions into deterministic checks, run at the
 * completion gate alongside the goal-matched tests, with every result
 * recorded as TaskVerification evidence. Criteria that do not look like an
 * assertion are reported as UNCHECKABLE (SKIPPED evidence) — never silently
 * passed.
 *
 * Supported shapes (tolerant, case-insensitive):
 *
 *   file-contains  — "the file src/foo.ts should contain 'bar'",
 *                    "notes.txt contains 'hello'",
 *                    "contains 'x' in src/a.ts"
 *   test-command   — "run npm test", "the command `npm run smoke:x` passes",
 *                    "npm run build exits 0", "npx vitest run passes"
 *                    (npm/npx/node/yarn/pnpm/python/pytest/go test/jest/
 *                    vitest/tsc prefixes; trailing prose like "passes" or
 *                    "exits 0" is stripped; execution is bounded like the
 *                    goal-test runner — 45 s timeout, 4 KB output)
 *   uncheckable    — anything else, reported with a reason, never passed
 *
 * Execution goes through the same execution-backend plan authority as
 * verify-then-retry (`executionBackendManager.createPlan`), so commands
 * honor the backend's shell/path handling. Never throws.
 */
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import util from 'util';
import { executionBackendManager } from '../execution-backend';

const execFileAsync = util.promisify(execFile);

export type CriterionKind = 'file-contains' | 'test-command' | 'uncheckable';

export interface CriterionResult {
  criterion: string;
  kind: CriterionKind;
  /** true/false for checkable criteria; null when uncheckable. */
  passed: boolean | null;
  detail: string;
}

export interface CriteriaEvaluationOptions {
  timeoutMs?: number;
  maxOutputChars?: number;
}

const FILE_CONTAINS_FIRST = /^(?:the\s+)?(?:file\s+)?(.+?)\s+(?:should\s+)?(?:contains?|includes?|mentions?)\s+["'`]([^"'`]{1,200})["'`]/i;
const FILE_CONTAINS_SECOND = /contains?\s+["'`]([^"'`]{1,200})["'`]\s*(?:in|within)\s*(?:the\s+)?(?:file\s+)?(.+)/i;

function tryFileContains(criterion: string): { file: string; needle: string } | null {
  let m = criterion.match(FILE_CONTAINS_FIRST);
  if (m) return { file: m[1].trim(), needle: m[2] };
  m = criterion.match(FILE_CONTAINS_SECOND);
  if (m) return { file: m[2].trim(), needle: m[1] };
  return null;
}

const COMMAND_PREFIXES = 'npm|npx|node|yarn|pnpm|python3?|pytest|go\\s+test|jest|vitest|tsc';
const COMMAND_TAIL = /\s+(?:passes?|succeeds?|must\s+pass|should\s+pass|must\s+succeed|exits?\s+0|is\s+green|ok)\s*$/i;
const PROSE_AFTER = /^\s*(?:passes?|succeeds?|must\s+pass|should\s+pass|must\s+succeed|exits?\s+0|is\s+green|ok)\s*$/i;

function stripCommandProse(command: string): string {
  return command
    .replace(COMMAND_TAIL, '')
    .replace(/^["'`]|["'`]$/g, '')
    .trim();
}

/**
 * Extract a runnable command from a criterion that looks like an assertion:
 * "run npm test", "the command `npm run build` passes", "npm run build exits
 * 0", "npx vitest run must pass". A command match must be start-anchored OR
 * followed by a pass/succeed prose tail, so a sentence like "check the npm
 * docs" stays uncheckable rather than mis-executed.
 */
function tryCommand(criterion: string): string | null {
  const re = new RegExp(
    `(?:^(?:run\\s+|execute\\s+|the\\s+command\\s+|command\\s+)?|(?:^|\\s)run\\s+(?:the\\s+)?(?:command\\s+)?)(?:["'\`])?((?:${COMMAND_PREFIXES})\\b[^\\n|;"'\`]{0,120})`,
    'i'
  );
  const m = criterion.match(re);
  if (!m) return null;
  const after = criterion.slice((m.index || 0) + m[0].length);
  const anchored = m.index === 0;
  const hasTail = PROSE_AFTER.test(after);
  if (!anchored && !hasTail) return null;
  const command = stripCommandProse(m[1]);
  return command || null;
}

function checkFileContains(file: string, needle: string, workspace: string): { passed: boolean; detail: string } {
  const full = path.isAbsolute(file) ? file : path.join(workspace, file);
  try {
    if (!fs.existsSync(full)) return { passed: false, detail: `file not found: ${file}` };
    const stat = fs.statSync(full);
    if (stat.size > 1024 * 1024) return { passed: false, detail: `${file} too large to check (${stat.size} bytes)` };
    const content = fs.readFileSync(full, 'utf8');
    return content.includes(needle)
      ? { passed: true, detail: `${file} contains '${needle}'` }
      : { passed: false, detail: `${file} does not contain '${needle}'` };
  } catch (error: any) {
    return { passed: false, detail: `could not check ${file}: ${error?.message || String(error)}` };
  }
}

async function runCommand(
  command: string,
  workspace: string,
  options: CriteriaEvaluationOptions
): Promise<{ passed: boolean; detail: string }> {
  let plan;
  try {
    plan = executionBackendManager.createPlan(command, workspace);
  } catch (error: any) {
    return { passed: false, detail: `could not plan \`${command}\`: ${error?.message || String(error)}` };
  }
  const maxOutputChars = options.maxOutputChars ?? 4000;
  try {
    const { stdout, stderr } = await execFileAsync(plan.executable, plan.args, {
      cwd: plan.cwd,
      env: plan.env,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      timeout: options.timeoutMs ?? 45000
    } as any);
    const output = `${String(stdout || '').trim()}\n${String(stderr || '').trim()}`.trim().slice(0, maxOutputChars);
    return { passed: true, detail: `\`${command}\` exit 0${output ? `: ${output.slice(0, 200)}` : ''}` };
  } catch (err: any) {
    const raw = `${String(err?.stdout || '').trim()}\n${String(err?.stderr || '').trim()}`.trim();
    const exitCode = err?.killed ? 'timeout' : typeof err?.code === 'number' ? err.code : 1;
    const output = (raw || (exitCode === 'timeout' ? '(timed out)' : String(err?.message || 'failed'))).slice(0, maxOutputChars);
    return { passed: false, detail: `\`${command}\` ${exitCode === 'timeout' ? 'timed out' : `exit ${exitCode}`}: ${output.slice(0, 200)}` };
  }
}

/**
 * Phase 20 Move 3 — the deterministic classification of ONE criterion,
 * exported so the plan builder (plan-builder.ts) and the verifier read the
 * SAME interpretation of the SAME criteria: Plan turns a criterion into a
 * step, Verify turns it into a check. file-contains carries the resolved
 * file + needle; test-command carries the extracted command.
 */
export interface CriterionClassification {
  kind: CriterionKind;
  /** file-contains: the file to check. */
  file?: string;
  /** file-contains: the needle the file must contain. */
  needle?: string;
  /** test-command: the extracted runnable command. */
  command?: string;
}

export function classifyCriterion(criterion: string): CriterionClassification {
  const fileCheck = tryFileContains(criterion);
  if (fileCheck) return { kind: 'file-contains', file: fileCheck.file, needle: fileCheck.needle };
  const command = tryCommand(criterion);
  if (command) return { kind: 'test-command', command };
  return { kind: 'uncheckable' };
}

/**
 * Evaluate each criterion deterministically. Order is preserved; every
 * criterion produces exactly one result (file-contains / test-command /
 * uncheckable). Never throws — a per-criterion failure is a FAILED result.
 */
export async function evaluateAcceptanceCriteria(
  criteria: string[],
  workspace: string,
  options: CriteriaEvaluationOptions = {}
): Promise<CriterionResult[]> {
  const results: CriterionResult[] = [];
  for (const raw of criteria) {
    const criterion = String(raw || '').trim();
    if (!criterion) continue;
    const cls = classifyCriterion(criterion);
    if (cls.kind === 'file-contains' && cls.file && cls.needle) {
      const r = checkFileContains(cls.file, cls.needle, workspace);
      results.push({ criterion, kind: 'file-contains', passed: r.passed, detail: r.detail });
      continue;
    }
    if (cls.kind === 'test-command' && cls.command) {
      const r = await runCommand(cls.command, workspace, options);
      results.push({ criterion, kind: 'test-command', passed: r.passed, detail: r.detail });
      continue;
    }
    results.push({
      criterion,
      kind: 'uncheckable',
      passed: null,
      detail: 'no deterministic interpretation (supported: test-command, file-contains) — reported, not silently passed'
    });
  }
  return results;
}
