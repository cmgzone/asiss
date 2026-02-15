import { customAgentManager, CustomAgentConfig } from '../core/custom-agents';

/**
 * Custom Agents Skill
 * 
 * Allows users to create, manage, and interact with custom AI agents.
 */
export class CustomAgentsSkill {
    name = 'custom_agents';
    description = 'Create and manage custom AI agents with unique personas and skills. Use this to create specialized agents for different tasks.';
    inputSchema = {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['create', 'create_from_template', 'list', 'get', 'delete', 'list_templates', 'update', 'save_to_file'],
                description: 'Action to perform'
            },
            name: {
                type: 'string',
                description: 'Agent name (for create/get/delete)'
            },
            displayName: {
                type: 'string',
                description: 'Display name for the agent'
            },
            description: {
                type: 'string',
                description: 'Brief description of what the agent does'
            },
            persona: {
                type: 'string',
                description: 'The system prompt / personality for the agent'
            },
            model: {
                type: 'string',
                description: 'Optional model id to use for this agent'
            },
            template: {
                type: 'string',
                description: 'Template name (for create_from_template): researcher, coder, writer, analyst, planner'
            },
            skills: {
                type: 'array',
                items: { type: 'string' },
                description: 'List of skills the agent can use'
            },
            profileId: {
                type: 'string',
                description: 'Optional profile ID or name to attach'
            },
            triggers: {
                type: 'array',
                items: { type: 'string' },
                description: 'Keywords that activate this agent'
            },
            agentId: {
                type: 'string',
                description: 'Agent ID or name for get/delete/update actions'
            }
        },
        required: ['action']
    };

    async execute(args: {
        action: 'create' | 'create_from_template' | 'list' | 'get' | 'delete' | 'list_templates' | 'update' | 'save_to_file';
        name?: string;
        displayName?: string;
        description?: string;
        persona?: string;
        model?: string;
        template?: string;
        skills?: string[];
        profileId?: string;
        triggers?: string[];
        agentId?: string;
        __sessionId?: string;
    }): Promise<any> {
        const { action } = args;

        switch (action) {
            case 'create': {
                if (!args.name || !args.persona) {
                    return { error: 'name and persona are required' };
                }
                const agent = customAgentManager.createAgent({
                    name: args.name,
                    displayName: args.displayName,
                    description: args.description,
                    persona: args.persona,
                    skills: args.skills,
                    triggers: args.triggers,
                    profileId: args.profileId,
                    model: args.model
                });
                return {
                    success: true,
                    agent: this.formatAgent(agent),
                    message: `Created agent: ${agent.displayName}`
                };
            }

            case 'create_from_template': {
                if (!args.template) {
                    return {
                        error: 'template is required',
                        availableTemplates: customAgentManager.getTemplates()
                    };
                }
                const agent = customAgentManager.createFromTemplate(args.template);
                if (!agent) {
                    return {
                        error: `Template not found: ${args.template}`,
                        availableTemplates: customAgentManager.getTemplates()
                    };
                }
                return {
                    success: true,
                    agent: this.formatAgent(agent),
                    message: `Created agent from template: ${agent.displayName}`
                };
            }

            case 'list': {
                const agents = customAgentManager.listAgents();
                return {
                    count: agents.length,
                    agents: agents.map(a => this.formatAgent(a))
                };
            }

            case 'get': {
                if (!args.agentId && !args.name) {
                    return { error: 'agentId or name is required' };
                }
                const agent = customAgentManager.getAgent(args.agentId || args.name!);
                if (!agent) {
                    return { error: 'Agent not found' };
                }
                return { agent: this.formatAgentFull(agent) };
            }

            case 'delete': {
                if (!args.agentId && !args.name) {
                    return { error: 'agentId or name is required' };
                }
                const success = customAgentManager.deleteAgent(args.agentId || args.name!);
                return {
                    success,
                    message: success ? 'Agent deleted' : 'Agent not found'
                };
            }

            case 'list_templates': {
                const templates = customAgentManager.getTemplates();
                const details = templates.map(name => {
                    const t = customAgentManager.getTemplate(name);
                    return {
                        name,
                        displayName: t?.displayName,
                        description: t?.description,
                        skills: t?.skills
                    };
                });
                return { templates: details };
            }

            case 'update': {
                if (!args.agentId && !args.name) {
                    return { error: 'agentId or name is required' };
                }
                const updates: Partial<CustomAgentConfig> = {};
                if (args.displayName) updates.displayName = args.displayName;
                if (args.description) updates.description = args.description;
                if (args.persona) updates.persona = args.persona;
                if (args.skills) updates.skills = args.skills;
                if (args.triggers) updates.triggers = args.triggers;
                if (args.profileId) updates.profileId = args.profileId;
                if (args.model) updates.model = args.model;

                const success = customAgentManager.updateAgent(args.agentId || args.name!, updates);
                return {
                    success,
                    message: success ? 'Agent updated' : 'Agent not found'
                };
            }

            case 'save_to_file': {
                if (!args.agentId && !args.name) {
                    return { error: 'agentId or name is required' };
                }
                const filePath = customAgentManager.saveAgentToFile(args.agentId || args.name!);
                return {
                    success: !!filePath,
                    filePath,
                    message: filePath ? `Saved to ${filePath}` : 'Agent not found'
                };
            }

            default:
                return { error: 'Invalid action' };
        }
    }

    private formatAgent(agent: CustomAgentConfig) {
        return {
            id: agent.id,
            name: agent.name,
            displayName: agent.displayName,
            description: agent.description,
            skills: agent.skills,
            triggers: agent.triggers,
            profileId: agent.profileId,
            enabled: agent.enabled
        };
    }

    private formatAgentFull(agent: CustomAgentConfig) {
        return {
            ...this.formatAgent(agent),
            persona: agent.persona,
            model: agent.model,
            temperature: agent.temperature,
            profileId: agent.profileId,
            createdAt: agent.createdAt,
            updatedAt: agent.updatedAt
        };
    }
}
