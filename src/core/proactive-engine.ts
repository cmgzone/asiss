import fs from 'fs';
import path from 'path';
import { analyticsTracker } from './analytics-tracker';

/**
 * Proactive Engine — Analyzes system state and generates smart suggestions
 * during idle periods. Detects stale projects, upcoming tasks, error patterns,
 * and unread collaboration results.
 */

export interface ProactiveSuggestion {
    id: string;
    type: 'stale_project' | 'upcoming_task' | 'error_pattern' | 'unread_collab' | 'optimization' | 'reminder';
    priority: 'low' | 'medium' | 'high';
    title: string;
    description: string;
    actionHint?: string;       // suggested user action
    createdAt: number;
    dismissed?: boolean;
}

interface ProactiveConfig {
    enabled: boolean;
    maxSuggestionsPerDay: number;
    staleProjectDays: number;         // days without activity to flag
    errorPatternThreshold: number;    // consecutive errors to flag
    checkIntervalMs: number;
}

const DEFAULT_CONFIG: ProactiveConfig = {
    enabled: true,
    maxSuggestionsPerDay: 5,
    staleProjectDays: 3,
    errorPatternThreshold: 3,
    checkIntervalMs: 300000,  // 5 minutes
};

export class ProactiveEngine {
    private config: ProactiveConfig;
    private suggestions: ProactiveSuggestion[] = [];
    private suggestionsToday = 0;
    private lastCheckDate: string = '';

    constructor() {
        this.config = this.loadConfig();
    }

    private loadConfig(): ProactiveConfig {
        try {
            const configPath = path.join(process.cwd(), 'config.json');
            if (fs.existsSync(configPath)) {
                const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
                if (raw.proactive) {
                    return { ...DEFAULT_CONFIG, ...raw.proactive };
                }
            }
        } catch (e) {
            console.error('[ProactiveEngine] Failed to load config:', e);
        }
        return { ...DEFAULT_CONFIG };
    }

    private formatDateKey(d: Date): string {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    private resetDailyCounterIfNeeded() {
        const today = this.formatDateKey(new Date());
        if (today !== this.lastCheckDate) {
            this.suggestionsToday = 0;
            this.lastCheckDate = today;
        }
    }

    /**
     * Run all proactive checks and return new suggestions.
     */
    async generateSuggestions(): Promise<ProactiveSuggestion[]> {
        if (!this.config.enabled) return [];

        this.resetDailyCounterIfNeeded();
        if (this.suggestionsToday >= this.config.maxSuggestionsPerDay) return [];

        const newSuggestions: ProactiveSuggestion[] = [];

        // 1. Check for stale projects
        const staleSuggestions = this.checkStaleProjects();
        newSuggestions.push(...staleSuggestions);

        // 2. Check for error patterns
        const errorSuggestions = this.checkErrorPatterns();
        newSuggestions.push(...errorSuggestions);

        // 3. Check for optimization opportunities
        const optimizationSuggestions = this.checkOptimizations();
        newSuggestions.push(...optimizationSuggestions);

        // Respect daily limit
        const remaining = this.config.maxSuggestionsPerDay - this.suggestionsToday;
        const toAdd = newSuggestions.slice(0, remaining);
        this.suggestionsToday += toAdd.length;
        this.suggestions.push(...toAdd);

        return toAdd;
    }

    private checkStaleProjects(): ProactiveSuggestion[] {
        const results: ProactiveSuggestion[] = [];
        try {
            const dataPath = path.join(process.cwd(), 'projects_data.json');
            if (!fs.existsSync(dataPath)) return [];
            const data = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
            const projects = data.projects || [];
            const now = Date.now();
            const staleCutoff = now - this.config.staleProjectDays * 24 * 60 * 60 * 1000;

            for (const project of projects) {
                if (project.status === 'completed' || project.status === 'archived') continue;
                const lastUpdated = new Date(project.updatedAt || project.createdAt || 0).getTime();
                if (lastUpdated < staleCutoff) {
                    const daysSince = Math.floor((now - lastUpdated) / (24 * 60 * 60 * 1000));
                    results.push({
                        id: `stale_${project.id || project.name}`,
                        type: 'stale_project',
                        priority: daysSince > 7 ? 'high' : 'medium',
                        title: `Project "${project.name}" needs attention`,
                        description: `No activity in ${daysSince} days. It's ${project.progress || 0}% complete with ${project.taskCount || 0} tasks.`,
                        actionHint: `Check on project "${project.name}" or update its status.`,
                        createdAt: now
                    });
                }
            }
        } catch { /* ignore */ }
        return results;
    }

    private checkErrorPatterns(): ProactiveSuggestion[] {
        const results: ProactiveSuggestion[] = [];
        try {
            const overview = analyticsTracker.getOverview();
            if (overview.totalFailures >= this.config.errorPatternThreshold) {
                const rate = overview.totalTasks > 0
                    ? Math.round((overview.totalFailures / overview.totalTasks) * 100) : 0;
                if (rate > 20) {
                    results.push({
                        id: `error_rate_${Date.now()}`,
                        type: 'error_pattern',
                        priority: rate > 50 ? 'high' : 'medium',
                        title: `High failure rate detected: ${rate}%`,
                        description: `${overview.totalFailures} out of ${overview.totalTasks} tasks have failed. This may indicate a configuration issue or model problem.`,
                        actionHint: 'Check your model configuration and API keys. Review recent errors in the Analytics tab.',
                        createdAt: Date.now()
                    });
                }
            }
        } catch { /* ignore */ }
        return results;
    }

    private checkOptimizations(): ProactiveSuggestion[] {
        const results: ProactiveSuggestion[] = [];
        try {
            const overview = analyticsTracker.getOverview();

            // Suggest thinking level adjustment if response times are slow
            if (overview.avgDurationMs > 15000 && overview.totalTasks > 5) {
                results.push({
                    id: `perf_slow_${Date.now()}`,
                    type: 'optimization',
                    priority: 'low',
                    title: 'Response times are above average',
                    description: `Average response time is ${Math.round(overview.avgDurationMs / 1000)}s. Consider using a faster model for simple queries.`,
                    actionHint: 'Enable model routing in config.json to auto-route simple queries to faster models.',
                    createdAt: Date.now()
                });
            }

            // Suggest auto-compact if many messages
            if (overview.totalMessages > 500) {
                results.push({
                    id: `compact_${Date.now()}`,
                    type: 'optimization',
                    priority: 'low',
                    title: 'Large conversation history',
                    description: `${overview.totalMessages} messages in history. Context compaction is recommended for better performance.`,
                    actionHint: 'Enable autoCompact in config.json if not already enabled.',
                    createdAt: Date.now()
                });
            }
        } catch { /* ignore */ }
        return results;
    }

    /**
     * Get all active (non-dismissed) suggestions.
     */
    getSuggestions(): ProactiveSuggestion[] {
        return this.suggestions.filter(s => !s.dismissed);
    }

    /**
     * Dismiss a suggestion by ID.
     */
    dismiss(id: string): boolean {
        const suggestion = this.suggestions.find(s => s.id === id);
        if (!suggestion) return false;
        suggestion.dismissed = true;
        return true;
    }

    /**
     * Clear all suggestions.
     */
    clear() {
        this.suggestions = [];
    }

    isEnabled(): boolean {
        return this.config.enabled;
    }
}

// Singleton
export const proactiveEngine = new ProactiveEngine();
