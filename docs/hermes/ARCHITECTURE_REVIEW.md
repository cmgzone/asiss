# Hermes Architecture Review (post-Phase 11)

> Written after Phases 0–11 plus the warmth telemetry, `/warmth` skill and web
> UI indicator landed (last commit `a3cdde9`). This is a *reassessment*, not a
> plan to move code: it records what the core looks like now, what it does
> well, where the coupling risks are, and the two or three highest-leverage
> next moves — chosen for **execution → verification → recovery → reliability**,
> not for feature surface.

## 1. What the core is now

Five engines plus one event bus were extracted out of `AgentRunner` (Phases
1–11). They live under `src/core/{task,tools,policy,model,context}/` and total
~5,300 lines across 27 files. The host that composes them, `AgentRunner`
(`src/agents/runner.ts`), is still 4,059 lines. That one number — the core is
roughly the same size as the host that wires it — is the headline of this
review.

| Engine | Files (LOC) | Entry points | Owns |
| --- | --- | --- | --- |
| **TaskEngine + TaskEventBus** | `task/` (~860) | `create`, `start`, `run`, `verify`, `recordToolExecution`, `completeToolExecution`, `recordCheckpoint`, `recordDecision`, `recordProgress`; bus: `on` / `emit` / `status` | Canonical Task lifecycle (CREATED → … → COMPLETED/FAILED), tool/checkpoint/decision/cost records, ~30 typed event names, `task-hooks-bridge` auto-forwards everything to hookManager audit |
| **ToolEngine** | `tools/` (7 files) | `execute(request, ctx)`, `catalog()`, `aliasCoverage()` | Discover → select → validate → authorize → execute → normalize → record, for native skills, MCP and dynamic tools; never throws for tool failures |
| **PolicyEngine** | `policy/` (4 files, ~570) | `evaluate(request, ctx)` | ALLOW / ASK / DENY verdicts from built-in rules; per-check observability; ASK resolved by `ApprovalCoordinator` (approval TaskEvents, 10-min fail-closed timeout); default allow mode |
| **ModelEngine** | `model/` (2 files, ~450) | `select(input, providers)`, `recordModelOutcome`, `recordToolOutcome`, `getPerformance` | Task-profile → complexity → scored provider selection (capability 40 / reliability 22 / tool-success 16 / context-fit 12 − latency − cost); persists `model_metrics.json` |
| **ContextEngine** | `context/` (10 files, ~2,600) | `build`, `renderHistory`, `indexRepository`, `refreshRepository`, `indexWarmth`, `repositorySection`, `goalFilesSection`, `resolveSymbols`, `relevantFiles`, `selectTools` | Budgeted context construction; persistent symbol-aware repository index (incremental, warm, telemetry-attributed); repo-watcher event warming; verify-then-retry helpers (Phase 11) |

Satellites wired around them: `ApprovalCoordinator` (ASK path), `repo-watcher`
(event-driven warm), `verify-then-retry` (`matchedTestFiles`,
`detectTestCommand`, `runGoalTests`), `SymbolSkill` + `WarmthSkill` (read the
index), and two hand-wired gateway projections (approval events, repo-warmth
events → web/Telegram clients).

## 2. How they compose today (the coupling map)

`AgentRunner.processMessage` is the composition root and the mission
orchestrator. Per mission turn it does, in order:

1. Creates the canonical Task, advances it through lifecycle states.
2. **ContextEngine**: `refreshRepository` (warm, throttled) → attach
   `repo-watcher` once per session → `repositorySection(workspace, goal)` →
   `renderHistory` (byte-identical drop-in) → optional goal files hint.
3. **ModelEngine**: `select` against the Task + prompt, then
   `recordModelOutcome` / `recordToolOutcome` around the model call.
4. **ToolEngine**: `execute` per tool call (PolicyEngine authorizes inside);
   on failure, runner-side `injectGoalRetryHint` (Phase 10) and
   `injectGoalVerifyOutput` (Phase 11) query ContextEngine and write system
   memories.
