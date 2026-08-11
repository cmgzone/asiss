import { ModelProvider, ModelResponse, Tool, ToolCall, ModelAttachment, StreamCallback, ModelLevel } from '../core/models';
import { inferModelLevel } from '../core/model-level';
import fetch from 'node-fetch';
import { promptCachingEnabled, isCacheableProvider, cacheSystem, cacheTools, stripCacheControl, extractCacheUsage } from '../core/prompt-cache';

/**
 * OpenCode Zen provider.
 *
 * OpenCode Zen is an AI gateway that exposes OpenAI-compatible endpoints, but
 * the correct endpoint depends on the model family:
 *   - GPT / o-series models      -> https://opencode.ai/zen/v1/responses
 *   - Claude / Sonnet / Opus    -> https://opencode.ai/zen/v1/messages
 *   - everything else (DeepSeek, GLM, Kimi, Grok, MiniMax, ...)
 *                                  -> https://opencode.ai/zen/v1/chat/completions
 *
 * Docs: https://opencode.ai/docs/zen/
 *
 * A request timeout is enforced so a stuck upstream call fails fast instead of
 * leaving the agent stuck "thinking" forever.
 */
export const OPENCODE_BASE_URL = 'https://opencode.ai/zen/v1';
const DEFAULT_TIMEOUT_MS = 150_000; // 2.5 minutes; fail fast rather than hang

export interface OpenCodeModelInfo {
  id: string;
  name: string;
}

type ZenEndpoint = 'chat' | 'responses' | 'messages';

function endpointForModel(model: string): ZenEndpoint {
  const m = model.toLowerCase();
  if (m.startsWith('gpt') || m.startsWith('o1') || m.startsWith('o3') || m.includes('chatgpt')) return 'responses';
  if (m.startsWith('claude') || m.startsWith('sonnet') || m.startsWith('opus') || m.startsWith('haiku') || m.startsWith('fable')) return 'messages';
  return 'chat';
}

export class OpenCodeProvider implements ModelProvider {
  id = 'opencode';
  name = 'OpenCode Zen';
  level?: ModelLevel;
  private apiKey: string;
  private modelName: string;
  private maxOutputTokens?: number;

  constructor(apiKey: string, modelName: string, maxOutputTokens?: number) {
    this.apiKey = apiKey;
    this.modelName = modelName;
    this.maxOutputTokens = maxOutputTokens;
    this.level = inferModelLevel(modelName, 'opencode');
  }

  setModel(modelName: string): void {
    this.modelName = modelName;
    this.level = inferModelLevel(modelName, 'opencode');
  }

  getModelName(): string {
    return this.modelName;
  }

  async generate(prompt: string, systemPrompt?: string, tools?: Tool[], attachments?: ModelAttachment[]): Promise<ModelResponse> {
    const ep = endpointForModel(this.modelName);
    if (ep === 'chat') return this.callChat(prompt, systemPrompt, tools, attachments);
    if (ep === 'responses') return this.callResponses(prompt, systemPrompt, tools);
    return this.callMessages(prompt, systemPrompt, tools);
  }

  async generateStream(prompt: string, systemPrompt?: string, tools?: Tool[], onChunk?: StreamCallback, attachments?: ModelAttachment[]): Promise<ModelResponse> {
    const ep = endpointForModel(this.modelName);
    if (ep !== 'chat') {
      const response = await this.generate(prompt, systemPrompt, tools, attachments);
      if (onChunk && response.content) onChunk(response.content);
      return response;
    }
    return this.callChatStream(prompt, systemPrompt, tools, attachments, onChunk);
  }

  private getMaxOutputTokens(): number | undefined {
    const configured = Number(this.maxOutputTokens || process.env.OPENCODE_MAX_OUTPUT_TOKENS || 0);
    if (!Number.isFinite(configured) || configured <= 0) return undefined;
    return Math.floor(configured);
  }

