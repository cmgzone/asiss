# Execution Map — pre-migration audit for `taskEngine.run()` adoption

Phase 12, final step. Before the mission loop delegates execution to
TaskEngine, this document maps **every operation the mission loop performs**
against what TaskEngine (and its satellite engines) already own, what can be
delegated, what must stay in the host, and what TaskEngine needs before the
migration is honest. Nothing here changes code; it is the audit that
`docs/hermes/ROADMAP.md` Phase 12 points at.

Method: the map was produced by reading `AgentRunner.processMessage`'s loop
(~lines 1700-2830), `TaskEngine` (task-engine.ts), and the engine call sites
in the runner (`taskEngine.*` greps). Every row is grounded in a call site
or an explicit absence (e.g. `taskEngine.verify` and `taskEngine.retry` are
NEVER called by the mission loop).

## 1. Operation map

| # | Mission-loop operation | Where it happens today | Verdict |
|---|------------------------|------------------------|---------|
| 1 | **Create task** | `beginMissionTask` → `taskEngine.create({kind:'mission', ...})` | **A — owned** |
| 2 | **Analyze** | `beginMissionTask` → `taskEngine.analyze(task.id)` | **A — owned** |
| 3 | **Plan** | `beginMissionTask` → `taskEngine.plan(task.id)` | **A — owned** (no planner hook wired; plan stays empty) |
| 4 | **Start (→ EXECUTING)** | `beginMissionTask` → `taskEngine.start(task.id)` | **A — owned** |
| 5 | **Context assembly** | `contextEngine.buildMissionPrompt(...)` (Phase 12 D1) | **B — delegatable, done** |
| 6 | **Model selection** | `modelEngine.select(...)` + `taskEngine.assignModel` + `taskEngine.recordDecision` | **B — delegatable** (ModelEngine owns scoring; TaskEngine records) |
| 7 | **Tool execution** | `toolEngine.execute(...)` (Phase 4) → records via TaskEngine (`ToolStarted/Completed/Failed`) | **B — delegatable, done** |
| 8 | **Checkpoints** | ToolEngine → CheckpointGateway (automatic before destructive shell/patch) → `taskEngine.recordCheckpoint` | **B — delegatable, done** |
| 9 | **Diagnosis (on failure)** | `injectGoalRetryHint` → `taskEngine.diagnose(taskId, {diagnoser})` (Move 2) | **A — owned** (runner only wires the diagnoser) |
| 10 | **Verification forcing** | Runner heuristic: `verificationRequired` + `lastMutationSequence > lastVerificationSequence` → forces a "verify now" continuation turn | **C/D — host decision, no engine call** (`taskEngine.verify` is terminal and unused) |
| 11 | **Repair** | Runner renders diagnosis into context (`goal_verify_output` memory); the model repairs on the next turn | **C — host** (model-driven; TaskEngine's `repair` hook lives only in the unused `retry()` path) |
| 12 | **Retry** | Runner's `for(;;)` loop just continues after a failed batch | **C — host loop** (`taskEngine.retry` exists for FAILED tasks but the mission never enters FAILED mid-loop) |
| 13 | **Completion decision** | Runner `completionBlocked` heuristic (lastBatchHadFailure \|\| toolRequired && no tools \|\| verification pending) → `deliverFinalResponse` | **C — host decision** |
| 14 | **Completion recording** | `finalizeMissionTask` → `taskEngine.complete(SUCCESS)` or `taskEngine.failTask(...)` | **A — owned** (decision is #13) |
| 15 | **Progress** | `taskEngine.recordProgress(missionTaskId, batchPct, ...)` | **A — owned** |
| 16 | **Cost** | `taskEngine.recordCost(...)` | **A — owned** |
| 17 | **Streaming / UI** | `gateway.sendStreamEvent/sendChunk/sendResponse` (`assistant_start/delta/done`, `tool_start`) | **C — host, must stay** |
| 18 | **Session memory** | `memory.getAll/add/applyCompactionFilter/selectRelevantMemories/autoCompact` | **C — host, must stay** |
| 19 | **Model call** | `currentModel.generate/generateStream` + `withModelRetry` + `modelEngine.recordModelOutcome` | **C — host call, engine telemetry** |
| 20 | **Tool batch orchestration** | parallel-delegation decision, dependency ordering, mutation/verification sequences | **C — host, must stay** |
| 21 | **Turn budget** | `maxTurns`/`maxToolCalls` enforcement + autoContinue + repetition/exploration guards | **C — host** (constraints already live on the Task via `beginMissionTask`) |
| 22 | **Approval (ASK path)** | PolicyEngine → approvalCoordinator → gateway card; runner resolves responses | **C — host** (Phase 5 ASK resolution) |

## 2. Verdict summary

**A — Already owned by TaskEngine (11 rows):** create, analyze, plan, start,
diagnose, completion/failure recording, progress, cost, tool execution
records, checkpoints, model/decision records. The engine's lifecycle and
recording surface is real and the mission already uses most of it.

**B — Exists elsewhere, already delegated (4 rows):** context (ContextEngine,
D1), model selection (ModelEngine), tool execution (ToolEngine), checkpoints
(CheckpointGateway). These are the Phase 4-12 engine extractions and they are
wired.

**C — Runner-specific, must remain outside TaskEngine (8 rows):** streaming/UI,
session memory, the model call itself, tool-batch orchestration, the
**completion decision**, the **verification-forcing decision**, retry-as-loop,
repair-as-model-turn, approval resolution, turn budgets. TaskEngine must never
own the gateway, the memory store, or the model client.

**D — Missing capability before the migration is honest (2 items):**

1. **A multi-turn execution contract.** `TaskEngine.run()`/`runExecution()`
   calls the executor **once** and then completes or fails. The mission loop is
   a multi-turn loop (up to `maxTurns` model turns × tool batches). There is no
   engine primitive that owns "keep looping until a completion verdict".
   Without one, adopting `run()` means either (a) stuffing the whole old loop
   into the executor — exactly the illusion the user forbade — or (b) adding a
   per-turn primitive first.
2. **A completion-verdict hook.** The engine records completion but does not
   decide it. `completionBlocked` (failed batch / no tools used / verification
   pending) is a host heuristic in the loop. The migration needs a way for the
   engine to *ask* the host "is this turn done?" or receive the verdict as part
   of the turn contract, so the engine owns the transition while the host owns
   the domain judgment.

**Near-misses (present but not used by the mission):** `taskEngine.verify`
(EXECUTING → VERIFYING → COMPLETED/FAILED — terminal, unsuitable for
in-mission step verification) and `taskEngine.retry` (FAILED → DIAGNOSING →
REPAIRING → EXECUTING — the mission never goes FAILED mid-loop; it uses
`diagnose`'s EXECUTING → VERIFYING → EXECUTING instead). Both are correct
machinery for the wrong shape of loop; D1/D2 (the map) captures the shape gap.

## 3. The target boundary

```
                 AgentRunner (host)
                      |
         create/configure Task (A) . context (B) . model call (C)
                      |
                      v
              TaskEngine.run() / runTurns
                      |
          +-----------+-----------+
          v           v           v
       ANALYZE      PLAN       EXECUTE*   (*multi-turn, host supplies
                                  |           the model call + verdict)
                                  v
                              VERIFY
                             /      \
                          PASS       FAIL
                           |           |
                           v           v
                        COMPLETE    DIAGNOSE (A)
                                       |
                                       v
                              REPAIR (host renders, model acts)
                                       |
                                       v
                                     RETRY (engine owns attempts)
```

Host keeps: gateway/streaming/UI, session memory, model client, tool-batch
orchestration, approval cards, turn budgets. Engine keeps: lifecycle state
machine, records, events, recovery authority (diagnose already there),
attempts, completion transitions.

## 4. Recommended slices (each with the e2e mission as the gate)

1. **Turn contract (D1):** add a per-turn execution primitive to TaskEngine
   (e.g. `runTurn(taskId, { turn, verdict })` or an executor contract that
   returns `{ done, reason, summary }`) that owns the EXECUTING → (VERIFYING) →
   EXECUTING / COMPLETED transitions across multiple turns. Runner behavior
   unchanged; the loop body becomes the future hook.
2. **Completion verdict (D2):** move `completionBlocked` into the turn
   contract — the engine asks the host for the verdict each turn and owns the
   terminal transition, so "who decides done" migrates to the engine's
   orchestration while the host supplies the judgment.
3. **Verify/diagnose in-loop:** reuse the existing EXECUTING → VERIFYING →
   EXECUTING path (diagnose) for step verification, and retire the runner's
   ad-hoc `lastMutation/lastVerification` forcing in favor of engine-owned
   verification turns.
4. **Delegate the loop:** once 1-3 land, the mission loop's *body* is the
   executor/turn hook; TaskEngine.runTurns drives it. The old loop's
   orchestration (memory, streaming, batch order) stays as host callbacks —
   the shape is `host supplies turn → engine decides lifecycle` throughout.

## 5. What would indicate failure / success

**Success:** `AgentRunner` is a thin adapter — it presents, streams, records
session memory, and supplies domain verdicts, but does not decide whether the
task verifies, retries, repairs, or completes.

**Failure:** `TaskEngine.run()` internally contains the old mission loop
(executor = the whole loop with streaming/memory inside), or the loop keeps
its own recovery counters (`repeatedFailureRecoveries`, `forcedContinuations`,
`lastMutation/lastVerification`) that the engine cannot see. Both would be the
illusion the map exists to prevent.
