/**
 * Phase 20 Move 5 — permanent verification gate (docs/hermes/AUDIT_11.md, G5).
 *
 * Static, no-network regression guard for the Phase 20 invariants — the
 * autonomous operating system integration. It must run forever as part of the
 * battery, protecting the audit's closed gaps:
 *
 *   Gate A — mission tasks link the goal (G2): `beginMissionTask` stamps the
 *            session goal id on the mission Task (`metadata.goalId`), and
 *            MainGoalManager exposes `linkTask` / `recordTaskOutcome` with
 *            `linkedTaskIds` / `taskOutcomes` on the goal record — the chain
 *            goal -> task is queryable from BOTH ends.
 *   Gate B — completion evidence flows back (G3): `completeGoal` accepts an
 *            evidence payload, the goal record carries `taskOutcomes`
 *            (GoalTaskEvidence), and the runner passes the canonical task's
 *            outcome + verification summary on the terminal path.
 *   Gate C — the plan is a deliverable (G1/F4): `buildGoalPlan` is defined +
 *            exported, `classifyCriterion` is exported from criteria-check
 *            (Plan and Verify read the same criteria), and the runner calls
 *            `taskEngine.plan` with the built steps — never bare — and
 *            renders the plan into the mission prompt (plan.enabled config).
 *   Gate D — learning carries the goal (G4/F11): `queueTaskReview` accepts
 *            `goalId`, `ReviewTask` carries it, the lesson bridge passes it,
 *            and `loadPendingReviews` round-trips the task fields.
 *   Gate E — the background plan merge (Move 8): `BackgroundWorker`
 *            exposes `planStepsForGoal` (the goal's position in the
 *            project/milestone/task tree), the runner maps it to
 *            `TaskPlanStep[]` with the current work item IN_PROGRESS,
 *            `executeTask` accepts `planSteps` and plans the child Task with
 *            them (never bare), and the child mission renders the same
 *            plan artifact with status.
 *   Gate F — the gate is wired: `smoke:phase20` is a registered script, in
 *            the canonical battery, and in the fast gate.
 *
 * Like smoke:phase16/18/19 it is comment-aware: comments are stripped from
 * source sweeps so explanatory prose can neither trip nor soothe a check.
 * The behavioral matrix is proven by the battery — smoke:runtime (mission
 * task carries the goal id + plan steps; the goal records the task outcome),
 * smoke:config (plan schema), smoke:turn-contract, smoke:memory-unified —
 * this file guards only the architectural invariants.
 *
 * Run: npm run smoke:phase20  (or as part of `npm run gate:fast`)
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { CANONICAL_BATTERY } from './run-battery';

const ROOT = process.cwd();

/** Remove block comments (incl. JSDoc) and line comments. */
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n\r]*/g, ' ');
}

