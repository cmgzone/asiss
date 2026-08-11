import { portableSkillsManager } from '../core/portable-skills';
import { Skill } from '../core/skills';

export class PortableSkillsSkill implements Skill {
  name = 'portable_skills';
  description = 'List, view, create, update, enable, disable, or delete portable agentskills.io-compatible SKILL.md workflows.';
  inputSchema = {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'view', 'create', 'update', 'enable', 'disable', 'delete'] },
      name: { type: 'string' },
      content: { type: 'string', description: 'Complete SKILL.md content for create or update.' }
    },
    required: ['action']
  };

  async execute(args: any) {
    const action = String(args?.action || '').trim();
    if (action === 'list') return { success: true, skills: portableSkillsManager.list() };
    const name = String(args?.name || '').trim();
    if (!name) return { success: false, error: 'name is required' };
    if (action === 'view') {
      const skill = portableSkillsManager.get(name);
      return skill ? { success: true, ...skill } : { success: false, error: `Portable skill not found: ${name}` };
    }
    if (action === 'create' || action === 'update') {
      if (!args?.content) return { success: false, error: 'content is required' };
      return { success: true, skill: portableSkillsManager.save(name, String(args.content)) };
    }
    if (action === 'enable' || action === 'disable') {
      const success = portableSkillsManager.setEnabled(name, action === 'enable');
      return { success, error: success ? undefined : `Portable skill not found: ${name}` };
    }
    if (action === 'delete') {
      const success = portableSkillsManager.remove(name);
      return { success, error: success ? undefined : `Portable skill not found: ${name}` };
    }
    return { success: false, error: `Unknown portable skill action: ${action}` };
  }
}
