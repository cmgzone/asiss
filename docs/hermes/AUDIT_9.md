# Hermes Architecture Audit 9 — Repository Intelligence (Phase 18, Move 1)

> Docs-first audit for Phase 18: **index/symbol/dependency graphs,
> change-impact analysis, minimal context.** Per the governing rules:
> the roadmap row says "Index/symbol/dependency graphs, change-impact
> analysis, minimal context" — and the phase table row 18 has sat `[ ]`
> since the renumbering, while Phases 7-11 quietly built a real
> repository-intelligence foundation underneath it. This audit maps the
> CURRENT foundation against the Phase 18 TARGET capability by capability,
> separates implementation from documentation, and proposes the smallest
> consolidation for each verified gap. Nothing here is assumed from the
> roadmap — every claim below carries a source file (or a test, or a
> commit) from the audit on 2026-08-12 at HEAD `a9ec9e3`.

## 1. The Phase 18 target vs what exists today

| Capability | Target (Phase 18 row) | Current implementation | Status |
|---|---|---|---|
| **Index** | a canonical repository index with concrete ownership | `src/core/context/repo-index.ts` — persistent, symbol-aware index (`PersistentRepositoryIndex`: files, languages, bytes, `exportedSymbols`, `importers`, version), persisted to `repo-index/<hash>.json` under the data root, load → incremental refresh → save lifecycle via `getRepositoryIndex` | ✅ (Phase 8) |
| **Symbols** | structural symbol intelligence | `extractSymbols` — regex extraction of function/class/interface/type (name + line) per language family; `exportedSymbols` map; `resolveSymbols` + `/symbol` skill. Explicitly "not a compiler" (tolerant scoring signal, 256-symbol cap, 512 KB file cap). No methods/variables/scoped defs, no references/callers/callees/implementations | 🟡 (Phase 8) |
| **Dependency graph** | queryable A→B relationship data | per-file `imports` (module specifiers) + reverse `importers` map built in `finalize()` and PERSISTED — but **`importers` is never read by any production code** (write-only). Imports contribute only a 0.3 matching signal inside `matchBySymbols`. No graph query API, no traversal | 🟡 (Phase 8 data, no query surface) |
| **Change-impact** | target → references → dependents → affected APIs/modules → related tests → regression surface | **absent** — no code computes dependents or a regression surface. Nearest: `matchedTestFiles` maps a *goal* to sibling tests (Phase 11), not a change to its dependents | ❌ |
| **Minimal context** | relevant symbols/files → dependencies → tests → memory → smallest useful context | `ContextEngine.relevantFiles`/`matchBySymbols` rank files; `repositorySection` + per-goal hints render into the mission prompt (opt-in); `build()` budgets tokens. But there is **no dependency-driven minimal-set selection** — ranking + token cap only. Child agents get **no repo context at all** (`'repo'` ContextPolicy source deferred, AUDIT_7 D2) | 🟡 |
| **Architecture discovery** | entry points / services / APIs / workers / databases / queues / config / integrations / test infra | **absent** — `ARCHITECTURE_REVIEW.md` describes the *Hermes* architecture statically; no code discovers repository architecture | ❌ |
| **Incremental indexing** | changed-file detection, add/remove, symbol/dep updates, cache invalidation, no full rebuilds | `refreshRepositoryIndex` re-parses only mtime/size-changed files; vanished files dropped, new files added; `ContextEngine.indexCache` invalidated on refresh; warm on demand (throttled 5 s, `force` bypass) + event-driven warming (`warmOnToolEvents`, debounced 500 ms) + warmth telemetry + `/warmth` skill | ✅ (Phase 9) |
| **Intelligence ↔ memory** | project-specific knowledge retained/retrieved (conventions, architecture facts, testing/deployment practices, failure patterns) | **absent** — `MemoryRecord` declares `'project'` type/scope (`memory-record.ts`) but nothing produces project-scoped records; Phase 14 deferred project-scoped memories as post-14 polish. Repo section and memory section coexist in the prompt but never cross-link | ❌ |
| **Permanent gate** | regression gate protecting the Phase 18 invariants | **absent** — `smoke:repo-index` (18 sections) is a behavioral smoke, not an architectural gate; `smoke:phase16` guards only Phase 16/17 invariants. No `smoke:phase18` | ❌ |

## 2. The verified foundation (what is real)

All of the following was verified against source + tests at HEAD `a9ec9e3`
(commits `7174743` Phase 7, `2435d44` Phase 8, `a62f32f` hints, `fd72796`
symbol skill, `8bdb7e7` Phase 9 warm, `1d3b48c` telemetry, `1dc465e` event
warming, `a3cdde9` warmth skill, `a926e36` Phase 10, `c46178a` Phase 11):

- **Index construction** — `repo-index.ts:indexWorkspace` walk (2000-file /
  12-depth caps, noise exclusions) → `detailOf` enriches each file with
  symbols, imports, imported names, test/config flags, mtime.
