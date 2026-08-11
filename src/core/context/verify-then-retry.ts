/**
 * Verify-then-retry — Hermes Evolution Phase 11.
 *
 * When a coding step fails, the mission should not just retry blind: find the
 * goal-matched test files in the persistent repository index, run them with a
 * detected test runner, and feed the output back into the retry context:
 *
 *   Tool fails -> matched tests -> run -> inspect output -> repair -> retry
 *
 * Everything is bounded (timeout, capped output), never throws, and only ever
 * runs the *matched* test files — never a whole suite unless one is selected.
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import util from 'util';
import { executionBackendManager } from '../execution-backend';
import { stemOverlap } from './relevance';
import { IndexedFile, RepositoryIndex } from './repository-context';

const execFileAsync = util.promisify(execFile);

/** Strip extension and test markers: auth.test.js -> auth; auth_test.py -> auth. */
export function stemOf(filePath: string): string {
  return path
    .basename(filePath)
    .replace(/\.[^.]+$/, '')
    .replace(/\.(test|spec)(\.[^.]+)?$/i, '')
    .replace(/(?:^|_)(?:test|spec)$/i, '')
    .toLowerCase();
}

function isTestFile(file: IndexedFile): boolean {
  return Boolean((file as any).isTest);
}

/**
 * Tests to run for a failed goal: tests the goal matcher surfaced directly,
 * plus sibling tests of the matched source files (src/auth/auth.ts ->
 * src/auth/auth.test.ts) regardless of language.
 */
export function matchedTestFiles(
  index: RepositoryIndex,
  goal: string,
  matchedFiles: IndexedFile[],
  limit = 4
): IndexedFile[] {
  if (!goal || !Array.isArray(index.files)) return [];
  const tests = index.files.filter(isTestFile);
  if (tests.length === 0) return [];
  // Tests the goal itself surfaces — signal-gated so depth-bonus noise from
  // the ranking never pulls in unrelated tests (billing.test.ts for an auth
  // goal). Works for lightweight indexes too (path-only signal).
  const goalTestPaths = new Set(
    tests
      .filter(
        (f) =>
          stemOverlap(goal, f.path) > 0 ||
          (Array.isArray((f as any).symbols) && (f as any).symbols.some((s: any) => stemOverlap(goal, s.name) > 0))
      )
      .map((f) => f.path)
  );
  // Only real signal counts: depth-bonus-only matches must not pull in
  // their sibling tests (billing.ts noise must not drag billing tests in).
  const sourceStems = new Set(
    matchedFiles
      .filter((f) => !isTestFile(f) && stemOverlap(goal, f.path) > 0)
      .map((f) => stemOf(f.path))
  );

  const out: IndexedFile[] = [];
  for (const test of tests) {
    if (goalTestPaths.has(test.path) || sourceStems.has(stemOf(test.path))) {
      out.push(test);
      if (out.length >= limit) break;
    }
  }
  return out;
}

export interface DetectedTestCommand {
  command: string;
  engine: string;
}

function hasDependency(workspace: string, name: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(workspace, 'package.json'), 'utf8'));
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    return Boolean(deps[name]);
  } catch {
    return false;
  }
}

function shellJoin(relPath: string): string {
  return `'${relPath.replace(/'/g, `'"'"'`)}'`;
}

/** Detect a runnable test command for the first matching test file. */
export function detectTestCommand(workspace: string, testFiles: IndexedFile[]): DetectedTestCommand | null {
  for (const file of testFiles) {
    const full = path.join(workspace, file.path);
    let content = '';
    try {
      const stat = fs.statSync(full);
      if (stat.size <= 512 * 1024) content = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(file.path)) {
      if (/node:test|require\(['"]node:test['"]\)/.test(content)) {
        return { engine: 'node:test', command: `node --test ${shellJoin(file.path)}` };
      }
      if (hasDependency(workspace, 'vitest') && /vitest|@vitest/.test(content)) {
        return { engine: 'vitest', command: `npx vitest run ${shellJoin(file.path)}` };
      }
      if (hasDependency(workspace, 'jest') && /jest|@jest\/globals/.test(content)) {
        return { engine: 'jest', command: `npx jest ${shellJoin(file.path)} --ci --silent` };
      }
      continue;
    }
    if (/\.py$/.test(file.path)) {
      if (/\bpytest\b|def test_|^import pytest/m.test(content)) {
        return { engine: 'pytest', command: `python -m pytest ${shellJoin(file.path)} -q` };
      }
      if (/\bunittest\b/.test(content)) {
        const module = file.path.replace(/\.py$/, '').split('/').join('.');
        return { engine: 'unittest', command: `python -m unittest ${module}` };
      }
      continue;
    }
    if (/\.go$/.test(file.path)) {
      return { engine: 'go', command: `go test ${shellJoin(path.dirname(file.path) || '.')}` };
    }
  }
  return null;
}

export interface RunGoalTestsOptions {
  timeoutMs?: number;
  maxOutputChars?: number;
}

export interface GoalTestRun {
  ran: boolean;
  command?: string;
  engine?: string;
  exitCode?: number | 'timeout';
  output?: string;
  error?: string;
}

/** Run the matched tests, bounded and non-throwing. */
export async function runGoalTests(
  workspace: string,
  testFiles: IndexedFile[],
  options: RunGoalTestsOptions = {}
): Promise<GoalTestRun> {
  if (!workspace || testFiles.length === 0) return { ran: false };
  let detected: DetectedTestCommand | null = null;
  try {
    detected = detectTestCommand(workspace, testFiles);
  } catch {
    return { ran: false };
  }
  if (!detected) return { ran: false };

  let plan;
  try {
    plan = executionBackendManager.createPlan(detected.command, workspace);
  } catch (error: any) {
    return { ran: false, error: String(error?.message || error) };
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
    return { ran: true, command: detected.command, engine: detected.engine, exitCode: 0, output };
  } catch (err: any) {
    const raw = `${String(err?.stdout || '').trim()}\n${String(err?.stderr || '').trim()}`.trim();
    const exitCode: number | 'timeout' = err?.killed
      ? 'timeout'
      : typeof err?.code === 'number'
        ? err.code
        : 1;
    return {
      ran: true,
      command: detected.command,
      engine: detected.engine,
      exitCode,
      output: (raw || (exitCode === 'timeout' ? '(timed out)' : String(err?.message || 'failed'))).slice(0, maxOutputChars)
    };
  }
}
