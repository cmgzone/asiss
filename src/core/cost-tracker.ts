import fs from 'fs';
import path from 'path';

/**
 * Cost Tracker — Tracks token usage per model, per session.
 * Estimates costs using model-specific pricing. Persists to cost_data.json.
 */

export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    model: string;
    sessionId: string;
    timestamp: number;
    estimatedCost: number;
}

export interface ModelPricing {
    inputPerMillion: number;    // USD per million input tokens
    outputPerMillion: number;   // USD per million output tokens
}

export interface CostSummary {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalEstimatedCost: number;
    byModel: Record<string, { input: number; output: number; cost: number; calls: number }>;
    bySession: Record<string, { input: number; output: number; cost: number }>;
    dailyCosts: Array<{ date: string; cost: number; tokens: number }>;
    recentUsage: TokenUsage[];
}

interface CostData {
    usage: TokenUsage[];
    startedAt: number;
}

// Default pricing (USD per million tokens) — update as models change
const MODEL_PRICING: Record<string, ModelPricing> = {
    // OpenAI
    'gpt-4o': { inputPerMillion: 2.50, outputPerMillion: 10.00 },
    'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.60 },
    'gpt-4-turbo': { inputPerMillion: 10.00, outputPerMillion: 30.00 },
    'gpt-3.5-turbo': { inputPerMillion: 0.50, outputPerMillion: 1.50 },
    'o1': { inputPerMillion: 15.00, outputPerMillion: 60.00 },
    'o1-mini': { inputPerMillion: 3.00, outputPerMillion: 12.00 },
    'o3-mini': { inputPerMillion: 1.10, outputPerMillion: 4.40 },

    // Anthropic
    'claude-3-5-sonnet': { inputPerMillion: 3.00, outputPerMillion: 15.00 },
    'claude-3-haiku': { inputPerMillion: 0.25, outputPerMillion: 1.25 },
    'claude-3-opus': { inputPerMillion: 15.00, outputPerMillion: 75.00 },

    // Google
    'gemini-2.0-flash': { inputPerMillion: 0.10, outputPerMillion: 0.40 },
    'gemini-1.5-pro': { inputPerMillion: 1.25, outputPerMillion: 5.00 },
    'gemini-1.5-flash': { inputPerMillion: 0.075, outputPerMillion: 0.30 },

    // NVIDIA / Open models (via OpenRouter or direct)
    'deepseek-r1': { inputPerMillion: 0.55, outputPerMillion: 2.19 },
    'llama-3.1-70b': { inputPerMillion: 0.52, outputPerMillion: 0.75 },
    'llama-3.1-8b': { inputPerMillion: 0.06, outputPerMillion: 0.06 },
    'mixtral-8x7b': { inputPerMillion: 0.24, outputPerMillion: 0.24 },

    // Fallback
    '_default': { inputPerMillion: 1.00, outputPerMillion: 3.00 },
};

export class CostTracker {
    private filePath: string;
    private data: CostData;
    private dirty = false;
    private saveInterval: NodeJS.Timeout | null = null;
    private maxRecords = 10000;
    private alertThreshold: number;

    constructor() {
        this.filePath = path.join(process.cwd(), 'cost_data.json');
        this.data = { usage: [], startedAt: Date.now() };
        this.alertThreshold = this.loadAlertThreshold();
        this.load();
        this.saveInterval = setInterval(() => this.save(), 30000);
    }

    private loadAlertThreshold(): number {
        try {
            const configPath = path.join(process.cwd(), 'config.json');
            if (fs.existsSync(configPath)) {
                const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
                return raw.costTracker?.alertThresholdUsd ?? 10.0;
            }
        } catch { /* ignore */ }
        return 10.0;
    }

    private load() {
        try {
            if (fs.existsSync(this.filePath)) {
                this.data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
                if (!this.data.usage) this.data.usage = [];
            }
        } catch (e) {
            console.error('[CostTracker] Failed to load:', e);
            this.data = { usage: [], startedAt: Date.now() };
        }
    }

    private save() {
        if (!this.dirty) return;
        try {
            // Trim to maxRecords
            if (this.data.usage.length > this.maxRecords) {
                this.data.usage = this.data.usage.slice(-this.maxRecords);
            }
            fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
            this.dirty = false;
        } catch (e) {
            console.error('[CostTracker] Failed to save:', e);
        }
    }

