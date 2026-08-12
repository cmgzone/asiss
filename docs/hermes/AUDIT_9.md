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
extraction; do not build a second index authority to get there.

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
dependencies → tests → memory) for a goal. **Plan (Move 7a, folded into
Moves 2-3): after dependents exist, add a minimal-set selector** that walks
goal → symbols → importing/imported modules → tests and returns the
budgeted, dependency-closed context the Phase 18 row names.

### G8 — no permanent Phase 18 regression gate

`smoke:phase16` protects Phase 16/17 invariants only. Phase 18 needs the
same comment-aware, permanent guard once the capabilities exist.
**Plan (Move 7b): `smoke:phase18`** asserting the new invariants — the
dependents API is queried, change-impact is reachable, `'repo'` is wired in
the child runtime, project memory has a producer, and no competing index
authority appears.

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
6. **Move 7 — permanent gate + minimal context (G7 + G8).** `smoke:phase18`
   permanent gate; minimal dependency-closed context selector on top of
   Moves 2-3.

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
