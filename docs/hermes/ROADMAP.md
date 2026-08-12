# Hermes Evolution — Phase Roadmap

> Controlled architectural evolution of the gitu/ASISS codebase into the Hermes
> architecture. Rule: introduce a new abstraction -> wrap the existing subsystem
> -> move one responsibility -> test -> move the next -> remove the old path.
> The system stays usable at every step; `src/agents/runner.ts` is not rewritten
> wholesale.

## Status legend

- [x] done · [~] in progress · [ ] not started

## Phases

| # | Phase | Deliverable | Status |
| --- | --- | --- | --- |
| 0 | Freeze baseline | `docs/hermes/BASELINE.md`, `AGENT_RUNNER_FLOW.md`, `SUBSYSTEM_INVENTORY.md`, `scripts/smoke-baseline.ts` | [x] |
| 1 | Canonical Task system | `src/core/task/` (types, state, events, store, engine) | [x] |
| 2 | TaskEngine ownership | AgentRunner creates a Task per mission, records tools/checkpoints/cost/progress, finalizes on every exit | [x] |
| 3 | Event system | TaskEventBus bridged to hookManager (audit + subscribers); events carry taskId/sessionId | [x] |
| 4 | ToolEngine | Extract tool dispatch from AgentRunner (`src/core/tools/`) | [x] |
| 5 | PolicyEngine | ALLOW / ASK / DENY before tool execution | [x] |
| 6 | ModelEngine | Capability/reliability/cost scoring instead of naive routing | [x] |
| 7 | ContextEngine | Budgeted relevance-based context construction | [x] |
| 8 | Repository intelligence | Symbol/file/test index for coding tasks | [x] |
| 9 | Warm index + telemetry | On-demand/event-driven index freshness, warmth audit events | [x] |
| 10 | Goal-aware retries | Failures suggest goal-matched files instead of retrying blind | [x] |
| 11 | Verify-then-retry | Goal-matched tests run before the retry; evidence fed back | [x] |
| 12 | Execution authority | Mission loop adopts taskEngine.run() (see docs/hermes/AUDIT_2.md) | [x] |
| 13 | Canonical scheduler -> Tasks | Delegation/swarm/background/scheduled all execute as canonical Tasks (Phase 13, done) | [x] |
| 14 | Unified memory | Model + catalog, episodic capture, consolidation/lifecycle, MemorySkill retrieve, learning loop — restart-recall proven (docs/hermes/MEMORY_AUDIT.md) | [x] |
| 15 | All autonomous work -> Tasks | Every origin funnels through canonical Tasks; skill creation + external research wrapped, legacy fallbacks retired (docs/hermes/AUDIT_6.md) | [x] |
| 16 | Unified AgentEngine | One engine; agents are configurations (profiles, roles, model/tool/memory policies, handoffs) — one Agent contract, one canonical execution, policies consumed by both paths, handoff enforcement, AgentRun retirement verified, permanent verification gate (docs/hermes/AUDIT_7.md) | [x] |
| 17 | Self-repair coding loop | code -> test -> diagnose -> repair -> verify with failure memory | [ ] |
| 18 | Repository intelligence | Index/symbol/dependency graphs, change-impact analysis, minimal context | [ ] |
| 19 | Verification & quality gates | Deterministic gates: lint/typecheck/tests/build/security/diff + acceptance criteria + evidence | [ ] |
| 20 | Autonomous operating system | Integration: Goal -> Plan -> Task -> Agent -> Execute -> Verify -> Repair -> Complete -> Learn | [ ] |

## Current milestone

