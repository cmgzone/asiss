import { SkillMarketplaceManager } from '../core/skill-marketplace';

export class MarketplaceSkill {
  name = 'skill_marketplace';
  description = 'Manage marketplace skills (list/install/enable/disable).';
  inputSchema = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list_available', 'list_installed', 'install', 'enable', 'disable', 'remove']
      },
      id: { type: 'string' }
    },
    required: ['action']
  };

  constructor(private marketplace: SkillMarketplaceManager) {}

  async execute(params: any): Promise<any> {
    const action = String(params?.action || '').trim();
    switch (action) {
      case 'list_available': {
        const skills = await this.marketplace.listAvailable();
        return { skills };
      }
      case 'list_installed': {
        return { skills: this.marketplace.listInstalled() };
      }
      case 'install': {
        if (!params?.id) return { error: 'id is required' };
        return await this.marketplace.install(params.id);
      }
      case 'enable': {
        if (!params?.id) return { error: 'id is required' };
        return this.marketplace.enable(params.id);
      }
      case 'disable': {
        if (!params?.id) return { error: 'id is required' };
        return this.marketplace.disable(params.id);
      }
      case 'remove': {
        if (!params?.id) return { error: 'id is required' };
        return this.marketplace.remove(params.id);
      }
      default:
        return { error: 'Invalid action' };
    }
  }
}
