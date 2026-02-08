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
  toolCalls?: ToolCall[];
  usage?: {
    promptTokens: number;
    completionTokens: number;
  };
}

export type StreamCallback = (chunk: string) => void;

export interface ModelProvider {
  id: string;
  name: string;
  generate(prompt: string, systemPrompt?: string, tools?: Tool[]): Promise<ModelResponse>;
  generateStream?(prompt: string, systemPrompt?: string, tools?: Tool[], onChunk?: StreamCallback): Promise<ModelResponse>;
}

export class ModelRegistry {
  private static providers: Map<string, ModelProvider> = new Map();

  static register(provider: ModelProvider) {
    this.providers.set(provider.id, provider);
  }

  static get(id: string): ModelProvider | undefined {
    return this.providers.get(id);
  }
}