function readFile(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

async function main() {
  const pkg = JSON.parse(readFile('package.json'));
  const scripts = pkg.scripts || {};
  const fast = scripts['gate:fast'] || '';

  // Gate A — mission tasks link the goal (G2).
  const runnerSrc = stripComments(readFile('src/agents/runner.ts'));
  assert.ok(
    runnerSrc.includes("goalId: mainGoalManager.getCurrent(input.sessionId)?.id"),
    'beginMissionTask must stamp the session goal id on the mission Task (metadata.goalId)'
  );
  assert.ok(
    runnerSrc.includes('mainGoalManager.linkTask(sessionId, missionTaskId)'),
    'the runner must link the goal record to its mission Task'
  );
  const goalSrc = stripComments(readFile('src/core/main-goal.ts'));
  assert.ok(goalSrc.includes('public linkTask('), 'MainGoalManager.linkTask must exist');
  assert.ok(goalSrc.includes('public recordTaskOutcome('), 'MainGoalManager.recordTaskOutcome must exist');
  assert.ok(goalSrc.includes('linkedTaskIds: string[]'), 'MainChatGoal must carry linkedTaskIds');
  assert.ok(goalSrc.includes('taskOutcomes: GoalTaskEvidence[]'), 'MainChatGoal must carry taskOutcomes');

  // Gate B — completion evidence flows back (G3).
  assert.ok(
    goalSrc.includes('public completeGoal(sessionId: string, note?: string, evidence?: GoalTaskEvidence)'),
    'completeGoal must accept the GoalTaskEvidence payload'
  );
  assert.ok(
    runnerSrc.includes('mainGoalManager.recordTaskOutcome(sessionId, evidence)'),
    'the runner must record the canonical task outcome on the goal'
  );
  assert.ok(
    runnerSrc.includes('mainGoalManager.completeGoal(sessionId, \'Completed by the autonomous execution loop.\', evidence)'),
    'auto-goal completion must carry the task evidence'
  );

  // Gate C — the plan is a deliverable (G1/F4).
  const planSrc = stripComments(readFile('src/core/context/plan-builder.ts'));
  assert.ok(
    planSrc.includes('export function buildGoalPlan('),
    'buildGoalPlan must be defined in plan-builder.ts'
  );
  assert.ok(
    stripComments(readFile('src/core/context/index.ts')).includes("export * from './plan-builder'"),
    'plan-builder must be exported through the context index'
  );
  const criteriaSrc = stripComments(readFile('src/core/context/criteria-check.ts'));
  assert.ok(
    criteriaSrc.includes('export function classifyCriterion('),
    'classifyCriterion must be exported so Plan and Verify read the same criteria'
  );
  assert.ok(
    runnerSrc.includes('taskEngine.plan(task.id, planSteps)'),
    'the runner must call taskEngine.plan with the built steps, never bare'
  );
  assert.ok(
    runnerSrc.includes('buildGoalPlan({'),
    'the runner must build the plan from the session goal data'
  );
  assert.ok(
    runnerSrc.includes('Mission plan (derived from the goal'),
    'the runner must render the recorded plan into the mission prompt'
  );
  // Phase 20 Move 7 — plan steps are LIVE: the engine owns the step state
  // machine (markPlanStep + deterministic derivation from tool kinds and
  // progress records), terminal completion finishes the plan, and both the
  // mission prompt and the loop API surface per-step status.
  const engineSrc = stripComments(readFile('src/core/task/task-engine.ts'));
  assert.ok(
    engineSrc.includes('async markPlanStep('),
    'TaskEngine must expose the explicit markPlanStep transition'
  );
  assert.ok(
    engineSrc.includes('startFirstPendingStep(') && engineSrc.includes('advancePastInProgressStep('),
    'the engine must derive step status from mutation/verification tool kinds'
  );
  assert.ok(
    engineSrc.includes('advancePlanByPercent('),
    'the engine must map progress records onto plan-step slices'
  );
  assert.ok(
    engineSrc.includes("{ ...s, status: 'COMPLETED' }"),
    'terminal completion must finish every remaining plan step'
  );
  assert.ok(
    runnerSrc.includes('step.status || \'PENDING\''),
    'the mission prompt must render per-step status'
  );
  assert.ok(
    stripComments(readFile('src/channels/web/server.ts')).includes('plan: (t.plan || []).map'),
    'the loop API must surface plan steps with status'
  );
  const configSrc = stripComments(readFile('src/core/config.ts'));
  assert.ok(
    configSrc.includes("{ key: 'plan', kind: 'object', nested: [{ key: 'enabled', kind: 'boolean' }] }"),
    "agent.context.plan.enabled must be part of the strict config schema"
  );

  // Gate D — learning carries the goal (G4/F11).
  const learningSrc = stripComments(readFile('src/core/learning-manager.ts'));
  assert.ok(
    learningSrc.includes('goalId?: string;'),
    'ReviewTask must carry goalId'
  );
  assert.ok(
    learningSrc.includes('goalId: task.goalId'),
    'queueTaskReview must store the goal id'
  );
  assert.ok(
    learningSrc.includes('goalId: item.goalId ? String(item.goalId) : undefined'),
    'loadPendingReviews must round-trip goalId'
  );
  assert.ok(
    learningSrc.includes('Goal id:'),
    'the review prompt must surface the goal id'
  );
  const bridgeSrc = stripComments(readFile('src/core/memory-unified/lesson-capture.ts'));
  assert.ok(
    bridgeSrc.includes("goalId: typeof task.metadata?.goalId === 'string' ? task.metadata.goalId : undefined"),
    'TaskLessonBridge must pass the task goal id into queueTaskReview'
  );
  // Phase 20 Move 6 — goal-level retrospectives: the last linked task of an
  // auto-completed goal queues a review spanning the goal's task set, linked
  // to the goal id (Goal -> Learn attributable).
  assert.ok(
    learningSrc.includes('queueGoalReview(goal: {'),
    'queueGoalReview must exist for goal-level retrospectives'
  );
  assert.ok(
    learningSrc.includes("origin: 'goal'"),
    'goal retrospectives carry the goal origin'
  );
  assert.ok(
    learningSrc.includes('goalId: goal.goalId'),
    'queueGoalReview stores the goal id on the review'
  );
  assert.ok(
    runnerSrc.includes('this.learning.queueGoalReview({'),
    'the runner queues a goal retrospective when an auto-origin goal completes'
  );

  // Gate E — the background plan merge (Phase 20 Move 8): /goal and
  // /plan_project goals produce the same canonical plan artifact the mission
  // loop renders. BackgroundWorker derives the goal's position in the
  // project/milestone/task tree; the runner maps it to TaskPlanStep[] with
  // the goal's own work item IN_PROGRESS; executeTask carries the steps onto
  // the child Task's plan (never bare); the child mission renders them with
  // live status.
  const bgSrc = stripComments(readFile('src/core/background-worker.ts'));
  assert.ok(
    bgSrc.includes('public planStepsForGoal('),
    'BackgroundWorker must expose planStepsForGoal for the goal plan tree'
  );
  assert.ok(
    runnerSrc.includes('backgroundWorker.planStepsForGoal(goal.id)'),
    'runBackgroundGoalViaEngine must derive plan steps from the goal tree'
  );
  assert.ok(
    runnerSrc.includes("status: idx === 0 ? 'IN_PROGRESS' as const : 'PENDING' as const"),
    'the current background goal starts IN_PROGRESS and the rest PENDING'
  );
  const agentSrc = stripComments(readFile('src/core/agent/agent-engine.ts'));
  assert.ok(
    agentSrc.includes('planSteps?: TaskPlanStep[]'),
    'executeTask must accept pre-built plan steps'
  );
  assert.ok(
    agentSrc.includes('taskEngine.plan(childTask.id, options.planSteps)'),
    'executeTask must plan the child Task with the provided steps, never bare'
  );
  assert.ok(
    agentSrc.includes('Mission plan (from the project/milestone plan tree'),
    'the child mission must render the plan artifact with step status'
  );

  // Gate F — the gate is wired.
  assert.ok(scripts['smoke:phase20'], 'smoke:phase20 must be a registered script');
  assert.ok(CANONICAL_BATTERY.some((e) => e.name === 'phase20'), 'smoke:phase20 must be in the canonical battery');
  assert.ok(fast.includes('npm run smoke:phase20'), 'gate:fast must include smoke:phase20');

  console.log('phase20 gate: all invariants hold — goal<->task linkage, completion evidence, plan deliverable, learning goalId');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
