import fs from 'fs';
import path from 'path';

/**
 * Guardrails — Input/output/action validation for safety.
 * Prevents dangerous operations, filters sensitive data, blocks injection.
 * Respects elevated mode levels.
 */

export type GuardrailSeverity = 'warn' | 'block' | 'ask';

export interface GuardrailResult {
    allowed: boolean;
    severity: GuardrailSeverity;
    reason?: string;
    sanitized?: string;   // cleaned version of content if applicable
}

interface GuardrailConfig {
    enabled: boolean;
    blockDangerousCommands: boolean;
    filterSecrets: boolean;
    maxInputTokens: number;
    maxOutputTokens: number;
    blockedCommandPatterns: string[];
    blockedPathPatterns: string[];
    secretPatterns: string[];
}

const DEFAULT_CONFIG: GuardrailConfig = {
    enabled: true,
    blockDangerousCommands: true,
    filterSecrets: true,
    maxInputTokens: 50000,
    maxOutputTokens: 100000,
    blockedCommandPatterns: [
        'rm\\s+-rf\\s+/',
        'rm\\s+-rf\\s+~',
        'rm\\s+-rf\\s+\\*',
        'rmdir\\s+/s\\s+/q\\s+[A-Z]:',
        'del\\s+/s\\s+/q\\s+[A-Z]:',
        'format\\s+[A-Z]:',
        'mkfs\\.',
        'dd\\s+if=.*of=/dev/',
        ':(){\\s*:|:&\\s*};:',         // fork bomb
        'shutdown',
        'reboot',
        'init\\s+0',
        'halt',
    ],
    blockedPathPatterns: [
        'C:\\\\Windows\\\\System32',
        '/etc/passwd',
        '/etc/shadow',
        '/boot/',
        'C:\\\\Program Files',
    ],
    secretPatterns: [
        'sk-[a-zA-Z0-9]{20,}',             // OpenAI keys
        'sk-ant-[a-zA-Z0-9]{20,}',         // Anthropic keys
        'ghp_[a-zA-Z0-9]{20,}',            // GitHub tokens
        'gho_[a-zA-Z0-9]{20,}',            // GitHub OAuth
        'AKIA[0-9A-Z]{16}',                // AWS access keys
        '[a-zA-Z0-9+/]{40}',               // generic 40-char base64 secrets (loose)
        'password\\s*[:=]\\s*["\']?[^\\s"\']{8,}', // password assignments
    ],
};

export class GuardrailManager {
    private config: GuardrailConfig;
    private compiledCommandPatterns: RegExp[];
    private compiledPathPatterns: RegExp[];
    private compiledSecretPatterns: RegExp[];

    constructor() {
        this.config = this.loadConfig();
        this.compiledCommandPatterns = this.config.blockedCommandPatterns.map(p => {
            try { return new RegExp(p, 'i'); } catch { return new RegExp('$^'); } // unmatchable
        });
        this.compiledPathPatterns = this.config.blockedPathPatterns.map(p => {
            try { return new RegExp(p.replace(/\\/g, '\\\\'), 'i'); } catch { return new RegExp('$^'); }
        });
        this.compiledSecretPatterns = this.config.secretPatterns.map(p => {
            try { return new RegExp(p, 'gi'); } catch { return new RegExp('$^', 'gi'); }
        });
    }

    private loadConfig(): GuardrailConfig {
        try {
            const configPath = path.join(process.cwd(), 'config.json');
            if (fs.existsSync(configPath)) {
                const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
                if (raw.guardrails) {
                    return { ...DEFAULT_CONFIG, ...raw.guardrails };
                }
            }
        } catch (e) {
            console.error('[Guardrails] Failed to load config:', e);
        }
        return { ...DEFAULT_CONFIG };
    }

