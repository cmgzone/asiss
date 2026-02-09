import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { dndManager } from './dnd';

/**
 * Background Worker - Autonomous Task Execution
 * 
 * Unlike the scheduler which runs user-prompted tasks at specific times,
 * the background worker proactively works on a goal queue when:
 * - The user is idle
 * - It's not quiet hours (unless task is urgent)
 * - There are pending goals to work on
 */

export type GoalPriority = 'low' | 'normal' | 'high' | 'urgent';
export type GoalStatus = 'pending' | 'in-progress' | 'completed' | 'failed' | 'paused';

export interface BackgroundGoal {
    id: string;
    title: string;
    description: string;
    priority: GoalPriority;
    status: GoalStatus;
    sessionId: string;
    createdAt: number;
    startedAt?: number;
    completedAt?: number;
    progress: number;        // 0-100
    progressNotes: string[];
    result?: string;
    error?: string;
    estimatedMinutes?: number;
    tags: string[];
}

export interface BackgroundWorkerConfig {
    enabled: boolean;
    maxConcurrentGoals: number;
    idleThresholdMs: number;      // How long user must be idle before starting work
    checkIntervalMs: number;      // How often to check for work
    respectDND: boolean;          // Pause non-urgent work during quiet hours
    reportOnCompletion: boolean;  // Send message when goal completes
}

type GoalExecutor = (goal: BackgroundGoal, progressCallback: (percent: number, note: string) => void) => Promise<string>;

export class BackgroundWorker {
    private goalsPath: string;
    private configPath: string;
    private goals: Record<string, BackgroundGoal> = {};
    private config: BackgroundWorkerConfig;
    private checkInterval: NodeJS.Timeout | null = null;
    private activeGoals: Set<string> = new Set();
    private executor: GoalExecutor | null = null;
    private lastUserActivityAt: Map<string, number> = new Map();
    private onComplete: ((goal: BackgroundGoal) => Promise<void>) | null = null;

    constructor() {
        this.goalsPath = path.join(process.cwd(), 'background_goals.json');
        this.configPath = path.join(process.cwd(), 'config.json');
        this.config = {
            enabled: false,
            maxConcurrentGoals: 1,
            idleThresholdMs: 5 * 60 * 1000,  // 5 minutes
            checkIntervalMs: 60 * 1000,       // 1 minute
            respectDND: true,
            reportOnCompletion: true
        };
        this.load();
    }

    private load() {
        // Load config
        if (fs.existsSync(this.configPath)) {
            try {
                const config = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
                if (config.backgroundWorker && typeof config.backgroundWorker === 'object') {
                    this.config = { ...this.config, ...config.backgroundWorker };
                }
            } catch {
                // Use defaults
            }
        }

        // Load goals
        if (fs.existsSync(this.goalsPath)) {
            try {
                this.goals = JSON.parse(fs.readFileSync(this.goalsPath, 'utf-8')) || {};
            } catch {
                this.goals = {};
            }
        }
    }

    private save() {
        try {
            fs.writeFileSync(this.goalsPath, JSON.stringify(this.goals, null, 2));
        } catch {
            console.error('[BackgroundWorker] Failed to save goals');
        }
    }

    /**
     * Set the goal executor function (called by AgentRunner)
     */
    public setExecutor(executor: GoalExecutor) {
        this.executor = executor;
    }

    /**
     * Set completion callback (for notifications)
     */
    public setOnComplete(callback: (goal: BackgroundGoal) => Promise<void>) {
        this.onComplete = callback;
    }

    /**
     * Record user activity (called on each message)
     */
    public recordActivity(sessionId: string) {
        this.lastUserActivityAt.set(sessionId, Date.now());
    }

    /**
     * Check if user is idle
     */
    public isUserIdle(sessionId: string): boolean {
        const lastActivity = this.lastUserActivityAt.get(sessionId);
        if (!lastActivity) return true;
        return Date.now() - lastActivity >= this.config.idleThresholdMs;
    }

    /**
     * Add a goal to the background queue
     */
    public addGoal(params: {
        title: string;
        description: string;
        sessionId: string;
        priority?: GoalPriority;
        estimatedMinutes?: number;
        tags?: string[];
    }): BackgroundGoal {
        const goal: BackgroundGoal = {
            id: uuidv4(),
            title: params.title,
            description: params.description,
            priority: params.priority || 'normal',
            status: 'pending',
            sessionId: params.sessionId,
            createdAt: Date.now(),
            progress: 0,
            progressNotes: [],
            estimatedMinutes: params.estimatedMinutes,
            tags: params.tags || []
        };

        this.goals[goal.id] = goal;
        this.save();
        console.log(`[BackgroundWorker] Added goal: ${goal.title} (${goal.id})`);
        return goal;
    }

