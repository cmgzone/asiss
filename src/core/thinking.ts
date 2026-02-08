import fs from 'fs';
import path from 'path';

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type VerboseLevel = 'off' | 'on' | 'full';
export type ReasoningLevel = 'off' | 'on' | 'stream';

// Thinking level prompts
const THINKING_PROMPTS: Record<ThinkingLevel, string> = {
    off: '',
    minimal: 'think',
    low: 'think hard',
    medium: 'think harder',
    high: 'ultrathink',
    xhigh: 'ultrathink+',
};

interface SessionState {
    thinking: ThinkingLevel;
    verbose: VerboseLevel;
    reasoning: ReasoningLevel;
}

interface ThinkingConfig {
    thinkingDefault: ThinkingLevel;
    verboseDefault: VerboseLevel;
    reasoningDefault: ReasoningLevel;
}

export class ThinkingManager {
    private sessions: Map<string, SessionState> = new Map();
    private config: ThinkingConfig;

    constructor() {
        this.config = this.loadConfig();
    }

    private loadConfig(): ThinkingConfig {
        const defaultConfig: ThinkingConfig = {
            thinkingDefault: 'low',
            verboseDefault: 'off',
            reasoningDefault: 'off',
        };

        try {
            const configPath = path.join(process.cwd(), 'config.json');
            if (fs.existsSync(configPath)) {
                const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
                if (raw.agents?.defaults) {
                    return {
                        thinkingDefault: raw.agents.defaults.thinkingDefault ?? defaultConfig.thinkingDefault,
                        verboseDefault: raw.agents.defaults.verboseDefault ?? defaultConfig.verboseDefault,
                        reasoningDefault: raw.agents.defaults.reasoningDefault ?? defaultConfig.reasoningDefault,
                    };
                }
            }
        } catch (e) {
            console.error('[ThinkingManager] Failed to load config:', e);
        }

        return defaultConfig;
    }

    private getSession(sessionId: string): SessionState {
        if (!this.sessions.has(sessionId)) {
            this.sessions.set(sessionId, {
                thinking: this.config.thinkingDefault,
                verbose: this.config.verboseDefault,
                reasoning: this.config.reasoningDefault,
            });
        }
        return this.sessions.get(sessionId)!;
    }

    // ===== THINKING LEVEL =====

    private parseThinkingLevel(input: string): ThinkingLevel | null {
        const normalized = input.toLowerCase().trim();
        const aliases: Record<string, ThinkingLevel> = {
            'off': 'off',
            'minimal': 'minimal',
            'low': 'low',
            'medium': 'medium',
            'high': 'high',
            'xhigh': 'xhigh',
            'x-high': 'xhigh',
            'x_high': 'xhigh',
            'extra-high': 'xhigh',
            'extra high': 'xhigh',
            'extra_high': 'xhigh',
            'highest': 'high',
            'max': 'high',
        };
        return aliases[normalized] ?? null;
    }

    getThinkingLevel(sessionId: string): ThinkingLevel {
        return this.getSession(sessionId).thinking;
    }

    getThinkingPrompt(sessionId: string): string {
        const level = this.getThinkingLevel(sessionId);
        return THINKING_PROMPTS[level];
    }

    setThinkingLevel(sessionId: string, level: ThinkingLevel): { success: boolean; message: string } {
        const session = this.getSession(sessionId);
        session.thinking = level;
        if (level === 'off') {
            return { success: true, message: 'Thinking disabled.' };
        }
        return { success: true, message: `Thinking level set to **${level}**.` };
    }

    // ===== VERBOSE LEVEL =====

    getVerboseLevel(sessionId: string): VerboseLevel {
        return this.getSession(sessionId).verbose;
    }

    setVerboseLevel(sessionId: string, level: VerboseLevel): { success: boolean; message: string } {
        const session = this.getSession(sessionId);
        session.verbose = level;
        if (level === 'off') {
            return { success: true, message: 'Verbose logging disabled.' };
        }
        return { success: true, message: `Verbose logging enabled (**${level}**).` };
    }

