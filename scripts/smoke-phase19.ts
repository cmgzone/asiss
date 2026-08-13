/**
 * Phase 19 Move 8 — permanent verification gate (docs/hermes/AUDIT_10.md, F10).
 *
 * Static, no-network regression guard for the Phase 19 invariants. It must
 * run forever as part of the battery, protecting the audit's closed gaps
 * (and absorbing the wiring assertions that `smoke:gates` carried through
 * Moves 2-6, which is now retired):
 *
 *   Gate A — the test gate is LIVE (G1/G7/F3): `npm test` / `npm run
 *            battery` run the battery runner, the canonical battery entries
 *            are all registered scripts, and logs/ is gitignored (the
 *            gate-report artifact is evidence, never committed state).
 *   Gate B — typecheck is scripted (G2/F4): `typecheck` = `tsc --noEmit`.
 *   Gate C — the lint gate is enforced (G3/F5): `lint:src` is scripted and
 *            exists.
 *   Gate D — the security gate is wired (G4/F6): the diff-based
 *            `security:secrets` sweep is scripted and in the fast gate; the
 *            dependency `security:audit` stays registered but OUT of it.
 *   Gate E — the diff gate is wired (G5/F7): `diff:gate` is scripted and
 *            exists.
 *   Gate F — the fast gate composes every Phase 19 gate (typecheck, lint,
 *            secrets, diff, build, phase16, phase18, this gate) and never
 *            the network-bound audit.
 *   Gate G — acceptance criteria are evaluated at the completion gate
 *            (G6/F8): evaluateAcceptanceCriteria is defined and exported,
 *            the runner threads the session goal's criteria and records
 *            'criteria' TaskVerification evidence, and 'criteria' is a
 *            TaskVerificationKind.
 *
 * Like smoke:phase16 / smoke:phase18 it is comment-aware: comments are
 * stripped from source sweeps so explanatory prose can neither trip nor
 * soothe a check. The behavioral matrix is proven by the battery —
 * smoke:turn-contract §17 (criteria evaluation), smoke:repo-index,
 * gate:fast (typecheck/lint/secrets/diff/build green) — this file guards
 * only the architectural invariants.
 *
 * Run: npm run smoke:phase19  (or as part of `npm run gate:fast`)
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { CANONICAL_BATTERY } from './run-battery';

const ROOT = process.cwd();

/** Remove block comments (incl. JSDoc) and line comments. */
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n\r]*/g, ' ');
}

function readFile(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

async function main() {
  const pkg = JSON.parse(readFile('package.json'));
  const scripts = pkg.scripts || {};
  const fast = scripts['gate:fast'] || '';

  // Gate A — the test gate is live.
  assert.strictEqual(scripts.test, 'ts-node scripts/run-battery.ts', 'npm test runs the battery runner (G1)');
  assert.strictEqual(scripts.battery, 'ts-node scripts/run-battery.ts', 'npm run battery runs the battery runner (G1)');
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts/run-battery.ts')), 'scripts/run-battery.ts exists');
  assert.ok(readFile('.gitignore').includes('logs/'), 'logs/ must be gitignored (gate report is evidence, G7)');
  for (const entry of CANONICAL_BATTERY) {
    assert.ok(scripts[`smoke:${entry.name}`], `battery entry smoke:${entry.name} must be a registered script`);
  }
  assert.ok(CANONICAL_BATTERY.some((e) => e.name === 'phase19'), 'the permanent phase19 gate is itself in the battery');

  // Gate B — typecheck is scripted.
  assert.strictEqual(scripts.typecheck, 'tsc --noEmit', 'typecheck runs tsc --noEmit (G2)');
  assert.ok(fs.existsSync(path.join(ROOT, 'tsconfig.json')), 'tsconfig.json exists');

  // Gate C — the lint gate is enforced.
  assert.strictEqual(scripts['lint:src'], 'ts-node scripts/lint-src.ts', 'lint:src is scripted (G3)');
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts/lint-src.ts')), 'scripts/lint-src.ts exists');

  // Gate D — the security gate is wired; the audit is out-of-band.
  assert.strictEqual(scripts['security:secrets'], 'ts-node scripts/security-secrets.ts', 'security:secrets is scripted (G4)');
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts/security-secrets.ts')), 'scripts/security-secrets.ts exists');
  assert.ok(scripts['security:audit'], 'security:audit stays registered (out-of-band)');
  assert.ok(!fast.includes('npm run security:audit'), 'security:audit never enters the fast gate');

  // Gate E — the diff gate is wired.
  assert.strictEqual(scripts['diff:gate'], 'ts-node scripts/diff-gate.ts', 'diff:gate is scripted (G5)');
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts/diff-gate.ts')), 'scripts/diff-gate.ts exists');

  // Gate F — the fast gate composes every Phase 19 gate and this gate.
  for (const part of [
    'npm run typecheck',
    'npm run lint:src',
    'npm run security:secrets',
    'npm run diff:gate',
    'npm run build',
    'npm run smoke:phase16',
    'npm run smoke:phase18',
    'npm run smoke:phase19'
  ]) {
    assert.ok(fast.includes(part), `gate:fast must include \`${part}\``);
  }

  // Gate G — acceptance criteria are evaluated at the completion gate.
  const criteriaSrc = stripComments(readFile('src/core/context/criteria-check.ts'));
  assert.ok(
    criteriaSrc.includes('export async function evaluateAcceptanceCriteria'),
    'evaluateAcceptanceCriteria is defined (G6)'
  );
  assert.ok(
    stripComments(readFile('src/core/context/index.ts')).includes(`export * from './criteria-check'`),
    'criteria-check is exported through the context index'
  );
  const runnerSrc = stripComments(readFile('src/agents/runner.ts'));
  assert.ok(runnerSrc.includes('evaluateAcceptanceCriteria('), 'the runner calls evaluateAcceptanceCriteria (G6)');
  assert.ok(
    runnerSrc.includes("recordVerification(task.id, 'criteria'"),
    'the runner records criteria TaskVerification evidence (F8)'
  );
  assert.ok(
    runnerSrc.includes('mainGoalManager.getCurrent(sessionId)?.acceptanceCriteria'),
    'criteria come from the session goal (mainGoalManager)'
  );
  assert.ok(
    /\| 'criteria'/.test(stripComments(readFile('src/core/task/task-types.ts'))),
    "'criteria' is a TaskVerificationKind"
  );

  console.log('phase19 gate: all invariants hold — test gate live, typecheck/lint/security/diff wired, criteria evaluated');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
