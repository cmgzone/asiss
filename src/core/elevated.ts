import fs from 'fs';
import path from 'path';

export type ElevatedLevel = 'off' | 'on' | 'ask' | 'full';

export interface ElevatedConfig {
    enabled: boolean;
    default: ElevatedLevel;
    allowFrom: {
        console?: string[];
        web?: string[];
        discord?: string[];
        telegram?: string[];
        whatsapp?: string[];
        slack?: string[];
        [channel: string]: string[] | undefined;
    };
}

interface SessionState {
    level: ElevatedLevel;
    channel: string;
    senderId: string;
}

export class ElevatedManager {
    private sessions: Map<string, SessionState> = new Map();
    private config: ElevatedConfig;

    constructor() {
        this.config = this.loadConfig();
    }

    private loadConfig(): ElevatedConfig {
        const defaultConfig: ElevatedConfig = {
            enabled: true,
            default: 'full',
            allowFrom: {
                console: ['*'],
                web: ['*'],
            },
        };

        try {
            const configPath = path.join(process.cwd(), 'config.json');
            if (fs.existsSync(configPath)) {
                const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
                if (raw.tools?.elevated) {
                    return {
                        enabled: raw.tools.elevated.enabled ?? defaultConfig.enabled,
                        default: raw.tools.elevated.default ?? defaultConfig.default,
                        allowFrom: raw.tools.elevated.allowFrom ?? defaultConfig.allowFrom,
                    };
                }
            }
        } catch (e) {
            console.error('[ElevatedManager] Failed to load config:', e);
        }

        return defaultConfig;
    }

    /**
     * Check if elevated mode is globally enabled
     */
    isEnabled(): boolean {
        return this.config.enabled;
    }

    /**
     * Check if a sender is allowed to use elevated mode on a given channel
     */
    isAllowed(senderId: string, channel: string): boolean {
        if (!this.config.enabled) return false;

        const channelAllowlist = this.config.allowFrom[channel.toLowerCase()];
        if (!channelAllowlist) return false;

        // Wildcard allows all
        if (channelAllowlist.includes('*')) return true;

        return channelAllowlist.includes(senderId);
    }

    /**
     * Initialize session with default level if not exists
     */
    initSession(sessionId: string, senderId: string, channel: string): void {
        if (!this.sessions.has(sessionId)) {
            this.sessions.set(sessionId, {
                level: this.config.default,
                channel,
                senderId,
            });
        }
    }

    /**
     * Get current elevated level for a session
     */
    getLevel(sessionId: string): ElevatedLevel {
        const state = this.sessions.get(sessionId);
        return state?.level ?? this.config.default;
    }

    /**
     * Set elevated level for a session
     * Returns success and message
     */
    setLevel(sessionId: string, level: ElevatedLevel, senderId: string, channel: string): { success: boolean; message: string } {
        if (!this.isEnabled()) {
            return { success: false, message: 'Elevated mode is disabled in config.' };
        }

        if (!this.isAllowed(senderId, channel)) {
            return { success: false, message: `You are not authorized to use elevated mode on ${channel}.` };
        }

        const validLevels: ElevatedLevel[] = ['off', 'on', 'ask', 'full'];
        if (!validLevels.includes(level)) {
            return { success: false, message: `Invalid level. Use: ${validLevels.join(' | ')}` };
        }

        this.sessions.set(sessionId, { level, channel, senderId });

        if (level === 'off') {
            return { success: true, message: 'Elevated mode disabled.' };
        }
        return { success: true, message: `Elevated mode set to **${level}**.` };
    }

    /**
     * Parse an elevated directive from message text
     * Returns the level if found, null otherwise
     */
    parseDirective(text: string): { level: ElevatedLevel; isQuery: boolean } | null {
        const trimmed = text.trim().toLowerCase();

        // Check for query (no argument)
        if (trimmed === '/elevated' || trimmed === '/elev' || trimmed === '/elevated:' || trimmed === '/elev:') {
            return { level: 'off', isQuery: true };
        }

        // Check for level setting
        const match = trimmed.match(/^\/(elevated|elev)\s+(on|off|ask|full)$/);
        if (match) {
            return { level: match[2] as ElevatedLevel, isQuery: false };
        }

        return null;
    }

    /**
     * Check if command execution should be allowed based on elevated level
     */
    shouldAllowExec(sessionId: string): { allowed: boolean; autoApprove: boolean; reason?: string } {
        const level = this.getLevel(sessionId);

        switch (level) {
            case 'off':
                return { allowed: false, autoApprove: false, reason: 'Elevated mode is off. Use `/elevated on` or `/elevated full` to enable.' };
            case 'on':
            case 'ask':
                return { allowed: true, autoApprove: false };
            case 'full':
                return { allowed: true, autoApprove: true };
            default:
                return { allowed: false, autoApprove: false, reason: 'Unknown elevated level.' };
        }
    }

    /**
     * Get session status string for logging/display
     */
    getStatusString(sessionId: string): string {
        const level = this.getLevel(sessionId);
        return `elevated=${level}`;
    }
}

// Singleton instance
export const elevatedManager = new ElevatedManager();
