import { backgroundWorker, BackgroundGoal, GoalPriority } from '../core/background-worker';
import { dndManager } from '../core/dnd';

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
                enum: ['add', 'list', 'cancel', 'status'],
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
            }
        },
        required: ['action']
    };

    async execute(args: {
        action: 'add' | 'list' | 'cancel' | 'status';
        title?: string;
        description?: string;
        priority?: GoalPriority;
        goalId?: string;
        estimatedMinutes?: number;
        tags?: string[];
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
                    tags: args.tags
                });
                return {
                    success: true,
                    goal: {
                        id: goal.id,
                        title: goal.title,
                        priority: goal.priority,
                        status: goal.status
                    },
                    message: `Goal "${goal.title}" added to background queue`
                };
            }

            case 'list': {
                const pending = backgroundWorker.getPendingGoals(args.__sessionId);
                const active = backgroundWorker.getActiveGoals();
                return {
                    pending: pending.map(g => ({
                        id: g.id,
                        title: g.title,
                        priority: g.priority,
                        createdAt: new Date(g.createdAt).toISOString()
                    })),
                    active: active.map(g => ({
                        id: g.id,
                        title: g.title,
                        progress: g.progress,
                        startedAt: g.startedAt ? new Date(g.startedAt).toISOString() : null
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
