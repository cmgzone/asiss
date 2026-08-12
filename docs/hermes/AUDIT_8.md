# Hermes Architecture Audit 8 — Self-Repair Coding Loop (Phase 17, Move 1)

> Docs-first audit for Phase 17: **code → test → diagnose → repair → verify,
> with failure memory.** Per the governing rules: TaskEngine owns the work
> lifecycle and recovery semantics; the host supplies domain evidence; there
> is exactly one execution authority (Phase 16 closed). This audit maps the
> CURRENT loop step by step, finds where the target loop's steps are missing
> or split, and proposes the smallest consolidation.

## 1. The target loop vs what exists today

| Step | Target | Current implementation | Authority |
|---|---|---|---|
| **code** | the agent writes/changes code | mission loop iterate (model + tools) | AgentEngine / mission loop (canonical Task) |
| **test** | goal-matched tests run and feed the repair | `buildMissionDiagnoser` → `runGoalTests` on FAILURE (verify-then-retry, Phase 11) | host-wired diagnoser, evidence recorded by TaskEngine |
| **diagnose** | gather recovery evidence | `TaskEngine.diagnose` (EXECUTING → VERIFYING → EXECUTING, attempts+1, TaskVerification records + TestStarted/TestPassed/TestFailed/TaskRecovered) | **TaskEngine** (Move 2) |
| **repair** | the agent repairs using the evidence | retry-as-loop: model retries with `goal_retry_hint` + `goal_verify_output` memories in context | mission loop (model-driven) |
| **verify** | the fix is verified before completing | **failure-driven only**: sequencing check (`pendingVerification` — mutation followed by a verification tool or PASSED evidence) + failure-time test runs. **No completion-driven, test-based gate.** | split: host judgment + engine state |
| **failure memory** | the loop remembers and reuses failures | Phase 14: episodic capture (terminal failed tasks → importance-4 episodes), TaskLessonBridge (lessons via approval), unified-memory section rendered into the mission prompt (episodes + proven rules); in-mission hints are session-scoped | Unified Memory (Phase 14) |

## 2. Engine-owned primitives vs what the mission actually uses

| Primitive | Declared | Used by the mission |
|---|---|---|
| `TaskEngine.diagnose` (in-loop recovery) | ✓ | **yes** — every tool failure / `verify` verdict |
| `TaskEngine.verify` (terminal: EXECUTING → VERIFYING → COMPLETED/FAILED with `TaskVerifier`) | ✓ | **never called** (only match is `crypto.verify` in skill-marketplace) |
| `TaskRepairer` hook (TaskEngineOptions + TaskRunOptions) | ✓ | invoked **only inside `retry()`** (host resume); no origin calls `retry()` or wires the hook |
| `TaskVerifier` contract (`{ passed, detail }`) | ✓ | never wired |

## 3. Findings, ranked

### F1 — the loop has no completion-driven verification gate (the biggest gap)

The target loop's **verify** step is meant to gate *completion* — "is the fix
actually good?" — but today verification only happens on *failure*:
verify-then-retry runs during `diagnose`, and the completion verdict's
`verify` answer routes to `diagnose` (non-terminal, EXECUTING → VERIFYING →
EXECUTING). Completion itself (`complete` verdict → COMPLETED) has no test
gate: the engine's `pendingVerification` is a tool-sequencing heuristic
(mutation followed by any verification tool or PASSED evidence), not a
goal-test pass. The engine ALREADY owns the terminal primitive for this —
`TaskEngine.verify` / `TaskVerifier` (EXECUTING → VERIFYING → COMPLETED or
FAILED) — it just sits unused, exactly the kind of dead contract Phase 16
Move 6 removed elsewhere. **Plan (Move 2): give the mission a terminal
verification gate** — when the completion verdict answers `verify` (goal
requires verification and the engine reports pending), run the engine's
terminal `verify()` with the goal-matched-test verifier (the same
`runGoalTests` evidence the diagnoser uses, expressed as a `TaskVerifier`).
The loop then closes as: repair attempts repeat until the tests pass
(VERIFYING → COMPLETED) or the budget exhausts (VERIFYING → FAILED →
failure memory). Verify becomes completion-driven, not only failure-driven.

### F2 — `TaskRepairer` is an unwired seam (invoked only by the engine's `retry()`)

The engine declares a `repair` hook (TaskEngineOptions/TaskRunOptions). It is
invoked exactly once in the codebase — inside `TaskEngine.retry()` (FAILED →
DIAGNOSING → REPAIRING → EXECUTING, the host resume path) — but **no origin
calls `retry()` and no production call site passes the `repair` option**; the
only exerciser is smoke-baseline's API test. Two honest options: **(a) wire
it** into the recovery path so a deterministic repairer can run before the
model retry (patch-apply style), or **(b) document retry-as-loop as the
repair authority** — the model with targeted evidence IS the repairer,
consistent with the D6 retry-layering decision — and keep the hook as the
future seam for autonomous repair engines. The audit recommends **(b)**:
introducing a second repair executor would recreate a competing authority
Phase 15/16 eliminated; the hook stays as the documented seam. **Plan (Move
3): document the decision + assert the seam stays unwired in the verification
gate. — RESOLVED (Move 3, below).**

### F3 — failure memory reaches the repair attempt (by design, done)

