/**
 * Phase 20 Move 3 — the plan is a real artifact (docs/hermes/AUDIT_11.md, G1).
 *
 * `buildGoalPlan` turns the goal's OWN data into `TaskPlanStep[]` — the goal
 * text, its acceptance criteria ("Done means: …"), and its constraints — with
 * no model call and no second execution authority. The Phase 19 criteria
 * classifier (`classifyCriterion`) is reused so Plan and Verify read the SAME
 * interpretation of the SAME criteria: a test-command criterion becomes a
 * "Run …" step, a file-contains criterion becomes an "Update or verify …"
 * step, an uncheckable criterion becomes a "Confirm …" step. The steps land
 * on the canonical Task at beginMissionTask and render into the mission
 * prompt as an advisory section (agent.context.plan.enabled, default on).
 *
 * Step-status tracking (IN_PROGRESS / COMPLETED as the mission advances) is
 * documented polish — this is a goal-owned guide, not a second execution
 * authority. Returns undefined when there is nothing to plan (informational
 * goals without criteria/constraints), preserving the bare plan() path.
 */
import type { TaskPlanStep } from '../task/task-types';
import { classifyCriterion } from './criteria-check';

/** Light actionability signal, mirroring main-goal's isActionable. */
const ACTIONABLE = /\b(fix|create|build|make|add|remove|update|change|implement|debug|review|check|test|run|write|refactor|migrate|deploy|install|configure|prepare|research|investigate|port)\b/i;

export interface GoalPlanInput {
  goal: string;
  acceptanceCriteria?: string[];
  constraints?: string[];
  /** Cap on the number of steps (default 8). */
  maxSteps?: number;
}

/**
 * Derive a deterministic plan from the goal's own data. Every step carries a
 * stable id and PENDING status; the plan is a guide the mission prompt
 * renders, not an execution schedule.
 */
export function buildGoalPlan(input: GoalPlanInput): TaskPlanStep[] | undefined {
  const goal = String(input.goal || '').trim();
  const criteria = (input.acceptanceCriteria || [])
    .map((c) => String(c || '').trim())
    .filter(Boolean)
    .slice(0, 30);
  const constraints = (input.constraints || [])
    .map((c) => String(c || '').trim())
    .filter(Boolean)
    .slice(0, 30);
  if (!goal && criteria.length === 0 && constraints.length === 0) return undefined;
  const maxSteps = Math.max(1, Math.floor(Number(input.maxSteps) || 8));

  const steps: TaskPlanStep[] = [];
  const push = (title: string, description?: string) => {
    steps.push({ id: `plan-${steps.length + 1}`, title, description, status: 'PENDING' });
  };

  if (ACTIONABLE.test(goal)) {
    push('Understand the goal and current state', goal.slice(0, 300));
  }

  for (const criterion of criteria) {
    const cls = classifyCriterion(criterion);
    if (cls.kind === 'test-command' && cls.command) {
      push(`Run \`${cls.command}\``, criterion);
    } else if (cls.kind === 'file-contains' && cls.file) {
      push(`Update or verify ${cls.file}`, criterion);
    } else {
      push(`Confirm: ${criterion.slice(0, 200)}`, 'stated acceptance criterion (no deterministic check)');
    }
  }

  if (constraints.length > 0) {
    push('Honor constraints', constraints.join(' | ').slice(0, 400));
  }

  if (criteria.length > 0 && steps.length > 0) {
    push('Verify completion', 'Run the acceptance criteria and goal-matched tests; repair failures before finishing.');
  }

  if (steps.length === 0) return undefined;
  return steps.slice(0, maxSteps);
}