- **Persistence** — `saveRepositoryIndex` / `loadRepositoryIndex` /
  `repositoryIndexPath` (sha256 of the resolved root, `repo-index/<hash>.json`,
  version-validated, corrupt → rebuild); `getRepositoryIndex` is the host
  entry point: load → incremental refresh → save.
- **Incremental refresh** — `refreshRepositoryIndex` re-uses unchanged
  details (`mtimeMs === prev.mtimeMs && size === prev.size`), re-parses only
  changed/new files, drops vanished files, re-finalizes `exportedSymbols` /
  `importers` / language counts.
- **Symbol + goal matching** — `matchBySymbols` (path relevance + stem-aware
  symbol 1.2 / imported-name 0.5 / import 0.3 signals, test/config bonuses),
  `resolveSymbols` (bare identifiers → defining files via `exportedSymbols`),
  `renderGoalFileHints` (per-goal justified hint block, empty when no signal).
- **Warmth** — `ContextEngine.refreshRepository` (throttle, `force`, warmth
  snapshot, `RepositoryIndexRefreshed` TaskEvent telemetry),
  `ContextEngine.indexWarmth`, `warmOnToolEvents` (MUTATING_TOOLS,
  ToolCompleted/ToolFailed → debounced refresh), `WarmthSkill`
  (`index_warmth`), `SymbolSkill` (`symbol_resolution`, force-warms).
- **Test intelligence** — `isTestFile`/`isConfigFile` classification,
  `matchedTestFiles` (goal tests + sibling tests, signal-gated),
  `detectTestCommand` (node:test / vitest / jest / pytest / unittest / go),
  `runGoalTests` (bounded: 45 s timeout, 4 KB output cap).
- **Host wiring** — `runner.ts:2362-2408`: repository section is rendered
  into the mission prompt (opt-in `agent.context.repository.enabled`), warm
  refresh + event-warming attached per session, section feeds
  `ContextEngine.buildMissionPrompt`. Phases 10/11 use the index for
  goal-retry hints and verify-then-retry; Phase 17's verifier/diagnoser share
  the same `goalTestEvidence` path.

## 3. Evidence matrix

| Requirement | Status | Evidence | Tests | Commit |
|---|---|---|---|---|
| F1 Audit | ❌ | No Phase 18 audit doc existed before this one; no AST parsing anywhere (only dep is `typescript` = ts-node compiler; extraction is regex) | — | — |
| F2 Repository index | ✅ | `repo-index.ts:PersistentRepositoryIndex`, persistence, lifecycle | smoke:repo-index §4, 6, 7, 8 | 2435d44 |
| F3 Symbols | 🟡 | 4 kinds (function/class/interface/type) + lines, `exportedSymbols`, `/symbol` skill; no methods/variables/references/callers/callees | smoke:repo-index §1, 5, 10 | 2435d44, fd72796 |
| F4 Dependencies | 🟡 | `imports` + `importers` built + persisted; **never queried** (write-only); imports used only as a match signal | smoke:repo-index §2, 4 | 2435d44 |
| F5 Architecture | ❌ | No discovery code; static docs only (`ARCHITECTURE_REVIEW.md`) | — | — |
| F6 Impact analysis | ❌ | No dependents/affected-surface computation anywhere | — | — |
| F7 Context selection | 🟡 | Main mission: repo section + hints in prompt (opt-in); **children: none** (`'repo'` deferred, `agent-engine.ts:617-619`); no dependency-minimal selection | smoke:repo-index §8, 9; smoke:runtime | Ph12 D1 wiring |
| F8 Incremental index | ✅ | mtime/size diff, add/remove, cache invalidation, warm/event-warm/force, no full rebuild | smoke:repo-index §7, 11, 12, 13 | 8bdb7e7, 1dc465e |
| F9 Index + memory | ❌ | `'project'` type/scope declared but never produced; no conventions/architecture/testing/deployment/failure knowledge flow | — | — |
| F10 Regression gate | ❌ | No Phase 18 gate or `smoke:phase18` | — | — |

## 4. Findings, ranked

### G1 — the dependency graph is write-only (the cheapest real win)

`finalize()` already builds `importers: Record<moduleSpecifier, filePaths[]>`:
`src/app.ts` importing `./auth/auth` registers `importers['./auth/auth'] =
['src/app.ts']` (proven by smoke:repo-index §4). It is persisted with the
index and updated by the incremental refresh. But the only production reads
of imports are the per-file `imports` list as a *matching signal* inside
`matchBySymbols` — no code ever answers "what depends on this module?". The
data exists; the query surface does not. **Plan (Move 2): expose the reverse
index as a queried API** (`ContextEngine.dependents(root, target)` →
importing files, resolved through the persistent index) with smoke coverage,
keeping the existing storage/lifecycle untouched. — RESOLVED (Move 2,
below).