5. Finalizes the Task on every exit path (try/finally).

The engines call the bus, not each other: ContextEngine emits
`RepositoryIndexRefreshed`; the ApprovalCoordinator emits
`ApprovalRequired/Granted/Denied`; TaskEngine emits everything else. Consumers
attach in the runner constructor (skill registration, gateway forwards) or via
the `task-hooks-bridge` (audit JSONL).

## 3. Strengths (what the evolution got right)

- **Behavior-preserving extraction.** The renderHistory drop-in is
  byte-identical; PolicyEngine defaults to pure allow; the e2e
  `smoke:runtime` mission is the behavior-neutrality proof that survives every
  phase. The "wrap → move → test" rule from Phase 0 held.
- **Engines are host-agnostic and injectable.** Every engine takes its
  dependencies via constructor options with process-wide defaults, so tests
  and future hosts (swarm agents, background worker, CLI) can construct them
  hermetic. The smoke suite leans on this heavily.
- **The bus actually decouples.** TaskEngine doesn't know about hookManager,
  the gateway, or the UI; the audit bridge and the projections subscribe. New
  lifecycle events reach audit automatically via `task-hooks-bridge`.
- **Policy is observable.** Every verdict carries per-rule checks and reasons;
  approvals are TaskEvents, so every client sees the same state and the audit
  records the decision.
- **Repository intelligence is trustworthy by construction.** Persistent,
  incremental (mtime/size only), warm (on-demand + event-driven), and
  telemetry-attributed (last refresh, files/symbols re-parsed, session/task) —
  so recovery decisions can be audited against index freshness.
- **Test discipline.** 16 smoke scripts including the 15-section
  `smoke:repo-index` and the end-to-end mission. New capabilities arrive with
  hermetic fixtures and an e2e assertion.

## 4. Gaps & coupling risks (ranked)

### R1. AgentRunner is still the composition root *and* the orchestrator
4,059 lines: it constructs every engine, forwards every event, and contains
the mission loop itself. The engines are services it calls; the *orchestration*
(sequence, retries, verification, state transitions per turn) is still one
monolith inside `processMessage`. Highest coupling risk: any evolution of the
loop (new phase, new recovery step) requires editing the runner, which is
exactly the file the evolution was supposed to shrink. The recovery logic of
Phases 10–11 (`injectGoalRetryHint`, `injectGoalVerifyOutput`) lives *in the
runner*, not in TaskEngine — where a home already exists.

### R2. The config surface is untyped
`loadConfig(): any` — every engine reads config structurally
(`ctx.config.policy`, `agent.context.repository`, `repository.goalHints`,
`policy.approval.defaultOutcome`, …). A typo silently disables a feature or,
worse, flips behavior, with no load-time error. This is a genuine correctness
risk that grows with each engine knob (there are now ~20 of them across the
core), and it is the one place where the "no silent behavior change" rule
cannot be enforced by the type system.

### R3. Two execution models coexist
TaskEngine has a full lifecycle machine (`run`, `analyze`, `plan`, `execute`,
`verify`, `diagnose`, `repair`, `recover`, `retry` — with stages and retry
semantics) that the mission loop never invokes: the runner only uses `create`
+ `record*` + finalize. Recovery and verification are re-implemented ad hoc in
the runner (Phases 10–11) instead of using the engine's own `verify`/`repair`
path. Divergence risk: two definitions of "recovery" drifting apart as the
self-repair loop grows.

### R4. Hand-wired event projections
Every new TaskEvent that should reach clients requires a manual forwarder in
the runner constructor (currently approval ×3, repository warmth ×1). There is
no typed projection table, so the UI/Telegram surface drifts from the event
set as events are added, and every projection is a bespoke edit in the god
file.