    // ===== REASONING VISIBILITY =====

    getReasoningLevel(sessionId: string): ReasoningLevel {
        return this.getSession(sessionId).reasoning;
    }

    setReasoningLevel(sessionId: string, level: ReasoningLevel): { success: boolean; message: string } {
        const session = this.getSession(sessionId);
        session.reasoning = level;
        if (level === 'off') {
            return { success: true, message: 'Reasoning visibility disabled.' };
        }
        return { success: true, message: `Reasoning visibility set to **${level}**.` };
    }

    // ===== DIRECTIVE PARSING =====

    parseDirective(text: string): {
        type: 'thinking' | 'verbose' | 'reasoning';
        value: string | null; // null = query
        isQuery: boolean;
    } | null {
        const trimmed = text.trim().toLowerCase();

        // Thinking: /t, /think, /thinking
        const thinkMatch = trimmed.match(/^\/(t|think|thinking)(?::?\s*(.*))?$/);
        if (thinkMatch) {
            const value = thinkMatch[2]?.trim() || null;
            return { type: 'thinking', value, isQuery: !value };
        }

        // Verbose: /v, /verbose
        const verboseMatch = trimmed.match(/^\/(v|verbose)(?::?\s*(.*))?$/);
        if (verboseMatch) {
            const value = verboseMatch[2]?.trim() || null;
            return { type: 'verbose', value, isQuery: !value };
        }

        // Reasoning: /reason, /reasoning
        const reasonMatch = trimmed.match(/^\/(reason|reasoning)(?::?\s*(.*))?$/);
        if (reasonMatch) {
            const value = reasonMatch[2]?.trim() || null;
            return { type: 'reasoning', value, isQuery: !value };
        }

        return null;
    }

    handleDirective(sessionId: string, text: string): { handled: boolean; message?: string } {
        const directive = this.parseDirective(text);
        if (!directive) {
            return { handled: false };
        }

        if (directive.type === 'thinking') {
            if (directive.isQuery) {
                const level = this.getThinkingLevel(sessionId);
                return { handled: true, message: `Current thinking level: **${level}**` };
            }
            const parsed = this.parseThinkingLevel(directive.value!);
            if (!parsed) {
                return { handled: true, message: `Invalid thinking level. Use: off | minimal | low | medium | high | xhigh` };
            }
            const result = this.setThinkingLevel(sessionId, parsed);
            return { handled: true, message: result.message };
        }

        if (directive.type === 'verbose') {
            if (directive.isQuery) {
                const level = this.getVerboseLevel(sessionId);
                return { handled: true, message: `Current verbose level: **${level}**` };
            }
            const valid: VerboseLevel[] = ['off', 'on', 'full'];
            if (!valid.includes(directive.value as VerboseLevel)) {
                return { handled: true, message: `Invalid verbose level. Use: off | on | full` };
            }
            const result = this.setVerboseLevel(sessionId, directive.value as VerboseLevel);
            return { handled: true, message: result.message };
        }

        if (directive.type === 'reasoning') {
            if (directive.isQuery) {
                const level = this.getReasoningLevel(sessionId);
                return { handled: true, message: `Current reasoning level: **${level}**` };
            }
            const valid: ReasoningLevel[] = ['off', 'on', 'stream'];
            if (!valid.includes(directive.value as ReasoningLevel)) {
                return { handled: true, message: `Invalid reasoning level. Use: off | on | stream` };
            }
            const result = this.setReasoningLevel(sessionId, directive.value as ReasoningLevel);
            return { handled: true, message: result.message };
        }

        return { handled: false };
    }

    getStatusString(sessionId: string): string {
        const session = this.getSession(sessionId);
        return `thinking=${session.thinking}, verbose=${session.verbose}, reasoning=${session.reasoning}`;
    }
}

// Singleton instance
export const thinkingManager = new ThinkingManager();
