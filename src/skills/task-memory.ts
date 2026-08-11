import { Skill } from '../core/skills';
import { taskMemory } from '../core/task';

/**
 * Task Memory Skill - Allows the AI to track what it's working on
 * so it can resume tasks across sessions.
 *
 * Phase 12 D2: backed by the canonical Task system (kind 'resume') via
 * TaskMemory instead of the legacy current_task.json manager. The model-facing
 * actions and response shapes are unchanged; the records now live on canonical
 * Tasks and surface through TaskEngine queries.
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
        // The executor injects the session id for native skills when available.
        const sessionId = params?.__sessionId || params?.sessionId || 'default';

        try {
            switch (action) {
                case 'task_start': {
                    const goal = params.goal || 'Working on user request';
                    const context = params.context || [];

                    const task = await taskMemory.start(goal, sessionId, context);

                    return {
                        success: true,
                        message: `Now tracking: "${goal}"`,
                        task: taskMemory.toEntry(task)
                    };
                }

                case 'task_context': {
                    const point = params.point;
                    if (!point) return { error: 'Missing "point" parameter' };

                    const added = await taskMemory.addContext(sessionId, point);
                    if (!added) return { error: 'No active task to add context to' };

                    const current = taskMemory.current(sessionId);
                    return {
                        success: true,
                        message: `Added context: "${point}"`,
                        task: current ? taskMemory.toEntry(current) : undefined
                    };
                }

                case 'task_update': {
                    const updates: any = {};
                    if (params.goal) updates.goal = params.goal;
                    if (params.status) updates.status = params.status;

                    const updated = await taskMemory.update(sessionId, updates);
                    if (!updated) return { error: 'No active task to update' };

                    const current = taskMemory.current(sessionId);
                    return {
                        success: true,
                        message: 'Task updated',
                        task: current ? taskMemory.toEntry(current) : undefined
                    };
                }

                case 'task_complete': {
                    const completed = await taskMemory.complete(sessionId);
                    if (!completed) return { error: 'No active task to complete' };

                    return {
                        success: true,
                        message: 'Task marked as complete'
                    };
                }

                case 'task_status': {
                    const activeTask = taskMemory.current(sessionId);
                    const recentTasks = taskMemory.recent(sessionId, 5);

                    return {
                        activeTask: activeTask ? taskMemory.toEntry(activeTask) : null,
                        recentTasks: recentTasks.map((task) => taskMemory.toEntry(task)),
                        hasActiveTask: !!activeTask
                    };
                }

                case 'task_clear': {
                    await taskMemory.clear(sessionId);
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