### R5. Runner's ContextEngine is constructed without config
`new ContextEngine()` — engine-level knobs (`repository.warm.enabled`,
`telemetry.enabled`, `goalHints.maxFiles`, …) read by the engine from *its own*
config are therefore defaults, while the runner separately checks
`agent.context.repository.enabled` for the gate. Two sources of truth for one
feature: the runner's checks and the engine's defaults can disagree, and
config that works in tests (which inject config) does not behave identically
in the runner (which does not).

### R6. Persistent-state sprawl
`model_metrics.json`, `memory.sqlite`, `projects_data.json`,
`repo-index/<hash>.json`, `analytics_data.json`, `cost_data.json`, `*.json`
for goals/swarm/runs — most keyed to `process.cwd()`, only the task store
honors `GITU_DATA_ROOT`. Portability, backup, and hermetic tests are each
reinventing the data-root story.

### R7. Documentation drift
`SUBSYSTEM_INVENTORY.md` is frozen at Phase 0 (no `task/`, `tools/`,
`policy/`, `model/`, `context/` engines listed); `AGENT_RUNNER_FLOW.md` is
Phase 0; the ROADMAP phase *table* still marks Phase 8 as `[ ]` and its rows
9–11 (ExecutionScheduler, Swarm, VerificationEngine) no longer match the
numbering of what actually shipped (warm index, goal-aware retries,
verify-then-retry), while the prose narrative is current. The table and the
inventory are the two stale artifacts; the narrative is the source of truth.

## 5. What to do next (and what not to do)

Rule from the previous turn holds: prioritize **execution → verification →
recovery → reliability** over UI/telemetry/feature surface. No new major
feature phase until the loop debt is paid.

### Move 1 — typed, validated config (smallest, highest leverage)
Replace `loadConfig(): any` with a typed `HermesConfig` + a hand-rolled
validator (the codebase already avoids new deps; no zod). Every engine knob
gets a type; a typo becomes a load-time error, not a silent behavior change.
Cost: one module + a smoke section. Payoff: hardens every future phase,
because every engine reads config. **Do first.**

### Move 2 — give the recovery loop to TaskEngine (completes R3)
Move Phase 10/11 recovery out of the runner and into TaskEngine's unused
`diagnose → repair → verify → retry` path: on a tool failure the engine
(configured with the ContextEngine) runs the goal-matched tests and emits
`TaskVerifying / TaskVerified / TaskVerificationFailed` itself. The mission
loop then just calls `taskEngine.run()` — one execution model, one place where
"recovery" is defined, and the start of the Phase 17 self-repair loop.
Risk: medium (behavior must stay identical; the e2e mission is the gate). This
is the natural *next* major move after Move 1.

### Move 3 — typed event→channel projection (fixes R4)
A projection table (`TaskEventName → stream-event factory`) replaces the
hand-wired approval/repo forwards, so every lifecycle event reaches web and
Telegram clients without a runner edit, and the UI surface can't drift from
the event set. Medium risk, large observability payoff (matches the
telemetry-first instinct). Can be done incrementally: introduce the table for
new events, migrate the two existing forwarders.

### Explicitly deferred (not the next moves)
- New feature phases (swarm-on-tasks, learning engine, execution scheduler as
  originally numbered) — feature drift without the config/loop foundation.
- More UI/telemetry surface — the warmth indicator was the right scope; the
  audit JSONL already covers observability.
- Merging the two event systems (TaskEventBus vs hookManager) — the bridge
  works and is cheap; a merge is churn without a user-visible win.

## 6. Verification evidence (all green at this commit)

`tsc --noEmit` clean; `smoke:baseline`, `smoke:tools`, `smoke:policy`,
`smoke:context`, `smoke:repo-index` (15 sections), `smoke:checkpoints`, and
the end-to-end `smoke:runtime` mission (`goalRetryHint: true`,
`goalVerification: true`) all pass. The reassessment above is based on reading
the engines' actual entry points and the runner's wiring at `a3cdde9`, not on
the stale Phase 0 docs — the next doc task is to refresh
`SUBSYSTEM_INVENTORY.md` and the ROADMAP table against this review.
