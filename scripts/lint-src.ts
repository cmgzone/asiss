/**
 * Phase 19 Move 4 — lint:src (docs/hermes/AUDIT_10.md, G3/F5).
 *
 * A lightweight, zero-new-dependency lint gate in the smoke-phase16/18
 * discipline. ESLint adoption is an explicit non-goal for this phase; these
 * are mechanical rules the tree already passes, so the gate starts green and
 * stays green unless someone introduces a violation:
 *
 *   1. no `debugger` statements (comment-aware: block/line comments are
 *      stripped first, so prose mentioning "debugger" cannot trip it);
 *   2. no `@ts-ignore` / `@ts-expect-error` directives (these live inside
 *      comments, so this rule searches the raw text on purpose);
 *   3. no `TODO` / `FIXME` / `XXX` drift markers (comment content is the
 *      point, so this rule also searches raw text).
 *
 * Sweeps src/ only — the audit's rules were measured on the production
 * tree, and the gate's own documentation (this file + smoke:phase19, both
 * in scripts/) names the patterns it enforces, so sweeping scripts/ would
 * be self-referential. The no-competing-authority sweeps stay centralized
 * in smoke:phase18 (Gate F), not duplicated here.
 *
 * Run: npm run lint:src  (or as part of `npm run gate:fast`)
 */
import fs from 'fs';
import path from 'path';

const ROOTS = ['src'];

interface Violation {
  file: string;
  line: number;
  rule: string;
  text: string;
}

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

/** Remove block comments (incl. JSDoc) and line comments, preserving
 *  newlines so reported line numbers stay accurate. */
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n\r]/g, ' '))
    .replace(/\/\/[^\n\r]*/g, ' ');
}

function lineOf(code: string, index: number): number {
  return code.slice(0, index).split(/\r?\n/).length;
}

function scan(dir: string): Violation[] {
  const violations: Violation[] = [];
  for (const file of collectTsFiles(dir)) {
    const code = fs.readFileSync(file, 'utf-8');
    const rel = path.relative(process.cwd(), file).replace(/\\/g, '/');

    // Rule 1 — `debugger` statements, comment-aware.
    const stripped = stripComments(code);
    for (const m of stripped.matchAll(/\bdebugger\b/g)) {
      violations.push({ file: rel, line: lineOf(code, m.index), rule: 'debugger', text: 'debugger statement' });
    }

    // Rule 2 — ts-ignore / ts-expect-error directives (raw text: comments).
    for (const m of code.matchAll(/@ts-(?:ignore|expect-error)\b/g)) {
      violations.push({ file: rel, line: lineOf(code, m.index), rule: 'ts-ignore', text: m[0] });
    }

    // Rule 3 — TODO / FIXME / XXX drift markers (raw text: comments).
    for (const m of code.matchAll(/\b(TODO|FIXME|XXX)\b/g)) {
      violations.push({ file: rel, line: lineOf(code, m.index), rule: 'drift', text: m[0] });
    }
  }
  return violations;
}

function main() {
  const violations: Violation[] = [];
  for (const root of ROOTS) {
    if (fs.existsSync(root)) violations.push(...scan(root));
  }

  if (violations.length > 0) {
    console.error(`lint:src — ${violations.length} violation${violations.length === 1 ? '' : 's'}:`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  [${v.rule}] ${v.text}`);
    }
    process.exit(1);
  }

  console.log('lint:src clean — no debugger, no ts-ignore, no TODO/FIXME/XXX drift');
}

main();
