import { agentProfileManager } from '../core/agent-profiles';
import { customAgentManager } from '../core/custom-agents';
import { agentSwarm } from '../core/agent-swarm';

export class AgentProfilesSkill {
  name = 'agent_profiles';
  description = 'Manage agent profiles and assign them to agents.';
  inputSchema = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['profile_create', 'profile_list', 'profile_update', 'profile_delete', 'profile_assign_custom', 'profile_assign_swarm']
      },
      profileId: { type: 'string' },
      name: { type: 'string' },
      description: { type: 'string' },
      modelId: { type: 'string' },
      allowedSkills: { type: 'array', items: { type: 'string' } },
      agentId: { type: 'string' }
    },
    required: ['action']
  };

  async execute(params: any): Promise<any> {
    const action = String(params?.action || '').trim();

    switch (action) {
      case 'profile_create': {
        if (!params?.name) return { error: 'name is required' };
        const profile = agentProfileManager.create({
          name: params.name,
          description: params.description,
          modelId: params.modelId,
          allowedSkills: params.allowedSkills
        });
        return { success: true, profile };
      }

      case 'profile_list': {
        return { profiles: agentProfileManager.list() };
      }

      case 'profile_update': {
        const id = params.profileId || params.name;
        if (!id) return { error: 'profileId or name is required' };
        const success = agentProfileManager.update(id, {
          name: params.name,
          description: params.description,
          modelId: params.modelId,
          allowedSkills: params.allowedSkills
        });
        return { success, message: success ? 'Profile updated' : 'Profile not found' };
      }

      case 'profile_delete': {
        const id = params.profileId || params.name;
        if (!id) return { error: 'profileId or name is required' };
        const success = agentProfileManager.delete(id);
        return { success, message: success ? 'Profile deleted' : 'Profile not found' };
      }

      case 'profile_assign_custom': {
        const agentId = params.agentId;
        const profileId = params.profileId || params.name;
        if (!agentId || !profileId) return { error: 'agentId and profileId are required' };
        const success = customAgentManager.updateAgent(agentId, { profileId });
        return { success, message: success ? 'Profile assigned to custom agent' : 'Agent not found' };
      }

      case 'profile_assign_swarm': {
        const agentId = params.agentId;
        const profileId = params.profileId || params.name;
        if (!agentId || !profileId) return { error: 'agentId and profileId are required' };
        const success = agentSwarm.updateAgent(agentId, { profileId });
        return { success, message: success ? 'Profile assigned to swarm agent' : 'Agent not found' };
      }

      default:
        return { error: 'Invalid action' };
    }
  }
}
