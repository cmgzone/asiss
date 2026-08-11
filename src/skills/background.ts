import { backgroundWorker, BackgroundGoal, GoalPriority, ProjectMilestonePlan, ProjectTaskPlan } from '../core/background-worker';
import { dndManager } from '../core/dnd';
import { mainGoalManager } from '../core/main-goal';

/**
 * Background Goals Skill
 * 
 * Allows the AI and user to manage background tasks that run
 * autonomously when the user is idle.
 */

export class BackgroundGoalsSkill {
    name = 'background_goals';
    description = 'Manage background tasks that run autonomously when you are idle (or always-on if configured). Use this to queue up work for the assistant to do while you are away.';
    inputSchema = {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['add', 'list', 'cancel', 'complete', 'checkpoint', 'score', 'status', 'plan_project', 'projects', 'project', 'project_memory', 'goal_memory'],
                description: 'Action to perform'
            },
            title: {
                type: 'string',
                description: 'Title of the goal (for add action)'
            },
            description: {
                type: 'string',
                description: 'Detailed description of what to accomplish (for add action)'
            },
            priority: {
                type: 'string',
                enum: ['low', 'normal', 'high', 'urgent'],
                description: 'Priority level (for add action)'
            },
            goalId: {
                type: 'string',
                description: 'Goal ID (for cancel action)'
            },
            estimatedMinutes: {
                type: 'number',
                description: 'Estimated time in minutes (for add action)'
            },
            tags: {
                type: 'array',
                items: { type: 'string' },
                description: 'Tags for categorization (for add action)'
            },
            dependencies: {
                type: 'array',
                items: { type: 'string' },
                description: 'Goal IDs that must complete before this goal can run'
            },
            projectId: {
                type: 'string',
                description: 'Optional project ID for grouping goals'
            },
            parentId: {
                type: 'string',
                description: 'Optional parent goal ID'
            },
            milestones: {
                type: 'array',
                description: 'Optional project milestone plan for plan_project. Each milestone may contain tasks and subtasks.'
            },
            tasks: {
                type: 'array',
                description: 'Optional flat project task plan for plan_project.'
            },
            projectIdFilter: {
                type: 'string',
                description: 'Project ID to show or update'
            },
            note: {
                type: 'string',
                description: 'Completion, checkpoint, or scoring note'
            },
            filesTouched: {
                type: 'array',
                items: { type: 'string' },
                description: 'Files touched while completing a goal or project'
            },
            decisions: {
                type: 'array',
                items: { type: 'string' },
                description: 'Architectural or project decisions learned while working'
            },
            score: {
                type: 'number',
                description: 'Success score from 0 to 1'
            }
        },
        required: ['action']
    };

    async execute(args: {
        action: 'add' | 'list' | 'cancel' | 'complete' | 'checkpoint' | 'score' | 'status' | 'plan_project' | 'projects' | 'project' | 'project_memory' | 'goal_memory';
        title?: string;
        description?: string;
        priority?: GoalPriority;
        goalId?: string;
        estimatedMinutes?: number;
        tags?: string[];
        dependencies?: string[];
        projectId?: string;
        projectIdFilter?: string;
        parentId?: string;
        milestones?: ProjectMilestonePlan[];
        tasks?: ProjectTaskPlan[];
        note?: string;
        filesTouched?: string[];
        decisions?: string[];
        score?: number;
        __sessionId?: string;
    }): Promise<any> {
        const { action } = args;

        switch (action) {
            case 'add': {
                if (!args.title || !args.description) {
                    return { error: 'Title and description are required' };
                }
                const goal = backgroundWorker.addGoal({
                    title: args.title,
                    description: args.description,
                    sessionId: args.__sessionId || 'default',
                    priority: args.priority,
                    estimatedMinutes: args.estimatedMinutes,
                    tags: args.tags,
                    dependencies: args.dependencies,
                    projectId: args.projectId,
                    parentId: args.parentId
                });
                const sessionId = args.__sessionId || 'default';
                if (!mainGoalManager.getCurrent(sessionId)) {
                    mainGoalManager.setGoal(sessionId, {
                        title: args.title,
                        objective: args.description,
                        origin: 'manual',
                        confidence: 0.9
                    });
                }
                mainGoalManager.linkBackgroundGoal(sessionId, goal.id);
                return {
                    success: true,
                    goal: {
                        id: goal.id,
                        title: goal.title,
                        priority: goal.priority,
                        status: goal.status,
                        duplicateCount: goal.duplicateCount
                    },
                    message: goal.duplicateCount > 0
                        ? `Goal "${goal.title}" already exists; reused existing goal`
                        : `Goal "${goal.title}" added to background queue`
                };
            }

            case 'plan_project': {
                if (!args.title || !args.description) {
                    return { error: 'Title and description are required' };
                }
                const result = backgroundWorker.planProject({
                    title: args.title,
                    description: args.description,
                    sessionId: args.__sessionId || 'default',
                    tags: args.tags,
                    milestones: args.milestones,
                    tasks: args.tasks
                });
                const sessionId = args.__sessionId || 'default';
                if (!mainGoalManager.getCurrent(sessionId)) {
                    mainGoalManager.setGoal(sessionId, {
                        title: args.title,
                        objective: args.description,
                        origin: 'manual',
                        confidence: 1
                    });
                }
                mainGoalManager.linkProject(sessionId, result.project.id);
                return {
                    success: true,
                    reused: result.reused,
                    project: {
                        id: result.project.id,
                        title: result.project.title,
                        status: result.project.status,
                        milestones: result.project.milestoneIds.length,
                        goals: result.goals.length,
                        duplicateCount: result.project.duplicateCount
                    },
                    goals: result.goals.map(g => ({
                        id: g.id,
                        title: g.title,
                        status: g.status,
                        dependencies: g.dependencies,
                        parentId: g.parentId,
                        milestoneId: g.milestoneId
                    })),
                    message: result.reused
                        ? `Project "${result.project.title}" already exists; reused existing plan`
                        : `Project "${result.project.title}" planned with ${result.project.milestoneIds.length} milestones and ${result.goals.length} goals`
                };
            }

            case 'list': {
                const pending = backgroundWorker.getPendingGoals(args.__sessionId);
                const active = backgroundWorker.getActiveGoals(args.__sessionId);
                return {
                    pending: pending.map(g => ({
                        id: g.id,
                        title: g.title,
                        priority: g.priority,
                        blockedReason: g.blockedReason,
                        createdAt: new Date(g.createdAt).toISOString()
                    })),
                    active: active.map(g => ({
                        id: g.id,
                        title: g.title,
                        progress: g.progress,
                        attempts: g.attempts,
                        maxRetries: g.maxRetries,
                        startedAt: g.startedAt ? new Date(g.startedAt).toISOString() : null
                    }))
                };
            }

            case 'projects': {
                const projects = backgroundWorker.getProjects(args.__sessionId);
                return {
                    projects: projects.map(project => {
                        const goals = backgroundWorker.getProjectGoals(project.id);
                        return {
                            id: project.id,
                            title: project.title,
                            status: project.status,
                            goals: goals.length,
                            completedGoals: goals.filter(g => g.status === 'completed').length,
                            blockedGoals: goals.filter(g => g.blockedReason || g.status === 'failed' || g.status === 'cancelled').length,
                            updatedAt: new Date(project.updatedAt).toISOString()
                        };
                    })
                };
            }

            case 'project': {
                const projectId = args.projectIdFilter || args.projectId;
                if (!projectId) {
                    return { error: 'projectIdFilter or projectId is required' };
                }
                const project = backgroundWorker.getProject(projectId);
                if (!project || project.sessionId !== (args.__sessionId || 'default')) {
                    return { error: 'Project not found' };
                }
                const goals = backgroundWorker.getProjectGoals(project.id);
                return {
                    project,
                    goals: goals.map(g => ({
                        id: g.id,
                        title: g.title,
                        status: g.status,
                        progress: g.progress,
                        dependencies: g.dependencies,
                        blockedReason: g.blockedReason,
                        parentId: g.parentId,
                        milestoneId: g.milestoneId,
                        successScore: g.successScore
                    }))
                };
            }

            case 'cancel': {
                if (!args.goalId) {
                    return { error: 'goalId is required' };
                }
                const success = backgroundWorker.cancelGoal(args.goalId);
                return { success, message: success ? 'Goal cancelled' : 'Goal not found' };
            }

            case 'complete': {
                if (!args.goalId) {
                    return { error: 'goalId is required' };
                }
                const success = backgroundWorker.completeGoal(args.goalId, args.note || 'Marked done');
                return { success, message: success ? 'Goal marked done' : 'Goal not found' };
            }

            case 'checkpoint': {
                if (!args.goalId || !args.note) {
                    return { error: 'goalId and note are required' };
                }
                const success = backgroundWorker.checkpointGoal(args.goalId, args.note);
                return { success, message: success ? 'Checkpoint saved' : 'Goal not found' };
            }

            case 'score': {
                if (!args.goalId || typeof args.score !== 'number') {
                    return { error: 'goalId and score are required' };
                }
                const success = backgroundWorker.scoreGoal(args.goalId, args.score, args.note);
                return { success, message: success ? 'Goal scored' : 'Goal not found' };
            }

            case 'project_memory': {
                const projectId = args.projectIdFilter || args.projectId;
                if (!projectId) {
                    return { error: 'projectIdFilter or projectId is required' };
                }
                const success = backgroundWorker.recordProjectMemory(projectId, {
                    note: args.note,
                    filesTouched: args.filesTouched,
                    decisions: args.decisions
                });
                return { success, message: success ? 'Project memory recorded' : 'Project not found' };
            }

            case 'goal_memory': {
                if (!args.goalId) {
                    return { error: 'goalId is required' };
                }
                const success = backgroundWorker.recordGoalMemory(args.goalId, {
                    note: args.note,
                    filesTouched: args.filesTouched,
                    decisions: args.decisions
                });
                return { success, message: success ? 'Goal memory recorded' : 'Goal not found' };
            }

            case 'status': {
                const workerStatus = backgroundWorker.getStatus();
                const dndStatus = dndManager.getStatus();
                return {
                    worker: workerStatus,
                    dnd: {
                        inQuietHours: dndStatus.inQuietHours,
                        pendingNotifications: dndStatus.pendingCount,
                        nextNotificationTime: dndManager.getNextNotificationTime().toISOString()
                    }
                };
            }

            default:
                return { error: 'Invalid action' };
        }
    }
}

/**
 * DND Skill
 * 
 * Allows checking and managing Do Not Disturb status.
 */
export class DNDSkill {
    name = 'dnd';
    description = 'Check or manage Do Not Disturb / Quiet Hours status. Use this to see if the user prefers not to be disturbed right now.';
    inputSchema = {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['status', 'check', 'pending'],
                description: 'status = full DND status, check = quick true/false, pending = count of queued notifications'
            }
        },
        required: ['action']
    };

    async execute(args: { action: 'status' | 'check' | 'pending'; __sessionId?: string }): Promise<any> {
        switch (args.action) {
            case 'status':
                return dndManager.getStatus();
            case 'check':
                return { isQuietHours: dndManager.isQuietHours() };
            case 'pending':
                return { count: dndManager.getPendingCount(args.__sessionId) };
            default:
                return { error: 'Invalid action' };
        }
    }
}
