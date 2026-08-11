# Hermes Architecture Audit 2 — Single Source of Truth

> Second audit, after the three architecture-review moves landed:
> `9162fe9` (typed config), `3ce0369` (one recovery authority), `d4c84b6`
> (typed event-to-channel projection). Verifies one authority per concern,
> consolidates what still has two competing implementations, and decides the
> next phase. No new abstraction (GoalEngine stays a design decision for a
> future audit).

## 1. What the three moves consolidated

| Move | Commit | Consolidation |
| --- | --- | --- |
| 1 — Typed config | `9162fe9` | Engine knobs validated at load (`policy`, `agent.context` strict; `agent`, `checkpoints` type-checked). A config typo is a loud, key-naming error instead of a silent behavior change. Runner `ContextEngine` now receives the validated config — the two-sources-of-truth for repository knobs (R5) is gone. |
| 2 — One recovery authority | `3ce0369` | `TaskEngine.diagnose` (EXECUTING → VERIFYING → EXECUTING) is now the canonical in-mission recovery path: records verification evidence, emits the full recovery event set, bumps attempts, never throws. The runner's Phase 10/11 recovery logic no longer defines semantics — it wires a diagnoser and renders the engine's diagnosis. |
| 3 — Typed event projection | `d4c84b6` | Hand-wired gateway forwards (approval ×3, warmth ×1) replaced by one typed table `TaskEventName → stream-event factory`. Adding an event name grows the table type; unprojected events are explicitly absent. Recovery events now stream as a compact `recovery` type. |

## 2. Single source of truth per concern

