/**
 * Phase 18 Move 7a — permanent verification gate (docs/hermes/AUDIT_9.md §G8).
 *
 * Static, no-network regression guard for the Phase 18 invariants. It must
 * run forever as part of the battery, protecting the audit's closed gaps:
 *
 *   Gate A — the persisted dependents graph is a QUERIED capability (G1):
 *            `findDependents` reads the `importers` reverse index and
 *            ContextEngine.dependents hosts it — the graph can never slip
 *            back to write-only dead data.
 *   Gate B — change-impact analysis is reachable (G2): `analyzeChangeImpact`
 *            exists and ContextEngine.changeImpact delegates to it.
 *   Gate C — 'repo' is wired into the child-agent runtime (G3): the engine
 *            keeps the contextEngine slot + child repo section builder, the
 *            'repo' source is handled in runChildMission, and the runner
 *            wires the engine in.
 *   Gate D — project memory has a producer (G4): ProjectMemoryStore +
 *            ProjectMemoryBridge + captureIndexFacts exist AND the runner
 *            actually captures index facts on warm.
 *   Gate E — symbol intelligence is reachable (G5/Move 6): the
 *            usage-reference map (callers/callees/implementations) and the
 *            evidence pass are defined and hosted on ContextEngine, and the
 *            persisted maps stay derived in finalize.
 *   Gate F — no competing index authority: the persistent index lifecycle
 *            (build/refresh/load/save) is authored only in repo-index.ts and
 *            hosted only by ContextEngine; the lightweight indexWorkspace is
 *            confined to its module + the host + repo-index's base passes;
 *            the content-extraction/derivation authorities are defined
 *            exactly once, in repo-index.ts.
 *   Gate G — the minimal dependency-closed context selector (G7/Move 7b) is
 *            reachable: selectMinimalContext + renderMinimalContext exist in
 *            minimal-context.ts, ContextEngine.minimalContext delegates, and
 *            the mission prompt's repositorySection renders the section for
 *            persistent indexes (minimalContextSection defined + called,
 *            repository.minimal enabled/maxBytes/maxFiles threaded in). The
 *            runtime surface stays live too: the minimal_context skill
 *            (goal or one-file closure via seedFiles) is registered on the
 *            runner.
 *
 * The behavioral matrix is proven by the battery — repo-index (22 sections:
 * dependents §19, change-impact §20, architecture §21, deeper symbols §22),
 * context, memory-unified (§project provider), agent-execution (§15 child
 * repo context) — and recorded in AUDIT_9 §16. This file only guards the
 * architectural invariants; like smoke:phase16, it is comment-aware: comments
 * are stripped so explanatory text can neither trip nor soothe a sweep.
 *
 * Run: npm run smoke:phase18
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
 *  comments about a capability do not trip (or soothe) the sweeps. */
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n\r]*/g, ' ');
}

