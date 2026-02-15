import fs from 'fs';
import path from 'path';

export interface TrustedActionConfig {
  enabled: boolean;
  allow: string[];
  allowAll?: boolean;
  log?: boolean;
}

export interface TrustedActionRequest {
  action: string;
  sessionId?: string;
  payload?: any;
  createdAt: number;
}

export class TrustedActionsManager {
  private configPath = path.join(process.cwd(), 'config.json');
  private logPath = path.join(process.cwd(), 'trusted_actions.log');
  private config: TrustedActionConfig = {
    enabled: false,
    allow: [],
    allowAll: false,
    log: true
  };

  constructor() {
    this.load();
  }

  private load() {
    if (!fs.existsSync(this.configPath)) return;
    try {
      const cfg = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
      if (cfg.trustedActions && typeof cfg.trustedActions === 'object') {
        this.config = { ...this.config, ...cfg.trustedActions };
        if (!Array.isArray(this.config.allow)) this.config.allow = [];
      }
    } catch {
      // keep defaults
    }
  }

  refresh() {
    this.load();
  }

  isAllowed(action: string): boolean {
    this.load();
    if (!this.config.enabled) return false;
    if (this.config.allowAll) return true;
    return this.config.allow.includes(action);
  }

  logRequest(request: TrustedActionRequest) {
    if (!this.config.log) return;
    try {
      fs.appendFileSync(this.logPath, JSON.stringify(request) + '\n');
    } catch {
      // ignore
    }
  }
}

export const trustedActions = new TrustedActionsManager();