  private async fetchWithTimeout(url: string, init: any): Promise<any> {
    const ms = Number(process.env.OPENCODE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, ms));
    try {
      return await fetch(url, { ...init, signal: controller.signal as any });
    } finally {
      clearTimeout(timer);
    }
  }

  private authHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`
    };
  }

  private get caching(): boolean {
    return promptCachingEnabled() && isCacheableProvider(OPENCODE_BASE_URL, this.modelName);
  }

  private async postJsonFallback(url: string, body: any): Promise<any> {
    const tryOnce = async (b: any) => {
      const response = await this.fetchWithTimeout(url, { method: 'POST', headers: this.authHeaders(), body: JSON.stringify(b) });
      if (!response.ok) throw this.buildError(response.status, url);
      return response.json();
    };
    try {
      return await tryOnce(body);
    } catch (e: any) {
      if (this.caching && e?.status >= 400 && e?.status < 500) {
        try { return await tryOnce(stripCacheControl(body)); } catch { /* keep original error */ }
      }
      throw e;
    }
  }

  private buildError(status: number, label: string): Error {
    const error: any = new Error(`OpenCode Zen (${label}) request failed with status ${status}`);
    error.status = status;
    return error;
  }

  private parseTextContent(value: any): string {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      return value.map((part: any) => (typeof part === 'string' ? part : part?.text || '')).join('');
    }
    if (value && typeof value === 'object') return value.text || '';
    return '';
  }

  // ---- OpenAI-compatible chat/completions (most models) ----
  private async callChat(prompt: string, systemPrompt?: string, tools?: Tool[], attachments?: ModelAttachment[]): Promise<ModelResponse> {
    const messages: any[] = [];
    if (systemPrompt) {
      if (this.caching) messages.push(...cacheSystem(systemPrompt));
      else messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({
      role: 'user',
      content: attachments?.length
        ? [{ type: 'text', text: prompt }, ...attachments.map(a => ({ type: 'image_url', image_url: { url: a.dataUrl } }))]
        : prompt
    });

    const body: any = { model: this.modelName, messages, temperature: 0.7 };
    const maxTokens = this.getMaxOutputTokens();
    if (maxTokens) body.max_tokens = maxTokens;
    if (tools && tools.length > 0) {
      const mapped = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema || {} } }));
      body.tools = this.caching ? cacheTools(mapped) : mapped;
      body.tool_choice = 'auto';
    }

    const data = await this.postJsonFallback(`${OPENCODE_BASE_URL}/chat/completions`, body);
    const message = data?.choices?.[0]?.message;
    const content = this.parseTextContent(message?.content) || '';
    const reasoning = this.parseTextContent(message?.reasoning_content) || '';
    const toolCalls: ToolCall[] = (message?.tool_calls || []).map((tc: any) => ({
      id: tc.id || `call_${Math.random().toString(36).slice(2)}`,
      name: tc.function?.name || '',
      arguments: safeParse(tc.function?.arguments)
    }));
    return {
      content,
      reasoning: reasoning.trim() ? reasoning : undefined,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      usage: normalizeUsage(data?.usage)
    };
  }

  private async callChatStream(prompt: string, systemPrompt?: string, tools?: Tool[], attachments?: ModelAttachment[], onChunk?: StreamCallback): Promise<ModelResponse> {
    const messages: any[] = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: prompt });

    const body: any = { model: this.modelName, messages, temperature: 0.7, stream: true };
    const maxTokens = this.getMaxOutputTokens();
    if (maxTokens) body.max_tokens = maxTokens;
    if (tools && tools.length > 0) {
      const mapped = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema || {} } }));
      body.tools = this.caching ? cacheTools(mapped) : mapped;
      body.tool_choice = 'auto';
    }

    let response = await this.fetchWithTimeout(`${OPENCODE_BASE_URL}/chat/completions`, {
      method: 'POST', headers: this.authHeaders(), body: JSON.stringify(body)
    });
    if (!response.ok && this.caching && response.status >= 400 && response.status < 500) {
      response = await this.fetchWithTimeout(`${OPENCODE_BASE_URL}/chat/completions`, {
        method: 'POST', headers: this.authHeaders(), body: JSON.stringify(stripCacheControl(body))
      });
    }
    if (!response.ok) throw this.buildError(response.status, 'chat/completions(stream)');

    const result: ModelResponse = { content: '', reasoning: '' };
    const toolCallsMap: Record<number, any> = {};

    await new Promise<void>((resolve, reject) => {
      const stream: any = (response as any).body;
      // SSE lines can be fragmented across network 'data' events, so we must
      // buffer partial lines across chunks before parsing. Parsing each chunk
      // with split('\n') dropped lines that straddled a chunk boundary — most
      // visibly the tool_call "name" delta — which produced empty-named tool
      // calls and broke every agentic tool call.
      let buffer = '';
      const handleLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') return;
        if (!trimmed.startsWith('data: ')) return;
        try {
          const data = JSON.parse(trimmed.slice(6));
          const delta = data.choices?.[0]?.delta;
          if (delta?.content) {
            result.content += delta.content;
            if (onChunk) onChunk(delta.content);
          }
          if (delta?.reasoning_content) {
            result.reasoning += delta.reasoning_content;
          }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (!toolCallsMap[tc.index]) toolCallsMap[tc.index] = { id: tc.id, name: '', arguments: '' };
              const entry = toolCallsMap[tc.index];
              if (tc.id) entry.id = tc.id;
              // Name often arrives in a later streamed delta; update it whenever
              // present so we never end up with an empty tool name.
              if (tc.function?.name) entry.name = tc.function.name;
              if (tc.function?.arguments) entry.arguments += tc.function.arguments;
            }
          }
        } catch { /* ignore partial/malformed line */ }
      };
      stream.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
          handleLine(buffer.slice(0, newlineIndex));
          buffer = buffer.slice(newlineIndex + 1);
        }
      });
      stream.on('end', () => {
        if (buffer.trim()) handleLine(buffer);
        // Defensive: drop any tool call that never acquired a real name so a
        // stray empty-named call cannot brick the whole agent run.
        const toolCalls: ToolCall[] = Object.values(toolCallsMap)
          .map((tc: any) => ({ id: tc.id || 'unknown', name: tc.name, arguments: safeParse(tc.arguments) }))
          .filter(tc => tc.name && tc.name !== 'unknown');
        if (toolCalls.length > 0) result.toolCalls = toolCalls;
        if (result.reasoning && typeof result.reasoning === 'string' && !result.reasoning.trim()) {
          result.reasoning = undefined;
        }
        resolve();
      });
      stream.on('error', (err: Error) => reject(err));
    });

    return result;
  }

  // ---- OpenAI Responses API (GPT / o-series) ----
  private async callResponses(prompt: string, systemPrompt?: string, tools?: Tool[]): Promise<ModelResponse> {
    const body: any = {
      model: this.modelName,
      input: [{ role: 'user', content: prompt }],
      instructions: systemPrompt || undefined,
      stream: false
    };
    const maxTokens = this.getMaxOutputTokens();
    if (maxTokens) body.max_tokens = maxTokens;
    if (tools && tools.length > 0) {
      body.tools = tools.map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.inputSchema || {} }));
      body.tool_choice = 'auto';
    }

    const response = await this.fetchWithTimeout(`${OPENCODE_BASE_URL}/responses`, {
      method: 'POST', headers: this.authHeaders(), body: JSON.stringify(body)
    });
    if (!response.ok) throw this.buildError(response.status, 'responses');
    const data = await response.json();

    let content = '';
    const toolCalls: ToolCall[] = [];
    for (const item of data?.output || []) {
      if (item.type === 'message') {
        content += (item.content || []).map((c: any) => c?.text || '').join('');
      } else if (item.type === 'function_call') {
        toolCalls.push({
          id: item.call_id || item.id || `call_${Math.random().toString(36).slice(2)}`,
          name: item.name || '',
          arguments: safeParse(item.arguments)
        });
      }
    }
    return { content, toolCalls: toolCalls.length ? toolCalls : undefined, usage: normalizeUsage(data?.usage) };
  }

  // ---- Anthropic Messages API (Claude / Sonnet / Opus) ----
  private async callMessages(prompt: string, systemPrompt?: string, tools?: Tool[]): Promise<ModelResponse> {
    const body: any = {
      model: this.modelName,
      max_tokens: this.getMaxOutputTokens() || 16000,
      messages: [{ role: 'user', content: prompt }]
    };
    if (systemPrompt) body.system = this.caching ? cacheSystem(systemPrompt)[0].content : systemPrompt;
    if (tools && tools.length > 0) {
      const mapped = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema || {} }));
      body.tools = this.caching ? cacheTools(mapped) : mapped;
    }

    const data = await this.postJsonFallback(`${OPENCODE_BASE_URL}/messages`, body);

    let content = '';
    const toolCalls: ToolCall[] = [];
    for (const block of data?.content || []) {
      if (block.type === 'text') content += block.text || '';
      else if (block.type === 'tool_use') {
        toolCalls.push({ id: block.id || `tu_${Math.random().toString(36).slice(2)}`, name: block.name || '', arguments: block.input || {} });
      }
    }
    return { content, toolCalls: toolCalls.length ? toolCalls : undefined, usage: normalizeUsage(data?.usage) };
  }

  static async fetchModels(apiKey: string): Promise<OpenCodeModelInfo[]> {
    const response = await fetch(`${OPENCODE_BASE_URL}/models`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      const error: any = new Error(`OpenCode Zen models fetch failed (${response.status}): ${errorText.slice(0, 300)}`);
      error.status = response.status;
      throw error;
    }
    const data: any = await response.json();
    const rawList = Array.isArray(data) ? data : (data?.data || data?.models || []);
    const models: OpenCodeModelInfo[] = [];
    for (const entry of rawList) {
      const id = entry?.id || entry?.name || entry?.model;
      if (!id) continue;
      models.push({ id: String(id), name: String(entry?.name || entry?.label || id) });
    }
    return models;
  }
}

function safeParse(value: any): any {
  if (typeof value !== 'string') return value || {};
  const trimmed = value.trim();
  if (!trimmed) return {};
  try { return JSON.parse(trimmed); } catch { return {}; }
}

function normalizeUsage(usage: any): { promptTokens: number; completionTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number } | undefined {
  if (!usage) return undefined;
  return {
    promptTokens: Number(usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokens ?? 0),
    completionTokens: Number(usage.completion_tokens ?? usage.output_tokens ?? usage.completionTokens ?? 0),
    ...extractCacheUsage(usage)
  };
}