    /**
     * Get pending goals sorted by priority
     */
    public getPendingGoals(sessionId?: string): BackgroundGoal[] {
        const priorityOrder: Record<GoalPriority, number> = {
            urgent: 0,
            high: 1,
            normal: 2,
            low: 3
        };

        return Object.values(this.goals)
            .filter(g => g.status === 'pending' && (!sessionId || g.sessionId === sessionId))
            .sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
    }

    /**
     * Get active (in-progress) goals
     */
    public getActiveGoals(): BackgroundGoal[] {
        return Object.values(this.goals).filter(g => g.status === 'in-progress');
    }

    /**
     * Get goal by ID
     */
    public getGoal(id: string): BackgroundGoal | undefined {
        return this.goals[id];
    }

    /**
     * Cancel a goal
     */
    public cancelGoal(id: string): boolean {
        const goal = this.goals[id];
        if (!goal) return false;

        goal.status = 'failed';
        goal.error = 'Cancelled by user';
        goal.completedAt = Date.now();
        this.save();
        this.activeGoals.delete(id);
        return true;
    }

    /**
     * Start the background worker loop
     */
    public start() {
        if (!this.config.enabled) {
            console.log('[BackgroundWorker] Disabled in config');
            return;
        }

        if (this.checkInterval) {
            clearInterval(this.checkInterval);
        }

        console.log(`[BackgroundWorker] Started (check every ${this.config.checkIntervalMs}ms)`);

        this.checkInterval = setInterval(() => {
            this.tick();
        }, this.config.checkIntervalMs);
    }

    /**
     * Stop the background worker
     */
    public stop() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
            console.log('[BackgroundWorker] Stopped');
        }
    }

    /**
     * Main tick - check if we should work on goals
     */
    private async tick() {
        // Check DND
        if (this.config.respectDND && dndManager.isQuietHours()) {
            // Only process urgent goals during quiet hours
            const urgentGoals = this.getPendingGoals().filter(g => g.priority === 'urgent');
            if (urgentGoals.length === 0) {
                return;
            }
        }

        // Check capacity
        if (this.activeGoals.size >= this.config.maxConcurrentGoals) {
            return;
        }

        // Find next goal to work on
        const pending = this.getPendingGoals();
        if (pending.length === 0) return;

        // Find a goal where the user is idle
        for (const goal of pending) {
            if (this.activeGoals.has(goal.id)) continue;

            // Check if user is idle for this session
            if (!this.isUserIdle(goal.sessionId)) {
                continue;
            }

            // Start working on this goal
            this.executeGoal(goal);
            break;
        }
    }

    /**
     * Execute a goal
     */
    private async executeGoal(goal: BackgroundGoal) {
        if (!this.executor) {
            console.error('[BackgroundWorker] No executor set');
            return;
        }

        this.activeGoals.add(goal.id);
        goal.status = 'in-progress';
        goal.startedAt = Date.now();
        this.save();

        console.log(`[BackgroundWorker] Starting: ${goal.title}`);

        try {
            const result = await this.executor(goal, (percent, note) => {
                // Progress callback
                goal.progress = percent;
                if (note) goal.progressNotes.push(`[${new Date().toISOString()}] ${note}`);
                this.save();
            });

            goal.status = 'completed';
            goal.result = result;
            goal.progress = 100;
            goal.completedAt = Date.now();
            console.log(`[BackgroundWorker] Completed: ${goal.title}`);

            // Notify if configured
            if (this.config.reportOnCompletion && this.onComplete) {
                // Respect DND for non-urgent completion notifications
                if (this.config.respectDND && dndManager.isQuietHours() && goal.priority !== 'urgent') {
                    dndManager.queueNotification(
                        goal.sessionId,
                        `✅ Background task completed: **${goal.title}**\n\n${result || 'Done'}`,
                        'normal'
                    );
                } else {
                    await this.onComplete(goal);
                }
            }
        } catch (err: any) {
            goal.status = 'failed';
            goal.error = err.message || 'Unknown error';
            goal.completedAt = Date.now();
            console.error(`[BackgroundWorker] Failed: ${goal.title}`, err);
        } finally {
            this.activeGoals.delete(goal.id);
            this.save();
        }
    }

    /**
     * Get status summary
     */
    public getStatus(): {
        enabled: boolean;
        activeCount: number;
        pendingCount: number;
        completedToday: number;
    } {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayMs = today.getTime();

        const completedToday = Object.values(this.goals).filter(
            g => g.status === 'completed' && g.completedAt && g.completedAt >= todayMs
        ).length;

        return {
            enabled: this.config.enabled,
            activeCount: this.activeGoals.size,
            pendingCount: this.getPendingGoals().length,
            completedToday
        };
    }
}

export const backgroundWorker = new BackgroundWorker();
