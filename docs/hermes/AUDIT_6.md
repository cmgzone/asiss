# Hermes Architecture Audit 6 — Autonomous Work vs Canonical Tasks (Phase 15)

> Docs-first audit for Phase 15 of the roadmap: **every autonomous work origin
> flows through the canonical Task lifecycle**. Per the governing rule from
> Phases 12-14: *TaskEngine = what work needs to happen, AgentEngine = who /
> how, Memory = what Hermes knows, everything autonomous flows through Tasks —
> no second execution authority.*

## 1. Authority map (per work origin)

| Origin | WHEN (trigger) | HOW (execution) | Canonical Task? |
|---|---|---|---|
| User message / channel | gateway → `processMessage` | mission loop → `beginMissionTask` (`kind: 'mission'`) | ✓ |
| Scheduler job | `SchedulerManager` timer | `AgentEngine.executeTask` (`kind: 'scheduled'`), legacy fallback → mission loop | ✓ (Phase 13, Step 9.3) |
| Background goal | `BackgroundWorker.tick` | `AgentEngine.executeTask` (`kind: 'background'`), legacy fallback → mission loop | ✓ (Phase 13, Step 9.2) |
| **Learned-skill-creation goal** | `BackgroundWorker` dispatch | **`LearningManager.executeSkillCreationGoal` — outside the lifecycle** | **✗ (S1)** |
| Delegation | `delegate_agent` skill | `AgentEngine.executeTask` (`kind: 'delegation'`) | ✓ |
| Swarm task | swarm executor | `AgentEngine.executeTask` | ✓ |
| Heartbeat | runner interval | `proactiveTick` (advisory) + `learning.tick` (queues goals → canonical) | n/a — WHEN only |
| Retry / resume | `TaskEngine.diagnose` / `retry` / `resume` | engine-owned lifecycle | ✓ |
| Learning external research | `learning.tick` → `processExternalLearning` | web research via skills; **no Task record** | ~ (S4, deferred) |
| Proactive suggestions | `ProactiveEngine.generateSuggestions` | advisory only — no execution, no state machine | n/a — advisory |

## 2. Findings (ranked)

### S1 — learned-skill-creation goals run outside the canonical lifecycle (consolidate)

The background worker dispatches `metadata.kind === 'learned-skill-creation'`
goals straight into `LearningManager.executeSkillCreationGoal`: model calls and
skill-store writes happen with **no canonical Task, no TaskEvents, no
tool/evidence records, no terminal state**. Every other origin (mission,
delegation, swarm, background, scheduled) produces a canonical Task with the
engine-owned lifecycle; skill creation is the last origin that doesn't.

**Consolidation:** the runner's background executor wraps the skill-creation
workflow in a canonical `kind: 'background'` Task — create → analyze → plan →
start → run the deterministic workflow (`executeSkillCreationGoal`) → complete
with the result as evidence (or `failTask` + return `ok: false` so the worker's
own status/retry authority decides the goal outcome). `goal.metadata.canonicalTaskId`
links the goal record to its Task, matching the Phase 13 linkage pattern
(background_goals.json stays authoritative for goal statuses).

Why not through `AgentEngine.executeTask`? Skill creation is a deterministic
internal workflow (its own model calls + `learnedSkillsManager` writes), not an
agent tool-execution mission — like verification, it is an injected capability
that runs *as* the Task's execution, not a separate agent loop. TaskEngine owns
the lifecycle and evidence either way.

### S2 — store statuses vs Task status (by design, not consolidated)

`background_goals.json`, `scheduler.json`, `swarm_data.json` remain the status
authorities for their own domains (attempts, retries, priorities); the canonical
Task id is carried as linkage (`canonicalTaskId` / `schedulerJobId` /
`canonicalTaskIds`) and TaskEngine owns execution evidence. Established in
Phase 13 and Audit 4 (finding S2); unchanged here.

### S3 — the mission loop is the host driver, not a second authority (by design)

`processMessage` (the legacy mission loop) survives only as (a) the interactive
mission driver and (b) the failure fallback for background/scheduled. Every
mission is a canonical `kind: 'mission'` Task (`beginMissionTask`), so the
fallback still produces Task records — the loop is the host that drives model
turns while TaskEngine owns the lifecycle (Audit 3 finding). Not a straggler.

