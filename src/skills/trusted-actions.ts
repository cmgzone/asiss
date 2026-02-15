import { trustedActions } from '../core/trusted-actions';
import fs from 'fs';
import path from 'path';

export class TrustedActionsSkill {
  name = 'trusted_actions';
  description = 'View trusted action configuration.';
  inputSchema = {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['status'] }
    },
    required: ['action']
  };

  async execute(params: any): Promise<any> {
    const action = String(params?.action || '').trim();
    if (action !== 'status') return { error: 'Invalid action' };
    trustedActions.refresh();
    const configPath = path.join(process.cwd(), 'config.json');
    let cfg: any = {};
    if (fs.existsSync(configPath)) {
      try {
        cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      } catch {
        cfg = {};
      }
    }
    return { trustedActions: cfg.trustedActions || {} };
  }
}
