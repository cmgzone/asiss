import { ModelProvider, ModelResponse, Tool, ToolCall, ModelAttachment, ModelLevel } from '../core/models';
import { inferModelLevel } from '../core/model-level';
import {
  promptCachingEnabled,
  isCacheableProvider,
  cacheSystem,
  cacheTools,
  extractCacheUsage,
  stripCacheControl
} from '../core/prompt-cache';
import { parseToolCallArguments } from '../core/provider-parse';
import fetch from 'node-fetch';

/**
 * Generic OpenAI Provider
 *
 * Connects to any OpenAI-compatible API (OpenAI, Ollama, LM Studio, vLLM, etc.)
 */
export class GenericOpenAIProvider implements ModelProvider {
    id: string;
    name: string;
    level?: ModelLevel;
    private apiKey: string;
    private baseURL: string;
    private modelName: string;
    private contextWindow: number;
    private maxOutputTokens?: number;

    constructor(id: string, name: string, baseURL: string, apiKey: string, modelName: string, contextWindow: number = 128000, maxOutputTokens?: number, level?: ModelLevel) {
        this.id = id;
        this.name = name;
        this.baseURL = baseURL.replace(/\/$/, ''); // Remove trailing slash
        this.modelName = modelName;
        this.contextWindow = contextWindow;
        this.maxOutputTokens = maxOutputTokens;
        this.level = level || inferModelLevel(modelName, this.baseURL.includes('openrouter.ai') ? 'openrouter' : (this.baseURL.includes('nvidia.com') ? 'nvidia' : 'openai'));

        // Fallback to environment variables if apiKey is missing or empty
        this.apiKey = apiKey;
        if (!this.apiKey || this.apiKey.trim() === '') {
            if (this.baseURL.includes('openrouter.ai')) {
                this.apiKey = process.env.OPENROUTER_API_KEY || '';
            } else if (this.baseURL.includes('nvidia.com')) {
                this.apiKey = process.env.NVIDIA_API_KEY || '';
            } else {
                this.apiKey = process.env.OPENAI_API_KEY || '';
            }
        }
    }

    private get caching(): boolean {
        return promptCachingEnabled() && isCacheableProvider(this.baseURL, this.modelName);
    }

    private authHeaders(): Record<string, string> {
        return {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
            'HTTP-Referer': 'https://github.com/cmgzone/asiss',
            'X-Title': 'Gitu AI Assistant'
        };
    }