### S4 — learning external research has no Task record (deferred)

`processExternalLearning` runs web research (search + fetch skills) and lands a
learning entry without a canonical Task. It is a passive, model-light pipeline
(no agent loop, no tools beyond web search), so wrapping it is lower value than
S1; defer and track on the roadmap.

### S5 — heartbeat / proactive engine are not execution authorities (by design)

The heartbeat only *triggers* `proactiveTick` (advisory suggestions, no
execution) and `learning.tick` (which queues goals that then run through the
canonical background path). The ProactiveEngine has no state machine and never
executes work. Nothing to consolidate.

## 3. Resolution — S1 executed

The runner's background executor now wraps learned-skill-creation goals in a
canonical `kind: 'background'` Task (`runSkillCreationGoalViaEngine`, next to
the background/scheduled engine wrappers): `taskEngine.create` (metadata
`source: 'skill-creation'` + `backgroundGoalId`) → analyze → plan → start →
`LearningManager.executeSkillCreationGoal` runs AS the Task's execution →
`complete` with the result as evidence. `goal.metadata.canonicalTaskId` links
the goal record (background_goals.json stays the goal-status authority). On
failure the Task is `failTask`-ed for evidence and the error is rethrown so the
worker's own retry/status authority decides the goal outcome.

Skill creation is the last origin without a canonical Task — every origin now
funnels into TaskEngine: mission, delegation, swarm, background, scheduled, and
skill-creation all produce canonical Tasks with engine-owned lifecycle and
evidence. Heartbeats and the proactive engine remain WHEN/advisory-only (S5);
store statuses remain authoritative with canonical linkage (S2); the mission
loop remains the host driver over canonical mission Tasks (S3); learning
external research is now wrapped in canonical Tasks (S4 executed in Move 2).

## 3b. Resolution — Move 2 (external research wrapped; fallbacks retired)

**S4 executed — external research runs inside canonical Tasks.**
`LearningManager` gains an optional `taskEngine` (plus injectable web skills
for deterministic testing); when wired (the runner passes it), each topic's
research in `processExternalLearning` runs inside a canonical
`kind: 'background'` Task (`metadata.source = 'external-learning'` +
`topicQuery`): create → analyze → plan → start → research-as-execution →
complete with the entry title/summary as evidence, or `failTask` on error.
When no engine is wired, the legacy direct path is unchanged.

**Legacy mission-loop fallbacks retired.** Both `runBackgroundGoalViaEngine`
and `runScheduledJobViaEngine` now return `{ ok, output?, error? }` and, on a
failed execution, ensure terminal canonical evidence via `failCanonicalTasks`
(fails any child Task the engine's exception path left non-terminal —
`runMission` already completes/fails child Tasks on verdicts). The background
executor no longer re-dispatches through `processMessage`: a failed goal
throws, and the worker's own retry/status authority (attempts ≤ maxRetries →
pending + nextRunAt) decides the outcome. The scheduled `onRun` no longer
re-dispatches either: it notifies the session of the failure and rethrows so
`SchedulerManager` records it — the scheduler's `runJob` previously swallowed
`onRun` failures entirely (`catch {}`), so scheduled failures were invisible;
it now persists `lastError` / `failureCount` / `lastFailedAt` on the job.

These were the last two call sites that routed autonomous work through the
interactive mission loop as a *fallback*; the loop remains the host-driven
interactive driver (S3) and still creates canonical `kind: 'mission'` Tasks.

## 4. Acceptance gate (Phase 15, Moves 1-2)

`tsc --noEmit` clean; `smoke:learning` green (skill-creation goal runs as a
canonical Task with goal linkage + evidence, AND external research runs
inside a canonical Task with evidence — both driven deterministically with
stubbed model/web skills, the smoke isolated via `GITU_DATA_ROOT`);
`smoke:scheduler` green (new section: a throwing `onRun` records
`failureCount`/`lastError`/`lastFailedAt` on the job and persists, one-shots
still disable themselves); `smoke:memory-unified`, `runtime`, `baseline`,
`delegation`, `agent-execution`, `terminal-paths` unchanged (baseline's
occasional `EPERM rename` on Windows is a pre-existing transient store flake
— green on rerun).