Phases 0-7 are complete. `AgentRunner.processMessage` now creates a canonical
Task per mission (`kind: 'mission'`), advances it through the lifecycle
(CREATED -> ANALYZING -> PLANNING -> EXECUTING), records tool executions
(ToolStarted/ToolCompleted/ToolFailed), automatic workspace checkpoints, token
cost and progress, and finalizes it on every exit path (success -> COMPLETED;
blocked / step-limit / thrown errors -> FAILED) via try/finally. Existing
behavior is unchanged: the engine only records, it does not execute. Verified
end-to-end by `scripts/smoke-agent-runtime.ts`. Phase 3 is also done: the
task-hooks bridge (`src/core/task/task-hooks-bridge.ts`) auto-subscribes the
process-wide TaskEventBus and forwards every task/tool lifecycle event onto
hookManager (extended HookEventName union), so telemetry/recovery/audit observe
the canonical Task system without AgentRunner wiring anything. Phase 4 is
also done: `src/core/tools/` now owns the whole tool lifecycle (result types,
registry catalog, name normalization + alias resolution + fallback chains,
argument validation, authorize/policy, execution with automatic checkpoints and
semantic fallback, and telemetry/task recording). AgentRunner's
`executeToolCall` and `normalizeToolCall` are thin delegations into
`ToolEngine.execute`; the old static helpers (resolveToolAlias,
resolveFallbackSkills, adaptFallbackArgs, closestToolNames) are deleted.
Verified by `scripts/smoke-tools.ts` (7 lifecycle sections) and by the
end-to-end `smoke-agent-runtime` mission running through the new pipeline.
Phase 5 is also done: `src/core/policy/` now owns authorization. The
PolicyEngine evaluates every tool request through composable rules
(workspace-guard, allow/deny lists, agent permissions, destructive-command,
secret-scan, network-tools, file-writes, elevated-command) and returns an
ALLOW / ASK / DENY verdict with per-rule checks and a risk score for
observability. ASK verdicts resolve through an approval handler (engine-level
or per-call) with a configurable default outcome. The DEFAULT configuration is
pure allow mode — every rule defaults to 'allow' and unresolved ASKs default
to allow — so adopting the engine changed nothing in production; the Phase 4
workspace guard and allow/deny lists moved into the engine with identical
scope (native tools). ToolEngine now runs the PolicyEngine for every tool
before execution and attaches the full verdict to denied results. The ASK path
is finished too: `ApprovalCoordinator` (`src/core/policy/policy-approval.ts`)
turns an ASK verdict into a real user decision — it emits `ApprovalRequired`
on the TaskEventBus (forwarded to hookManager audit and, via AgentRunner, to
the session's gateway as `approval_required` stream events), waits for the
user, and on Allow/Deny emits `ApprovalGranted`/`ApprovalDenied` plus a
decision record on the canonical Task. The web channel routes
`approval_response` payloads back into the coordinator, and the UI renders an
approval card with Allow/Deny buttons; unresolved requests fail closed after
10 minutes. Verified by `scripts/smoke-policy.ts` (15 sections) and by all
prior smokes unchanged.
Phase 6 is also done: `src/core/model/` provides a task-aware `ModelEngine`.
It profiles the active canonical Task and scores routable providers by
capability fit, observed model reliability, observed tool-call success, context
fit, latency, and actual CostTracker history. Its lightweight durable metrics
are stored locally in ignored `model_metrics.json`. Explicit ModelRouter rules
remain hard user overrides, but empty level rules now use ModelEngine rather
than a first-match provider. AgentRunner records the selected provider and the
explainable score on the Task, and feeds model/tool outcomes back into the
engine; resilient providers expose which provider actually fulfilled the call
so performance is attributed accurately. Verified by
`scripts/smoke-model-engine.ts` and the end-to-end runtime smoke.

Phase 7 is also done: `src/core/context/` owns budgeted, relevance-based
context construction (relevance scoring, token budgeting with priority
trimming, injectable summarizer with cache, on-demand repository indexing that
surfaces goal-matched files, and a builder that assembles history / decisions /
project / repository / tools / notes into one observable ContextPackage).
AgentRunner's history renderer now delegates to the engine's `renderHistory`
(byte-identical output — the e2e runtime smoke passes unchanged), and an
opt-in repository section (`agent.context.repository.enabled`) surfaces the
files most relevant to the goal. Verified by `scripts/smoke-context.ts`
(7 sections) and all prior smokes.
Phase 8 is done: `src/core/context/repo-index.ts` builds a persistent,
symbol-aware repository index on top of Phase 7's on-demand index. For each
source file it extracts symbols (functions/classes/interfaces/types by
language family), imports (a module graph), and test/config classification,
then persists the index under the standard data root (`repo-index/<hash>.json`)
and refreshes it incrementally — only files whose mtime/size changed are
re-parsed, and vanished/new files are dropped/added. ContextEngine now prefers
the persistent index by default (load -> refresh -> save, corrupt files
rebuild; `repository.persistent: false` restores the lightweight walk), and
`matchBySymbols` resolves goals to files via path + symbol + import signals
with test/config bonuses ("fix authentication" -> src/auth/auth.ts and
tests/auth/*; "add tests" surfaces test files; "docker deploy" surfaces
Dockerfile). The repository section now also renders a per-goal
"Files relevant to the current goal" hint each turn, driven by the same
`agent.context.repository` config (`goalHints.enabled: false` opts back into
the plain path list): symbol/test/config reasons per file, powered by a
stem-aware matcher ("authentication" hits `authenticate`/`auth`) and gated so
unrelated goals inject no noise. Verified by `scripts/smoke-repo-index.ts`
(9 sections: extraction, imports, classification, full index, symbol
matching, disk round-trip, incremental refresh, engine integration, goal
hints) and all prior smokes. Symbol references now also resolve
directly through the index's exportedSymbols map ("fix authenticate()" ->
src/auth/auth.ts, exact + case-insensitive) via `ContextEngine.resolveSymbols`,
and a `symbol` skill answers "where does this symbol live?" with the defining
files, kinds, and lines.
Phase 9 is done: the index stays warm on demand. `ContextEngine.refreshRepository`
re-runs the Phase 8 incremental refresh (only changed files re-parsed, then
re-saved) or rebuilds the lightweight index, throttled per root (default 5s,
`repository.warm.throttleMs`, fully off via `repository.warm.enabled: false`,
bypassed with `{ force: true }`). AgentRunner warms the workspace before
rendering the repository section each turn, and the symbol skill force-warms
before every explicit query, so /symbol never answers from a stale index.
Verified by `scripts/smoke-repo-index.ts` (11 sections: + warm refresh,
throttle, force, opt-out, lightweight rebuild, skill self-refresh).
Phase 9 telemetry is in: every index refresh records warmth per root
(lastRefreshedAt, filesReParsed, symbolsRefreshed, fileCount, sessionId,
taskId) and emits a `RepositoryIndexRefreshed` TaskEvent — auto-forwarded to
the hook audit by the Phase 3 bridge, opt-out via
`repository.telemetry.enabled: false` — so audit can tell whether a recovery
decision was made against a fresh index. `ContextEngine.indexWarmth(root)`
exposes the snapshot. Verified by smoke:repo-index section 12.
Event-driven warming is in: `warmOnToolEvents` subscribes to the TaskEventBus
and refreshes a workspace root's index (debounced, default 500ms) as soon as a
mutating tool completes or fails — apply_patch, shell, file writes — so symbols
stay fresh between turns instead of only at the next prompt build. AgentRunner
attaches one watcher per session when the repository section is enabled.
Verified by smoke:repo-index section 13 (non-mutating tools ignored,
ToolFailed warms, unsubscribe stops).
Phase 10 is done: goal-aware retries. When a tool call fails inside the
mission loop, `injectGoalRetryHint` queries the (now trustworthy) repository
index for the files matched by the goal and adds a `goal_retry_hint` system
memory naming them, so the model's retry is targeted instead of blind —
gated by the same `agent.context.repository.enabled` config, deduped per
session, advisory-only. The e2e runtime smoke now asserts the hint fires on
the failed verification step and names the goal-matched file. With the index
fresh (Phase 9 warm + telemetry) and failures now carrying file suggestions,
recovery decisions are both observable and targeted.
Phase 11 is done: verify-then-retry. On a tool failure the runner now finds
the goal-matched test files in the index (tests the goal surfaces directly
plus sibling tests of the matched sources, cross-language, signal-gated so
depth-bonus noise never drags unrelated tests in), detects the runner
(node:test / vitest / jest / pytest / unittest / go — dependency-checked),
and runs ONLY those files with a timeout, feeding the output back as a
`goal_verify_output` memory before the retry. Bounded (45s timeout, 4k
output cap), advisory-only, opt-out via `verifyOnFailure.enabled`. Verified
by smoke-repo-index section 14 (stems, matching, detection, passing +
failing runs) and the e2e runtime smoke (the failed verification step now
runs the sibling `node --test` and records `exit 0` in context).
The warmth skill (`/warmth`, `WarmthSkill`, capability `index_warmth`) is
done: it reports per-workspace freshness (fresh / recent / stale /
never_warmed), last-refresh age, file/symbol counts from the Phase 9
warmth snapshots, and a `refresh` action that forces the incremental
re-index — so Hermes can reason about its own repository intelligence.
The web UI now shows a subtle Repository indicator in the sidebar: a
green/amber/red dot for freshness, last-refresh age, files/symbols
re-parsed per refresh (from `RepositoryIndexRefreshed` events forwarded
as `repository_refreshed` stream events), and a ⟳ button that requests an
on-demand refresh through the socket (`repo_refresh` → runner
force-warm). Verified by smoke-repo-index section 15 and the e2e runtime
smoke.
Architecture reassessment is done: `docs/hermes/ARCHITECTURE_REVIEW.md`
documents the five engines, their composition, strengths, seven ranked
gaps (runner as orchestrator, untyped config, two execution models,
hand-wired projections, config-less runner ContextEngine, state sprawl,
doc drift) and the agreed next moves: typed validated config first, then
recovery moved into TaskEngine, then a typed event-to-channel projection.
The phase table above is stale (Phase 8 shipped; rows 9-11 renumbered) and
is the next doc task.
Review Move 1 is done: typed, validated config. `src/core/config.ts`
provides `validateConfig` / `strictValidateConfig` / `loadHermesConfig`.
Engine sections are validated at load — `policy` and `agent.context`
STRICT (unknown keys error and are stripped), `agent` and `checkpoints`
permissive (engine knobs type-checked, other keys pass through), all other
sections untouched. A typo (`policy.destructivCommands`) is now a named,
loud error listing the exact key instead of a silent behavior change, and
the runner's `loadConfig()` + `new ContextEngine()` now use the validated
config (fixes the two-sources-of-truth risk R5). Verified by
`scripts/smoke-config.ts` (`npm run smoke:config`, 9 sections) and the e2e
runtime mission (behavior unchanged).
Review Move 2 is done: one recovery authority. `TaskEngine.diagnose`
(EXECUTING -> VERIFYING -> EXECUTING) is now the canonical in-mission
recovery path: it runs an injected diagnoser, records every goal-matched
test run as TaskVerification evidence, emits TaskRetrying/TaskVerifying/
TestStarted/TestPassed/TestFailed/TaskVerificationFailed/TaskRecovered,
bumps attempts, and never throws. AgentRunner's Phase 10/11
injectGoalRetryHint now only wires the repository diagnoser
(ContextEngine + verify-then-retry) and renders the engine's diagnosis
into context — the runner no longer defines recovery semantics. The
mission loop remains the driver (model turns); recovery authority is the
engine's, which is the foundation for adopting taskEngine.run() later.
Verified by smoke-repo-index section 16 (events, records, transitions,
diagnoser-failure survival, terminal no-op, end-to-end repository
diagnoser) and the e2e runtime mission now asserting the canonical Task
carries unit verification records and bumped attempts.
Review Move 3 is done: typed event-to-channel projection.
`src/core/task/task-event-projection.ts` replaces the runner's hand-wired
forwards with one typed table (`TaskEventName -> stream-event factory`):
approvals (required/granted/denied), repository warmth, and the Move 2
recovery events (one compact `recovery` stream type, stage-discriminated
for verifying/verified/verification_failed/test_passed/test_failed).
Events without a projection are explicitly absent from the table and
simply not routed; adding a TaskEventName grows the table type so hosts
must decide. AgentRunner now just calls `installTaskEventProjections(this
.gateway)` — no per-event forwarder edits. Verified by smoke-repo-index
section 17 (approval/warmth/recovery routing, unprojected events ignored,
unsubscribe) and the e2e runtime mission (behavior unchanged).
All three review moves are done. Next: the second architecture audit —
verify single-source-of-truth per concern (Task/Context/Tools/Policy/
Models/Events/Repository/Recovery/Verification/Checkpoints/Memory/
Learning/Telemetry), consolidate any remaining duplicate, then decide the
next phase. GoalEngine stays a design decision for that audit, not a new
abstraction now.
Audit 2 is done (`docs/hermes/AUDIT_2.md`): single-source-of-truth per
concern verified — Tools/Policy/Models/Events/Repository/Recovery/Verification
are each single-authority after Moves 1-3; remaining duplicates are D1
(prompt assembly not in ContextEngine.build), D2 (legacy task-context
coexists with the canonical Task), D3 (runner's direct hook emits vs the
bus bridge for the tool lifecycle), plus the deferred pre-existing
managers (memory/learning/checkpoints/telemetry). GoalEngine deferred.
Next phase decided: **Phase 12 — Execution authority** (fold task-context
into TaskEngine, wire ContextEngine.build into the mission prompt, route
the tool lifecycle through the bridge alone, then adopt taskEngine.run()
for missions).

**Phase 12, D2 — task-context folded into the canonical Task (done).**
`src/core/task-context.ts` (and `current_task.json`) deleted. The legacy
surface is re-implemented as `TaskMemory` (`src/core/task/task-memory.ts`)
on top of TaskEngine: kind `resume` tasks own the tracked goal, context
points become kind-`context` artifacts, legacy statuses map to the state
machine (in-progress/paused/completed), recents are terminal tasks, and
`summaryPrompt()` renders the exact legacy `## Current Task (Resume)`
block from the Task record. The runner's `getSummaryPrompt()` and the
`task_memory` skill now read TaskEngine (via `taskMemory`); the baseline
smoke asserts the summary matches the legacy format and that
`current_task.json` is never written. Determinism fix: `mem.start`'s
new-task path monotonic-touches so a mission and a tracked resume created
in the same millisecond still resolve current() deterministically.
**Phase 12, D1 — mission prompt assembly is a ContextEngine call (done).**
`ContextEngine.buildMissionPrompt(input)` reproduces AgentRunner's inline
assembly byte-for-byte — base + workspace + time + user line + project +
repository (opt-in) + notes, plus the `
Conversation and current mission:`
body with the mission-marker history — while routing the same sources
through `build()` so the budgeted, sectioned pipeline genuinely
participates (sections/tokens/warnings on the returned package, without
changing default output). The runner now passes its pre-rendered
workspace/time/user/project blocks (host state) and the engine owns the
assembly + history + repository text. The warm/event-warming wiring stays
in the host. Smoke-context section 8 proves byte-identical system prompt
and body (with and without repository/notes/system-context), minimal
omission behavior, package sections, and that a tight budget never changes
the assembled prompt. The e2e runtime mission (repository enabled)
exercises the full path.

**Phase 12, D3 — tool lifecycle is bus-only (done).** The runner's direct
`before_tool`/`after_tool`/`tool_error` hookManager emits are removed —
the runner now emits nothing for the tool lifecycle. ToolEngine records
through TaskEngine, whose canonical ToolStarted/ToolCompleted/ToolFailed
events carry the full payload (arguments, output, durationMs, projectId
threaded from the host context); the task-hooks bridge forwards them to
hookManager under the canonical names AND the legacy `before_tool` /
`after_tool` / `tool_error` aliases with equivalent payloads, so audit
consumers and pre-existing hook subscribers see the same names unchanged.
Smoke-baseline section 11 asserts both canonical forwarding and the
aliases (success, failure, projectId, output, timing); the e2e runtime
mission asserts before_tool/after_tool/tool_error all arrive via the
bridge during a real mission.

**Phase 12, final step — pre-migration execution map (done, audit only).**
`docs/hermes/EXECUTION_MAP.md` maps all 22 mission-loop operations against
TaskEngine before any migration code: 11 already owned (A), 4 already
delegated to satellite engines (B: context/model/tools/checkpoints), 8 that
must stay host-side (C: streaming/UI, session memory, model client, batch
orchestration, completion + verification decisions, retry-as-loop,
repair-as-model-turn, approval, turn budgets), and **2 missing engine
capabilities (D): a multi-turn execution contract** (`run()`/`runExecution`
call the executor once and complete/fail — there is no per-turn primitive
that owns "keep looping until a verdict") **and a completion-verdict hook**
(the engine records completion but the `completionBlocked` heuristic is
host-owned). It also flags the near-misses: `taskEngine.verify` (terminal,
unused) and `taskEngine.retry` (FAILED-path, the mission never enters
FAILED mid-loop — it uses `diagnose`'s EXECUTING → VERIFYING → EXECUTING).
Recommended migration order: turn contract → completion verdict →
verify/diagnose in-loop → delegate the loop body as the executor hook, each
sliced with the e2e mission as the gate.

**Phase 12, Move 1 — the turn contract (done).** `TaskEngine.runTurn()` is
the per-turn execution primitive the execution map identified as missing.
It owns the EXECUTING -> (VERIFYING) -> EXECUTING / COMPLETED transitions
across the turns of a long-running mission; the host supplies each turn's
domain verdict (`continue` / `verify` / `complete` / `fail` / `blocked`)
plus optional tool evidence / model / progress, and the engine records it on
the canonical Task (tool STARTED/COMPLETED/FAILED, assignModel, progress)
and emits `TaskTurnStarted` / `TaskTurnCompleted` on the bus. Turns are
strictly sequential (`task.timing.turns`), READY tasks are started
implicitly, `verify` verdicts run the existing in-loop `diagnose` recovery
authority (EXECUTING -> VERIFYING -> EXECUTING with diagnosis evidence),
`complete` records the SUCCESS outcome, and `fail`/`blocked` transition to
FAILED (blocked keeps a PARTIAL outcome). The runner loop is untouched —
this is the contract the mission loop's body becomes the hook for in the
later moves. Verified by `npm run smoke:turn-contract` (8 sections: normal,
tool-producing, failed, verification-required, multi-turn continuation,
sequential enforcement, blocked, engine-owned completion) and by all prior
smokes unchanged (`smoke:baseline`, `smoke:runtime` e2e mission,
`smoke:repo-index`, `smoke:tools`).

**Phase 12, Move 2 — the completion verdict hook (done).** The runner's old
`completionBlocked` / `continuationReason` inline decision is gone. The
completion decision now lives in the turn contract: `TaskEngine.runTurn()`
accepts an optional `verdict` plus a `TaskCompletionEvidence` payload, and
when the verdict is omitted it asks its **completion-verdict hook** (per-call
via `TaskTurnRunOptions.completionVerdict`, engine-level via
`TaskEngineOptions.completionVerdict`, else rejects) "is completion allowed?"
The hook answers `continue` / `verify` / `complete` / `fail` / `blocked`; the
engine owns the resulting lifecycle transition, records the answer as a
`TaskDecision`, and surfaces the verdict `reason` on `TaskTurnResult`. The
runner now supplies the evidence (tool counts, batch failure, verification
state, forced-continuation budget, final draft) and reacts to the engine's
returned `action` — it no longer computes `missionCompleted` from its own
boolean. Constraint honored: **the decision moved, it was not duplicated** —
`rg completionBlocked src/agents/runner.ts` matches only the explanatory
comment; the verdict is a declared answer to the engine's question and the
Task's terminal state is set inside `runTurn`. The old heuristic survives as
`AgentRunner.completionVerdict()` — host domain knowledge that classifies the
goal/tool evidence and draft text — answering the engine's question, with a
task-less degraded fallback that still routes the same judgment. Verified by
`npm run smoke:turn-contract` (12 sections — 4 new: hook continue, hook
blocked on exhausted budget, hook complete, engine-level hook + guard) and by
`npm run smoke:runtime` (the 6-turn e2e mission still completes through the
moved decision).

**Phase 12, Move 3 — verify/diagnose in-loop (done).** The engine now owns
mutation/verification state and the in-loop verification decision. The host
annotates each executed tool's role via `TaskEngine.recordToolKind(executionId,
kind)` (mutation / verification / inspection), and the engine answers
`verificationPending(taskId)` — true when a successful mutation has no later
successful verification tool and no PASSED verification evidence. The runner's
lastMutationSequence/lastVerificationSequence counters now survive only as a
task-less degraded fallback (when beginMissionTask failed). The completion hook
answers `verify` (not `continue`) when the goal requires verification and the
engine reports pending; `runTurn` then runs the engine's in-loop diagnose
authority with the same repository diagnoser failure recovery uses
(`buildMissionDiagnoser`, extracted from `injectGoalRetryHint`), yielding
canonical TaskVerification evidence + TaskVerifying/TaskVerified events, and
the runner renders that diagnosis into context. The mission's
verification-pending continuations and late-failure recoveries both route
through the engine's diagnose authority. Verified by `npm run
smoke:turn-contract` (14 sections — 2 new: verify verdict runs the diagnose
authority, recordToolKind drives verification-pending) and by `npm run
smoke:runtime` (the 6-turn e2e mission still completes).

**Phase 12, Move 4a — engine-owned mission driver (done).** `TaskEngine.runMission`
now owns the mission loop shape. The host supplies one model+tool batch per
iteration via the `iterate` hook (`TaskMissionIterate`); the engine walks the
turns sequentially, enforces the budgets (`maxTurns`, `maxForcedContinuations`),
and owns every lifecycle transition through `runTurn`. The engine decides a tool
batch is not a completion point (the iteration keeps working), a no-tool draft
is asked against the completion hook, and terminal states are always produced by
runTurn's verdict switch — the engine never leaves the task in a state it did
not own. Step-limit exhaustion surfaces `stoppedByStepLimit`. Verified by
`npm run smoke:turn-contract` (15 sections — 1 new: runMission walks a tool
batch then a final answer to COMPLETED, and step-limit answers blocked) plus
`smoke:runtime` (6-turn e2e) and `smoke:baseline` still green. AgentRunner still
owns the loop body in production; Move 4b migrates it onto the driver.

**Phase 12, Move 4b — host-recorded tool handoff (done).** `runMission` accepts
`TaskMissionIteration.usedTools` so a host that already recorded its tool
executions (AgentRunner's tool engine writes ToolExecution records directly)
can mark an iteration as a tool batch without the driver re-recording `tools` —
removing the double-record hazard in the migration path. Verified by the
runMission smoke (host-recorded execution is not duplicated; the mutation kind
survives for verification-pending). `smoke:runtime` (6-turn e2e),
`smoke:turn-contract` (15), and `smoke:baseline` all green.

**Phase 12, Move 4c — migrate AgentRunner's loop body (done).** The runner's
context construction → model call → tool batch execution → tool-role recording
now runs as the `TaskEngine.runMission()` `iterate` hook. The engine owns the
sequential turn loop, lifecycle transitions, completion-verdict hook,
verification/diagnosis path, forced-continuation budget, and terminal state.
The terminal-path audit found that `blocked` is wrong for a successful
suppressed-budget final, so `TaskMissionIteration.verdict` routes that case to
engine `complete`, while a repeated failed batch routes to engine `blocked`.
Both are recorded canonical turns and preserve their user-visible final
responses. Verified by `smoke:terminal-paths`, `smoke:turn-contract`, and
`smoke:runtime`.

**Phase 12, Move 4d — strip dead loop scaffolding (done).** The runner's
`for(;;)`/inner-`for` loops, `stoppedByStepLimit`, `missionTurn`, runner-owned
completion counter, degraded task-less mission path, and finalizer are gone.
`runMission` receives the combined configured turn/auto-continue budget and
surfaces `stoppedByStepLimit`; the host's `onTurn` renders continuation evidence
and terminal UI after the engine transition. `AUDIT_3.md` records the final
execution-authority audit.

---

**Phase 13 — AgentEngine: agents as first-class workers (in progress).**

> TaskEngine owns the work. AgentEngine owns who performs the work.
> Phase 13 must not create a second execution authority — delegated
> children currently ARE one (bespoke `runChildLoop` in
> `src/skills/delegate-agent.ts` bypasses ToolEngine, PolicyEngine,
> memory, guardrails, and the canonical Task). This phase replaces the
> four overlapping agent definitions with one canonical Agent, rebuilds
> delegation/swarm on TaskEngine + AgentEngine, makes permissions
> agent-aware, and standardizes results as evidence. Step 1 audit:
> `docs/hermes/AGENT_ARCHITECTURE_AUDIT.md`. (This is the roadmap table's
> Phase 16 "AgentEngine", pulled forward into the current track.)

- [~] Step 1 — Agent architecture audit (`AGENT_ARCHITECTURE_AUDIT.md`)
- [x] Step 2 — Canonical `Agent` + unified registry over the existing
      stores (`src/core/agent/`: `agent-types.ts`, `agent.ts`-surface via
      `agent-capabilities.ts`, `agent-registry.ts`, `agent-engine.ts`,
      `agent-result.ts` + `index.ts`). Wrap-first: adapters normalize
      custom agents / profiles / swarm agents / A2A cards; stores stay
      authoritative. Selection is capability-only (no performance
      ranking); `executeTask` is a guard that refuses a second execution
      authority until Step 3 wires it onto TaskEngine. Verified by
      `npm run smoke:agent-engine` (adapters, registry, selection,
      result round-trip, guard, lifecycle) + `tsc --noEmit` clean.
- [~] Step 3 — `AgentEngine` (`agent-engine.ts`): registerAgent /
      getAgent / selectAgent / assignTask / executeTask / releaseAgent,
      execution delegated to TaskEngine
      - [x] Sub-step 1 — runChildLoop responsibility map
        (`docs/hermes/CHILD_LOOP_MIGRATION_MAP.md`)
      - [x] Sub-step 2 — `executeTask` wired onto TaskEngine as a thin
        orchestration adapter: child Tasks (`kind: 'delegation'`) under
        the parent, driven via `runMission` iterate (one model+tool batch
        per turn), model from `modelPolicy`, tool calls through ToolEngine
        with `ctx.taskId` + `ctx.agentPermissions` (agent-permissions
        policy rule now live), outcomes mapped to canonical AgentResult;
        retries are fresh child Tasks, never a second loop. Verified by
        `npm run smoke:agent-execution` (acceptance gate:
        COMPLETED+SUCCESS, turns>0, ToolExecution recorded, policy DENY
        recorded FAILED, parent subtask link, runChildLoop never
        involved) + `tsc --noEmit` clean. `runChildLoop` stays in place
        until DelegateAgentSkill rewires onto this path (sub-step 3 /
        Step 5).
      - [x] Sub-step 3 — `DelegateAgentSkill` rewired onto
        `agentEngine.executeTask`; the bespoke second execution authority
        (`runChildLoop`, `executeAllowedTool`, child prompt builders,
        child tool dispatch) is DELETED — every responsibility has an
        engine owner per the migration map. The skill keeps only request
        parsing, agent resolution (incl. ephemeral registry-born agents),
        an `agentRunManager` bookkeeping shim (child Task
        toolExecutions -> run toolCalls/messages; report normalized from
        the canonical AgentResult), and result formatting. Tool calls now
        route through the runner's ToolEngine with `agentPermissions`
        enforced; children link to the parent mission Task via the
        injected `__taskId`. Legacy `npm run smoke:delegation` migrated
        and green (single + parallel, overlap preserved, reviewPrompt
        keeps finalOutput). Parenthesis note: Step 5's "kill
        runChildLoop" is now the deletion itself — completed here.
- [x] Step 4 — Agent selection: capability matching against TaskProfile,
      performance-ranked later
- [x] Step 5 — Kill `runChildLoop`; route delegation through canonical
      Tasks (`kind: 'delegation'`) with agent policy injected via
      iterate-style handlers
- [x] Step 6 — Agent permissions: feed `agentPermissions` into the
      existing dead rule (`policy-rules.ts:152-165`); PolicyEngine stays
      the single ALLOW/ASK/DENY authority
- [x] Step 7 — ModelPolicy: agent-width pin over ModelEngine's
      task-shaped scoring
- [x] Step 8 — Canonical `AgentResult` (status, findings, evidence,
      artifacts, recommendations, confidence, unresolvedQuestions) mapped
      to/from `AgentTaskReport`, registered as task artifacts
- [x] Step 9 — Rebuild swarm on AgentEngine (assigned child Tasks,
      selected workers); background goals adopt canonical Tasks
      (`kind: 'background'`)

**Phase 13, Steps 4-8 done.** Step 4: TaskProfile-based eligibility selection
(`src/core/agent/task-profile.ts` + AgentEngine's `candidatesForProfile` /
`selectForProfile` / `selectForTask` / `selectForTaskId`). Selection answers
"WHO CAN do this job?" through capability + role + task-scope + tool-grant +
permission + workspace filters with a deterministic coverage/name tie-break and
NO performance ranking. `profileFromTask` adapts a canonical Task (goal, kind,
workspace, allowed tools, model pin, constraints); the `exclude` filter lives in
the options argument (`SelectForProfileOptions`), never as a positional
parameter. Verified by `npm run smoke:agent-task-profile` (9 sections: goal
hints, role, scope, required tools + deny/allow lists, workspace grants,
selectForTask/TaskId, coverage tie-break, exclude + no-match) and `tsc --noEmit`.
Step 5 (delegation on canonical Tasks, `runChildLoop` deleted) and Step 6
(agent-permissions rule live through ToolEngine -> PolicyEngine, denied calls
recorded FAILED) were completed inside Step 3's sub-steps and are now marked
done. Step 7 gap-fill: AgentEngine's child mission now honors the full
`AgentModelPolicy` — the pinned `modelId` first, then `fallbackModelIds` in
order via a minimal `AgentModelFallback` chain (no second authority; cooldowns
stay in ResilientModelProvider on the main mission path). Step 8 gap-fill: the
canonical AgentResult is registered on each child Task as a task artifact
(`recordArtifact`, kind `agent-result`, summary + full data). Both verified by
new smoke:agent-execution sections (fallback completion via a failing pinned
model, artifact presence) plus all prior smokes unchanged.

**Step 9, sub-step 1 — swarm jobs are canonical Tasks (done).** Swarm execution
already routed through `delegate_agent` -> AgentEngine.executeTask; the runner's
swarm executor now passes `__kind: 'swarm'`, the skill threads it through the new
`ExecuteTaskOptions.kind` (default `delegation`), so every swarm job runs as a
canonical kind-'swarm' child Task under the parent mission — engine-owned turn
loop, verdicts, policy, checkpoints, telemetry — while `swarm_data.json` stays
authoritative for swarm-level statuses/results. Verified by smoke:agent-execution
(kind-'swarm' child Task, COMPLETED + SUCCESS) and all prior smokes unchanged.

**Step 9, sub-step 2 — background goals are canonical Tasks (done).** The
runner's background goal executor now routes every goal through
`AgentEngine.executeTask` as a canonical kind-'background' Task: it selects a
worker via `selectForProfile` (capability hints from the goal + task-scope
'background', falling back to a registered ephemeral Background Worker agent
with the full native tool surface), runs the goal prompt through the
engine-owned child mission (turn loop, policy, checkpoints, telemetry), and
links the canonical Task id back onto the goal record
(`metadata.canonicalTaskId`) so background_goals.json consumers can trace
statuses to the canonical Task — background_goals.json stays authoritative for
statuses (the worker still owns in-progress/completed/failed/retry
transitions). `ExecuteTaskOptions.metadata` carries host linkage
(`backgroundGoalId`) onto the child Task. On any failure the executor falls
back to the legacy mission-loop path so background work never drops; the
learned-skill-creation path is unchanged. Verified by smoke:agent-execution
section 6 (kind-'background' child Task + linkage metadata),
smoke:agent-task-profile (background task-scope selection), and all prior
smokes unchanged.

**Step 9.3 — scheduled jobs are canonical Tasks (done).** Audit first
(`docs/hermes/SCHEDULER_MIGRATION_MAP.md`): the scheduler is a WHEN-only
trigger — it already delegates execution to TaskEngine via processMessage, so
it is not a second execution authority. The gaps were the task kind (scheduled
work recorded as 'mission' while kind 'scheduled' sat unused), no worker
selection (WHO), and no job linkage. The runner's scheduler onRun now runs each
job through `AgentEngine.executeTask` as a canonical kind-'scheduled' Task:
worker via `selectForProfile` (prompt hints + task-scope 'scheduled', falling
back to an ephemeral Scheduled Worker agent), `metadata.schedulerJobId` /
`schedulerJobType` linkage on the child Task, and the completed result
delivered back into the job's session. Scheduler semantics are preserved
byte-for-byte: timing, scheduler.json persistence, cancellation, no retries
(`retries: 0`), and an explicit in-flight overlap guard — a tick whose
previous run is still executing is skipped and re-armed (bumping `skippedRuns`,
so the cadence shifts instead of overlapping; the recurring path was already
serial by construction, the guard hardens `start()`-re-entry and future
re-arm paths). On any failure the legacy mission path takes over.
`AgentTaskScope` gained 'scheduled'. Verified by smoke:agent-execution
section 7 (kind-'scheduled' child Task + linkage),smoke:agent-task-profile (scheduled task-scope selection), `smoke:scheduler` (overlap guard), and all
prior smokes unchanged.

**Phase 13 closeout — Audit 4 (done, `docs/hermes/AUDIT_4.md`).**
Single-source-of-truth verified across the migrated work origins: every one
executes as a canonical Task through AgentEngine.executeTask (single HOW), the
scheduler/worker are WHEN-only triggers, and worker selection is engine-owned
where it applies (background/scheduled via selectForProfile; swarm uses
explicit store agents by design). One duplicate consolidated (S1): the swarm
store could not be traced to its canonical child Tasks — delegate_agent now
surfaces `canonicalTaskIds` on its result and the runner's swarm executor
records them on the swarm agent (`SwarmAgent.canonicalTaskIds`, persisted to
swarm_data.json), closing the linkage gap that background
(`canonicalTaskId`) and scheduled (`schedulerJobId`) already had. Verified by
smoke:delegation (canonical child id surfaced + kind-'delegation' task
resolves). Deferred: agentRunManager shim consumers (S4), store statuses vs
Task status by design (S2), store path sprawl (S5).

**Phase 13 closeout — Audit 5, `agentRunManager` removed (done,
`docs/hermes/AUDIT_5.md`).** Pre-removal dependency audit first (documentation
only): every `agentRunManager` responsibility classified as canonical
Task/TaskEvent functionality — run bookkeeping (child Task
outcome/status/timing), tool records (`Task.toolExecutions`), review prompt
(render from child Tasks), project-manager reports (TaskEngine query), report
types + adapters (already adjacent to AgentResult). Verdict: purely
compatibility bookkeeping, no genuinely missing functionality. Removal:
`src/core/agent-run-manager.ts` (and `agent_runs.json` writes) deleted.
`AgentTaskReport` / `AgentToolCallRecord` moved into `agent-result.ts`;
`taskReportFromOutcome` normalizes a child Task's stored outcome.result;
`renderDelegationReports` / `delegationTasksForSession` produce the identical
"Agent Delegation Reports" block from canonical Tasks (kinds
delegation/swarm/background/scheduled, newest first). delegate_agent now
adapts the report from the canonical AgentResult with toolCalls read from the
child Tasks' toolExecutions and the report's taskId being the canonical child
Task id (real linkage instead of the manager's synthetic id); the runner's
workspace context and the delegate result's reviewPrompt render from
TaskEngine; project-manager's `agent_run`/`agent_run_all` reports query
TaskEngine by canonical assignedAgent. `agent_runs.json` data on disk was left
untouched (runtime state; no code reads it). Verified by tsc --noEmit clean,
smoke:delegation (report taskId === canonical child id, reviewPrompt from the
child Task, toolCalls from toolExecutions, no agent_runs.json written), and
the full battery (agent-engine, agent-execution, agent-task-profile,
scheduler, runtime, baseline, terminal-paths) unchanged. No reference to
`agentRunManager` / `agent-run-manager` remains in src/ or scripts/. Withthe shim gone, every work origin executes as a canonical Task and there is no
legacy execution bookkeeping surrounding it — one execution authority, one
report shape.

---

**Phase 14 — Unified Memory (in progress, docs/hermes/MEMORY_AUDIT.md).**

> One coherent memory subsystem. The rule from Phases 12–13 applies: **no
> second memory authority.** Existing stores (MemoryManager conversation,
> LearningManager procedural rules, TaskEngine task records) stay
> authoritative; the unified layer projects a canonical `MemoryRecord` shape
> and one retrieval interface with scoring.

**Phase 14, Move 1 — MemoryRecord model + unified retrieval catalog (done).**
`src/core/memory-unified/` lands the canonical Phase 14.1 field set
(`memory-record.ts`: id `<source>:<nativeId>`, type working/episodic/semantic/
procedural/project/task, source, scope, importance 0-5, confidence 0..1,
lifecycle, createdAt/updatedAt, accessCount/lastAccessedAt, relations,
metadata) and `UnifiedMemoryCatalog` (`memory-catalog.ts`): register
providers, `records()` projection, `retrieve()` with weighted scoring
(relevance via token overlap or the source store's semanticScore, recency
exponential decay with a half-life, importance, confidence, access —
`wR .5 wA .2 wI .15 wC .1 wU .05`, overridable), budget-limited (default 5 =
"smallest useful context"), deduped by canonical id, each hit carrying a
`scoreBreakdown`. Wrap-first adapters read through MemoryManager (episodic),
LearningManager applied actions (procedural, confidence carried), and
TaskEngine/TaskMemory (working current task + episodic terminal outcomes).
MemoryManager now surfaces `id`/`session_id` on get/search rows so
cross-session results keep a stable identity (the catalog dedupes on it). The
catalog persists nothing — access stats are in-memory; durability lands with
Move 3. Verified by `npm run smoke:memory-unified` (model shape, coverage
across all three stores, ranking: the proven rule outranks the raw message,
budget cap, dedupe, access tracking) + `tsc --noEmit`; prior smokes unchanged
(baseline/runtime/agent-execution/delegation/scheduler green; the pre-existing
`smoke:learning` failure is unrelated to this move — it fails identically at
HEAD without these changes).

**Phase 14, Move 2 — episodic capture + one context section (done).**
`EpisodicCapture` subscribes to the TaskEventBus terminal events
(TaskCompleted / TaskFailed / TaskCancelled) and projects each terminal task's
outcome into a bounded (50) in-memory episode feed, deduped by task id;
failures rank importance 4 (the most valuable experience), and the summary
falls back to the recorded failure when the task has no outcome.result. The
feed is seeded from the durable TaskEngine on construction, so a restarted
process recalls recent episodes without the old process alive. The runner now
builds the catalog over conversation + learning + task (+ capture) and renders
one budgeted `Memory context (unified)` section in the mission prompt (working
task, recent episodes, proven rules — 1/3/3, advisory-only). Verified by
`smoke:memory-unified` (capture for completed + failed tasks, restart-safe
seeding, catalog exposure; smoke now isolates its Task store via
`GITU_DATA_ROOT` instead of writing into the real shared store) +
`smoke:runtime` (mission prompt with the new section) and the full regression
battery. The pre-existing per-store context blocks stay until each is proven
covered (the review prompt already moved to canonical Tasks in Audit 5).

**Phase 14, Move 3 — consolidation + lifecycle (done).**
`MemoryConsolidation` (`memory-unified/memory-consolidation.ts`) is the
consolidation/lifecycle layer over the catalog. It owns ONLY the state no
source store has — dedupe/merge results, record lifecycle, feedback-driven
promotion, durable access stats — persisted as a per-record overlay
(`memory/memory_lifecycle.json` under the data root, atomic tmp+rename);
content stays in the source stores, so there is still exactly one content
authority per source and one lifecycle authority here. Dedupe by canonical
id; near-duplicates (same source+type+normalized content, knowledge sources
only — conversation is excluded) keep the stronger record and archive the
weaker with `supersededBy`, the survivor carrying `mergedFrom`; fresh
low-importance records start `candidate`; `recordAccess` (≥3) or success
feedback (importance +1, confidence +0.1 — the LearningManager feedback loop
generalized to records) promotes candidate -> active; stale records expire
after the TTL (180 days, clock injectable); `retrieve()` excludes
archived/expired. The runner's mission-prompt memory section now reads
THROUGH the consolidation layer, so dedupe/merge + lifecycle apply to what
the model sees. Verified by `smoke:memory-unified` (dedupe-by-id, merge with
archived superseder, promotion by access and by feedback, TTL expiry,
overlay persistence across save/load, retrieval excluding archived/expired)
+ `tsc --noEmit` and the full regression battery (runtime/baseline/
delegation/agent-execution/scheduler green).

**Phase 14, Move 4 — MemorySkill canonical retrieve (done).**
`MemorySkill` gains the `retrieve` action — one retrieval entry point over
the unified layer (consolidation when wired, else the catalog) —
understanding query, sessionId, source, types, limit, minScore,
minImportance, minConfidence, and taskId filters, and returning unified
records with a `scoreBreakdown`. The breakdown now surfaces both relevance
sources (`semantic` embedding similarity when the store computed one, else
`lexical` token overlap) plus recency/importance/confidence/access, so
retrieval behavior is inspectable. `search` and `semantic_search` are thin
delegates over the same path (legacy row shape preserved, `unified: true`
marker, mode keyword or semantic|lexical with a reason), falling back to the
legacy MemoryManager paths when no unified layer is wired; `get_recent` stays
a raw session-history read. The runner passes its catalog + consolidation
into the skill, and its own prompt-memory section already reads through the
same canonical layer — one retrieval path everywhere. Verified by
`smoke:memory-unified` (retrieve with filters + breakdown keys, delegated
search rows in legacy shape, lexical semantic mode, bare-skill fallback) +
`tsc --noEmit` and the full regression battery.

**Phase 14, Move 5 — learning loop (done).** `TaskLessonBridge`
(`memory-unified/lesson-capture.ts`) subscribes to the TaskEventBus terminal
events and queues a self-review per task outcome via the new
`LearningManager.queueTaskReview()` — engine-driven work (delegation, swarm,
background, scheduled, mission) enters the same approval pipeline as
interactive lessons; `processNextReview` prompts over the canonical Task
(goal/status/outcome) and the extracted lesson flows queue → approval →
applied → retrievable unified-memory record (`taskOutcomeSummary` shared
with the episodic capture so both views read the same evidence). The runner
wires the bridge next to the episodic capture. **Phase 14 acceptance
verified end to end:** the smoke completes a task, runs the full loop, then
simulates a restart with FRESH instances over the same data root (new
TaskEngine/LearningManager/MemoryManager/catalog/consolidation) and
retrieves both the terminal episode and the approved lesson — knowledge
recalled without the old process alive. Verified by `smoke:memory-unified`
(review queued, lesson extracted, approved + applied, live catalog exposure,
restart episode/lesson/retrieval) + `tsc --noEmit` and the full regression
battery.

**Phase 14 moves complete** (model + catalog, episodic capture, consolidation
+ lifecycle, MemorySkill retrieve, learning loop). The memory subsystem now
has one canonical record shape, one retrieval interface, one consolidation/
lifecycle layer, and the learning loop — with the restart-recall acceptance
criterion proven. Remaining 14.x polish (retrieval quality tuning,
project-scoped memories, deeper consolidation heuristics) is tracked as
post-Phase-14 improvements; the next phase on the roadmap is **Phase 15 —
all autonomous work flows through canonical Tasks** (heartbeats, recurring
work, autonomous goals, retry/resume on the canonical Task lifecycle,
removing duplicate autonomous-work managers).

**Phase 15, Move 1 — audit + consolidate the last straggler (done,
docs/hermes/AUDIT_6.md).** The audit mapped every autonomous work origin
against the canonical Task lifecycle: mission/delegation/swarm/background/
scheduled all funnel into TaskEngine (via `AgentEngine.executeTask` or the
mission loop, which creates canonical `kind: 'mission'` Tasks); the heartbeat
and proactive engine are WHEN/advisory-only; retry/resume is engine-owned
(`TaskEngine.diagnose`/`retry`/`resume`); store statuses remain authoritative
with canonical linkage (by design, Audit 4 S2). One straggler remained:
learned-skill-creation goals executed through
`LearningManager.executeSkillCreationGoal` OUTSIDE the lifecycle — no Task,
no events, no evidence. Consolidated: the runner's background executor now
wraps skill creation in a canonical `kind: 'background'` Task
(`runSkillCreationGoalViaEngine`: create → analyze → plan → start →
workflow-as-execution → complete with evidence; on failure `failTask` for
evidence + rethrow so the goal store's retry/status authority decides).
`goal.metadata.canonicalTaskId` links the goal record. Verified by
`smoke:learning` (canonicalSkillCreation: goal linkage → COMPLETED → result
evidence; smoke isolated via `GITU_DATA_ROOT`) + `tsc --noEmit`; the full
battery unchanged. **Every work origin now produces a canonical Task.**

**Phase 15, Move 2 — external research wrapped; fallbacks retired (done).**
`LearningManager` gains an optional `taskEngine` (runner wires it); each
external-research topic runs inside a canonical `kind: 'background'` Task
(`source: 'external-learning'` + `topicQuery`) with the entry title/summary as
evidence, or `failTask` on error (legacy direct path when no engine wired).
The legacy mission-loop fallbacks are retired from BOTH the background
executor and the scheduled `onRun`: failed engine executions leave terminal
canonical evidence (`failCanonicalTasks` fails any non-terminal child Task),
the background worker's retry/status authority decides goal outcomes, and the
scheduler now RECORDS failures on the job (`lastError`/`failureCount`/
`lastFailedAt`, persisted) instead of swallowing them (`catch {}`). These
were the last two call sites routing autonomous work through the interactive
loop as a fallback; the loop remains the host-driven interactive driver.
Verified by `smoke:learning` (canonicalExternalResearch: research Task
COMPLETED with evidence, stubbed model/web skills — no network) +
`smoke:scheduler` (new section: a throwing `onRun` records failureCount /
lastError / lastFailedAt and persists; one-shots still disable) + `tsc
--noEmit`; the full battery green. **Phase 15 complete: every autonomous work
origin — mission, delegation, swarm, background, scheduled, skill creation,
external research — funnels through the canonical Task lifecycle, with one
WHEN authority per trigger and store statuses authoritative via canonical
linkage.**

**Phase 16 — Unified AgentEngine (in progress, docs/hermes/AUDIT_7.md).**

> Task = what work needs to happen; AgentProfile = how this kind of agent
> behaves; AgentEngine = who performs the work and how that execution is
> configured. One engine, one contract; policies are configurations, not
> separate systems.

**Phase 16, Move 1 — Agent Execution Authority Audit (done, docs only).**
Mapped every agent execution path (mission loop, delegation, swarm,
background, scheduled, skill creation, external research, tool execution,
model invocation) with the who-owns matrix (create/lifecycle/model/context/
tools/failure/retry/persist/events/cancel). Already unified and preserved:
`TaskEngine.runMission` is the one lifecycle driver, `ToolEngine.execute` the
one tool execution mechanism, one `TaskEventBus` + hooks bridge, WHEN-only
triggers (Phase 15), and `agentRunManager` deleted (Audit 5, zero references).
Findings: **D1** — the swarm executor's non-delegate branch runs a bare
`model.generate` with no Task/evidence (remove); **D2** — two context
authorities (rich ContextEngine mission prompt vs flat AgentEngine child
prompt — consolidate via contextPolicy); **D3** — two model-selection paths
(router/engine vs agent modelPolicy — one ModelPolicy contract); **D4** — two
tool-selection paths (single ToolEngine execution, split selection policy);
**D5** — no memory injection into child missions (Phase 14 unified memory
reaches agents via memoryPolicy); **D6/D7** — retry layering by design;
streaming deferred. Agent contract gap: `Agent` lacks contextPolicy /
memoryPolicy / handoffPolicy / executionLimits / instructions; decision is to
keep **Task-as-run** (no new AgentRun record — avoids re-introducing the
bookkeeping Audit 5 removed). **Next: Move 2** — extend the Agent contract;
**Move 3** — canonical execution (remove D1, mission resolves the default
profile through the same contract); **Move 4** — policies; **Move 5** —
handoffs; **Move 6** — AgentRunManager retirement check; **Move 7** —
verification.

**Phase 16, Move 2 — extended Agent contract (done, docs/hermes/AUDIT_7.md §4).**
The canonical `Agent` (agent-types.ts) gains the five missing fields:
`instructions` (explicit imperative operating rules, rendered into the child
system prompt AFTER persona so they win conflicts), `contextPolicy` (enabled
context sources task/instructions/repo/memory/history/attempts + assembly
budget), `memoryPolicy` (unified-memory retrieval/injection: injectLimit /
minScore / minImportance / types / sources — children default to no
injection, D5), `executionLimits` (maxTurns / maxAttempts / maxOutputTokens /
timeoutMs / maxContextChars), and `handoffPolicy` (allowDelegation /
allowedRoles / maxDepth, enforced in Move 5). Every wrapped agent
(custom/profile/swarm/A2A) and every registry-born agent now carries a
complete contract — adapters fill defaults (`contextPolicy.sources =
task,instructions`, `memoryPolicy.injectLimit = 0`, delegation allowed,
A2A cards disallow delegation), `register()` accepts the full AgentInput.
**Task-as-run is kept and documented in the contract header**: the run IS the
child canonical Task + assignedAgent + registry status projection — no
AgentRun record, so Audit 5's removed run bookkeeping cannot re-materialize.
Two wirings make the contract live now (the rest land in Moves 3-5):
`executeTask` falls back to `executionLimits.maxTurns` / `maxAttempts` when
callers don't override, and `instructions` render in the child system prompt.
Verified by `smoke:agent-engine` section 7 (defaults on wrapped agents,
full-contract register + storage, executionLimits.maxTurns feeding the child
mission budget, instructions in the child system prompt, one child task =
one run) + `tsc --noEmit`; the full battery green (delegation ×2,
agent-execution, agent-task-profile, runtime, baseline, scheduler,
memory-unified, learning).

**Phase 16, Move 3a — swarm fragment (D1) removed (done).** The swarm
executor's non-delegate branch is DELETED: when `delegate_agent` is
unavailable it no longer runs a bare `model.generate(prompt,
this.baseSystemPrompt, [])` (no Task, no ToolEngine, no events, no evidence)
— it logs loudly and throws `delegate_agent skill is unavailable — cannot run
swarm agent … outside the canonical Task lifecycle`, and the swarm store's
`runAgent` catch marks the task `failed` with that message (swarm_data.json
stays authoritative for swarm statuses, Audit 4 S2). This was the last
fragment path where agent work happened outside the canonical lifecycle; the
skill is registered unconditionally by the runner, so it was dead defensive
code that Phase 16's "no competing agent execution path" rule forbids.
Verified by `smoke:agent-execution` section 12 (throwing executor → result
`success: false` + loud message on the task, agent released from working) +
`tsc --noEmit`; the full battery green in one pass. The remaining
`model.generate` sites are non-swarm by construction (canonical mission loop,
summarization, dynamic-tool interpreter, proactive check-in, @-mention
fallback).

**Phase 16, Move 3b — the mission loop resolves a designated default
AgentProfile (done).** `AgentEngine.resolveDefaultAgent()` returns the first
AVAILABLE agent explicitly designated `metadata.default: true` (registry
order, designation-only — wrapped store agents are NEVER implicit defaults,
so production behavior is byte-identical until someone designates one). When
resolved, the host-driven mission shares the SAME contract surface as
AgentEngine children: the mission Task is created with
`assignedAgent: <default id>`, the agent's `modelPolicy.modelId` is layered
UNDER the explicit ModelRouter override as the model-selection pin (router
wins; agent pin is the width — complementary per Audit 7 D3, closing half of
the two-model-selection gap), and the agent's persona + instructions render
into the mission system prompt (persona first, instructions last so they win
conflicts). Tool/context/memory policies remain Move 4. Verified by
`smoke:agent-engine` section 8 (designation semantics) + `smoke:runtime`
e2e (mission Task assigned to the designated default, its instructions in the
system prompt, its model pin honored with selection unchanged — the default
pins the fake model) + `tsc --noEmit`; the full battery green in one pass.

**Phase 16, Move 4 — policies wired into both paths (done).** All three
remaining policies are consumed, keeping the guardrail *policy = decision,
engine = execution, store = persistence* — no new mini-engines.
**ToolPolicy (D4):** the designated default agent's `permissions` now shape
the mission's advertised tool surface — denied tools always removed, an
explicit allow list (or the agent's declared tools) intersects the surface,
`permissions.maxToolCalls` becomes the mission tool-call budget when the host
config doesn't set one; the child side already honored `agent.tools` ∩
request-allowed. **MemoryPolicy (D5):** `AgentEngineRuntime` gains a
`retrieveMemory` hook (the runner wires the Phase 14 consolidation layer);
`runChildMission` maps the child agent's `memoryPolicy` (injectLimit /
minScore / minImportance / types / sources) to a retrieval and renders a
`Memory context (unified)` section in the child system prompt — children now
receive unified memory (the audit's D5 gap), with AgentEngine ignorant of how
memory is stored. The mission side applies the default agent's memoryPolicy
as a filter on its existing unified-memory section. **ContextPolicy (D2):**
the child context assembles from `contextPolicy.sources` — task /
instructions / history are structural (task contract + loop contract, always
rendered), 'memory' gates the injection, 'attempts' feeds prior failed-attempt
outcome lines into later attempts (from the failed child Tasks); 'repo'
(deferred — needs ContextEngine in the child runtime, tracked in AUDIT_7
D2). Default context sources are task/instructions/history = today's child
context exactly (zero behavior change). Verified by `smoke:agent-execution`
section 13 (memory section + confidence in the child system prompt,
executionLimits.maxAttempts → 2 attempts, prior-outcome lines on the second
attempt), `smoke:runtime` e2e (deniedTools removed web_search from every
advertised mission surface while apply_patch + shell stayed; mission
completed), and `smoke:agent-engine` 7a (default sources); `tsc --noEmit`
clean, full battery green in one pass.

**Phase 16, Move 5 — handoffPolicy enforced (done).** Agent-to-agent
collaboration stays Task-only (Phase 15's canonical delegation), and the
`handoffPolicy` declared in Move 2 is now enforced at the single delegation
entry point — `AgentEngine.executeTask`. The delegating agent is the parent
Task's `assignedAgent`; enforcement walks the parent chain and answers:
**allowDelegation** gates delegation at all (false → refused, no child Task
created), **allowedRoles** restricts the target's role when set, and every
ancestor delegator's **maxDepth** bounds the handoff chain originating from
it (depth 1 = direct delegation, 2 = grandchild, …). Refusals return a clear
failed AgentResult naming the exact policy ('does not allow delegation',
'may only hand off to roles', 'maxDepth (1) — this delegation sits at depth
2'). Host-driven delegations (no parent, or no agent on the chain) are
unrestricted, and all registry defaults (allowDelegation true, maxDepth 3)
preserve existing behavior byte-for-byte — only explicit configuration
changes outcomes. Because every origin (delegation/swarm/background/
scheduled) funnels through executeTask, the enforcement covers all of them.
Verified by `smoke:agent-execution` section 14 (role refusal, allowed depth-1
handoff, depth-2 refusal under maxDepth 1, allowDelegation=false refusal) +
`tsc --noEmit`; the full battery green in one pass.

**Phase 16, Move 6 — AgentRunManager retirement check (done).** Audit 5's
deletion held: grep sweeps show zero `agentRunManager` references in src/ or
scripts/, no `agent_runs.json` writes anywhere, and no `AgentRun` record type
— the name exists only as the Task-as-run doc comment in agent-types.ts.
Run state lives in Task + toolExecutions + TaskEvents, with agent status a
registry projection. Two remnants consolidated: **dead analytics API removed**
— `AnalyticsTracker.recordAgentRun` (zero call sites since the runner's
delegation path stopped using it) and the never-emitted/never-consumed
`'agent_run'` AnalyticsEvent type are gone; agent-run telemetry comes from
TaskEvents via the hooks bridge, not a parallel analytics hook — and
**stale skill docs fixed** — project-manager's `agent_run` / `agent_run_all`
descriptions still claimed "AgentRunManager reports" while the
implementation had already moved to canonical delegated child Tasks
(`getAgentRunReports` → TaskEngine); they now name the canonical source. The
delegation smoke still asserts `agent_runs.json` is never written. Verified
by the sweeps + `tsc --noEmit`; the full battery green in one pass.

**Phase 16, Move 7 — end-to-end verification gate (done) — Phase 16
complete.** The behavioral matrix (docs/hermes/AUDIT_7.md §8) maps every
origin — mission, delegation, swarm, background, scheduled, skill creation,
external research — to the battery smoke that proves its contract cells
(canonical Task, resolved AgentProfile, AgentEngine path, model/tool/
memory/context policies, evidence). A permanent, comment-aware source gate
lands in the regression suite: `npm run smoke:phase16`
(`scripts/smoke-phase16.ts`, sweeps 191 TS files) keeps Gate 1 (the swarm
executor block contains no bare `model.generate` and fails loudly when
delegate_agent is unavailable), Gate 2 (all five contract fields declared),
Gate 3 (no `\bAgentRun\b` — Task-as-run), and Gate 7 (`agentRunManager` /
`recordAgentRun` / `agent_runs.json` writes at zero in src/ + scripts/,
comments and the guard file itself excluded) green forever. **Phase 16 is
complete and committed-ready**: one Agent contract (Move 2), one canonical
execution path (Move 3a swarm fragment removed + Move 3b mission default
profile), policies consumed by both paths (Move 4), handoff enforcement
(Move 5), AgentRun retirement verified (Move 6), verification gated (Move 7).
The architecture converges on: **Task = execution identity, AgentProfile =
behavior/configuration, AgentEngine = execution authority, TaskEngine = work
lifecycle authority, ToolEngine = tool execution authority, Unified Memory =
knowledge authority, TaskEvents = execution history.**