### G2 — change-impact analysis is entirely missing

There is no computation of target → references → dependents → affected
APIs/modules → related tests → regression surface. The only adjacent piece
is Phase 11's `matchedTestFiles` (goal → sibling tests), which is a
*goal*-shaped query, not a *change*-shaped one. **Plan (Move 3): build
change-impact on the Move 2 dependents API** — dependents of a changed file
→ their imports/exported symbols → sibling tests → a ranked regression
surface, reusing `matchedTestFiles`' signal gating. — RESOLVED (Move 3,
below).

### G3 — child-agent repository context is still deferred (AUDIT_7 D2)

`AgentContextPolicy.sources` (Phase 16 Move 4) gates child context assembly:
`task`/`instructions`/`history` are structural, `memory` drives the unified
memory section, `attempts` gates prior-outcome lines — and `'repo'` is
explicitly deferred with the comment "needs ContextEngine in the child
runtime — tracked in AUDIT_7 D2" (`agent-engine.ts:617-619`). Child missions
(delegation/swarm/background/scheduled) get no repository context today.
**Plan (Move 4, part 1): wire `'repo'` into the child runtime** — run the
repository section through ContextEngine for children whose policy enables
it, with the same opt-in discipline and warmth handling as the main loop.
— RESOLVED (Move 4, below).

### G4 — repository intelligence and unified project memory are not integrated

Phase 14's `MemoryRecord` type declares `'project'` scope and memory type,
but no producer exists — nothing captures conventions, architecture facts,
testing/deployment practices, or known repository failure patterns, and
nothing retrieves them. The mission prompt renders a memory section
(unified) and a repository section (repo-index) side by side without any
cross-linking. **Plan (Move 4, part 2): project-scoped knowledge capture** —
a project-memory bridge keyed on the workspace/root that records what the
index + missions learn (architecture facts from the index, conventions from
applied lessons) and retrieves it through the unified layer. — RESOLVED
(Move 4, below).

### G5 — symbol intelligence is shallow (by design, but limited)

Extraction is regex, tolerant, and explicitly "not a compiler"
(`repo-index.ts` header): four kinds, no method/variable scope, no
definition-references, no callers/callees, no implementations. It is a
scoring signal, not structural intelligence — fine for context ranking,
insufficient for the Phase 18 "symbol graphs" ambition. **Plan (Move 6):
deepen only where the index already pays for it** — decide, on evidence,
whether the next increment is a real parser for one language family
(feeding callers/callees) or a usage-reference map over the existing
extraction; do not build a second index authority to get there. — RESOLVED
(Move 6, below): the evidence pass decided usage-reference-map for this
corpus and the map (callers/callees/implementations) is implemented.

### G6 — architecture discovery is absent

No code discovers entry points, services, APIs, workers, databases, queues,
configuration surfaces, external integrations, or test infrastructure.
**Plan (Move 5): a bounded, convention-based architecture pass over the
index** — classify known entry points (main/index/server files), config
files (already flagged), worker/queue candidates, and test infrastructure
from the existing per-file data, rendered as an architecture section/skill.
Deliberately heuristic like the rest of the index — not a new authority.

### G7 — no minimal-context selection (only ranking + budget)

Today "relevant context" is `matchBySymbols` ranking + the token budget.
There is no selection of the smallest dependency-closed set (symbols →
dependencies → tests → memory) for a goal. **Plan (Move 7b, folded into
Moves 2-3): after dependents exist, add a minimal-set selector** that walks
goal → symbols → importing/imported modules → tests and returns the
budgeted, dependency-closed context the Phase 18 row names. — RESOLVED
(Move 7b, below).

### G8 — no permanent Phase 18 regression gate

`smoke:phase16` protects Phase 16/17 invariants only. Phase 18 needs the
same comment-aware, permanent guard once the capabilities exist.
**Plan (Move 7b): `smoke:phase18`** asserting the new invariants — the
dependents API is queried, change-impact is reachable, `'repo'` is wired in
the child runtime, project memory has a producer, and no competing index
authority appears. — RESOLVED (Move 7a, below): `npm run smoke:phase18`
guards all six invariants; only the minimal dependency-closed context
selector (G7, Move 7b) remains.

## 5. Move plan (Moves 2-7)

1. **Move 2 — queried dependents API (G1) — DONE (below).**
   `ContextEngine.dependents(root, target)` over the existing `importers` map
   (persistent index), resolved to file paths; smoke:repo-index section 19.
   Smallest change that makes the persisted graph real.
2. **Move 3 — change-impact analysis (G2) — DONE (below).** Dependents →
   exported symbols → sibling tests → ranked regression surface; reuse
   `matchedTestFiles` signal gating; smoke:repo-index section 20.
3. **Move 4 — child repo context + project memory (G3 + G4) — DONE
   (below).** Wire `'repo'` into `AgentEngine` child missions via
   ContextEngine; add the project-scoped memory producer/retriever over the
   unified layer.
