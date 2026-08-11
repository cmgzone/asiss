
export interface Tool {
  name: string;
  description?: string;
  inputSchema?: any;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: any;
}

export interface ModelResponse {
  content: string | null;
  reasoning?: string;
  toolCalls?: ToolCall[];
  usage?: {
    promptTokens: number;
    completionTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}

export type StreamCallback = (chunk: string) => void;

export interface ModelAttachment {
  type: 'image';
  mimeType: string;
  dataUrl: string;
  name?: string;
}

/**
 * Capability tier of a model. `low` = fast/cheap small models, `max` = the
 * strongest (largest/most capable) available. Used for dynamic model selection.
 */
export type ModelLevel = 'low' | 'medium' | 'high' | 'max';

export const MODEL_LEVELS: ModelLevel[] = ['low', 'medium', 'high', 'max'];

export const LEVEL_RANK: Record<ModelLevel, number> = { low: 0, medium: 1, high: 2, max: 3 };

export interface ModelProvider {
  id: string;
  name: string;
  level?: ModelLevel;
  generate(prompt: string, systemPrompt?: string, tools?: Tool[], attachments?: ModelAttachment[]): Promise<ModelResponse>;
  generateStream?(prompt: string, systemPrompt?: string, tools?: Tool[], onChunk?: StreamCallback, attachments?: ModelAttachment[]): Promise<ModelResponse>;
}

export class ModelRegistry {
  private static providers: Map<string, ModelProvider> = new Map();
  private static currentModelId: string = 'mock';

  static register(provider: ModelProvider) {
    this.providers.set(provider.id, provider);
  }

  static get(id: string): ModelProvider | undefined {
    return this.providers.get(id);
  }

  static getAll(): ModelProvider[] {
    return Array.from(this.providers.values());
  }

  static setCurrentModel(id: string) {
    if (this.providers.has(id)) {
      this.currentModelId = id;
      return true;
    }
    return false;
  }

  static getCurrentModelId(): string {
    return this.currentModelId;
  }

  static getCurrentModel(): ModelProvider {
    return this.providers.get(this.currentModelId) || this.providers.values().next().value || {
      id: 'fallback',
      name: 'Fallback',
      generate: async () => ({ content: 'No models available' })
    };
  }
}
