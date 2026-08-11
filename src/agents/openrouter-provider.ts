import { ModelProvider, ModelResponse, Tool, StreamCallback, ModelAttachment, ModelLevel } from '../core/models';
import { inferModelLevel } from '../core/model-level';
import OpenAI from 'openai';
import { promptCachingEnabled, isCacheableProvider, cacheSystem, cacheTools, stripCacheControl, extractCacheUsage } from '../core/prompt-cache';

export class OpenRouterProvider implements ModelProvider {
  id: string;
  name: string;
  level?: ModelLevel;
  private client: OpenAI;
  private modelName: string;
  private static readonly BASE_URL = 'https://openrouter.ai/api/v1';

  constructor(apiKey: string, modelName: string, id: string = 'openrouter') {
    this.id = id;
    this.name = `OpenRouter · ${modelName}`;
    this.level = inferModelLevel(modelName, 'openrouter');
    this.client = new OpenAI({
      baseURL: OpenRouterProvider.BASE_URL,
      apiKey: apiKey,
    });
    this.modelName = modelName;
  }

  private get caching(): boolean {
    return promptCachingEnabled() && isCacheableProvider(OpenRouterProvider.BASE_URL, this.modelName);
  }

  private getMaxOutputTokens(): number | undefined {
    const configured = Number(process.env.OPENROUTER_MAX_OUTPUT_TOKENS || 0);
    if (Number.isFinite(configured) && configured > 0) return Math.floor(configured);
    return undefined;
  }

  private buildMessages(systemPrompt?: string, prompt?: string, attachments?: ModelAttachment[]): any[] {
    const messages: any[] = [];
    if (systemPrompt) {
      if (this.caching) messages.push(...cacheSystem(systemPrompt));
      else messages.push({ role: 'system', content: systemPrompt });
    }
    if (prompt) {
      messages.push({
        role: 'user',
        content: attachments?.length
          ? [
              { type: 'text', text: prompt },
              ...attachments.map(item => ({ type: 'image_url', image_url: { url: item.dataUrl } }))
            ]
          : prompt
      });
    }
    return messages;
  }

  private buildTools(tools?: Tool[]): any[] | undefined {
    if (!tools || tools.length === 0) return undefined;
    const mapped = tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema }
    }));
    return this.caching ? cacheTools(mapped) : mapped;
  }

  async generate(prompt: string, systemPrompt?: string, tools?: Tool[], attachments?: ModelAttachment[]): Promise<ModelResponse> {
      return this.generateStream(prompt, systemPrompt, tools, undefined, attachments);
  }

  async generateStream(prompt: string, systemPrompt?: string, tools?: Tool[], onChunk?: StreamCallback, attachments?: ModelAttachment[]): Promise<ModelResponse> {
    const attempt = async (cached: boolean): Promise<ModelResponse> => {
      const messages = cached ? this.buildMessages(systemPrompt, prompt, attachments) : this.buildMessagesPlain(systemPrompt, prompt, attachments);
      const openAiTools = cached ? this.buildTools(tools) : (tools && tools.length ? tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })) : undefined);
      const stream: any = await this.client.chat.completions.create({
        model: this.modelName,
        messages: messages as any,
        tools: openAiTools as any,
        stream: true,
        stream_options: { include_usage: true },
        ...(this.getMaxOutputTokens() ? { max_tokens: this.getMaxOutputTokens() } : {})
      } as any);

      let fullContent = '';
      let fullReasoning = '';
      let toolCallsMap: Record<number, any> = {};
      let usageData: any;

      for await (const chunk of stream) {
          if (chunk.usage) { usageData = chunk.usage; continue; }
          const delta = chunk.choices[0]?.delta;

          if (delta?.content) {
              fullContent += delta.content;
              if (onChunk) onChunk(delta.content);
          }

          if (delta?.reasoning) fullReasoning += delta.reasoning;
          if (delta?.reasoning_content) fullReasoning += delta.reasoning_content;

          if (delta?.tool_calls) {
              delta.tool_calls.forEach((tc: any) => {
                  if (!toolCallsMap[tc.index]) {
                      toolCallsMap[tc.index] = { id: tc.id, name: tc.function?.name || '', arguments: '' };
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

      const usage = usageData
        ? {
            promptTokens: Number(usageData.prompt_tokens ?? 0),
            completionTokens: Number(usageData.completion_tokens ?? 0),
            ...extractCacheUsage(usageData)
          }
        : { promptTokens: 0, completionTokens: 0 };

      return {
        content: fullContent || null,
        reasoning: fullReasoning.trim() ? fullReasoning : undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        usage
      };
    };

    try {
      return await attempt(this.caching);
    } catch (e: any) {
      if (this.caching && e?.status >= 400 && e?.status < 500) {
        try { return await attempt(false); } catch { /* fall through to original error */ }
      }
      console.error('[OpenRouterProvider] Error:', e);
      throw e;
    }
  }

  private buildMessagesPlain(systemPrompt?: string, prompt?: string, attachments?: ModelAttachment[]): any[] {
    const messages: any[] = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    if (prompt) {
      messages.push({
        role: 'user',
        content: attachments?.length
          ? [{ type: 'text', text: prompt }, ...attachments.map(item => ({ type: 'image_url', image_url: { url: item.dataUrl } }))]
          : prompt
      });
    }
    return messages;
  }
}
