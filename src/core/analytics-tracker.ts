import fs from 'fs';
import path from 'path';

/**
 * Analytics Tracker - Tracks task completions, agent performance, and system metrics.
 * Persists data to analytics_data.json for dashboard display.
 */

export interface AnalyticsEvent {
    id: string;
    // Phase 16 Move 6 (AUDIT_7): 'agent_run' removed — it was never emitted or
    // consumed; agent-run bookkeeping belongs to the canonical Task system.
    type: 'task_complete' | 'task_failed' | 'goal_complete' | 'goal_failed' | 'tool_call' | 'message';
    timestamp: number;
    sessionId?: string;
    agentId?: string;
    agentName?: string;
    durationMs?: number;
    metadata?: Record<string, any>;
}

export interface DailyStat {
    date: string;        // YYYY-MM-DD
    tasks: number;
    successes: number;
    failures: number;
    toolCalls: number;
    messages: number;
    goalsDone: number;
}

export interface AgentPerformance {
    agentId: string;
    agentName: string;
    totalTasks: number;
    successes: number;
    failures: number;
    avgDurationMs: number;
    lastActive: number;
}

export interface AnalyticsOverview {
    totalTasks: number;
    totalSuccesses: number;
    totalFailures: number;
    successRate: number;
    avgDurationMs: number;
    totalGoals: number;
    goalsCompleted: number;
    totalToolCalls: number;
    totalMessages: number;
    activeAgents: number;
    uptimeMs: number;
}

export interface ToolUsageStat {
    toolName: string;
    calls: number;
    successes: number;
    failures: number;
    lastUsed: number;
}

interface AnalyticsData {
    events: AnalyticsEvent[];
    startedAt: number;
}

export class AnalyticsTracker {
    private filePath: string;
    private data: AnalyticsData;
    private dirty = false;
    private saveInterval: NodeJS.Timeout | null = null;
    private maxEvents = 5000; // Cap events to prevent unbounded growth

    constructor(filePath?: string) {
        this.filePath = filePath || path.join(process.cwd(), 'analytics_data.json');
        this.data = { events: [], startedAt: Date.now() };
        this.load();

        // Debounced save every 10 seconds
        this.saveInterval = setInterval(() => {
            if (this.dirty) {
                this.save();
                this.dirty = false;
            }
        }, 10000);
    }

    private load() {
        if (fs.existsSync(this.filePath)) {
            try {
                const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
                this.data = {
                    events: Array.isArray(raw.events) ? raw.events : [],
                    startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : Date.now()
                };
            } catch {
                this.data = { events: [], startedAt: Date.now() };
            }
        }
    }

    private save() {
        try {
            // Trim old events if over cap
            if (this.data.events.length > this.maxEvents) {
                this.data.events = this.data.events.slice(-this.maxEvents);
            }
            fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
        } catch (err) {
            console.error('[Analytics] Failed to save:', err);
        }
    }

    // ===== RECORDING =====