4. **Move 5 — architecture discovery (G6).** Convention-based classification
   over the existing index (entry points, workers/queues, test infra,
   integrations); architecture section/skill.
5. **Move 6 — deeper symbols (G5).** Evidence-based decision: real parser
   (one family) or usage-reference map; callers/callees/implementations.
6. **Move 7 — permanent gate + minimal context (G7 + G8).** Split: 7a =
   `smoke:phase18` permanent gate — DONE (below); 7b = minimal
dependency-closed context selector on top of Moves 2-3 — DONE (below).

## 6. Acceptance gate (Move 1 — this audit)

Move 1 is documentation only: this audit + the ROADMAP Phase 18 entry. It
is verified by the audit run at HEAD `a9ec9e3`: `tsc --noEmit` clean and
`smoke:repo-index` (18 sections), `smoke:context`, `smoke:phase16`
(permanent gates), `smoke:memory-unified` all green; the e2e `smoke:runtime`
(green earlier in the same battery) exercises the repository section and
goal-verification path. Nothing above depends on a roadmap checkbox — every
row in §3 cites source, test, or commit.

## 7. Move 2 — queried dependents API (done)

**Engine** (`repo-index.ts`): `findDependents(index, target, { transitive,
limit })` turns the persisted `importers` reverse index into a queried
capability. Each `importers` entry (specifier → importing paths) is matched
against the target with resolution semantics: RELATIVE specifiers are
resolved against each importing file's directory and normalized (extension
and `/index` collapsed) — so `'./auth/auth'` from `src/app.ts`,
`'../auth/auth'` from `src/payments/billing.ts`, and `'./auth'` from
`src/auth/auth.test.ts` all resolve to `src/auth/auth.ts`; BARE specifiers
(packages/aliases) match tolerantly against the target's basename or path
forms (documented heuristic, same tolerant philosophy as the rest of the
index). Results are deduped, sorted by path, and carry the written
specifier + isTest/isConfig flags. `transitive: true` walks the closure
(dependents of dependents) — the primitive Move 3's change-impact builds
on. The lightweight (Phase 7) index has no `importers` data and returns [].

**Host** (`context-engine.ts`): `ContextEngine.dependents(root, target,
options)` resolves the workspace's persistent index (load → incremental
refresh → save, cached) and delegates to `findDependents`; empty for
lightweight indexes. Exported through `src/core/context/index.ts`. The
`importers` map is no longer write-only dead data — the persisted graph is
a queried capability with the existing storage/lifecycle untouched: no new
index authority, no rebuild semantics.

## 8. Acceptance gate (Move 2)

Verified by `tsc --noEmit` clean + `smoke:repo-index` section 19 (direct
same-dir / cross-dir `../` / sibling `./auth` / bare-alias resolution,
non-dependent exclusion, isTest + written-specifier carried, dedupe,
transitive closure with direct-before-transitive ordering, unknown target
→ [], limit cap, lightweight-index opt-out) + the regression battery green
in one pass (`smoke:context`, `smoke:turn-contract`, `smoke:phase16`
permanent gates, `smoke:baseline`, `smoke:terminal-paths`, `smoke:runtime`
e2e).

## 9. Move 3 — change-impact analysis (done)

**Engine** (`change-impact.ts`): `analyzeChangeImpact(index, target, {
.transitive, goal, limit, testLimit })` answers the audit's chain — target
→ dependents → affected APIs/modules → related tests → regression surface:

- **Dependency closure with depth** — `dependentClosure` reuses the Move 2
dependents API level by level: direct dependents (depth 1), then
dependents of dependents (depth 2+) only when `transitive` is set. Each
impacted file carries the written specifier, isTest/isConfig, depth, and
the symbols it exports.
- **Affected API surface** — the target's exported symbols are listed on
the impact, and every impacted file's own exports are attached (the
consuming API surface).
- **Regression surface** — sibling tests of the target itself plus every
impacted NON-test file (the `matchedTestFiles` sibling rule: `stemOf`
equality), ranked by how many impacted files each test covers; an optional
`goal` adds goal-surfaced tests with the same `stemOverlap` rule
`matchedTestFiles` uses. So changing `src/auth/auth.ts` surfaces its own
test plus the sibling tests of every file that imports it; the transitive
closure extends that to second-hop dependents.
- **Detail** — a human-readable summary (target, exports, impacted list
with depth, ranked regression surface) ready to render into context/skills.

**Host** (`context-engine.ts`): `ContextEngine.changeImpact(root, target,
options)` resolves the persistent index and delegates; empty impact for
lightweight indexes or unknown targets. Exported through
`src/core/context/index.ts`. One authority, zero new index data: the whole
capability is the Move 2 dependents API + the existing test-matching rules.

## 10. Acceptance gate (Move 3)