Phase 14 already delivers the loop's memory half: terminal failures become
importance-4 episodes; lessons flow through approval into retrievable
records; and the mission prompt's unified-memory section renders recent
episodes + proven rules, so the repair attempt sees past failures. The
restart-recall acceptance (Phase 14 Move 5) proves durability. The
in-mission `goal_retry_hint` / `goal_verify_output` memories are
session-scoped by design (they are this mission's diagnosis, not durable
knowledge). **No consolidation — verified by smoke:memory-unified +
smoke:runtime.** One enhancement noted for Move 4: the terminal-verification
FAILED path must land in the episodic capture like any other failure
(it does — TaskFailed events feed the capture).

### F4 — repair is retry-as-loop, model-driven (by design)

The repair step is the mission loop continuing with evidence in context —
bounded by runMission's maxTurns + diagnose's attempts counter. This is the
D6-layered, one-authority design; do not merge it into an engine repair
executor (see F2).

## 4. Consolidation plan (Moves 2-4)

1. **Move 2 — terminal verification gate — DONE (below).** The completion
   verdict's `verify` answer now runs the engine's gate with a
   goal-matched-test `TaskVerifier`; pass -> COMPLETED, fail -> repair
   (recover to EXECUTING) until the turn budget exhausts -> FAILED.
2. **Move 3 — repair authority documented (F2) — DONE (below).**
   Retry-as-loop is the repair authority; `TaskRepairer` stays the
   documented future seam, asserted unwired in the verification gate
   (smoke:phase16 Gate 8).
3. **Move 4 — verification**: update AUDIT_8 + ROADMAP; full battery.

## 5. Move 2 — terminal verification gate (done)

**Engine** (`task-engine.ts`): `TaskTurnRunOptions` gains `verifier` +
`maxTurns`; the `verify` verdict, when a verifier is wired (per-call or
engine-level), runs the new `runCompletionVerificationGate` — EXECUTING →
VERIFYING → verifier: **pass** -> recordVerification PASSED + TaskVerified →
COMPLETED with the verification evidence; **fail** -> recordVerification
FAILED + TaskVerificationFailed, then recover to EXECUTING (attempts+1,
TaskRetrying) while `turn < maxTurns` so the host's repair loop re-runs the
gate at the next completion point, else FAILED (terminal — feeds episodic
capture + lessons). `runMission` passes `maxTurns` into runTurn so the gate
shares the mission turn budget. Without a verifier, the `verify` verdict
keeps its Phase 12 diagnose behavior unchanged.

**Host** (`runner.ts`): `buildMissionVerifier` expresses the goal-matched
tests as a `TaskVerifier` (fail-open when there is nothing to gate on — no
workspace / no goal-matched tests / verifier error), sharing one
`goalTestEvidence` helper with the failure diagnoser so "what the goal's
tests are" has a single authority. The runner wires it into runMission. The
completion verdict logic is unchanged: `verify` still fires when verification
is pending; that answer now gates on real tests instead of only sequencing.
The gate failure reason (test output) flows into the completion-check memory
so the model's repair is targeted.

## 6. Acceptance gate (Moves 1-3)

Move 1 was documentation only. Move 2 verified by `tsc --noEmit` clean +
`smoke:turn-contract` section 16 (gate pass -> COMPLETED with a PASSED
custom verification + TaskVerified; gate fail -> repair iteration -> gate
pass -> COMPLETED with attempts bumped and FAILED then PASSED verification
records; gate fail until the budget exhausts -> FAILED with
TaskVerificationFailed + TaskRetrying + TaskFailed) + `smoke:phase16`
(phase17_gateWired: the runner passes `verifier: this.buildMissionVerifier(`
into runMission) + the full battery green in one pass (runtime included —
which caught a real regression: the `goalTestEvidence` refactor had renamed
`matchedFiles` -> `matched`, breaking the diagnose contract's retry hint;
fixed, runtime green).

Move 3 verified by `tsc --noEmit` clean + `smoke:phase16` Gate 8
(phase17_repairSeam: `TaskRepairer` exists only in task-engine.ts, no
production call site passes the `repair` option, and the hook is invoked
exactly once — inside the engine's `retry()` resume path) + the full battery.

## 7. Move 3 — repair authority documented (done)

**The decision (F2, option b).** Retry-as-loop is the single autonomous repair
authority: the mission loop continues with targeted evidence (diagnose
records, `goal_retry_hint` / `goal_verify_output`, and the Move 2 gate's test
output) — the model IS the repairer, bounded by runMission's turn budget. A
second repair executor would recreate the competing authority Phases 15/16
eliminated, so `TaskRepairer` is kept as a declared-only future seam for an
autonomous repair engine (patch-apply style).

**The seam's single invocation point.** The hook is invoked exactly once in
the codebase: `TaskEngine.retry()` (FAILED → DIAGNOSING → REPAIRING →
EXECUTING), the engine's host-driven resume path. No origin calls `retry()`
and no production call site passes the `repair` option — smoke-baseline's
no-op is the only exerciser of that API, which stays as the resume path's
test.

**Documented in the engine** (`task-engine.ts`): the `TaskRepairer` type, the
`repair` option on TaskEngineOptions/TaskRunOptions, and `retry()` itself now
carry the authority statement — retry-as-loop is the repair authority, the
hook is the seam, do not wire it outside `retry()`.

**Permanent gate** (`smoke:phase16` Gate 8): `TaskRepairer` exists only in
task-engine.ts; no `repair:` option passes at any production call site;
the hook is invoked exactly once, via `options.repair(`, inside `retry()`.
Comments are stripped so the seam's own documentation cannot trip the guard.
Phase 17 is otherwise verification-complete: F1 (Move 2), F2 (Move 3),
F3/F4 by design; Move 4 closes with the battery + this doc.
