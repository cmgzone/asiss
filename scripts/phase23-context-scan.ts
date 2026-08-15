/**
 * Phase 23 §19 — static architecture gate: process.cwd() in execution paths.
 *
 * The active project must NEVER be inferred from process.cwd() — the engine
 * root (where ASISS itself runs) is a different concept from the user project
 * workspace. This gate scans the execution-path areas and flags every
 * process.cwd() occurrence that lacks an explicit justification marker
 * (`phase23-ok:` in a comment on the same line or the line above).
 *
 * Legitimate uses are annotated in place, e.g.:
 *   // phase23-ok: engine-root data file (config.json), not project context
 *   path.join(process.cwd(), 'config.json')
 *
 * Run: npm run check:project-context  (also part of gate:fast).
 */

import fs from 'fs';
import path from 'path';

/** Execution-path areas that must never silently infer the active project. */
const TARGET_AREAS: string[] = [
  'src/core/agent',          // AgentEngine / sub-agent creation
  'src/core/context',        // ContextEngine / repository indexing
  'src/core/memory-unified', // Memory
  'src/core/memory.ts',      // Memory
  'src/core/tools',          // Tool execution
  'src/core/task',           // Task engine (execution records)
  'src/skills',              // Tool execution (native skills)
  'src/core/execution-backend.ts',
  'src/core/workspace-manager.ts',
  'src/core/conversation-manager.ts'
];

const JUSTIFICATION_MARKER = 'phase23-ok';

interface Occurrence {
  file: string;
  line: number;
  snippet: string;
}

function scanFile(full: string, out: Occurrence[]): void {
  const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('process.cwd()')) continue;
    const trimmed = line.trim();
    // Pure comment mentions (documentation of the rule) are not code sites.
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    const prev = i > 0 ? lines[i - 1] : '';
    const justified = line.includes(JUSTIFICATION_MARKER) || prev.includes(JUSTIFICATION_MARKER);
    if (justified) continue;
    out.push({ file: full, line: i + 1, snippet: line.trim().slice(0, 120) });
  }
}

function collectOccurrences(root: string): Occurrence[] {
  const out: Occurrence[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
        walk(full);
        continue;
      }
      if (!/\.ts$/.test(entry.name)) continue;
      scanFile(full, out);
    }
  };
  for (const area of TARGET_AREAS) {
    const full = path.resolve(root, area);
    if (!fs.existsSync(full)) continue;
    if (fs.statSync(full).isDirectory()) walk(full);
    else scanFile(full, out);
  }
  return out;
}

function main() {
  const occurrences = collectOccurrences(process.cwd());
  if (occurrences.length === 0) {
    console.log('phase23-context-scan: no un-justified process.cwd() in execution paths.');
    return;
  }
  console.error(`phase23-context-scan: ${occurrences.length} un-justified process.cwd() occurrence(s) in execution paths:`);
  for (const occ of occurrences) {
    console.error(`  ${path.relative(process.cwd(), occ.file)}:${occ.line}  ${occ.snippet}`);
  }
  console.error('');
  console.error('The active project must never be inferred from process.cwd() (that is the ENGINE_ROOT,');
  console.error('not the user project workspace). Annotate legitimate engine-root uses with a comment');
  console.error(`containing "${JUSTIFICATION_MARKER}:", e.g. "// ${JUSTIFICATION_MARKER}: engine-root data file, not project context".`);
  process.exit(1);
}

main();