| Concern | Single source | Competing implementation remaining? | Verdict |
| --- | --- | --- | --- |
| Task state | `TaskEngine` + `TaskEventBus` | Missions are canonical Tasks. **`task-context.ts` (legacy "current task") still exists** and the runner reads `taskContext.getSummaryPrompt()` (runner:837); the `task-memory` skill uses it. | **~ duplicate — consolidate (D2)** |
| Context | `ContextEngine` | History rendering + repository section + goal hints are engine-owned. **Full prompt assembly is still inline in the runner** (`baseSystemPrompt` + workspace/time/project/user injections); `contextEngine.build()` is never called by the mission loop. | **~ split — consolidate (D1)** |
| Tools | `ToolEngine` | Every tool call goes through `toolEngine.execute`; `executeToolCall` is a thin delegator. | ✓ single |
| Permissions | `PolicyEngine` | Tool authorization is engine-owned. `workspaceManager.assertAllowed`, `guardrails`, `trustedActions` are complementary input/output layers, not competing tool authorization. | ✓ single |
| Models | `ModelEngine` | Scoring is engine-owned; `ModelRouter` explicit rules are hard overrides by design. | ✓ single |
| Events | `TaskEventBus` | Lifecycle/tool/approval/repo/recovery events all flow on the bus; audit via `task-hooks-bridge`; channel projection via the typed table. **But the runner still emits `before_tool`/`after_tool`/`tool_error` to hookManager directly while the bridge forwards `ToolStarted/Completed/Failed`** — two parallel observations of one tool lifecycle (different moments/names; complementary, not identical, but two buses). | **~ dual observation (D3)** |
| Repository | `RepositoryIndex` (ContextEngine) | Persistent, incremental, warm, telemetry-attributed; event-watcher keeps it fresh. | ✓ single |
| Recovery | `TaskEngine.diagnose` | Runner no longer defines recovery semantics (Move 2). | ✓ single |
| Verification | `TaskEngine` (records/events) + injected diagnoser (test execution) | Authority is the engine's; the repository diagnoser (ContextEngine + verify-then-retry) is an injected capability. A dedicated `VerificationEngine` remains a possible future consolidation. | ✓ single (by injection) |
| Checkpoints | `checkpointManager` | Recorded on Tasks via `taskEngine.recordCheckpoint`, but the manager is not engine-wrapped (pre-existing; roadmap's checkpoint-integration phase). | ~ deferred |
| Memory | `MemoryManager` | Not engine-wrapped (pre-existing; unified-memory phase). | ~ deferred |
| Learning | `LearningManager` | Not engine-wrapped (pre-existing; learning-engine phase). | ~ deferred |
| Telemetry | `analyticsTracker`/`costTracker` + warmth events | Not engine-wrapped (pre-existing; telemetry-engine phase). | ~ deferred |

## 3. Remaining duplicates, ranked

**D1 — Prompt assembly is not in ContextEngine (Context concern).** The
mission loop composes the system prompt inline (base soul + workspace +
time + user + project + repository + history). `ContextEngine.build()` —
the budgeted, sectioned pipeline built in Phase 7 — is never called. This
is the largest piece of "context" that still lives in the host, and it is
the last structural blocker to adopting `taskEngine.run()` with planner/
executor hooks.

**D2 — Legacy "current task" coexists with the canonical Task (Task
concern).** `task-context.ts` maintains its own in-progress task with its
own JSON persistence (`current_task.json`), read by the runner and the
`task-memory` skill, while the canonical Task system tracks the same
notion per mission. Two definitions of "what am I working on".

**D3 — Dual tool-lifecycle observation (Events concern).** The bridge
forwards `ToolStarted/ToolCompleted/ToolFailed` to hookManager; the runner
independently emits `before_tool/after_tool/tool_error`. Different moments
and hook names, so not an exact duplicate, but the same lifecycle is
reported through two buses — audit consumers must know both. Consolidate
by having the runner emit nothing for the tool lifecycle (the bridge +
projections already cover it) or by aliasing the hook names.

**D4 (deferred, pre-existing).** Memory / Learning / Checkpoints /
Telemetry managers are singletons not wrapped behind engines. These are
the roadmap's later phases, not duplicates *of* the core engines — but
they are the reason the "single source of truth" table has ~ rows.

**D5 (deferred, from review 1, R6).** Persistent-state sprawl: most
manager files key to `process.cwd()`, only the task store honors
`GITU_DATA_ROOT`. Not touched by the three moves.

**D6 (doc drift, review 1 R7).** The ROADMAP phase table still marks
Phase 8 `[ ]` and rows 9–11 use the old numbering. Fixed in this audit's
commit (table now reflects shipped work; narrative stays the source of
truth). `SUBSYSTEM_INVENTORY.md` remains Phase 0 — next doc task.

## 4. GoalEngine decision

Deferred, as agreed. Do not introduce GoalEngine while D1–D3 exist: the
goal is exactly the kind of new abstraction that would widen, not close,
the gap between the engines and the host. Revisit at the next audit after
the execution authority lands.

## 5. Next phase decision

**Phase 12: Execution authority** — finish the unification the review
started. Concretely, in order:

1. **D2 first (smallest):** fold `task-context.ts` into the canonical Task
   (the runner's `getSummaryPrompt()` read becomes a TaskEngine query on the
   mission Task; `task-memory` reads the same). One definition of "current
   task".
2. **D1:** wire `ContextEngine.build()` into the mission prompt so the
   runner's inline assembly becomes a call into the engine (byte-identical
   default output, same drop-in discipline as `renderHistory` in Phase 7).
3. **D3:** route the tool lifecycle through the bridge/projections alone
   (or alias hook names), removing the runner's direct emits.
4. **Then adopt `taskEngine.run()` for missions** — the planner/executor/
   verifier hooks now have real homes (context build = planner, turn loop =
   executor, diagnose/verify = recovery), delivering the
   `Mission → TaskEngine → Plan/Execute/Verify/Diagnose/Repair/Retry`
   diagram as one execution authority.

Each step keeps behavior identical (the e2e `smoke:runtime` mission is the
gate) and lands as its own commit. After Phase 12, the third audit decides
the next major feature phase (GoalEngine among the candidates).