    public record(event: Omit<AnalyticsEvent, 'id' | 'timestamp'>): void {
        const entry: AnalyticsEvent = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: Date.now(),
            ...event
        };
        this.data.events.push(entry);
        this.dirty = true;
    }

    public recordTaskComplete(sessionId: string, durationMs?: number, metadata?: Record<string, any>): void {
        this.record({ type: 'task_complete', sessionId, durationMs, metadata });
    }

    public recordTaskFailed(sessionId: string, metadata?: Record<string, any>): void {
        this.record({ type: 'task_failed', sessionId, metadata });
    }

    public recordGoalComplete(sessionId: string, agentName?: string, durationMs?: number): void {
        this.record({ type: 'goal_complete', sessionId, agentName, durationMs });
    }

    public recordGoalFailed(sessionId: string, agentName?: string): void {
        this.record({ type: 'goal_failed', sessionId, agentName });
    }

    public recordToolCall(sessionId: string, toolName: string): void {
        this.record({ type: 'tool_call', sessionId, metadata: { toolName } });
    }

    /** Record the outcome of a tool call (ok/error) for per-tool usage stats. */
    public recordToolCallResult(sessionId: string, toolName: string, success: boolean): void {
        this.record({
            type: 'tool_call',
            sessionId,
            metadata: { toolName, result: success ? 'ok' : 'error' }
        });
    }

    public recordMessage(sessionId: string): void {
        this.record({ type: 'message', sessionId });
    }

    // ===== AGGREGATION =====

    private formatDateKey(d: Date): string {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    }

    public getDailyStats(days: number = 7): DailyStat[] {
        const now = new Date();
        const result: DailyStat[] = [];

        for (let i = days - 1; i >= 0; i--) {
            const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
            const key = this.formatDateKey(d);
            const dayStart = new Date(d);
            dayStart.setHours(0, 0, 0, 0);
            const dayEnd = new Date(d);
            dayEnd.setHours(23, 59, 59, 999);

            const dayEvents = this.data.events.filter(
                e => e.timestamp >= dayStart.getTime() && e.timestamp <= dayEnd.getTime()
            );

            result.push({
                date: key,
                tasks: dayEvents.filter(e => e.type === 'task_complete' || e.type === 'task_failed').length,
                successes: dayEvents.filter(e => e.type === 'task_complete').length,
                failures: dayEvents.filter(e => e.type === 'task_failed').length,
                toolCalls: dayEvents.filter(e => e.type === 'tool_call').length,
                messages: dayEvents.filter(e => e.type === 'message').length,
                goalsDone: dayEvents.filter(e => e.type === 'goal_complete').length
            });
        }

        return result;
    }

    public getToolUsageStats(): ToolUsageStat[] {
        const byName = new Map<string, ToolUsageStat>();

        for (const event of this.data.events) {
            if (event.type !== 'tool_call') continue;
            const toolName = String(event.metadata?.toolName || '').trim();
            if (!toolName) continue;

            let entry = byName.get(toolName);
            if (!entry) {
                entry = { toolName, calls: 0, successes: 0, failures: 0, lastUsed: 0 };
                byName.set(toolName, entry);
            }
            entry.calls += 1;
            const result = event.metadata?.result;
            if (result === 'ok') entry.successes += 1;
            else if (result === 'error') entry.failures += 1;
            if (event.timestamp > entry.lastUsed) entry.lastUsed = event.timestamp;
        }

        return Array.from(byName.values())
            .sort((a, b) => b.calls - a.calls || b.lastUsed - a.lastUsed);
    }

    public getAgentPerformance(): AgentPerformance[] {
        const agentMap = new Map<string, {
            agentName: string;
            total: number;
            successes: number;
            failures: number;
            totalDuration: number;
            durationCount: number;
            lastActive: number;
        }>();

        for (const event of this.data.events) {
            if (!event.agentId) continue;
            if (event.type !== 'task_complete' && event.type !== 'task_failed') continue;

            let entry = agentMap.get(event.agentId);
            if (!entry) {
                entry = {
                    agentName: event.agentName || event.agentId,
                    total: 0,
                    successes: 0,
                    failures: 0,
                    totalDuration: 0,
                    durationCount: 0,
                    lastActive: 0
                };
                agentMap.set(event.agentId, entry);
            }

            entry.total += 1;
            if (event.type === 'task_complete') entry.successes += 1;
            if (event.type === 'task_failed') entry.failures += 1;
            if (event.durationMs && event.durationMs > 0) {
                entry.totalDuration += event.durationMs;
                entry.durationCount += 1;
            }
            if (event.timestamp > entry.lastActive) {
                entry.lastActive = event.timestamp;
            }
        }

        return Array.from(agentMap.entries()).map(([agentId, data]) => ({
            agentId,
            agentName: data.agentName,
            totalTasks: data.total,
            successes: data.successes,
            failures: data.failures,
            avgDurationMs: data.durationCount > 0 ? Math.round(data.totalDuration / data.durationCount) : 0,
            lastActive: data.lastActive
        })).sort((a, b) => b.totalTasks - a.totalTasks);
    }

    public getOverview(): AnalyticsOverview {
        const events = this.data.events;
        const tasks = events.filter(e => e.type === 'task_complete' || e.type === 'task_failed');
        const successes = events.filter(e => e.type === 'task_complete');
        const failures = events.filter(e => e.type === 'task_failed');
        const goals = events.filter(e => e.type === 'goal_complete' || e.type === 'goal_failed');
        const goalsCompleted = events.filter(e => e.type === 'goal_complete');
        const toolCalls = events.filter(e => e.type === 'tool_call');
        const messages = events.filter(e => e.type === 'message');

        const durations = successes.filter(e => e.durationMs && e.durationMs > 0).map(e => e.durationMs!);
        const avgDuration = durations.length > 0
            ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
            : 0;

        const uniqueAgents = new Set(events.filter(e => e.agentId).map(e => e.agentId));

        return {
            totalTasks: tasks.length,
            totalSuccesses: successes.length,
            totalFailures: failures.length,
            successRate: tasks.length > 0 ? Math.round((successes.length / tasks.length) * 100) : 0,
            avgDurationMs: avgDuration,
            totalGoals: goals.length,
            goalsCompleted: goalsCompleted.length,
            totalToolCalls: toolCalls.length,
            totalMessages: messages.length,
            activeAgents: uniqueAgents.size,
            uptimeMs: Date.now() - this.data.startedAt
        };
    }

    public getGoalStats(): { total: number; completed: number; failed: number; recentGoals: AnalyticsEvent[] } {
        const goalEvents = this.data.events.filter(e => e.type === 'goal_complete' || e.type === 'goal_failed');
        return {
            total: goalEvents.length,
            completed: goalEvents.filter(e => e.type === 'goal_complete').length,
            failed: goalEvents.filter(e => e.type === 'goal_failed').length,
            recentGoals: goalEvents.slice(-20).reverse()
        };
    }

    public stop() {
        if (this.saveInterval) {
            clearInterval(this.saveInterval);
            this.saveInterval = null;
        }
        if (this.dirty) {
            this.save();
        }
    }
}

// Singleton
export const analyticsTracker = new AnalyticsTracker();
