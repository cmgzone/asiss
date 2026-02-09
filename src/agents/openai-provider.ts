import { ModelProvider, ModelResponse, Tool, ToolCall } from '../core/models';
import fetch from 'node-fetch';

/**
 * Generic OpenAI Provider
 * 
 * Connects to any OpenAI-compatible API (OpenAI, Ollama, LM Studio, vLLM, etc.)
 */
export class GenericOpenAIProvider implements ModelProvider {
    id: string;
    name: string;
    private apiKey: string;
    private baseURL: string;
    private modelName: string;
    private contextWindow: number;

    constructor(id: string, name: string, baseURL: string, apiKey: string, modelName: string, contextWindow: number = 128000) {
        this.id = id;
        this.name = name;
        this.baseURL = baseURL.replace(/\/$/, ''); // Remove trailing slash
        this.apiKey = apiKey;
        this.modelName = modelName;
        this.contextWindow = contextWindow;
    }

    async generate(prompt: string, systemPrompt?: string, tools?: Tool[]): Promise<ModelResponse> {
        const messages = [];
        if (systemPrompt) {
            messages.push({ role: 'system', content: systemPrompt });
        }
        messages.push({ role: 'user', content: prompt });

        const body: any = {
            model: this.modelName,
            messages: messages,
            temperature: 0.7,
            max_tokens: 4096
        };

        // Add tools if supported
        if (tools && tools.length > 0) {
            body.tools = tools.map((t: Tool) => ({
                type: 'function',
                function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.inputSchema
                }
            }));
            body.tool_choice = 'auto'; // Let model decide
        }

        try {
            const response = await fetch(`${this.baseURL}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`
                },
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`API error (${response.status}): ${errorText}`);
            }

            const data: any = await response.json();
            const choice = data.choices[0];
            const message = choice.message;

            const result: ModelResponse = {
                content: message.content,
                usage: data.usage ? {
                    promptTokens: data.usage.prompt_tokens,
                    completionTokens: data.usage.completion_tokens
                } : undefined
            };

            if (message.tool_calls) {
                result.toolCalls = message.tool_calls.map((tc: any) => ({
                    id: tc.id,
                    name: tc.function.name,
                    arguments: JSON.parse(tc.function.arguments)
                }));
            }

            return result;
        } catch (error: any) {
            console.error(`[GenericOpenAI] Error generating response from ${this.name}:`, error);
            return {
                content: `⚠️ **Model Error**: ${error.message}`
            };
        }
    }

    async generateStream(prompt: string, systemPrompt?: string, tools?: Tool[], onChunk?: (chunk: string) => void): Promise<ModelResponse> {
        const messages = [];
        if (systemPrompt) {
            messages.push({ role: 'system', content: systemPrompt });
        }
        messages.push({ role: 'user', content: prompt });

        const body: any = {
            model: this.modelName,
            messages: messages,
            temperature: 0.7,
            max_tokens: 4096,
            stream: true
        };

        if (tools && tools.length > 0) {
            body.tools = tools.map((t: Tool) => ({
                type: 'function',
                function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.inputSchema
                }
            }));
            body.tool_choice = 'auto';
        }

        try {
            const response = await fetch(`${this.baseURL}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`
                },
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`API error (${response.status}): ${errorText}`);
            }

            // Real streaming implementation
            const result: ModelResponse = { content: '' };
            const toolCallsMap: Record<number, any> = {};

            // Note: node-fetch v2 doesn't have AsyncIterator on body by default
            // but we can use response.body.on('data', ...) or similar if it's a Node stream
            // In many environments node-fetch v2 body is a Node Readable Stream

            return new Promise((resolve, reject) => {
                let fullContent = '';
                const stream = response.body;

                stream.on('data', (chunk: Buffer) => {
                    const lines = chunk.toString().split('\n');
                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed || trimmed === 'data: [DONE]') continue;

                        if (trimmed.startsWith('data: ')) {
                            try {
                                const data = JSON.parse(trimmed.slice(6));
                                const delta = data.choices[0]?.delta;

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
                            } catch (e) {
                                // Ignore partial or malformed lines
                            }
                        }
                    }
                });

                stream.on('end', () => {
                    result.content = fullContent;
                    const toolCalls = Object.values(toolCallsMap).map((tc: any) => ({
                        id: tc.id || 'unknown',
                        name: tc.name,
                        arguments: tc.arguments ? JSON.parse(tc.arguments) : {}
                    }));
                    if (toolCalls.length > 0) result.toolCalls = toolCalls;
                    resolve(result);
                });

                stream.on('error', (err: Error) => {
                    reject(err);
                });
            });

        } catch (error: any) {
            console.error(`[GenericOpenAI] Stream Error (${this.name}):`, error);
            if (onChunk) onChunk(`\n⚠️ **Stream Error**: ${error.message}`);
            return { content: `⚠️ **Model Error**: ${error.message}` };
        }
    }
}
