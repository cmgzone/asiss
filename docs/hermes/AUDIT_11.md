# Hermes Architecture Audit 11 — The Autonomous Operating System (Phase 20, Move 1)

> Docs-first audit for Phase 20: **integration of the full loop — Goal → Plan →
> Task → Agent → Execute → Verify → Repair → Complete → Learn.** Per the
> governing rules: the roadmap row says exactly that (Phase 20, "Autonomous
> operating system"), and every prior phase (12-19) closed by handing the next
> phase a foundation — the loop's stages now all exist as engine-owned
> authorities, but the *arrows between them* were never audited as one chain.
> This audit maps each stage and each transition against the CURRENT state,
> separates implementation from documentation, and proposes the smallest
> consolidation for each verified gap. Nothing here is assumed — every claim
> carries a source file (or a test, or a commit) from the audit on 2026-08-13.

## 1. The Phase 20 target vs what exists today

The Phase 20 row is one sentence: **Goal → Plan → Task → Agent → Execute →
Verify → Repair → Complete → Learn.** Stage by stage, with the arrow in
between:

| Stage / arrow | Target (Phase 20 row) | Current implementation | Status |
|---|---|---|---|
| **Goal** | a durable, user-stated goal that drives work | `MainGoalManager` (`src/core/main-goal.ts`, `main_goals.json`): title, objective, constraints, acceptanceCriteria ("Done means: …"), notes, origin auto/manual, linkedProjectId, linkedBackgroundGoalIds. Auto-created from user messages, replaced on focus change, prompt-rendered into every mission. Background goals (`background_goals.json`) add projects/milestones/plan trees | ✅ real |
| **Goal → Task** | the goal produces canonical work | Mission Tasks are created from `msg.content` (`beginMissionTask`, runner.ts:2002) with `metadata: { source, background }` — **no goal id**. Background goals DO link (`metadata.canonicalTaskId`, Phase 13 Step 9.2). The goal's `acceptanceCriteria` flow into the mission verifier (runner.ts:2344), so data flows goal→task, but neither record points at the other | 🟡 (one-way data, no linkage) |
| **Plan** | a plan that guides execution | `Task.plan?: TaskPlanStep[]` (`task-types.ts`) + a `TaskPlanner` hook (`task-engine.ts:46`) exist, but **production never produces a plan**: the runner calls `taskEngine.plan(task.id)` with NO steps (runner.ts:2066), so every mission's plan is empty; plan-mode (`plan-mode.ts`) is a prompt directive (3-6 bullets in the answer), not a plan artifact; the background worker has its own `ProjectMilestonePlan`/`ProjectTaskPlan` tree (`background-worker.ts:516`) — a separate planning concept that never lands on the canonical Task | ❌ (plan is a state, not a deliverable) |
| **Task** | canonical work identity | `TaskEngine` — one lifecycle (CREATED→ANALYZING→PLANNING→READY→EXECUTING→VERIFYING→COMPLETED + failure paths), every work origin (mission/delegation/swarm/background/scheduled/skill-creation/external-research) is a canonical Task (Phases 12-15) | ✅ |
| **Task → Agent** | who performs the work | `assignedAgent` on the Task; `AgentEngine.executeTask` for engine-driven origins; the mission loop resolves a designated default profile (Phase 16 Move 3b) | ✅ |
| **Execute** | one execution authority | `TaskEngine.runMission` (turn loop, budgets, verdicts); `ToolEngine` for tools; `ModelEngine` for model selection | ✅ |
| **Verify** | deterministic verification | Phase 17 completion gate (goal-matched tests → PASSED/FAILED evidence) + Phase 19 `evaluateAcceptanceCriteria` (test-command / file-contains / uncheckable→SKIPPED) recorded as `'criteria'` TaskVerification | ✅ |
| **Repair** | autonomous repair | diagnose (EXECUTING→VERIFYING→EXECUTING with evidence) + gate-fail repair-as-loop bounded by the turn budget; `TaskRepairer` declared-only seam (Phase 17 Move 3) | ✅ |
| **Complete** | completion with evidence | `runTurn` verdicts own the COMPLETED/FAILED/BLOCKED transitions; the runner auto-completes an auto-origin goal on mission completion — `mainGoalManager.completeGoal(sessionId, 'Completed by the autonomous execution loop.')` (runner.ts:3429) — **the goal record receives no task evidence** (no task id, outcome, verification, criteria results) | 🟡 (completion flows, evidence doesn't) |
| **Learn** | the loop remembers | Phase 14 unified memory: terminal tasks → episodic capture + `TaskLessonBridge` → `queueTaskReview` → approval → retrievable lesson; project memory (Phase 18 Move 4) | ✅ (task-scoped) |
| **Learn → Goal** | learning attributable to the goal | Lessons are per-task; a review carries `taskId` but the mission Task's `metadata.goalId` does not exist, so a lesson cannot be traced to the goal that produced it | 🟡 |

## 2. The verified foundation (what is real)

All of the following was verified against source at HEAD `07e2410` plus the
Phase 19 working tree (uncommitted at audit time, `AUDIT_10.md` + Moves 2-8):

- **The goal is durable, prompt-rendered, and criteria-bearing** —
  `main-goal.ts`: `getPrompt()` renders "Main Chat Goal", "Done means: …",
  constraints, notes into every mission; `observeUserMessage` auto-creates /
  refines goals; `acceptanceCriteria` is the data Phase 19 Move 7 evaluates
  deterministically at the completion gate (`runner.ts:2344`,
  `buildMissionVerifier`).
- **Every work origin is a canonical Task with an assigned agent** — Phases
  12-16: mission (`runMission`), delegation/swarm/background/scheduled via
  `AgentEngine.executeTask`, skill-creation/external-research wrapped (Phase
  15). One lifecycle authority, one execution authority, one tool authority,
  one memory authority.
- **Verify + Repair are engine-owned and evidence-producing** —
  `runCompletionVerificationGate` (task-engine.ts): pass → COMPLETED with
  TaskVerification; fail → repair-as-loop while the turn budget allows →
  terminal FAILED feeding episodic capture + lessons. `diagnose` records
  TestStarted/Passed/Failed + TaskVerified/VerificationFailed. Phase 19 adds
  `'criteria'` evidence (PASSED/FAILED/SKIPPED) from the goal's own criteria.
- **Learn is wired per-task** — `TaskLessonBridge` (lesson-capture.ts)
  subscribes to terminal TaskEvents and queues `queueTaskReview` with the
  task's goal/status/summary; approved lessons land in unified memory and are
  retrievable (Phase 14 Move 5 acceptance proven across restart).
- **The battery + permanent gates exist** — `npm test` runs the 22-script
  battery (`run-battery.ts`, `logs/gate-report.json` evidence artifact), and
  the comment-aware `smoke:phase16` / `smoke:phase18` / `smoke:phase19`
  permanently guard prior-phase invariants.

## 3. Evidence matrix

| Requirement | Status | Evidence | Tests |
|---|---|---|---|
| F1 Audit | ❌ | No Phase 20 audit doc existed before this one; the integration chain was never mapped end-to-end | — |
| F2 Goal | ✅ | `MainGoalManager` durable + prompt-rendered; criteria/constraints/notes | smoke:runtime, smoke:casual |
| F3 Goal→Task linkage | 🟡 | Mission task metadata has no goalId; goal has no linkedTaskIds; background goals link `canonicalTaskId` only | smoke:agent-execution §6 |
| F4 Plan | ❌ | `TaskPlanStep[]` + `TaskPlanner` hook exist; runner calls `plan()` bare; plan-mode is prompt-only; background worker's plan tree is a separate concept | smoke:baseline (plan field empty) |
| F5 Task→Agent | ✅ | `assignedAgent` on Task; `AgentEngine.executeTask`; default-profile resolution | smoke:agent-engine §8, smoke:agent-execution |
| F6 Execute | ✅ | `runMission` owns the loop | smoke:runtime, smoke:turn-contract |
| F7 Verify | ✅ | Phase 17 gate + Phase 19 criteria evaluation | smoke:turn-contract §16-17 |
| F8 Repair | ✅ | diagnose + gate-fail repair-as-loop | smoke:turn-contract §16, smoke:repo-index §16 |
| F9 Complete→Goal evidence | 🟡 | Goal auto-completed with a fixed note; no task evidence recorded | smoke:runtime (goal completion unasserted) |
| F10 Learn | ✅ | TaskLessonBridge → queueTaskReview → unified memory; restart-recall proven | smoke:memory-unified |
| F11 Learn→Goal | 🟡 | Reviews carry taskId, not goalId; `loadPendingReviews` drops even the task fields on restart | smoke:learning (out of battery) |
| F12 Permanent gate | ❌ | No `smoke:phase20` | — |

## 4. Findings, ranked

### G1 — Plan is a state, not a deliverable (the loop's missing middle)

The lifecycle passes through PLANNING on every mission, but `Task.plan` is
always empty in production: `beginMissionTask` calls `taskEngine.plan(task.id)`
with no steps, no `TaskPlanner` is ever wired, and `TaskPlanStep.status` /
`subtaskId` are never updated by any origin. The model is told "Don't repeat
prior plans" and "Never present a plan as the final answer" — but nothing ever
records a plan the loop can point at. The background worker's own plan trees
(`planProject` → milestones → tasks) never reach the canonical Task either, so
two planning concepts coexist without one connecting to the other. **Plan
(Move 3): a deterministic plan builder** — `buildGoalPlan` derives
`TaskPlanStep[]` from the goal's own data (acceptance criteria via the Phase 19
classifier, constraints) with an analysis step and a verification step, lands
it on the canonical Task at `beginMissionTask`, and renders it into the mission
prompt as an advisory section (gated by `agent.context.plan.enabled`, default
on). No new authority: the plan is goal-owned data + the existing criteria
classifier, and the loop's Verify stage later evaluates the same criteria the
plan turned into steps.

### G2 — Goal ↔ Task linkage is missing on the interactive/mission path

Background goals trace to their canonical Task (`metadata.canonicalTaskId`,
Phase 13 Step 9.2); mission Tasks carry **no goal id**, and the `MainChatGoal`
record carries **no task ids**. After a mission, the chain
goal → task → agent → outcome is not queryable from either end: you cannot ask
"which goal did this mission serve?" from the Task, nor "which tasks did this
goal produce and how did they end?" from the goal. **Plan (Move 2): bidirectional
linkage** — the mission Task records `metadata.goalId` (the session's current
goal at begin), and the goal records `linkedTaskIds`; terminal mission outcomes
append `GoalTaskEvidence` (taskId, outcome, attempts, turns, verification
summary, tool calls) to the goal.

### G3 — Complete → Goal carries no evidence

The auto-origin goal is completed with a fixed note — `'Completed by the
autonomous execution loop.'` — discarding exactly the evidence Verify+Repair
produced (task id, outcome, TaskVerification records, criteria results,
attempts). A completed goal cannot show *why* it was completed. Failed
missions don't touch the goal at all (it stays active with no failure trace).
**Plan (Move 2, part 2): evidence flows back** — `completeGoal` accepts the
`GoalTaskEvidence` payload and the runner records it (completion records the
evidence; a failed/blocked terminal also appends `GoalTaskEvidence` so the
failure is traceable without silently killing the goal).

### G4 — Learning is task-scoped, not goal-attributable

Lessons fire per terminal Task and carry `taskId`, but no goal id — and
`LearningManager.loadPendingReviews` drops even the task fields (`origin`,
`taskId`, `taskKind`, `taskStatus`) on restart, so a queued task review loses
its provenance entirely. **Plan (Move 4): goal id threads through the learning
pipeline** — `TaskLessonBridge` passes `task.metadata.goalId` into
`queueTaskReview`, `ReviewTask` stores it, `loadPendingReviews` round-trips the
task fields (fixing the provenance drop), and the review prompt shows the goal
id. Goal-level retrospection (a review per completed goal spanning its tasks)
is documented as a deferred polish — the task-level lesson already names the
goal via this linkage.

### G5 — no permanent Phase 20 gate

Consistent with the phase discipline (Phase 16/18/19 each shipped a
comment-aware gate), nothing guards the Phase 20 invariants. **Plan (Move 5):
`smoke:phase20`** — mission tasks carry `goalId`, goals carry
`linkedTaskIds`/task evidence, `buildGoalPlan` is hosted and called with steps,
completion records evidence, and the lesson pipeline threads goalId.

## 5. Move plan

| Move | Closes | Deliverable |
|---|---|---|
| **Move 1** | F1 | This audit + ROADMAP row 20 → `[~]` (done, docs only) |
| **Move 2** | G2, G3, F9 | Goal↔Task linkage + completion evidence: `linkedTaskIds` / `GoalTaskEvidence` on `MainChatGoal`, mission task `metadata.goalId`, `completeGoal` evidence param, failure evidence recording |
| **Move 3** | G1, F4 | `buildGoalPlan` (deterministic, criteria/constraint-derived `TaskPlanStep[]`), wired at `beginMissionTask`, rendered into the mission prompt (advisory, `agent.context.plan.enabled` default on) |
| **Move 4** | G4, F11 | goalId threads through `TaskLessonBridge` → `queueTaskReview` → `ReviewTask` → review context; `loadPendingReviews` round-trips task fields |
| **Move 5** | G5, F12 | permanent comment-aware `smoke:phase20` gate + battery/gate:fast wiring |

Each move lands with `tsc --noEmit` clean + targeted smoke coverage + the
battery green in one pass, and is recorded in the corresponding section below
and the ROADMAP.

---

## Move 2 — Goal↔Task linkage + completion evidence (done, G2/G3/F9)

`MainChatGoal` gains `linkedTaskIds: string[]` and `taskOutcomes:
GoalTaskEvidence[]` (`GoalTaskEvidence` = taskId, outcome
SUCCESS/FAILURE/PARTIAL/CANCELLED, summary, attempts, turns, verification
render, toolCalls). `MainGoalManager` gains `linkTask(sessionId, taskId)` and
`recordTaskOutcome(sessionId, evidence)`; `completeGoal(sessionId, note,
evidence?)` accepts the payload and appends it before completing. The runner's
`beginMissionTask` stamps `metadata.goalId` from the session's current goal and
links the goal → task after creation; the mission terminal path records
`GoalTaskEvidence` from the canonical `TaskTurnResult.task` (outcome +
verification/criteria counts + attempts/turns/tool calls) — completing the
auto-origin goal with that evidence, and recording failed/blocked outcomes
without completing the goal. The chain
goal → task → agent → verify → complete is now queryable from both ends.
A web trace panel surfaces it: `GET /api/loop` (auth-guarded like every
`/api` route) serves goals (current + recent, with `linkedTaskIds` +
`taskOutcomes`) and canonical tasks (with `goalId`, outcome, verification,
turns/attempts/toolCalls), and the chat UI's new **Loop** modal renders
both sides with navigation — clicking a goal highlights its tasks, clicking
a task (or its evidence chip) jumps to the goal it serves. Verified by
`tsc --noEmit` clean + smoke:phase20 Gates A/B + smoke:runtime (mission
Task carries the goal id + plan, the goal records the task outcome — now
asserted end-to-end) + a live `/api/loop` probe + the full battery.

## Move 3 — the plan is a real artifact (done, G1/F4)

`src/core/context/plan-builder.ts` lands `buildGoalPlan({ goal,
acceptanceCriteria, constraints, maxSteps })` → `TaskPlanStep[] | undefined`,
built from the goal's own data with no model call and no second authority:
an analysis step ("Understand the goal and current state") when the goal is
actionable; one step per acceptance criterion via the Phase 19 classifier
(file-contains → "Update/verify <file>", test-command → "Run `cmd`",
uncheckable → "Confirm: <criterion>"); a constraints step when constraints
exist; and a closing verification step when criteria exist. `criteria-check.ts`
exports the classifier (`classifyCriterion`) so Plan and Verify read the same
interpretation of the same criteria. The runner passes the steps to
`taskEngine.plan(task.id, steps)` at `beginMissionTask` (bare call preserved
when nothing is planable), and the mission prompt renders the plan as an
advisory section before the execution contract — gated by
`agent.context.plan.enabled` (default true), present only when the task has
steps, so goals without criteria/constraints stay unchanged. `TaskPlanStep`
status tracking (IN_PROGRESS/COMPLETED as the mission advances) is documented
as deferred polish — the plan is a goal-owned guide, not a second execution
authority. Verified by `tsc --noEmit` clean + smoke:phase20 Gate C + a direct
plan-builder assertion in smoke:phase20 + smoke:runtime (mission task carries
steps; prompt renders the plan) + the battery.

## Move 4 — learning carries the goal (done, G4/F11)

`TaskLessonBridge` now passes `goalId` (from `task.metadata?.goalId`) into
`LearningManager.queueTaskReview`; `ReviewTask` gains `goalId`; the review
prompt's task context block shows the goal id so an extracted lesson is
attributable to the goal that produced it; and `loadPendingReviews` round-trips
the task-review fields (`origin`, `taskId`, `taskKind`, `taskStatus`, `goalId`)
instead of dropping them on restart. Verified by `tsc --noEmit` clean +
smoke:phase20 Gate D + the battery. Goal-level retrospection (a review per
completed goal across its tasks) stays a documented deferred polish.

## Move 5 — the permanent smoke:phase20 gate (done, G5/F12)

`scripts/smoke-phase20.ts` (`npm run smoke:phase20`) is the permanent,
comment-aware regression guard for the Phase 20 invariants — same discipline
as `smoke:phase16/18/19` (comments stripped from source sweeps so prose can
neither trip nor soothe). Gates:

- **Gate A (G2)** — mission tasks link the goal: `beginMissionTask` metadata
  carries `goalId`, and `MainGoalManager` exposes `linkTask` /
  `recordTaskOutcome` with `linkedTaskIds` / `taskOutcomes` on the goal record.
- **Gate B (G3)** — completion evidence flows back: `completeGoal` accepts an
  evidence payload and the runner passes the canonical task's outcome +
  verification summary.
- **Gate C (G1/F4)** — the plan is a deliverable: `buildGoalPlan` is defined +
  exported, `classifyCriterion` is exported from criteria-check, and the runner
  calls `taskEngine.plan` with the built steps (not bare).
- **Gate D (G4/F11)** — learning carries the goal: `queueTaskReview` accepts
  `goalId`, `ReviewTask` carries it, and `loadPendingReviews` round-trips the
  task fields. Goal-level retrospectives are gated too: `queueGoalReview`
  exists, goal reviews carry the `'goal'` origin, and the runner queues one
  when an auto-origin goal completes (Move 6).
- **Gate E** — the gate is wired: `smoke:phase20` is a registered script, in
  the canonical battery, and in `gate:fast`.

Verified by `tsc --noEmit` clean + smoke:phase20 with negative probes on the
new directions + `npm run gate:fast` green + the full battery green in one
pass with the gate-report artifact.

## Move 6 — goal-level retrospectives (done, the G4 polish)

`LearningManager.queueGoalReview` queues a retrospective when the LAST linked
task of an auto-completed goal finishes — the runner calls it in the same
completion path that auto-completes the goal (AUDIT_11 Move 2), after
`recordTaskOutcome` so the payload spans the goal's full task set. The review
carries the `'goal'` origin + the goal id, and `processNextReview` prompts
over the completed goal — title, objective, and every linked task outcome
line (not just the final one) — storing the extracted lesson on a
`Goal retrospective: <title>` entry with the `goalId`. The goal id threads
the rest of the pipeline: derived pending actions (`auto_update`,
`autoGoals`, `skillCreation`) carry it, and the unified-memory procedural
record's metadata links the lesson to the goal. `ReviewTask` round-trips the
goal fields through `loadPendingReviews`; per-session review rate limits and
the approval pipeline are unchanged. Verified by `tsc --noEmit` clean +
smoke:memory-unified §8b (queued with the goal origin + full task set,
lesson extracted with goalId, approved, unified record metadata.goalId) +
smoke:phase20 Gate D + smoke:runtime + the battery green. The loop's Learn
stage is now attributable to the Goal end-to-end.

## Move 7 — live plan-step status (done, the remaining G1 polish)

`TaskPlanStep.status` is now engine-owned and advances as the mission moves.
`TaskEngine.markPlanStep(taskId, stepId, status)` is the explicit, validated
transition (PENDING → IN_PROGRESS → COMPLETED, monotonic forward — a
COMPLETED step never reverts), and the engine derives advancement
deterministically from the evidence it already owns:
- a successful **mutation** tool (recordToolKind) starts the first pending
  step (the mission is working on it);
- a successful **verification** tool completes the in-progress step and
  starts the next PENDING one (a unit of work verified done);
- **progress records** (recordProgress) map the percent onto equal step
  slices as a fallback for turns without tool kinds;
- task **COMPLETED** (complete) finishes every remaining step.

The mission prompt renders each step with its status — `1. [IN_PROGRESS]
…` — and the loop API (`/api/loop` task payload) + web Loop modal surface
the plan with PENDING / IN_PROGRESS / COMPLETED badges per step. Verified by
`tsc --noEmit` clean + smoke:turn-contract §18 (mutation starts, verification
advances, failed tools do not advance, progress slicing, explicit
markPlanStep validation, terminal completion finishes the plan) +
smoke:phase20 Gate C + smoke:runtime + the battery green. The plan is now
a live guide the mission walks, not a static checklist.

## Move 8 — the background worker's plan trees merge onto canonical plans (done, the last deferred follow-up)

The last deferred follow-up is closed: `/goal` and `/plan_project` goals now
produce **the same plan artifact the mission loop renders**. The background
worker's project/milestone/task tree (`BackgroundWorker.planStepsForGoal`)
returns the goal's position in the tree as ordered work items — the goal
itself, its subtasks, then every later goal in the milestone (addTaskTree
records `milestone.goalIds` in DFS pre-order, so slicing from the goal's
index is exactly the remaining plan). The runner maps those to
`TaskPlanStep[]` with the goal's own work item IN_PROGRESS and the rest
PENDING, and passes them through `agentEngine.executeTask`'s new
`planSteps` option — the child Task is planned with them, never bare — and
the child mission renders the numbered, per-step-status plan section just
like the mission loop. The engine's Move 7 live step machine then advances
the merged tree steps as the child mission walks them (terminal completion
finishes the tree). Standalone goals (no project) get their single work item.

Verified by `tsc --noEmit` clean + smoke:agent-execution §16 (tree order for
root/subtask/standalone goals, the merged plan recorded on the child Task,
live `[IN_PROGRESS]` render, terminal completion finishing every tree step)
+ smoke:phase20 Gate E (planStepsForGoal, the runner mapping, executeTask's
planSteps, the never-bare plan call, the child render) + the battery green.
The Loop modal already surfaces these plans via the `/api/loop` plan payload.

**Phase 20 is complete (this pass):** the loop
**Goal → Plan → Task → Agent → Execute → Verify → Repair → Complete → Learn**
is now one connected chain — the goal produces a plan and canonical tasks and
receives their evidence back; verification and the plan read the same
criteria; learning is attributable to the goal; the background worker's plan
trees merge onto the same canonical plan artifact; and the integration is
gated forever by `smoke:phase20`.
