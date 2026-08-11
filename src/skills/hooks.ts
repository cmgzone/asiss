import { hookManager } from '../core/hooks';
import { Skill } from '../core/skills';

export class HooksSkill implements Skill {
  name = 'hooks_status';
  description = 'Inspect the local lifecycle hook and audit-event system.';
  inputSchema = { type: 'object', properties: {} };
  async execute() {
    return { success: true, ...hookManager.status() };
  }
}
