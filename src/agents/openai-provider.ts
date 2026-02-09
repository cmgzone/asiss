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
        // Basic streaming simulation for now
        const result = await this.generate(prompt, systemPrompt, tools);
        if (onChunk && result.content) {
            // Split by words to simulate stream
            const words = result.content.split(' ');
            for (const word of words) {
                onChunk(word + ' ');
                await new Promise(r => setTimeout(r, 10));
            }
        }
        return result;
    }
}
