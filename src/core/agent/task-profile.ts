/**
 * TaskProfile — Phase 13 Step 4.
 *
 * The eligibility contract between a piece of work and the worker pool:
 *
 *   Task -> TaskProfile -> AgentEngine -> candidate Agents
 *        -> capability + role + scope + tool/permission filtering
 *        -> selected Agent
 *
 * Step 4 answers "WHO CAN do this job?" Selection ranks NOBODY on past
 * performance — performance routing is a later phase with measurement
 * infrastructure. `risk` / `complexity` / `modelRequirements` travel with the
 * profile (execution and policy read them) but are not eligibility filters.
 */

import type { Task, TaskConstraints, TaskKind } from '../task/task-types';
import type { AgentRole } from './agent-types';

export interface TaskProfileModelRequirements {
  /** Provider/model id the task prefers (pinned at execution). */
  preferredModelId?: string;
  /** ModelEngine complexity preference. */
  desiredLevel?: 'low' | 'medium' | 'high';
  /** The task needs function calling (model must support tools). */
  requiresToolCalling?: boolean;
}

export interface TaskProfile {
  /** What the task wants done (capability hints derive from this text). */
  goal: string;
  /** The kind of work — filtered against the agent's taskScope. */
  kind?: TaskKind | 'any';
  /** Explicit capability requirements (normalized against the catalog). */
  requiredCapabilities?: string[];
  /** Preferred worker role (not hard — filters candidates to that role). */
  preferredRole?: AgentRole;
  /** Host-computed task risk; travels to PolicyEngine, not an eligibility gate. */
  risk?: 'low' | 'medium' | 'high';
  /** Host-computed complexity; travels for routing decisions later. */
  complexity?: 'low' | 'medium' | 'high';
  /** Workspace the task will operate in — checked against agent path grants. */
  workspace?: string;
  /** Tools the task requires — the agent must be granted ALL of them. */
  requiredTools?: string[];
  /** Model requirements (pinning, not eligibility). */
  modelRequirements?: TaskProfileModelRequirements;
  /** Task constraints carried for execution. */
  constraints?: Partial<TaskConstraints>;
}

/**
 * Adapter from the canonical Task: goal, kind, workspace (context or
 * constraints), allowed tools, model pin, and constraints carry over. Free-text
 * capability hints are derived at selection time (the goal may change between
 * profile creation and selection).
 */
export function profileFromTask(task: Task): TaskProfile {
  return {
    goal: task.goal,
    kind: task.kind,
    workspace: task.context?.workspacePath || task.constraints?.workspacePath,
    requiredTools: [...(task.constraints?.allowedTools || [])],
    modelRequirements: task.model ? { preferredModelId: task.model } : undefined,
    constraints: {
      maxTurns: task.constraints?.maxTurns,
      maxToolCalls: task.constraints?.maxToolCalls,
      deniedTools: task.constraints?.deniedTools,
      requiresApproval: task.constraints?.requiresApproval,
      tags: task.constraints?.tags
    }
  };
}