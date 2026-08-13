/**
 * Phase 19 Move 5 — the diff-based secrets sweep (docs/hermes/AUDIT_10.md, G4/F6).
 *
 * Local, offline, deterministic: scans the working-tree diff vs HEAD (plus
 * untracked non-ignored files) for secret-shaped ADDED content — provider
 * key formats (OpenAI/GitHub/AWS/Slack/Google/JWT/Bearer/nclaw), private-key
 * blocks, `key: "value"` assignments, and high-entropy tokens. Fails only
 * on NEW content, so the tree passes today.
 *
 * Exclusion — the documented latent exposure: tracked files that .gitignore
 * says should not be tracked but are ("gitignored in spirit": users.json,
 * projects_data.json, memory.sqlite, logs/*, MEMORY.md, notes.md) are
 * excluded via `git check-ignore --no-index` (which, unlike plain
 * check-ignore, works for tracked files). Those carry real user data by
 * design; the gate prevents NEW secret-shaped content from entering every
 * OTHER file. The remediation (untracking the ignored-in-spirit files) is
 * documented in AUDIT_10 Move 5 — it is not done here because those files
 * hold other agents' uncommitted work.
 *
 * The dependency audit is a separate, out-of-band check (`npm run
 * security:audit` -> `npm audit --omit=dev`): network-dependent, never in
 * the fast gate.
 *
 * Run: npm run security:secrets  (or as part of `npm run gate:fast`)
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();

interface Violation {
  file: string;
  line: number;
  rule: string;
  text: string;
}

function runGit(args: string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf-8', maxBuffer: 128 * 1024 * 1024 });
}

/** True when the file matches .gitignore patterns even though it is tracked
 *  (the documented "gitignored in spirit" exposure set). Cached per file —
 *  spawning git per line would take minutes on a big diff. */
const ignoredCache = new Map<string, boolean>();
function isIgnoredInSpirit(file: string): boolean {
  const cached = ignoredCache.get(file);
  if (cached !== undefined) return cached;
  let ignored = false;
  try {
    execFileSync('git', ['check-ignore', '--no-index', '-q', file], { cwd: ROOT, stdio: 'ignore' });
    ignored = true;
  } catch {
    ignored = false;
  }
  ignoredCache.set(file, ignored);
  return ignored;
}

const PATTERNS: { rule: string; re: RegExp }[] = [
  { rule: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g },
  { rule: 'openai-key', re: /\bsk-[A-Za-z0-9]{16,}\b/g },
  { rule: 'github-token', re: /\bghp_[A-Za-z0-9]{20,}\b/g },
  { rule: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { rule: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { rule: 'google-key', re: /\bAIza[0-9A-Za-z_-]{20,}\b/g },
  { rule: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g },
  { rule: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._~-]{20,}\b/g },
  { rule: 'nclaw-token', re: /\bnclaw_[A-Za-z0-9_-]{10,}\b/g },
  {
    rule: 'secret-assignment',
    re: /["']?(?:api[_-]?key|apikey|secret|secret[_-]?key|passwd|password|token|access[_-]?token|auth[_-]?token|private[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["'][^"'\s]{8,}["']/gi
  }
];

const HIGH_ENTROPY_BITS = 4.5;

function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) || 0) + 1);
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function charClasses(s: string): number {
  let classes = 0;
  if (/[a-z]/.test(s)) classes++;
  if (/[A-Z]/.test(s)) classes++;
  if (/[0-9]/.test(s)) classes++;
  if (/[^a-zA-Z0-9]/.test(s)) classes++;
  return classes;
}

/** Package-manager lockfiles carry integrity hashes that look high-entropy by
 *  design but are public metadata, never secrets. */
const LOCKFILE_RE = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/;
function isLockfile(file: string): boolean {
  return LOCKFILE_RE.test(file);
}

function scanLine(file: string, line: number, text: string, violations: Violation[]): void {
  if (text.includes('\u0000')) return; // binary content
  if (isLockfile(file)) return; // integrity hashes are not secrets
  for (const { rule, re } of PATTERNS) {
    for (const m of text.matchAll(re)) {
      violations.push({ file, line, rule, text: m[0].slice(0, 80) });
    }
  }
  for (const m of text.matchAll(/[A-Za-z0-9_\-]{32,}/g)) {
    const token = m[0];
    if (shannonEntropy(token) >= HIGH_ENTROPY_BITS && charClasses(token) >= 3) {
      violations.push({ file, line, rule: 'high-entropy', text: token.slice(0, 80) });
    }
  }
}

function scanDiff(violations: Violation[]): void {
  const diff = runGit(['diff', 'HEAD']);
  let currentFile = '';
  let currentLine = 0;
  for (const raw of diff.split(/\r?\n/)) {
    if (raw.startsWith('diff --git ')) {
      const m = raw.match(/^diff --git a\/(.*) b\/(.*)$/);
      currentFile = m ? m[2] : '';
      currentLine = 0;
      continue;
    }
    if (raw.startsWith('+++ ') || raw.startsWith('--- ')) continue;
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      currentLine = parseInt(hunk[1], 10);
      continue;
    }
    if (raw.startsWith('+')) {
      if (currentFile && !isIgnoredInSpirit(currentFile)) {
        scanLine(currentFile, currentLine, raw.slice(1), violations);
      }
      currentLine++;
    } else if (!raw.startsWith('-')) {
      currentLine++; // context line exists on the new-file side
    }
  }
}

function scanUntracked(violations: Violation[]): void {
  const files = runGit(['ls-files', '--others', '--exclude-standard']).split(/\r?\n/).filter(Boolean);
  for (const file of files) {
    if (isIgnoredInSpirit(file)) continue;
    const abs = path.join(ROOT, file);
    if (!fs.existsSync(abs)) continue;
    const lines = fs.readFileSync(abs, 'utf-8').split(/\r?\n/);
    lines.forEach((text, i) => scanLine(file, i + 1, text, violations));
  }
}

function main() {
  const violations: Violation[] = [];
  scanDiff(violations);
  scanUntracked(violations);

  if (violations.length > 0) {
    console.error(`security:secrets — ${violations.length} possible secret${violations.length === 1 ? '' : 's'} in new content:`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  [${v.rule}] ${v.text}`);
    }
    console.error('(tracked files matching .gitignore are excluded by design — see AUDIT_10 Move 5)');
    process.exit(1);
  }

  console.log('security:secrets clean — no secret-shaped content in new diff lines or untracked files');
}

main();