Verified by `tsc --noEmit` clean + `smoke:repo-index` section 20 (target
API surface; direct dependents sorted by path with depth 1 only when not
transitive; unrelated modules excluded; target + dependent sibling tests in
the surface; transitive depth-2 dependent with direct-before-transitive
ordering and its sibling test joining the surface; goal bias surfacing a
related test absent without a goal; unknown target → empty impact;
lightweight-index → empty impact) + the regression battery green in one
pass (`smoke:context`, `smoke:turn-contract`, `smoke:phase16` permanent
gates, `smoke:baseline`, `smoke:terminal-paths`, `smoke:runtime` e2e).
## 11. Move 4 — child repo context + project memory (done)

**Child-agent repo context (G3)** — `AgentEngineRuntime` gains a
`contextEngine` slot; `runChildMission` renders a repository section for
children whose `contextPolicy.sources` includes `'repo'` — warm (throttled)
via `refreshRepository`, then `repositorySection(workspace, goal)` through
the runtime's ContextEngine, appended to the child system prompt beside the
memory section (`buildChildRepoSection`; never throws — advisory, same
opt-in discipline as the main loop). The AUDIT_7 D2 deferral comment is
replaced; the runner wires `contextEngine: this.contextEngine` into
`agentEngine.configure`. Children still default to
`['task', 'instructions', 'history']` — `'repo'` stays agent-opt-in.

**Project-scoped memory (G4)** — `src/core/memory-unified/project-memory.ts`
lands `ProjectMemoryStore` (the durable content authority for project
knowledge: conventions / architecture facts / practices / failure patterns,
keyed on the workspace root, persisted as `memory/project-memory.json` with
atomic tmp+rename, idempotent upsert — unchanged entries never rewrite the
file) and `ProjectMemoryBridge`: `captureIndexFacts(index)` derives a
per-root architecture-facts entry from the Phase 18 index (languages,
tests, config files, scale; no-op under `minFiles` or for lightweight
indexes), a generic `capture()` for lesson/convention/failure-pattern
entries, a `'project'` `MemoryProvider` registered on the unified catalog
(`MemorySource` union extended), and `retrieve(root, query, { layer })`
through the catalog or consolidation layer scoped to the workspace root.
The runner wires the bridge over its catalog and captures index facts when
the mission loop warms a workspace — so repo knowledge is retained and
retrievable like any other unified memory.

## 12. Acceptance gate (Move 4)

Verified by `tsc --noEmit` clean + `smoke:agent-execution` section 15
(RepoBot with the `'repo'` source sees the warmed, goal-matched repository
section naming `src/auth/auth.ts` in its system prompt; NoRepoBot without
the source sees none — control) + `smoke:memory-unified` (index facts
captured with language/test counts, the `'project'` provider live on the
catalog, scoped retrieval through the consolidation layer finding both the
failure pattern and the architecture facts, idempotent index capture, and
durability across fresh instances over the same data file) + the full
regression battery green in one pass (repo-index 20 sections, context,
turn-contract, phase16 gates, baseline, terminal-paths, agent-engine,
agent-task-profile, scheduler, delegation, agent-execution, memory-unified,
and the e2e smoke:runtime — which constructs the runner with the new
wiring). Next: Move 5 — architecture discovery; Move 6 — deeper symbols;
Move 7 — permanent `smoke:phase18` gate + minimal dependency-closed
context.

## 13. Architecture discovery (Move 5, G6)

`src/core/context/architecture.ts` lands the Phase 18 G6 gap — a bounded,
convention-based pass over the **persistent index only** (no content reads,
no new index authority):

- **`classifyArchitecture(file)`** — role classification from path/name
  tokens + the index's `isTest`/`isConfig` flags, using the `stemOf`-style
  basename rule (`path.posix.basename` minus extension) shared with the
  rest of the index codebase. Buckets: `entry` (root `main|server|app|start|
  bootstrap|run|cli` basenames, `index` only at depth ≤ 2 — deep barrels
  excluded), `worker` (`worker|queue|job|cron|scheduler|daemon|listener`),
  `service` (`api|route|controller|handler|endpoint|service|graphql|rest|
  view`), `database` (`db|database|schema|migration|repository|entity|
  sql|query`), `integration` (`integration|connector|adapter|webhook|
  provider|plugin|sdk|client`), plus `test` and `config` from the index
  flags.
- **`discoverArchitecture(index)`** — the profile: entry points, services,
  workers, databases, integrations, test files, test configs (config
  filtered through the jest/vitest/mocha/cypress/playwright/karma/pytest
  regex), config files, languages, file count, indexed-at. Each file
  carries its exported symbols (the API surface for entry/service buckets).
- **`renderArchitectureProfile(profile)`** — the human-readable
  `Architecture overview:` section (buckets, per-bucket caps, export notes)
  that renders into agent context.
