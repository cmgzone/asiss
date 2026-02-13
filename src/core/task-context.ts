import fs from 'fs';
import path from 'path';

export interface TaskContextEntry {
    goal: string;
    status: 'in-progress' | 'paused' | 'completed';
    context: string[];
    lastActivity: number;
    sessionId: string;
    startedAt: number;
}

export interface TaskContextData {
    currentTask: TaskContextEntry | null;
    recentTasks: TaskContextEntry[];
}

export class TaskContext {
    private filePath: string;
    private data: TaskContextData;

    constructor(filename: string = 'current_task.json') {
        this.filePath = path.join(process.cwd(), filename);
        this.data = { currentTask: null, recentTasks: [] };
        this.load();
    }

    private load() {
        if (fs.existsSync(this.filePath)) {
            try {
                const raw = fs.readFileSync(this.filePath, 'utf-8');
                const parsed = JSON.parse(raw);
                this.data = this.normalizeData(parsed);
                if (this.data.currentTask) {
                    console.log(`[TaskContext] Loaded active task: "${this.data.currentTask.goal}"`);
                }
            } catch (err) {
                console.error('[TaskContext] Failed to load:', err);
                this.data = { currentTask: null, recentTasks: [] };
            }
        }
    }

    private normalizeEntry(entry: any): TaskContextEntry {
        const context = Array.isArray(entry?.context) ? entry.context.map((v: any) => String(v)) : [];
        return {
            goal: typeof entry?.goal === 'string' ? entry.goal : '',
            status: entry?.status === 'paused' || entry?.status === 'completed' ? entry.status : 'in-progress',
            context,
            lastActivity: Number.isFinite(entry?.lastActivity) ? entry.lastActivity : Date.now(),
            sessionId: typeof entry?.sessionId === 'string' ? entry.sessionId : 'unknown',
            startedAt: Number.isFinite(entry?.startedAt) ? entry.startedAt : Date.now()
        };
    }

    private normalizeData(data: any): TaskContextData {
        const currentTask = data?.currentTask ? this.normalizeEntry(data.currentTask) : null;
        const recentTasks = Array.isArray(data?.recentTasks)
            ? data.recentTasks.map((entry: any) => this.normalizeEntry(entry))
            : [];
        return { currentTask, recentTasks };
    }

    private save() {
        try {
            fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
        } catch (err) {
            console.error('[TaskContext] Failed to save:', err);
        }
    }

    /**
     * Start or update the current task
     */
    public setTask(goal: string, sessionId: string, context: string[] = []): void {
        this.data.currentTask = {
            goal,
            status: 'in-progress',
            context,
            lastActivity: Date.now(),
            sessionId,
            startedAt: Date.now()
        };
        this.save();
        console.log(`[TaskContext] Started task: "${goal}"`);
    }

    /**
     * Add context point to current task
     */
    public addContext(point: string): boolean {
        if (!this.data.currentTask) return false;

        this.data.currentTask.context.push(point);
        this.data.currentTask.lastActivity = Date.now();
        this.save();
        console.log(`[TaskContext] Added context: "${point}"`);
        return true;
    }

    /**
     * Update the current task goal or status
     */
    public updateTask(updates: Partial<Pick<TaskContextEntry, 'goal' | 'status'>>): boolean {
        if (!this.data.currentTask) return false;

        if (updates.goal) this.data.currentTask.goal = updates.goal;
        if (updates.status) this.data.currentTask.status = updates.status;
        this.data.currentTask.lastActivity = Date.now();
        this.save();
        return true;
    }

    /**
     * Mark current task as completed
     */
    public completeTask(): boolean {
        if (!this.data.currentTask) return false;

        this.data.currentTask.status = 'completed';
        this.data.currentTask.lastActivity = Date.now();

        // Move to recent tasks
        this.data.recentTasks.unshift(this.data.currentTask);
        if (this.data.recentTasks.length > 10) {
            this.data.recentTasks = this.data.recentTasks.slice(0, 10);
        }

        const completedGoal = this.data.currentTask.goal;
        this.data.currentTask = null;
        this.save();
        console.log(`[TaskContext] Completed task: "${completedGoal}"`);
        return true;
    }

    /**
     * Get the active task
     */
    public getActiveTask(): TaskContextEntry | null {
        return this.data.currentTask;
    }

    /**
     * Get recent completed tasks
     */
    public getRecentTasks(): TaskContextEntry[] {
        return this.data.recentTasks;
    }

    /**
     * Check if there's an unfinished task from a previous session
     */
    public hasUnfinishedTask(): boolean {
        return this.data.currentTask !== null && this.data.currentTask.status === 'in-progress';
    }

    /**
     * Generate a summary prompt for AI injection
     */
    public getSummaryPrompt(): string {
        if (!this.data.currentTask) return '';

        const task = this.data.currentTask;
        const timeSince = Date.now() - task.lastActivity;
        const minutesAgo = Math.round(timeSince / (1000 * 60));

        let prompt = `\n## Current Task (Resume)\n`;
        prompt += `You were working on: **${task.goal}**\n`;
        prompt += `Status: ${task.status} (last activity: ${minutesAgo} minutes ago)\n`;

        const contextItems = Array.isArray(task.context) ? task.context : [];
        if (contextItems.length > 0) {
            prompt += `\nContext points:\n`;
            contextItems.forEach((ctx, i) => {
                prompt += `${i + 1}. ${ctx}\n`;
            });
        }

        prompt += `\nYou should ask the user if they want to continue this task or start something new.\n`;

        return prompt;
    }

    /**
     * Clear the current task without completing it
     */
    public clearTask(): void {
        if (this.data.currentTask) {
            this.data.currentTask.status = 'paused';
            this.data.recentTasks.unshift(this.data.currentTask);
        }
        this.data.currentTask = null;
        this.save();
    }
}

export const taskContext = new TaskContext();
