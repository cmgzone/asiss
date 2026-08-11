import fs from 'fs';
import path from 'path';
import { ModelLevel, ModelRegistry } from './models';
import { selectProviderForLevel } from './model-level';

/**
 * Model Router — Classifies request complexity and routes to the appropriate model.
 * Simple queries → fast/cheap model, complex tasks → powerful model.
 * Routing is either explicit (`rules`: complexity → modelId) or level-aware
 * (`levelMap`: complexity → ModelLevel, resolved against registered providers).
 */

export type ComplexityLevel = 'simple' | 'medium' | 'complex';

interface RoutingRule {
    level: ComplexityLevel;
    modelId: string;
}

interface RouterConfig {
    enabled: boolean;
    rules: RoutingRule[];
    defaultModelId: string;
    levelMap?: Partial<Record<ComplexityLevel, ModelLevel>>;
}

// Heuristic patterns for complexity classification
const SIMPLE_PATTERNS = [
    /^(hi|hello|hey|thanks|thank you|ok|yes|no|bye|sure)\b/i,
    /^what (is|are|was|were) /i,
    /^(who|when|where) /i,
    /^(define|explain briefly|summarize)\b/i,
    /^how (do|does|can|to) /i,
];

const COMPLEX_PATTERNS = [
    /\b(implement|build|create|develop|architect|design|refactor)\b.*\b(system|service|feature|module|application|api|engine)\b/i,
    /\b(analyze|debug|investigate|diagnose|fix)\b.*\b(issue|bug|error|problem|crash|failure)\b/i,
    /\b(multi[- ]?step|chain[- ]?of[- ]?thought|step[- ]?by[- ]?step)\b/i,
    /\b(research|deep dive|comprehensive|thorough|detailed analysis)\b/i,
    /\b(compare|contrast|evaluate|pros?\s+and\s+cons?)\b/i,
    /\b(plan|strategy|roadmap|migration)\b/i,
    /\b(security|vulnerability|audit)\b/i,
    /write\s+(a\s+)?(full|complete|entire|whole)\b/i,
];

const COMPLEXITY_TO_LEVEL: Record<ComplexityLevel, ModelLevel> = {
    simple: 'low',
    medium: 'medium',
    complex: 'high',
};

export class ModelRouter {
    private config: RouterConfig;

    constructor() {
        this.config = this.loadConfig();
    }

    private loadConfig(): RouterConfig {
        const defaultConfig: RouterConfig = {
            enabled: false,
            defaultModelId: '',
            rules: []
        };

        try {
            const configPath = path.join(process.cwd(), 'config.json');
            if (fs.existsSync(configPath)) {
                const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
                if (raw.modelRouter) {
                    const cfg: RouterConfig = {
                        enabled: raw.modelRouter.enabled ?? false,
                        defaultModelId: raw.modelRouter.defaultModelId || '',
                        rules: Array.isArray(raw.modelRouter.rules) ? raw.modelRouter.rules : []
                    };
                    if (raw.modelRouter.levelMap && typeof raw.modelRouter.levelMap === 'object') {
                        cfg.levelMap = raw.modelRouter.levelMap;
                    }
                    return cfg;
                }
            }
        } catch (e) {
            console.error('[ModelRouter] Failed to load config:', e);
        }

        return defaultConfig;
    }

    /**
     * Classify the complexity of a user message.
     */
    classifyComplexity(message: string): ComplexityLevel {
        const text = message.trim();

        // Very short messages are likely simple
        if (text.length < 30 && !COMPLEX_PATTERNS.some(p => p.test(text))) {
            return 'simple';
        }

        // Check for complex patterns first (higher priority)
        if (COMPLEX_PATTERNS.some(p => p.test(text))) {
            return 'complex';
        }

        // Check for simple patterns
        if (SIMPLE_PATTERNS.some(p => p.test(text))) {
            return 'simple';
        }

        // Length-based heuristic
        if (text.length > 500) return 'complex';
        if (text.length > 200) return 'medium';

        // Check if message contains code blocks
        if (/```[\s\S]+```/.test(text)) return 'medium';

        // Check for multiple questions/requirements
        const questionMarks = (text.match(/\?/g) || []).length;
        const bulletPoints = (text.match(/^[\s]*[-*•\d.]\s/gm) || []).length;
        if (questionMarks > 2 || bulletPoints > 3) return 'complex';

        return 'medium';
    }

    /**
     * Resolve the ModelLevel to use for a complexity bucket, honoring config.
     */
    private levelForComplexity(complexity: ComplexityLevel): ModelLevel {
        return this.config.levelMap?.[complexity] || COMPLEXITY_TO_LEVEL[complexity];
    }

    /**
     * Get the recommended model ID based on message complexity.
     * Level-aware routing picks the best registered provider for the desired
     * level; explicit rules always win when present for that complexity.
     * Returns null if routing is disabled or nothing matches.
     */
    selectModelId(message: string): string | null {
        if (!this.config.enabled || this.config.rules.length === 0) {
            return null;
        }

        const complexity = this.classifyComplexity(message);
        const rule = this.config.rules.find(r => r.level === complexity);
        if (rule && rule.modelId) return rule.modelId;

        const desired = this.levelForComplexity(complexity);
        const provider = selectProviderForLevel(ModelRegistry.getAll(), desired);
        if (provider) return provider.id;

        return this.config.defaultModelId || null;
    }

    /**
     * Level-only selection: no explicit rules needed, pure capability routing.
     */
    selectModelIdByLevel(message: string): string | null {
        if (!this.config.enabled) return null;

        const complexity = this.classifyComplexity(message);
        const desired = this.levelForComplexity(complexity);
        const provider = selectProviderForLevel(ModelRegistry.getAll(), desired);
        if (provider) return provider.id;
        return this.config.defaultModelId || null;
    }

    /**
     * What level would this message route to, without resolving providers.
     */
    desiredLevelFor(message: string): ModelLevel | null {
        if (!this.config.enabled) return null;
        return this.levelForComplexity(this.classifyComplexity(message));
    }

    /**
     * Check if router is enabled and configured.
     */
    isEnabled(): boolean {
        return this.config.enabled && this.config.rules.length > 0;
    }

    /**
     * True when level-aware routing is possible (enabled + registered providers).
     */
    hasProviders(): boolean {
        return this.config.enabled && ModelRegistry.getAll().length > 0;
    }

    /**
     * Get current configuration for display.
     */
    getConfig(): RouterConfig {
        return { ...this.config, levelMap: { ...(this.config.levelMap || {}) } };
    }
}

// Singleton
export const modelRouter = new ModelRouter();
