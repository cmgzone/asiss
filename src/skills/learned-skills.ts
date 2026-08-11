import { learnedSkillsManager } from '../core/learned-skills';

export class LearnedSkillsSkill {
  name = 'learned_skills';
  description = 'Inspect and manage declarative skills created from proven learning. Use this to list, enable, disable, or roll back learned skills. Skill creation itself is restricted to the validated learning background pipeline.';
  inputSchema = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'status', 'enable', 'disable', 'rollback']
      },
      name: {
        type: 'string',
        description: 'Learned skill name for enable, disable, or rollback.'
      }
    },
    required: ['action']
  };

  async execute(args: {
    action: 'list' | 'status' | 'enable' | 'disable' | 'rollback';
    name?: string;
    __sessionId?: string;
  }) {
    const sessionId = args.__sessionId || 'default';
    const records = learnedSkillsManager.list(sessionId);

    if (args.action === 'list') {
      return { skills: records };
    }
    if (args.action === 'status') {
      return {
        total: records.length,
        enabled: records.filter(item => item.enabled).length,
        disabled: records.filter(item => !item.enabled).length,
        skills: records.map(item => ({
          name: item.name,
          version: item.version,
          enabled: item.enabled,
          updatedAt: item.updatedAt
        }))
      };
    }
    if (!args.name) return { error: 'name is required for this action' };

    if (args.action === 'enable' || args.action === 'disable') {
      const enabled = args.action === 'enable';
      const success = learnedSkillsManager.setEnabled(args.name, enabled, sessionId);
      return {
        success,
        message: success
          ? `${enabled ? 'Enabled' : 'Disabled'} learned skill: ${args.name}`
          : `Learned skill not found: ${args.name}`
      };
    }

    if (args.action === 'rollback') {
      const skill = learnedSkillsManager.rollback(args.name, sessionId);
      return skill
        ? { success: true, skill, message: `Rolled back ${skill.name} to version ${skill.version}` }
        : { success: false, message: `No previous version is available for ${args.name}` };
    }

    return { error: 'Unsupported action' };
  }
}