    private getMaxOutputTokens(): number | undefined {
        const configured = Number(this.maxOutputTokens || process.env.OPENAI_MAX_OUTPUT_TOKENS || process.env.MAX_OUTPUT_TOKENS || 0);
        if (!Number.isFinite(configured) || configured <= 0) return undefined;
        return Math.floor(configured);
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
        const mapped = tools.map((t: Tool) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.inputSchema }
        }));
        return this.caching ? cacheTools(mapped) : mapped;
    }

    // POST JSON with a safe "retry without cache_control" fallback for 4xx.
    private async postJson(url: string, body: any): Promise<any> {
        const tryOnce = async (b: any): Promise<any> => {
            const response = await fetch(url, {
                method: 'POST',
                headers: this.authHeaders(),
                body: JSON.stringify(b)
            });
            if (!response.ok) {
                const errorText = await response.text().catch(() => '');
                const err: any = new Error(`API error (${response.status}): ${errorText}`);
                err.status = response.status;
                throw err;
            }
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

    async generate(prompt: string, systemPrompt?: string, tools?: Tool[], attachments?: ModelAttachment[]): Promise<ModelResponse> {
        const messages = this.buildMessages(systemPrompt, prompt, attachments);
        const body: any = { model: this.modelName, messages, temperature: 0.7 };
        const maxOutputTokens = this.getMaxOutputTokens();
        if (maxOutputTokens) body.max_tokens = maxOutputTokens;
        const mappedTools = this.buildTools(tools);
        if (mappedTools) {
            body.tools = mappedTools;
            body.tool_choice = 'auto';
        }

        try {
            const data: any = await this.postJson(`${this.baseURL}/chat/completions`, body);
            const choice = data.choices[0];
            const message = choice.message;

            const result: ModelResponse = {
                content: message.content,
                usage: data.usage
                    ? {
                        promptTokens: data.usage.prompt_tokens,
                        completionTokens: data.usage.completion_tokens,
                        ...extractCacheUsage(data.usage)
                      }
                    : undefined
            };

            if (message.tool_calls) {
                result.toolCalls = (message.tool_calls as any[]).map((tc: any) => ({
                    id: tc.id,
                    name: tc.function.name,
                    arguments: parseToolCallArguments(tc.function.arguments, { provider: this.name, toolName: tc.function?.name })
                }));
            }

            return result;
        } catch (error: any) {
            console.error(`[GenericOpenAI] Error generating response from ${this.name}:`, error);
            throw error;
        }
    }

    async generateStream(prompt: string, systemPrompt?: string, tools?: Tool[], onChunk?: (chunk: string) => void): Promise<ModelResponse> {
        const messages = this.buildMessages(systemPrompt, prompt);
        const body: any = { model: this.modelName, messages, temperature: 0.7, stream: true, stream_options: { include_usage: true } };
        const maxOutputTokens = this.getMaxOutputTokens();
        if (maxOutputTokens) body.max_tokens = maxOutputTokens;
        const mappedTools = this.buildTools(tools);
        if (mappedTools) {
            body.tools = mappedTools;
            body.tool_choice = 'auto';
        }

        try {
            return await this.streamChat(body, onChunk);
        } catch (e: any) {
            if (this.caching && e?.status >= 400 && e?.status < 500) {
                try { return await this.streamChat(stripCacheControl(body), onChunk); } catch { /* keep original error */ }
            }
            throw e;
        }
    }

    private streamChat(body: any, onChunk?: (chunk: string) => void): Promise<ModelResponse> {
        return new Promise((resolve, reject) => {
            fetch(`${this.baseURL}/chat/completions`, {
                method: 'POST',
                headers: this.authHeaders(),
                body: JSON.stringify(body)
            }).then(async (response) => {
                if (!response.ok) {
                    const errorText = await response.text().catch(() => '');
                    const err: any = new Error(`API error (${response.status}): ${errorText}`);
                    err.status = response.status;
                    throw err;
                }
                return response;
            }).then((response) => {
                const result: ModelResponse = { content: '' };
                const toolCallsMap: Record<number, any> = {};
                let usageData: any;
                const stream: any = (response as any).body;

                // SSE lines can be fragmented across network 'data' events, so
                // buffer partial lines across chunks before parsing. Parsing
                // each chunk with split('\n') dropped lines that straddled a
                // chunk boundary, silently corrupting streamed tool-call
                // arguments and yielding unterminated JSON at the end.
                let buffer = '';
                const handleLine = (line: string) => {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed === 'data: [DONE]') return;
                    if (!trimmed.startsWith('data: ')) return;
                    try {
                        const data = JSON.parse(trimmed.slice(6));
                        if (data.usage) { usageData = data.usage; return; }
                        const delta = data.choices[0]?.delta;

                        if (delta?.content) {
                            result.content += delta.content;
                            if (onChunk) onChunk(delta.content);
                        }

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
                    } catch (e) {
                        // Ignore partial or malformed lines
                    }
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
                    try {
                        if (buffer.trim()) handleLine(buffer);
                        const toolCalls = Object.values(toolCallsMap).map((tc: any) => ({
                            id: tc.id || 'unknown',
                            name: tc.name,
                            arguments: tc.arguments
                                ? parseToolCallArguments(tc.arguments, { provider: this.name, toolName: tc.name })
                                : {}
                        }));
                        if (toolCalls.length > 0) result.toolCalls = toolCalls;
                        if (usageData) {
                            result.usage = {
                                promptTokens: Number(usageData.prompt_tokens ?? 0),
                                completionTokens: Number(usageData.completion_tokens ?? 0),
                                ...extractCacheUsage(usageData)
                            };
                        }
                        resolve(result);
                    } catch (err) {
                        reject(err);
                    }
                });

                stream.on('error', (err: Error) => reject(err));
            }).catch(reject);
        });
    }

    setModel(modelName: string): void {
        this.modelName = modelName;
    }

    getModelName(): string {
        return this.modelName;
    }
}
