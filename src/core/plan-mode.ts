import fs from 'fs';
import path from 'path';

export type PlanModeState = 'off' | 'on';

interface SessionState {
  enabled: boolean;
}

interface PlanModeConfig {
  planModeDefault: PlanModeState;
}

export class PlanModeManager {
  private sessions: Map<string, SessionState> = new Map();
  private config: PlanModeConfig;

  constructor() {
    this.config = this.loadConfig();
  }

  private loadConfig(): PlanModeConfig {
    const defaultConfig: PlanModeConfig = {
      planModeDefault: 'off'
    };

    try {
      const configPath = path.join(process.cwd(), 'config.json');
      if (fs.existsSync(configPath)) {
        const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        if (raw.agents?.defaults?.planModeDefault) {
          const value = String(raw.agents.defaults.planModeDefault).toLowerCase();
          return {
            planModeDefault: value === 'on' ? 'on' : 'off'
          };
        }
      }
    } catch (e) {
      console.error('[PlanModeManager] Failed to load config:', e);
    }

    return defaultConfig;
  }

  private getSession(sessionId: string): SessionState {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, {
        enabled: this.config.planModeDefault === 'on'
      });
    }
    return this.sessions.get(sessionId)!;
  }

  isEnabled(sessionId: string): boolean {
    return this.getSession(sessionId).enabled;
  }

  setEnabled(sessionId: string, enabled: boolean): { success: boolean; message: string } {
    const session = this.getSession(sessionId);
    session.enabled = enabled;
    return {
      success: true,
      message: enabled ? 'Plan mode enabled.' : 'Plan mode disabled.'
    };
  }

  getPlanPrompt(sessionId: string): string {
    if (!this.isEnabled(sessionId)) return '';
    return [
      'Plan mode is enabled.',
      'Before answering, provide a short plan as 3-6 bullet points.',
      'Then give the final answer without additional internal reasoning.'
    ].join(' ');
  }

  getStatusString(sessionId: string): string {
    return this.isEnabled(sessionId) ? 'on' : 'off';
  }

  handleDirective(sessionId: string, text: string): { handled: boolean; message?: string } {
    const trimmed = text.trim().toLowerCase();
    if (!trimmed.startsWith('/plan')) return { handled: false };

    const parts = trimmed.split(/\s+/).slice(1);
    if (parts.length === 0) {
      return { handled: true, message: `Plan mode is **${this.getStatusString(sessionId)}**.` };
    }

    const arg = parts[0];
    if (['on', 'enable', 'enabled', 'true', '1'].includes(arg)) {
      const result = this.setEnabled(sessionId, true);
      return { handled: true, message: result.message };
    }
    if (['off', 'disable', 'disabled', 'false', '0'].includes(arg)) {
      const result = this.setEnabled(sessionId, false);
      return { handled: true, message: result.message };
    }

    return { handled: true, message: 'Usage: /plan [on|off]' };
  }
}

export const planModeManager = new PlanModeManager();
