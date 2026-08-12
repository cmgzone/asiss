/**
 * Phase 16 Move 7 — permanent verification gate (docs/hermes/AUDIT_7.md §8).
 *
 * Static, no-network regression guard for the Phase 16 invariants. It must
 * run forever as part of the battery:
 *
 *   Gate 7 — no AgentRun-style bookkeeping re-materializes (Audit 5 deletion
 *            holds): `agentRunManager`, `recordAgentRun`, `agent_runs.json`
 *            writes, and an `AgentRun` record type all remain ZERO in src/
 *            and scripts/, with explanatory comments excluded.
 *   Gate 3 — Task-as-run: no AgentRun execution identity anywhere in code
 *            (`\bAgentRun\b` matched only the removed comment, so any hit is
 *            a re-materialization; AgentRunner / agent-runner do not match).
 *   Gate 1 — the swarm executor's bare model.generate fragment stays gone:
 *            the fail-loudly marker remains in the runner.
 *   Gate 2 — the Agent contract still declares all five Move 2 fields
 *            (instructions / contextPolicy / memoryPolicy / executionLimits /
 *            handoffPolicy) so every origin resolves the same contract.
 *   Gate 8 — the repair authority stays retry-as-loop (Phase 17 Move 3):
 *            TaskRepairer exists only in task-engine.ts, no origin passes the
 *            repair option, and the hook is invoked exactly once — inside the
 *            engine's retry() resume path. A declared-only future seam.
 *
 * The behavioral matrix (which implementation actually executed per origin)
 * is proven by the battery — mission (smoke:runtime), delegation
 * (smoke:delegation + smoke:agent-execution), swarm (agent-execution §5/§12),
 * background (§6), scheduled (§7), skill creation + external research
 * (smoke:learning) — and recorded in AUDIT_7 §8.
 *
 * Run: npm run smoke:phase16
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.isFile() && /\.ts$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Remove block comments (incl. JSDoc) and line comments so explanatory
 *  comments about the removed system do not trip the sweeps. */
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n\r]*/g, ' ');
}

function readAllTs(dir: string, excludeFile?: string): string {
  return collectTsFiles(dir)
    .filter((f) => !excludeFile || !f.endsWith(excludeFile))
    .map((f) => fs.readFileSync(f, 'utf-8'))
    .join('\n');
}