    private getPricing(model: string): ModelPricing {
        // Try exact match first
        if (MODEL_PRICING[model]) return MODEL_PRICING[model];
        // Try partial match (model name might be prefixed/suffixed)
        const lower = model.toLowerCase();
        for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
            if (lower.includes(key) || key.includes(lower)) return pricing;
        }
        return MODEL_PRICING['_default'];
    }

    /**
     * Record token usage from a model call.
     */
    record(model: string, sessionId: string, inputTokens: number, outputTokens: number): TokenUsage {
        const pricing = this.getPricing(model);
        const estimatedCost =
            (inputTokens / 1_000_000) * pricing.inputPerMillion +
            (outputTokens / 1_000_000) * pricing.outputPerMillion;

        const usage: TokenUsage = {
            inputTokens,
            outputTokens,
            model,
            sessionId,
            timestamp: Date.now(),
            estimatedCost: Math.round(estimatedCost * 1_000_000) / 1_000_000 // 6 decimal places
        };

        this.data.usage.push(usage);
        this.dirty = true;

        // Check alert threshold
        const todayCost = this.getTodayCost();
        if (todayCost > this.alertThreshold) {
            console.warn(`[CostTracker] ⚠️ Daily cost ($${todayCost.toFixed(4)}) exceeds threshold ($${this.alertThreshold})`);
        }

        return usage;
    }

    /**
     * Estimate token count from text (rough: ~4 chars per token).
     */
    estimateTokens(text: string): number {
        return Math.ceil((text || '').length / 4);
    }

    /**
     * Record from raw text (estimates tokens).
     */
    recordFromText(model: string, sessionId: string, inputText: string, outputText: string): TokenUsage {
        return this.record(
            model,
            sessionId,
            this.estimateTokens(inputText),
            this.estimateTokens(outputText)
        );
    }

    private getTodayCost(): number {
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        return this.data.usage
            .filter(u => u.timestamp >= todayStart)
            .reduce((sum, u) => sum + u.estimatedCost, 0);
    }

    private formatDateKey(d: Date): string {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    /**
     * Get comprehensive cost summary for the analytics dashboard.
     */
    getSummary(days: number = 14): CostSummary {
        const usage = this.data.usage;

        let totalInput = 0, totalOutput = 0, totalCost = 0;
        const byModel: Record<string, { input: number; output: number; cost: number; calls: number }> = {};
        const bySession: Record<string, { input: number; output: number; cost: number }> = {};

        for (const u of usage) {
            totalInput += u.inputTokens;
            totalOutput += u.outputTokens;
            totalCost += u.estimatedCost;

            if (!byModel[u.model]) byModel[u.model] = { input: 0, output: 0, cost: 0, calls: 0 };
            byModel[u.model].input += u.inputTokens;
            byModel[u.model].output += u.outputTokens;
            byModel[u.model].cost += u.estimatedCost;
            byModel[u.model].calls += 1;

            if (!bySession[u.sessionId]) bySession[u.sessionId] = { input: 0, output: 0, cost: 0 };
            bySession[u.sessionId].input += u.inputTokens;
            bySession[u.sessionId].output += u.outputTokens;
            bySession[u.sessionId].cost += u.estimatedCost;
        }

        // Daily costs
        const now = new Date();
        const dailyCosts: Array<{ date: string; cost: number; tokens: number }> = [];
        for (let i = days - 1; i >= 0; i--) {
            const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
            const key = this.formatDateKey(d);
            const dayStart = new Date(d); dayStart.setHours(0, 0, 0, 0);
            const dayEnd = new Date(d); dayEnd.setHours(23, 59, 59, 999);
            const dayUsage = usage.filter(u => u.timestamp >= dayStart.getTime() && u.timestamp <= dayEnd.getTime());
            dailyCosts.push({
                date: key,
                cost: dayUsage.reduce((s, u) => s + u.estimatedCost, 0),
                tokens: dayUsage.reduce((s, u) => s + u.inputTokens + u.outputTokens, 0)
            });
        }

        return {
            totalInputTokens: totalInput,
            totalOutputTokens: totalOutput,
            totalEstimatedCost: Math.round(totalCost * 10000) / 10000,
            byModel,
            bySession,
            dailyCosts,
            recentUsage: usage.slice(-20)
        };
    }

    stop() {
        if (this.saveInterval) { clearInterval(this.saveInterval); this.saveInterval = null; }
        this.save();
    }
}

// Singleton
export const costTracker = new CostTracker();
