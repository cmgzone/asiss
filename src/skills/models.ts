import { modelManager, ModelConfig } from '../core/model-manager';
import { ModelRegistry } from '../core/models';
import { GenericOpenAIProvider } from '../agents/openai-provider';

export class ModelsSkill {
    name = 'models';
    description = 'Manage AI models. Add new models (Ollama, OpenAI, etc.), list available models, and switch between them.';
    inputSchema = {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['add', 'list', 'remove', 'use'],
                description: 'Action to perform'
            },
            provider: {
                type: 'string',
                enum: ['openai', 'ollama', 'openrouter'],
                description: 'Model provider (for add)'
            },
            name: {
                type: 'string',
                description: 'Friendly name for the model (e.g. "my-local-llama")'
            },
            modelId: {
                type: 'string',
                description: 'Actual model ID (e.g. "llama3:8b", "gpt-4o")'
            },
            baseUrl: {
                type: 'string',
                description: 'Base URL (for Ollama/OpenAI compatible)'
            },
            apiKey: {
                type: 'string',
                description: 'API Key (optional for Ollama)'
            }
        },
        required: ['action']
    };

    async execute(args: any): Promise<any> {
        const { action } = args;

        if (action === 'list') {
            const models = modelManager.listModels();
            const current = ModelRegistry.getCurrentModelId ? ModelRegistry.getCurrentModelId() : 'unknown';

            return {
                models: models.map(m => ({
                    name: m.name,
                    provider: m.provider,
                    modelId: m.modelName,
                    active: m.id === current
                }))
            };
        }

        if (action === 'add') {
            if (!args.name || !args.provider || !args.modelId) {
                return { error: 'name, provider, and modelId are required for add' };
            }

            const id = args.name.toLowerCase().replace(/\s+/g, '-');
            const config: ModelConfig = {
                id,
                name: args.name,
                provider: args.provider,
                modelName: args.modelId,
                baseUrl: args.baseUrl || (args.provider === 'ollama' ? 'http://localhost:11434/v1' : 'https://api.openai.com/v1'),
                apiKey: args.apiKey
            };

            if (modelManager.addModel(config)) {
                // Automatically register it
                const provider = new GenericOpenAIProvider(
                    config.id,
                    config.name,
                    config.baseUrl,
                    config.apiKey || '',
                    config.modelName
                );
                ModelRegistry.register(provider);

                return { success: true, message: `Added model: ${config.name} (${config.modelName})` };
            } else {
                return { error: `Model with name ${args.name} already exists` };
            }
        }

        if (action === 'remove') {
            if (!args.name) return { error: 'name is required' };
            const id = args.name.toLowerCase().replace(/\s+/g, '-');
            if (modelManager.removeModel(id)) {
                return { success: true, message: `Removed model: ${args.name}` };
            }
            return { error: 'Model not found' };
        }

        return { error: 'Invalid action' };
    }
}