function readFile(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

/** Number of times a definition marker appears across src/ (comments stripped). */
function definitionCount(src: string, fn: string): number {
  return (src.match(new RegExp(`export function ${fn}\\b`, 'g')) || []).length;
}

async function main() {
  const srcDir = path.join(ROOT, 'src');
  assert(fs.existsSync(srcDir), 'src/ exists (run from the project root, e.g. `npm run smoke:phase18`)');

  const repoIndexSrc = readFile('src/core/context/repo-index.ts');
  const contextEngineSrc = readFile('src/core/context/context-engine.ts');
  const changeImpactSrc = readFile('src/core/context/change-impact.ts');
  const symbolsSrc = readFile('src/core/context/symbols.ts');
  const agentEngineSrc = readFile('src/core/agent/agent-engine.ts');
  const runnerSrc = readFile('src/agents/runner.ts');
  const projectMemorySrc = readFile('src/core/memory-unified/project-memory.ts');

  // ------------------------------------------------------------------ Gate A
  // G1 — the persisted importers graph is queried, never write-only.
  assert(/export function findDependents/.test(repoIndexSrc), 'findDependents defined in repo-index.ts');
  assert(
    repoIndexSrc.includes('Object.entries(index.importers)'),
    'findDependents READS the importers reverse index (queried, not write-only)'
  );
  assert(/dependents\s*\(/.test(contextEngineSrc), 'ContextEngine.dependents exists');
  assert(contextEngineSrc.includes('findDependents('), 'ContextEngine.dependents delegates to findDependents');

  // ------------------------------------------------------------------ Gate B
  // G2 — change-impact analysis is reachable through the host.
  assert(/export function analyzeChangeImpact/.test(changeImpactSrc), 'analyzeChangeImpact defined in change-impact.ts');
  assert(/changeImpact\s*\(/.test(contextEngineSrc), 'ContextEngine.changeImpact exists');
  assert(contextEngineSrc.includes('analyzeChangeImpact('), 'ContextEngine.changeImpact delegates to analyzeChangeImpact');

  // ------------------------------------------------------------------ Gate C
  // G3 — 'repo' is wired into the child-agent runtime (AUDIT_7 D2 closed).
  assert(
    agentEngineSrc.includes('contextEngine?: ContextEngine'),
    'AgentEngineRuntime keeps the contextEngine slot (child repo context)'
  );
  assert(agentEngineSrc.includes('buildChildRepoSection'), 'child repo section builder present');
  assert(agentEngineSrc.includes("sources.has('repo')"), "'repo' ContextPolicy source handled in runChildMission");
  assert(
    runnerSrc.includes('agentEngine.configure(') && runnerSrc.includes('contextEngine: this.contextEngine'),
    'runner wires the context engine into agentEngine.configure'
  );

  // ------------------------------------------------------------------ Gate D
  // G4 — project memory has a live producer in the runner.
  assert(/export class ProjectMemoryStore/.test(projectMemorySrc), 'ProjectMemoryStore durable store present');
  assert(/export class ProjectMemoryBridge/.test(projectMemorySrc), 'ProjectMemoryBridge present');
  assert(projectMemorySrc.includes('captureIndexFacts('), 'captureIndexFacts derives architecture facts from the index');
  assert(runnerSrc.includes('new ProjectMemoryBridge('), 'runner wires the project memory bridge over the unified catalog');
  assert(runnerSrc.includes('captureIndexFacts('), 'runner actually captures index facts on warm (producer is live)');

  // ------------------------------------------------------------------ Gate E
  // G5/Move 6 — deeper symbol intelligence is reachable: the usage-reference
  // map (callers/callees/implementations) + the evidence pass, defined in
  // symbols.ts and hosted on ContextEngine; maps stay derived in finalize.
  for (const fn of ['findCallers', 'findCallees', 'findImplementations', 'symbolIntelligenceEvidence']) {
    assert(new RegExp(`export function ${fn}\\b`).test(symbolsSrc), `${fn} defined in symbols.ts`);
  }
  assert(contextEngineSrc.includes('findCallers('), 'ContextEngine.callersOf delegates to findCallers');
  assert(contextEngineSrc.includes('findCallees('), 'ContextEngine.calleesOf delegates to findCallees');
  assert(contextEngineSrc.includes('findImplementations('), 'ContextEngine.implementationsOf delegates to findImplementations');
  assert(contextEngineSrc.includes('measureSymbolIntelligence('), 'ContextEngine.symbolIntelligenceEvidence runs the evidence pass');
  assert(repoIndexSrc.includes('symbolReferences:'), 'persisted symbolReferences map still derived in finalize');
  assert(repoIndexSrc.includes('implementations:'), 'persisted implementations map still derived in finalize');

  // ------------------------------------------------------------------ Gate G
  // G7/Move 7b — the minimal dependency-closed context selector is reachable:
  // defined in minimal-context.ts, hosted on ContextEngine, exported through
  // the context index (the smoke imports it from the barrel).
  const minimalContextSrc = readFile('src/core/context/minimal-context.ts');
  assert(/export function selectMinimalContext/.test(minimalContextSrc), 'selectMinimalContext defined in minimal-context.ts');
  assert(/export function renderMinimalContext/.test(minimalContextSrc), 'renderMinimalContext defined in minimal-context.ts');
  assert(/export function emptyMinimalContext/.test(minimalContextSrc), 'emptyMinimalContext defined (lightweight-index fallback)');
  assert(/minimalContext\s*\(/.test(contextEngineSrc), 'ContextEngine.minimalContext exists');
  assert(contextEngineSrc.includes('selectMinimalContext('), 'ContextEngine.minimalContext delegates to selectMinimalContext');
  assert(contextEngineSrc.includes('emptyMinimalContext('), 'ContextEngine.minimalContext falls back to emptyMinimalContext');
  assert(
    (contextEngineSrc.match(/minimalContextSection\(/g) || []).length >= 2,
    'minimalContextSection is defined AND rendered by repositorySection (the mission-prompt wiring stays live)'
  );
  assert(
    contextEngineSrc.includes('cfg.minimal') && contextEngineSrc.includes('minimalContextOptions('),
    'repositorySection threads the repository.minimal config (enabled/maxBytes/maxFiles) into the selector'
  );
  // The runtime surface: the minimal_context skill exists (goal or file
  // closure via seedFiles) and the runner registers it, so an agent can ask
  // for the closure on demand, mirroring /symbol and /warmth.
  const minimalSkillSrc = readFile('src/skills/minimal-context.ts');
  assert(/export class MinimalContextSkill/.test(minimalSkillSrc), 'MinimalContextSkill defined in src/skills/minimal-context.ts');
  assert(runnerSrc.includes('new MinimalContextSkill('), 'runner registers the minimal-context skill');
  assert(minimalContextSrc.includes('seedFiles'), 'selectMinimalContext supports explicit seedFiles (closure around one file)');

  // ------------------------------------------------------------------ Gate F
  // No competing index authority: the persistent index lifecycle is authored
  // only in repo-index.ts and hosted only by ContextEngine; indexWorkspace
  // (the lightweight fallback) is confined to its module + the host + the
  // repo-index base passes; the extraction/derivation authorities are defined
  // exactly once. Comments are stripped so this file's own prose — and any
  // stray docs in src/ — cannot soothe a sweep.
  const persistentLifecycle = ['getRepositoryIndex', 'buildPersistentIndex', 'refreshRepositoryIndex', 'loadRepositoryIndex', 'saveRepositoryIndex'];
  for (const file of collectTsFiles(srcDir)) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    if (rel.endsWith('repo-index.ts') || rel.endsWith('context-engine.ts')) continue;
    const stripped = stripComments(fs.readFileSync(file, 'utf-8'));
    for (const sym of persistentLifecycle) {
      assert.strictEqual(
        stripped.includes(sym),
        false,
        `persistent index lifecycle '${sym}' is confined to repo-index.ts + ContextEngine (${rel})`
      );
    }
  }
  for (const file of collectTsFiles(srcDir)) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    if (rel.endsWith('repository-context.ts') || rel.endsWith('context-engine.ts') || rel.endsWith('repo-index.ts')) continue;
    assert.strictEqual(
      stripComments(fs.readFileSync(file, 'utf-8')).includes('indexWorkspace'),
      false,
      `indexWorkspace (lightweight index) is confined to repository-context.ts + the host + repo-index base passes (${rel})`
    );
  }
  const allSrc = stripComments(collectTsFiles(srcDir).map((f) => fs.readFileSync(f, 'utf-8')).join('\n'));
  for (const fn of ['extractSymbols', 'extractImports', 'collectIdentifiers', 'extractImplemented', 'buildSymbolReferences', 'buildImplementations']) {
    assert.strictEqual(
      definitionCount(allSrc, fn),
      1,
      `extraction/derivation authority '${fn}' is defined exactly once, in repo-index.ts`
    );
  }

  console.log(JSON.stringify({
    success: true,
    gates: {
      gateA_dependentsQueried: true,
      gateB_changeImpactReachable: true,
      gateC_repoWiredInChildRuntime: true,
      gateD_projectMemoryProducer: true,
      gateE_symbolIntelligenceReachable: true,
      gateF_noCompetingIndexAuthority: true,
      gateG_minimalContextSelector: true
    },
    scannedTsFiles: collectTsFiles(srcDir).length,
    note: 'Behavioral matrix per capability is proven by the battery (smoke:repo-index §19-§23, smoke:agent-execution §15, smoke:memory-unified); this gate guards the architectural invariants.'
  }, null, 2));
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
