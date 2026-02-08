import { Skill } from '../core/skills';
import { taskContext } from '../core/task-context';

/**
 * Task Memory Skill - Allows the AI to track what it's working on
 * so it can resume tasks across sessions.
 */
export class TaskMemorySkill implements Skill {
    name = 'task_memory';
    description = `Track and remember what you're working on across sessions.

ACTIONS:
- task_start (goal, context?) - Start tracking a new task/goal
- task_context (point) - Add a context point to the current task
- task_update (goal?, status?) - Update the current task
- task_complete - Mark current task as finished
- task_status - Get current task info
- task_clear - Clear current task without completing

Use this when starting significant work to ensure continuity.
The system will remind you of unfinished tasks on startup.`;

    inputSchema = {
        type: "object",
        properties: {
            action: {
                type: "string",
                enum: ["task_start", "task_context", "task_update", "task_complete", "task_status", "task_clear"],
                description: "The action to perform"
            },
            goal: {
                type: "string",
                description: "The goal or task description"
            },
            context: {
                type: "array",
                items: { type: "string" },
                description: "Initial context points for the task"
            },
            point: {
                type: "string",
                description: "A context point to add to the current task"
            },
            status: {
                type: "string",
                enum: ["in-progress", "paused"],
                description: "Task status"
            }
        },
        required: ["action"]
    };

    async execute(params: any): Promise<any> {
        const action = params?.action;

        try {
            switch (action) {
                case 'task_start': {
                    const goal = params.goal || 'Working on user request';
                    const context = params.context || [];
                    const sessionId = params.sessionId || 'default';

                    taskContext.setTask(goal, sessionId, context);

                    return {
                        success: true,
                        message: `Now tracking: "${goal}"`,
                        task: taskContext.getActiveTask()
                    };
                }

                case 'task_context': {
                    const point = params.point;
                    if (!point) return { error: 'Missing "point" parameter' };

                    const added = taskContext.addContext(point);
                    if (!added) return { error: 'No active task to add context to' };

                    return {
                        success: true,
                        message: `Added context: "${point}"`,
                        task: taskContext.getActiveTask()
                    };
                }

                case 'task_update': {
                    const updates: any = {};
                    if (params.goal) updates.goal = params.goal;
                    if (params.status) updates.status = params.status;

                    const updated = taskContext.updateTask(updates);
                    if (!updated) return { error: 'No active task to update' };

                    return {
                        success: true,
                        message: 'Task updated',
                        task: taskContext.getActiveTask()
                    };
                }

                case 'task_complete': {
                    const completed = taskContext.completeTask();
                    if (!completed) return { error: 'No active task to complete' };

                    return {
                        success: true,
                        message: 'Task marked as complete'
                    };
                }

                case 'task_status': {
                    const activeTask = taskContext.getActiveTask();
                    const recentTasks = taskContext.getRecentTasks();

                    return {
                        activeTask,
                        recentTasks: recentTasks.slice(0, 5),
                        hasActiveTask: !!activeTask
                    };
                }

                case 'task_clear': {
                    taskContext.clearTask();
                    return {
                        success: true,
                        message: 'Current task cleared (moved to recent)'
                    };
                }

                default:
                    return {
                        error: `Unknown action: ${action}`,
                        allowedActions: ["task_start", "task_context", "task_update", "task_complete", "task_status", "task_clear"]
                    };
            }
        } catch (err: any) {
            return { error: `TaskMemory error: ${err.message}` };
        }
    }
}
