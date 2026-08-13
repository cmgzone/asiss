/**
 * Phase 19 Move 6 — the diff gate (docs/hermes/AUDIT_10.md, G5/F7).
 *
 * Local, offline, deterministic scope gate over the working-tree and staged
 * diffs. Rules:
 *
 *   1. Forbidden paths — `dist/`, `.env` (exact), `node_modules/` must never
 *      appear in the tracked diff (they are gitignored and untracked; a diff
 *      entry means someone tracked them by force).
 *   2. Whitespace (`git diff --check`) — per tracked file that is NOT
 *      gitignored-in-spirit (the documented exposure set from Move 5:
 *      users.json, projects_data.json, memory.sqlite, logs/*, MEMORY.md,
 *      notes.md — runtime churn with real trailing-whitespace noise): a
 *      whitespace error in real code/docs fails, naming file:line.
 *   3. Staged scope — `git diff --cached`: nothing staged may include a
 *      forbidden path or an ignored-in-spirit data file (the "what would you
 *      commit" check), and the staged diff must be whitespace-clean.
 *   4. Size caps — on the working-tree diff vs HEAD: total insertions
 *      <= 12,000, total files <= 60, per-file insertions <= 7,000, total
 *      deletions <= 8,000. Generous for the current tree (7,312 ins /
 *      20 files / 4,932 max per-file, a log) but a tripwire for a
 *      node_modules-style dump or a giant accidental addition.
 *
 * Secret-shaped additions are NOT re-checked here — that is
 * `security:secrets`'s job (Move 5); this gate owns scope/size/whitespace.
 *
 * Run: npm run diff:gate  (or as part of `npm run gate:fast`)
 */
import { execFileSync } from 'child_process';

const ROOT = process.cwd();

function runGit(args: string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
}

function runGitOrNull(args: string[]): string | null {
  try {
    return runGit(args);
  } catch (error: any) {
    // git diff --check exits 2 on whitespace errors and prints them to
    // stdout — execFileSync throws, so recover the output, don't drop it.
    if (error && typeof error.stdout === 'string' && error.stdout.length > 0) return error.stdout;
    return null;
  }
}

/** Same documented exclusion as the secrets sweep: tracked files that
 *  .gitignore says should not be tracked but are (runtime/user data). */
function isIgnoredInSpirit(file: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '--no-index', '-q', file], { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const FORBIDDEN = /^(dist\/|node_modules\/|\.env$)/;

interface RuleResult {
  violations: string[];
}

function checkForbiddenPaths(trackedDiffFiles: string[]): RuleResult {
  const violations = trackedDiffFiles.filter((f) => FORBIDDEN.test(f));
  return { violations: violations.map((f) => `${f} — forbidden path in the tracked diff (dist/, .env, node_modules/)`) };
}

function checkWhitespace(trackedDiffFiles: string[]): RuleResult {
  const violations: string[] = [];
  for (const file of trackedDiffFiles) {
    if (isIgnoredInSpirit(file)) continue; // runtime-churn noise, documented exposure
    const out = runGitOrNull(['diff', '--check', 'HEAD', '--', file]);
    if (out) {
      // git diff --check prints file:line messages for whitespace errors.
      for (const line of out.split(/\r?\n/).filter(Boolean)) {
        violations.push(line.replace(/\s+$/, ''));
      }
    }
  }
  return { violations };
}

function checkStagedScope(): RuleResult {
  const violations: string[] = [];
  const staged = runGit(['diff', '--cached', '--name-only']).split(/\r?\n/).filter(Boolean);
  for (const file of staged) {
    if (FORBIDDEN.test(file)) violations.push(`${file} — staged but forbidden (dist/, .env, node_modules/)`);
    else if (isIgnoredInSpirit(file)) violations.push(`${file} — staged but is an ignored-in-spirit data file (never commit users.json / logs / memory / notes)`);
  }
  const stagedCheck = runGitOrNull(['diff', '--cached', '--check']);
  if (stagedCheck) {
    for (const line of stagedCheck.split(/\r?\n/).filter(Boolean)) {
      violations.push(line.replace(/\s+$/, ''));
    }
  }
  return { violations };
}

function checkSizeCaps(): RuleResult {
  const violations: string[] = [];
  const numstat = runGit(['diff', 'HEAD', '--numstat']).split(/\r?\n/).filter(Boolean);
  let totalIns = 0;
  let totalDel = 0;
  for (const line of numstat) {
    const [ins, del] = line.split('\t');
    if (ins === '-') continue; // binary
    totalIns += parseInt(ins, 10);
    totalDel += parseInt(del, 10);
    if (parseInt(ins, 10) > 7_000) {
      violations.push(`${line.split('\t')[2]} — ${ins} insertions in one file (cap 7,000)`);
    }
  }
  if (totalIns > 12_000) violations.push(`total insertions ${totalIns} exceed the cap (12,000)`);
  if (totalDel > 8_000) violations.push(`total deletions ${totalDel} exceed the cap (8,000)`);
  if (numstat.length > 60) violations.push(`diff touches ${numstat.length} files (cap 60)`);
  return { violations };
}

function main() {
  const trackedDiffFiles = runGit(['diff', 'HEAD', '--name-only']).split(/\r?\n/).filter(Boolean);

  const all: string[] = [];
  all.push(...checkForbiddenPaths(trackedDiffFiles).violations);
  all.push(...checkWhitespace(trackedDiffFiles).violations);
  all.push(...checkStagedScope().violations);
  all.push(...checkSizeCaps().violations);

  if (all.length > 0) {
    console.error(`diff:gate — ${all.length} violation${all.length === 1 ? '' : 's'}:`);
    for (const v of all) console.error(`  ${v}`);
    console.error('(ignored-in-spirit files are excluded from whitespace checks — see AUDIT_10 Move 5)');
    process.exit(1);
  }

  console.log('diff:gate clean — no forbidden paths, whitespace errors, staged data files, or oversized diffs');
}

main();
