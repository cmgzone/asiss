import { ModelProvider, ModelResponse, Tool, StreamCallback } from '../core/models';
import OpenAI from 'openai';

export class OpenRouterProvider implements ModelProvider {
  id = 'openrouter';
  name = 'OpenRouter';
  private client: OpenAI;
  private modelName: string;

  constructor(apiKey: string, modelName: string) {
    this.client = new OpenAI({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: apiKey,
    });
    this.modelName = modelName;
  }

  async generate(prompt: string, systemPrompt?: string, tools?: Tool[]): Promise<ModelResponse> {
      return this.generateStream(prompt, systemPrompt, tools);
  }

  async generateStream(prompt: string, systemPrompt?: string, tools?: Tool[], onChunk?: StreamCallback): Promise<ModelResponse> {
    try {
      const messages: any[] = [];
      
      if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
      }
      
      messages.push({ role: 'user', content: prompt });

      let openAiTools: any[] | undefined;
      if (tools && tools.length > 0) {
          openAiTools = tools.map(t => ({
              type: 'function',
              function: {
                  name: t.name,
                  description: t.description,
                  parameters: t.inputSchema
              }
          }));
      }

      const stream = await this.client.chat.completions.create({
        model: this.modelName,
        messages: messages,
        tools: openAiTools,
        stream: true
      });

      let fullContent = '';
      let toolCallsMap: Record<number, any> = {};

      for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta;
          
          if (delta?.content) {
              fullContent += delta.content;
              if (onChunk) onChunk(delta.content);
          }

          if (delta?.tool_calls) {
              delta.tool_calls.forEach((tc: any) => {
                  if (!toolCallsMap[tc.index]) {
                      toolCallsMap[tc.index] = {
                          id: tc.id,
                          name: tc.function?.name || '',
                          arguments: ''
                      };
                  }
                  if (tc.function?.arguments) {
                      toolCallsMap[tc.index].arguments += tc.function.arguments;
                  }
              });
          }
      }

      const toolCalls = Object.values(toolCallsMap).map((tc: any) => ({
          id: tc.id || 'unknown',
          name: tc.name,
          arguments: tc.arguments ? JSON.parse(tc.arguments) : {}
      }));
      
      return {
        content: fullContent || null,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        usage: {
            promptTokens: 0, // Streaming doesn't return usage usually
            completionTokens: 0
        }
      };
    } catch (error: any) {
      console.error('[OpenRouterProvider] Error:', error);
      const errorMsg = `[Error] Failed to generate response: ${error.message}`;
      // CRITICAL FIX: Stream the error message to the user so they see it!
      if (onChunk) onChunk(errorMsg);
      return {
        content: errorMsg
      };
    }
  }
}