    /**
     * Validate user input before processing.
     */
    validateInput(text: string): GuardrailResult {
        if (!this.config.enabled) return { allowed: true, severity: 'warn' };

        // Check input length (rough token estimate: 1 token ≈ 4 chars)
        const estimatedTokens = Math.ceil(text.length / 4);
        if (estimatedTokens > this.config.maxInputTokens) {
            return {
                allowed: false,
                severity: 'block',
                reason: `Input too long (~${estimatedTokens} tokens, max ${this.config.maxInputTokens})`
            };
        }

        // Check for prompt injection patterns
        const injectionPatterns = [
            /ignore\s+(all\s+)?previous\s+instructions/i,
            /you\s+are\s+now\s+(a\s+)?new\s+ai/i,
            /jailbreak/i,
            /DAN\s+mode/i,
        ];
        for (const pattern of injectionPatterns) {
            if (pattern.test(text)) {
                return {
                    allowed: false,
                    severity: 'block',
                    reason: 'Potential prompt injection detected'
                };
            }
        }

        return { allowed: true, severity: 'warn' };
    }

    /**
     * Validate a shell command before execution.
     */
    validateCommand(command: string, elevatedLevel: string = 'off'): GuardrailResult {
        if (!this.config.enabled || !this.config.blockDangerousCommands) {
            return { allowed: true, severity: 'warn' };
        }

        // Full elevated mode bypasses command guardrails
        if (elevatedLevel === 'full') {
            return { allowed: true, severity: 'warn' };
        }

        for (let i = 0; i < this.compiledCommandPatterns.length; i++) {
            if (this.compiledCommandPatterns[i].test(command)) {
                return {
                    allowed: false,
                    severity: elevatedLevel === 'on' ? 'ask' : 'block',
                    reason: `Dangerous command blocked: matches pattern "${this.config.blockedCommandPatterns[i]}"`
                };
            }
        }

        // Check for dangerous path access
        for (let i = 0; i < this.compiledPathPatterns.length; i++) {
            if (this.compiledPathPatterns[i].test(command)) {
                return {
                    allowed: false,
                    severity: elevatedLevel === 'on' ? 'ask' : 'block',
                    reason: `Access to restricted path: ${this.config.blockedPathPatterns[i]}`
                };
            }
        }

        return { allowed: true, severity: 'warn' };
    }

    /**
     * Sanitize output — redact secrets/sensitive data.
     */
    sanitizeOutput(text: string): GuardrailResult {
        if (!this.config.enabled || !this.config.filterSecrets) {
            return { allowed: true, severity: 'warn', sanitized: text };
        }

        let sanitized = text;
        let found = false;

        for (const pattern of this.compiledSecretPatterns) {
            pattern.lastIndex = 0; // reset stateful regex
            if (pattern.test(sanitized)) {
                found = true;
                pattern.lastIndex = 0;
                sanitized = sanitized.replace(pattern, (match) => {
                    if (match.length < 10) return match; // too short to be a real secret
                    return match.slice(0, 4) + '•'.repeat(Math.min(match.length - 8, 20)) + match.slice(-4);
                });
            }
        }

        return {
            allowed: true,
            severity: found ? 'warn' : 'warn',
            sanitized,
            reason: found ? 'Sensitive data redacted' : undefined
        };
    }

    /**
     * Validate a file path before read/write operations.
     */
    validateFilePath(filePath: string, operation: 'read' | 'write' | 'delete', elevatedLevel: string = 'off'): GuardrailResult {
        if (!this.config.enabled) return { allowed: true, severity: 'warn' };
        if (elevatedLevel === 'full') return { allowed: true, severity: 'warn' };

        const normalizedPath = path.resolve(filePath);

        for (let i = 0; i < this.compiledPathPatterns.length; i++) {
            if (this.compiledPathPatterns[i].test(normalizedPath)) {
                return {
                    allowed: false,
                    severity: operation === 'delete' ? 'block' : 'ask',
                    reason: `${operation} to restricted path: ${this.config.blockedPathPatterns[i]}`
                };
            }
        }

        // Block writes to `.env` files (could overwrite secrets)
        if (operation === 'write' && /\.env$/i.test(normalizedPath)) {
            return {
                allowed: elevatedLevel === 'on',
                severity: 'ask',
                reason: 'Writing to .env file — may overwrite sensitive config'
            };
        }

        return { allowed: true, severity: 'warn' };
    }

    isEnabled(): boolean {
        return this.config.enabled;
    }
}

// Singleton
export const guardrailManager = new GuardrailManager();
