import { ModelProvider, ModelResponse, Tool, StreamCallback, ModelAttachment, ModelLevel } from '../core/models';
import { inferModelLevel } from '../core/model-level';
import OpenAI from 'openai';
import { parseToolCallArguments } from '../core/provider-parse';

export class NvidiaProvider implements ModelProvider {
  id: string;
  name: string;
  level?: ModelLevel;
  private client: OpenAI;
  private modelName: string;
  private enableThinking: boolean;

  constructor(apiKey: string, modelName: string, enableThinking: boolean = true, id: string = 'nvidia') {
    this.id = id;
    this.name = `NVIDIA · ${modelName}`;
    this.level = inferModelLevel(modelName, 'nvidia');
    this.client = new OpenAI({
      baseURL: 'https://integrate.api.nvidia.com/v1',
      apiKey: apiKey,
    });
    this.modelName = modelName;
    this.enableThinking = enableThinking;
  }

  async generate(prompt: string, systemPrompt?: string, tools?: Tool[], attachments?: ModelAttachment[]): Promise<ModelResponse> {
    return this.generateStream(prompt, systemPrompt, tools, undefined, attachments);
  }

  async generateStream(prompt: string, systemPrompt?: string, tools?: Tool[], onChunk?: StreamCallback, attachments?: ModelAttachment[]): Promise<ModelResponse> {
    try {
      const messages: any[] = [];

      if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
      }

      messages.push({ role: 'user', content: attachments?.length ? [
        { type: 'text', text: prompt },
        ...attachments.map(item => ({ type: 'image_url', image_url: { url: item.dataUrl } }))
      ] : prompt });

      let openAiTools: any[] | undefined;
      if (tools && tools.length > 0) {
        openAiTools = tools.map((t) => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: t.inputSchema
          }
        }));
      }

      const stream = await (this.client.chat.completions.create({
        model: this.modelName,
        messages,
        tools: openAiTools,
        tool_choice: openAiTools && openAiTools.length > 0 ? 'auto' : undefined,
        stream: true,
        chat_template_kwargs: this.enableThinking ? { thinking: true } : undefined
      } as any) as any as AsyncIterable<any>);

      let fullContent = '';
      const toolCallsMap: Record<number, any> = {};

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

      const toolCalls = Object.values(toolCallsMap).map((tc: any) => {
        return {
          id: tc.id || 'unknown',
          name: tc.name,
          arguments: tc.arguments
              ? parseToolCallArguments(tc.arguments, { provider: this.name, toolName: tc.name })
              : {}
        };
      });

      return {
        content: fullContent || null,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        usage: {
          promptTokens: 0,
          completionTokens: 0
        }
      };
    } catch (error: any) {
      const status = typeof error?.status === 'number' ? error.status : undefined;
      const requestId =
        (typeof error?.headers?.get === 'function' ? error.headers.get('x-request-id') : undefined) ||
        (typeof error?.headers?.['x-request-id'] === 'string' ? error.headers['x-request-id'] : undefined);

      let hint = '';
      if (status === 401) {
        hint = 'Check NVIDIA_API_KEY in .env (valid key, no quotes/spaces) and restart the app.';
      } else if (status === 403) {
        hint = 'Key is rejected/unauthorized. Verify your NVIDIA key has access to integrate.api.nvidia.com and that the model is allowed for your account.';
      } else if (status === 404) {
        hint = 'Model or endpoint not found. Try listing models and set config.aiModel to an available model id.';
      }

      const parts = [
        '[Error] Failed to generate response from NVIDIA Integrate API.',
        status ? `status=${status}` : null,
        requestId ? `request_id=${requestId}` : null,
        error?.message ? `details=${error.message}` : null,
        hint ? `hint=${hint}` : null
      ].filter(Boolean);

      const wrapped: any = new Error(parts.join(' '));
      wrapped.status = status;
      wrapped.requestId = requestId;
      throw wrapped;
    }
  }
}