- **`ContextEngine.architecture(root)` / `architectureSection(root)`** —
  thin wrappers resolving through the persistent index (load → incremental
  refresh → save, cached); `[]`-safe/empty for lightweight indexes and
  unknown roots, matching the dependents/change-impact discipline.
- **`src/skills/architecture.ts`** — the `architecture_survey` skill
  registered on the runner, rendering the section into the system prompt.

## 14. Acceptance gate (Move 5)

Verified by `tsc --noEmit` clean + `smoke:repo-index` section 21 (entry
points: `src/main.ts`/`src/server.ts`/`src/app.ts`/root `index.ts` in,
deep barrel `src/auth/index.ts` out, `src/utils/format.ts` not an entry
point; service/worker/database/integration/test/config classification;
entry point carries its exports; rendered section headers) + the full
regression battery green in one pass (repo-index 21 sections, context,
turn-contract, phase16 gates, baseline, terminal-paths, and the e2e
smoke:runtime). One real bug caught and fixed during verification: the
initial classifier split on `.` too, so `src/main.ts` produced basename
`ts` — now `path.posix.basename` minus extension like `stemOf`.

## 15. Deeper symbol intelligence (Move 6, G5)

**The evidence-based decision.** AUDIT_9 §G5 said: decide, on evidence,
whether the next increment is a real parser for one language family or a
usage-reference map over the existing extraction. `symbolIntelligenceEvidence`
(`src/core/context/symbols.ts`) measures the persistent index — per-family
file/symbol density, dominance, parser availability (TypeScript is the only
family with an in-tree parser), cross-family symbol coverage, reference
edges, parse cost — and decides:

- no dominant family (largest < 50% of files) → usage-reference map
- dominant family without an in-tree parser → usage-reference map
- dominant TypeScript but other families still carry symbols →
  usage-reference map
- single-family TypeScript corpus → parser is viable