async function main() {
  const srcDir = path.join(ROOT, 'src');
  const scriptsDir = path.join(ROOT, 'scripts');
  assert(fs.existsSync(srcDir), 'src/ exists (run from the project root, e.g. `npm run smoke:phase16`)');
  assert(fs.existsSync(scriptsDir), 'scripts/ exists');

  // This guard file itself names the patterns it protects, so it is excluded
  // from the scripts sweep (its assertions are the guard, not the guarded).
  const src = stripComments(readAllTs(srcDir));
  const scripts = stripComments(readAllTs(scriptsDir, 'smoke-phase16.ts'));

  // ------------------------------------------------------------------ Gate 7
  // No AgentRun-style run bookkeeping anywhere in code (comments excluded).
  assert.strictEqual(/agentRunManager/.test(src), false, 'agentRunManager must stay removed (src)');
  assert.strictEqual(/agentRunManager/.test(scripts), false, 'agentRunManager must stay removed (scripts)');
  assert.strictEqual(/recordAgentRun/.test(src), false, 'recordAgentRun must stay removed (src)');
  assert.strictEqual(/agent_runs\.json/.test(src), false, 'agent_runs.json must never be written (src)');
  // scripts/ is intentionally NOT swept for agent_runs.json: the only
  // reference there is smoke-agent-delegation's own absence-check (asserts
  // the file is never written) — the guard guarding the guard.

  // ------------------------------------------------------------------ Gate 3
  // Task-as-run: an AgentRun identity is forbidden. AgentRunner and the
  // 'agent-runner' source marker do NOT match \bAgentRun\b.
  assert.strictEqual(/\bAgentRun\b/.test(src), false, 'no AgentRun record/type may re-materialize (Task-as-run)');

  // ------------------------------------------------------------------ Gate 1
  // The swarm executor fragment (bare model.generate) stays gone: the
  // fail-loudly path the removal introduced must still be present, and the
  // executor block itself must not contain a bare model.generate call.
  const runnerSrc = fs.readFileSync(path.join(srcDir, 'agents', 'runner.ts'), 'utf-8');
  assert(
    runnerSrc.includes('delegate_agent skill is unavailable'),
    'swarm executor fails loudly when delegate_agent is unavailable (D1 stays gone)'
  );
  const executorStart = runnerSrc.indexOf('agentSwarm.setExecutor');
  assert(executorStart >= 0, 'swarm executor wiring still present');
  // Comments are stripped so the block's own explanatory text (which names
  // the removed pattern) does not trip the check.
  const executorBody = stripComments(runnerSrc.slice(executorStart, runnerSrc.indexOf('});', executorStart)));
  assert.strictEqual(
    /model\.generate/.test(executorBody),
    false,
    'the swarm executor block contains no bare model.generate (no second execution path)'
  );

  // ------------------------------------------------------------------ Gate 2
  // The Agent contract declares every Move 2 field, so every origin resolves
  // the same contract surface.
  const agentTypes = fs.readFileSync(path.join(srcDir, 'core', 'agent', 'agent-types.ts'), 'utf-8');
  for (const field of ['instructions', 'contextPolicy', 'memoryPolicy', 'executionLimits', 'handoffPolicy']) {
    assert(agentTypes.includes(`${field}?`) || agentTypes.includes(`${field}:`), `Agent contract field '${field}' present`);
  }

  // ------------------------------------------------------------------ Phase 17
  // Move 2 — the runner actually wires the terminal verification gate into
  // runMission (the engine-level behavior is proven by smoke:turn-contract
  // section 16; this keeps the host wiring from silently regressing).
  assert(
    runnerSrc.includes('private buildMissionVerifier(') && runnerSrc.includes('verifier: this.buildMissionVerifier('),
    'runner wires the goal-matched-test verifier into runMission (Phase 17 Move 2 gate)'
  );

  // ------------------------------------------------------------------ Gate 8
  // Move 3 — the single repair authority is retry-as-loop, model-driven
  // (mission loop + diagnose + the verification gate). TaskRepairer stays a
  // declared-only future seam: no origin may wire it. The hook may be invoked
  // only by the engine's retry() resume path, and only the baseline smoke
  // exercises that API. Comments are stripped so the seam's own documentation
  // cannot trip the check.
  const nonEngineSrc = stripComments(
    collectTsFiles(srcDir)
      .filter((f) => !f.endsWith('task-engine.ts'))
      .map((f) => fs.readFileSync(f, 'utf-8'))
      .join('\n')
  );
  assert.strictEqual(
    /TaskRepairer/.test(nonEngineSrc),
    false,
    'TaskRepairer exists only in task-engine.ts (declared seam, never wired)'
  );
  assert.strictEqual(
    /repair\s*:/.test(nonEngineSrc),
    false,
    'no production call site passes the repair option (retry-as-loop is the repair authority)'
  );
  const engineStripped = stripComments(fs.readFileSync(path.join(srcDir, 'core', 'task', 'task-engine.ts'), 'utf-8'));
  assert.strictEqual(
    (engineStripped.match(/repair\s*\(/g) || []).length === 1 && engineStripped.includes('options.repair('),
    true,
    'the TaskRepairer hook is invoked exactly once, inside the engine retry() resume path'
  );

  console.log(JSON.stringify({
    success: true,
    gates: {
      gate1_swarmFragmentGone: true,
      gate2_contractFields: true,
      gate3_taskAsRun: true,
      gate7_noAgentRunBookkeeping: true,
      phase17_gateWired: true,
      phase17_repairSeam: true
    },
    scannedTsFiles: collectTsFiles(srcDir).length + collectTsFiles(scriptsDir).length,
    note: 'Behavioral matrix per origin is proven by the battery (see AUDIT_7 §8); Phase 17 gate behavior in smoke:turn-contract §16.'
  }, null, 2));
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
