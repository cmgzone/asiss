/**
 * Phase 19 Move 3 — the battery runner (docs/hermes/AUDIT_10.md, G1/G7/F3).
 *
 * One command for the deterministic smoke battery: runs the canonical
 * battery in order, spawns each `smoke:*` in its own child process (real
 * isolation — a crash or hang can't take down the runner), aggregates
 * pass/fail/error + duration per script, writes the gate-level evidence
 * artifact `logs/gate-report.json` (G7), prints a human summary, and exits
 * non-zero on any failure (G1: the test gate is no longer a stub).
 *
 * Canonical battery (in-battery, documented in AUDIT_10 §4 G1 / §5 M3):
 * fast static gates first (failure-fast), heaviest e2e last:
 *
 *   baseline, render-bench, terminal-paths, phase16, phase18, phase19, phase20, config,
 *   context, tools, policy, turn-contract, execution-store, scheduler, agent-engine,
 *   agent-task-profile, agent-execution, memory-unified, repo-index,
 *   checkpoints, model-engine, executable-skills, execution-backends,
 *   delegation, runtime, phase22, webui-e2e
 *
 * Out of battery by documented decision (AUDIT_9/AUDIT_10): smoke:learning,
 * smoke:model-resilience, smoke:execute-workflow (pre-existing failures
 * identical at HEAD), the interactive smoke:casual / smoke:repetition
 * (need a live model; hang without one), and smoke:web-api (binds a port;
 * never part of the documented battery).
 *
 * Options:
 *   npm test                        run the full battery
 *   npm test -- --only=phase16      run just the named scripts (comma-sep)
 *   npm test -- --list              print the canonical battery and exit
 *
 * Each script runs with a bounded timeout (default 300 s; the e2e runtime
 * gets 600 s) so a hung smoke is reported as `error`, not a silent hang.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const LOG_DIR = path.join(ROOT, 'logs');
const REPORT_PATH = path.join(LOG_DIR, 'gate-report.json');

interface BatteryEntry {
  name: string;
  timeoutMs: number;
}

export const CANONICAL_BATTERY: BatteryEntry[] = [
  { name: 'baseline', timeoutMs: 300_000 },
  { name: 'render-bench', timeoutMs: 120_000 },
  { name: 'terminal-paths', timeoutMs: 300_000 },
  { name: 'phase16', timeoutMs: 300_000 },
  { name: 'phase18', timeoutMs: 300_000 },
  { name: 'phase19', timeoutMs: 300_000 },
  { name: 'phase20', timeoutMs: 300_000 },
  { name: 'config', timeoutMs: 300_000 },
  { name: 'context', timeoutMs: 300_000 },
  { name: 'tools', timeoutMs: 300_000 },
  { name: 'policy', timeoutMs: 300_000 },
  { name: 'turn-contract', timeoutMs: 300_000 },
  { name: 'execution-store', timeoutMs: 300_000 },
  { name: 'webui-cards', timeoutMs: 300_000 },
  { name: 'phase22', timeoutMs: 120_000 },
  { name: 'webui-e2e', timeoutMs: 180_000 },
  { name: 'scheduler', timeoutMs: 300_000 },
  { name: 'agent-engine', timeoutMs: 300_000 },
  { name: 'agent-task-profile', timeoutMs: 300_000 },
  { name: 'agent-execution', timeoutMs: 300_000 },
  { name: 'memory-unified', timeoutMs: 300_000 },
  { name: 'repo-index', timeoutMs: 300_000 },
  { name: 'checkpoints', timeoutMs: 300_000 },
  { name: 'model-engine', timeoutMs: 300_000 },
  { name: 'executable-skills', timeoutMs: 300_000 },
  { name: 'execution-backends', timeoutMs: 300_000 },
  { name: 'delegation', timeoutMs: 300_000 },
  { name: 'runtime', timeoutMs: 600_000 }
];

interface RunResult {
  name: string;
  status: 'pass' | 'fail' | 'error';
  durationMs: number;
  exitCode: number | null;
  error?: string;
  outputTail?: string;
}

function parseArgs(argv: string[]): { only: string[]; list: boolean } {
  const only: string[] = [];
  let list = false;
  for (const arg of argv) {
    if (arg === '--list') list = true;
    else if (arg.startsWith('--only=')) {
      for (const name of arg.slice('--only='.length).split(',')) {
        const trimmed = name.trim();
        if (trimmed) only.push(trimmed);
      }
    }
  }
  return { only, list };
}

function runScript(entry: BatteryEntry): Promise<RunResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn('npm', ['run', `smoke:${entry.name}`], {
      cwd: ROOT,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let buffer = '';
    const TAIL_LIMIT = 24_000;
    const tee = (chunk: Buffer, isErr: boolean) => {
      const text = chunk.toString();
      buffer = (buffer + text).slice(-TAIL_LIMIT);
      (isErr ? process.stderr : process.stdout).write(text);
    };
    child.stdout.on('data', (c: Buffer) => tee(c, false));
    child.stderr.on('data', (c: Buffer) => tee(c, true));

    let settled = false;
    const finish = (result: Omit<RunResult, 'name' | 'durationMs'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ name: entry.name, durationMs: Date.now() - startedAt, ...result });
    };

    const timer = setTimeout(() => {
      child.kill();
      finish({
        status: 'error',
        exitCode: null,
        error: `timed out after ${entry.timeoutMs / 1000}s`,
        outputTail: buffer.slice(-8_000)
      });
    }, entry.timeoutMs);

    child.on('error', (error) => {
      finish({
        status: 'error',
        exitCode: null,
        error: `spawn failed: ${error.message}`,
        outputTail: buffer.slice(-8_000)
      });
    });
    child.on('close', (code) => {
      finish({
        status: code === 0 ? 'pass' : 'fail',
        exitCode: code,
        outputTail: buffer.slice(-8_000)
      });
    });
  });
}

function humanDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

async function main() {
  const { only, list } = parseArgs(process.argv.slice(2));
  const battery = only.length > 0
    ? CANONICAL_BATTERY.filter((e) => only.includes(e.name))
    : CANONICAL_BATTERY;

  if (only.length > 0) {
    const known = new Set(CANONICAL_BATTERY.map((e) => e.name));
    for (const name of only) {
      if (!known.has(name)) console.warn(`[battery] warning: \`${name}\` is not in the canonical battery`);
    }
  }

  if (list) {
    console.log('Canonical battery:');
    for (const entry of CANONICAL_BATTERY) console.log(`  smoke:${entry.name}`);
    return;
  }

  if (battery.length === 0) {
    console.error('[battery] nothing to run (no names matched --only)');
    process.exit(1);
  }

  const startedAt = Date.now();
  console.log(`[battery] running ${battery.length} smoke${battery.length === 1 ? '' : 's'}...`);

  const results: RunResult[] = [];
  for (const entry of battery) {
    console.log(`\n===== smoke:${entry.name} =====`);
    const result = await runScript(entry);
    results.push(result);
    console.log(`\n===== smoke:${entry.name} ${result.status.toUpperCase()} (${humanDuration(result.durationMs)}) =====`);
  }

  const passed = results.filter((r) => r.status === 'pass').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  const errors = results.filter((r) => r.status === 'error').length;
  const totalMs = Date.now() - startedAt;

  let head = '';
  try {
    head = require('child_process').execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf-8' }).trim();
  } catch {
    head = 'unknown';
  }

  const report = {
    gate: 'battery',
    generatedAt: new Date().toISOString(),
    head,
    node: process.version,
    platform: process.platform,
    summary: {
      total: results.length,
      passed,
      failed,
      errors,
      durationMs: totalMs
    },
    result: failed === 0 && errors === 0 ? 'pass' : 'fail',
    scripts: results
  };

  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  console.log(`\n[battery] report written to ${REPORT_PATH}`);
  console.log(`Battery complete: ${passed} passed, ${failed} failed, ${errors} errored (${results.length} total) in ${humanDuration(totalMs)} — ${report.result === 'pass' ? 'PASS' : 'FAIL'}`);
  for (const r of results) {
    if (r.status !== 'pass') {
      console.log(`  x smoke:${r.name} — ${r.error || `exit ${r.exitCode}`}`);
    }
  }

  process.exit(report.result === 'pass' ? 0 : 1);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