**The evidence (this repo, at implementation time).** Running the pass over
the Hermes repo itself: **336 files, 1,047 symbols, 3,401 usage-reference
edges** — families: typescript (213 files, 914 symbols), other (122 files,
132 symbols), python (1 file, 1 symbol). TypeScript dominates at 63% but
python + other families still carry 133 symbols, so the decision is
**usage-reference-map**: a TS-only parser would cover 63% of the corpus and
miss the rest, while the word-boundary map covers every family from the
existing extraction — zero new dependencies, no second index authority (the
audit's explicit constraint), and the map stays incremental-refresh
compatible. A future single-family TS corpus would flip the decision to
parser-viable (the rule is data-driven, not hard-coded).

**The usage-reference map (chosen increment).** `repo-index.ts` records per
file a bounded `identifiers` list (≤ 512 distinct word-boundary
identifiers, the reference signal) and `implementedSymbols` (`implements X`
/ `extends Y`, ≤ 16, TS + JVM/.NET families only) during `detailOf`;
`finalize` derives the index-level `symbolReferences` (symbol → files that
reference it, excluding definers) and `implementations` (symbol → files
that implement/extends it, kept only for repo-defined symbols) —
incremental-refresh compatible: unchanged files are reused by identity,
exactly like the importers graph. The persisted index format bumps to
version 2, invalidating old persisted indexes through the existing load
check (one-time rebuild, no rebuild semantics added). Queries —
`findCallers` / `findCallees` / `findImplementations` — answer "who calls
this symbol?", "what does this file call?", "who implements this
interface?" with per-file isTest/isConfig flags, sorted, deduped, capped.
Hosted on `ContextEngine` (`callersOf` / `calleesOf` / `implementationsOf`
/ `symbolIntelligenceEvidence`), exported through `src/core/context/index.ts`.
Same tolerant "not a compiler" discipline: references are bounded and may
include noise (documented heuristic, like the rest of the index).

**A real bug the move exposed and fixed.** The plain-object record maps
inherit Object.prototype members, so an identifier like `constructor`
(present in this repo's docs) passed the `exportedSymbols[name]` truthiness
check and crashed map building. `hasOwnKey`
(Object.prototype.hasOwnProperty.call) now guards every record-map
membership check in `finalize`, the reference builders, `resolveSymbols`,
and the symbols.ts queries — prototype member names never resolve as
symbols.

## 16. Acceptance gate (Move 6)

Verified by `tsc --noEmit` clean + `smoke:repo-index` section 22 (mixed
corpus decides usage-reference-map with TS dominant + cross-family symbols;
pure single-family TS corpus decides parser-viable; identifiers collected;
callers excluding the defining file with isTest flags; callees carrying
defining files; own definitions excluded; implements/extends recorded and
unimplemented symbols empty; unknown symbols/files → []; persistence
round-trip of symbolReferences/implementations/identifiers; incremental
refresh dropping a stale caller while keeping fresh ones; engine host
callersOf/calleesOf/implementationsOf/evidence + limit + lightweight opt-out
→ []/undefined; prototype-safety: `constructor` never resolves) + the
regression battery green in one pass (repo-index 22 sections, context,
turn-contract, phase16 gates, baseline, terminal-paths, agent-engine,
agent-task-profile, scheduler, delegation, agent-execution, memory-unified,
and the e2e smoke:runtime). One pre-existing flake noted: smoke:delegation's
parallel-child completion assertion is timing-sensitive and intermittently
fails under load on any tree (HEAD and working tree both green on re-run).
## 17. Permanent Phase 18 gate (Move 7a, G8)

`scripts/smoke-phase18.ts` (registered as `npm run smoke:phase18`) is the
permanent, comment-aware regression gate — same discipline as `smoke:phase16`:
comments are stripped so explanatory prose can neither trip nor soothe a
sweep. Seven gates, one per closed gap:

- **Gate A (G1) — dependents queried:** `findDependents` is defined in
  repo-index.ts and READS `index.importers` (never write-only dead data),
  and ContextEngine.dependents delegates to it.
- **Gate B (G2) — change-impact reachable:** `analyzeChangeImpact` is
defined in change-impact.ts and ContextEngine.changeImpact delegates.
- **Gate C (G3) — 'repo' wired in the child runtime:** the engine keeps the
  `contextEngine` slot + `buildChildRepoSection`, `runChildMission` handles
  `sources.has('repo')`, and the runner wires `contextEngine:` into
  `agentEngine.configure`.
- **Gate D (G4) — project memory has a producer:** `ProjectMemoryStore` +
  `ProjectMemoryBridge` + `captureIndexFacts` exist AND the runner
  constructs the bridge and calls `captureIndexFacts` on warm — a declared
  type with no producer trips this gate.
- **Gate E (G5/Move 6) — symbol intelligence reachable:** the four
  symbols.ts exports (`findCallers` / `findCallees` / `findImplementations` /
  `symbolIntelligenceEvidence`) are defined and each is hosted on
  ContextEngine, and the persisted `symbolReferences` / `implementations`
  maps stay derived in `finalize`.
- **Gate F — no competing index authority:** in src/, the persistent index
  lifecycle (`getRepositoryIndex` / `buildPersistentIndex` /
  `refreshRepositoryIndex` / `loadRepositoryIndex` / `saveRepositoryIndex`)
  appears only in repo-index.ts + context-engine.ts; `indexWorkspace` (the
  lightweight fallback) only in its module + the host + repo-index's base
  passes; and the extraction/derivation authorities (`extractSymbols` /
  `extractImports` / `collectIdentifiers` / `extractImplemented` /
  `buildSymbolReferences` / `buildImplementations`) are defined exactly
  once, in repo-index.ts.
- **Gate G (G7/Move 7b) — minimal context reachable:** `selectMinimalContext`
  + `renderMinimalContext` + `emptyMinimalContext` exist in
  minimal-context.ts and ContextEngine.minimalContext delegates (with the
  empty fallback), so the selector can never silently disappear from the
  host surface.

Verified bidirectionally: a comment naming `getRepositoryIndex` in a src
file does NOT trip the gate (comment-aware), while an actual code reference
in any non-host src module FAILS it with the offending file named.

## 18. Acceptance gate (Move 7a)

Verified by `tsc --noEmit` clean + `npm run smoke:phase18` (all seven gates;
168 src files scanned; negative + comment-awareness probes both behave) +
`smoke:phase16` still green (the new gate is additive) + the regression
battery green in one pass (repo-index 22 sections, context, turn-contract,
phase16, baseline, terminal-paths, agent-engine, agent-task-profile,
scheduler, delegation, agent-execution, memory-unified, and the e2e
smoke:runtime). Next was Move 7b — the minimal dependency-closed context
selector (G7), landed below.

## 19. Minimal dependency-closed context (Move 7b, G7)

`src/core/context/minimal-context.ts` lands the audit's G7 gap — the
smallest useful, budgeted context the Phase 18 row names, built on the Move
2-3 machinery with zero new index authority:

- **`selectMinimalContext(index, goal, options)`** — walks the audit's
  chain goal → symbols → importing/imported modules → tests:
  - **Seeds (goal → symbols)** — `matchBySymbols` ranking (capped,
    `seedLimit`, default 6). Seeds always survive the budget — they are the
    point.
  - **Dependency closure, both directions** — BFS over the per-file
    `imports` (outgoing, resolved via the shared `resolveImportTarget`
    against each file's directory) and `findDependents` (incoming), level
    by level, with **smallest-first admission** so large unrelated files
    never displace the dependency spine. Bare specifiers (packages/aliases)
    are collected as `externalModules` — legitimate leaves, not missing
    closure.
  - **Closure status** — `closed` is true only when every in-repo module
    referenced by an included file (both directions) is itself included;
    `truncated` reports a budget/file-cap cut, so callers know whether the
    returned context is complete.
  - **Related tests** — the goal-surfaced + sibling tests via the
    signal-gated `matchedTestFiles` rule (`includeTests`, default true).
  - **Budget** — byte cap (`maxBytes`, default 96 KB) + file cap
    (`maxFiles`, default 40); `totalTokens` at the codebase's ~4 chars/token
    estimate; direction opt-outs `includeDependents` / `includeImports`.
- **`renderMinimalContext(ctx)`** — the human-readable
  `Minimal dependency-closed context` section (seeds / imported modules /
  importing modules / tests / totals / external modules) ready for the
  mission prompt.
- **`ContextEngine.minimalContext(root, goal, options)`** — the host
  wrapper (empty fallback for lightweight indexes), exported through
  `src/core/context/index.ts`.

**Wired into the mission prompt.** `ContextEngine.repositorySection` — the
block the main loop (runner) and child agents (`buildChildRepoSection`)
render — now renders the **minimal dependency-closed context** instead of
the per-goal file hint whenever a persistent index exists, so an agent
sees not just the matched files but the smallest closure around them
(seeds → imported/importing modules → tests) with the closure status.
Lightweight indexes and no-match goals fall back to the previous hint path;
`goalHints.enabled === false` still restores the plain path list;
`goalHints.maxFiles` now seeds the minimal context (`seedLimit`) for
persistent indexes. The new **`repository.minimal` config** makes the
section tunable: `minimal.enabled` (default true — set false to fall back
to the goal-file hint), `minimal.maxBytes` (byte cap, default 96 KB), and
`minimal.maxFiles` (file cap, default 40); both caps are strict in the
config schema (`src/core/config.ts`) and thread through `repositorySection`
into `selectMinimalContext`. Depth-bonus-only matcher noise is excluded by
the same `hasGoalSignalForFile` gate the hint renderer uses (a seed must
carry a real path/symbol/import stem hit). The `smoke:phase18` Gate G
additionally asserts `minimalContextSection` is defined AND called from
`repositorySection` with the `minimal` config threaded in, so the wiring
and its knobs cannot silently regress.

**Runtime skill.** `src/skills/minimal-context.ts` registers the
`minimal_context` skill (runner-wired, mirroring `/symbol` and `/warmth`):
force-warms the index, then answers the closure for **any goal** (e.g.
"fix the authentication flow") or **any single file** (a root-relative
path via the selector's new `seedFiles` option — the closure around ONE
change, unknown paths safely ignored) and returns the structured context
plus the rendered section. A lightweight index yields an advisory note, not
a crash. The four index-backed context skills (`symbol`, `warmth`,
`architecture`, `minimal_context`) are cross-linked in
`src/skills/README.md` with a "which question → which skill" table, so an
agent can pick the right query without reading source.

## 20. Acceptance gate (Move 7b)

Verified by `tsc --noEmit` clean + `smoke:repo-index` sections 23-24 (23:
seeds with the unrelated file excluded; imported/importing/transitive
modules joining with roles dependency/dependent; dependency-closed status;
bare package reported as an external leaf; deterministic across calls;
seed-capped role block proving jwt/app/server enter via the closure, not
the seeds; the tests pass surfacing a nothing-imports test only via
matchedTestFiles, removed by includeTests:false; includeDependents /
includeImports opt-outs; budget truncation keeping only the top seed with
closed=false; rendered section; lightweight-index empty fallback. 24: the
repository section renders the minimal context for persistent indexes
(seeds + imported/importing modules + tests, unrelated file absent,
closure status), goalFilesSection stays the unchanged fallback API,
goalHints opt-out restores the plain list, non-matching goals render no
block, lightweight indexes never render it. 25: the `repository.minimal`
config threads through — `maxFiles` caps the rendered set with truncation
reported, `maxBytes` keeps only the top seed, `enabled:false` restores the
goal-file hint, `goalHints.maxFiles` still seeds) + `smoke:config`
(minimal.enabled/maxBytes/maxFiles survive the strict schema round-trip) +
`smoke:agent-execution` section 15 (the child agent with the `'repo'`
source sees the minimal context section in its system prompt — end-to-end
through the runner wiring; the control agent gets none). 26: the
`minimal_context` skill — goal-driven and file-driven closures via
`seedFiles` (imported/importing modules + related test, unrelated file
excluded, closed status), unknown seed files → empty, missing args → loud
error, lightweight index → advisory note) + the permanent `smoke:phase18`
Gate G (selector defined + hosted + empty fallback + repositorySection
wiring + minimal config threading + skill defined and runner-registered +
seedFiles option) + the full regression battery green in one pass
(repo-index 26 sections, phase16 + phase18 gates, context, turn-contract,
baseline, terminal-paths, agent-engine, agent-task-profile, scheduler,
delegation, agent-execution, memory-unified, config, tools, policy, and the
e2e smoke:runtime — which constructs the runner with the new skill
registration).
**Phase 18 is complete** — every gap in the §3 evidence matrix is closed
and permanently guarded.
