import { planModeManager } from '../core/plan-mode';

export class PlanModeSkill {
  name = 'plan_mode';
  description = 'Toggle plan mode for this session. When enabled, the assistant will include a brief plan before answers.';
  inputSchema = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['status', 'enable', 'disable', 'set'],
        description: 'Action to perform'
      },
      enabled: {
        type: 'boolean',
        description: 'Whether to enable plan mode (used with action=set)'
      }
    },
    required: ['action']
  };

  async execute(args: any): Promise<any> {
    const sessionId = args.__sessionId;
    if (!sessionId) return { error: 'sessionId is required' };

    const action = String(args.action || '').toLowerCase();
    if (action === 'status') {
      return { enabled: planModeManager.isEnabled(sessionId) };
    }
    if (action === 'enable') {
      const result = planModeManager.setEnabled(sessionId, true);
      return { success: result.success, enabled: true, message: result.message };
    }
    if (action === 'disable') {
      const result = planModeManager.setEnabled(sessionId, false);
      return { success: result.success, enabled: false, message: result.message };
    }
    if (action === 'set') {
      if (typeof args.enabled !== 'boolean') {
        return { error: 'enabled must be boolean for action=set' };
      }
      const result = planModeManager.setEnabled(sessionId, args.enabled);
      return { success: result.success, enabled: args.enabled, message: result.message };
    }

    return { error: 'Invalid action' };
  }
}
