import { ModelProvider, ModelResponse, Tool } from '../core/models';

export class MockProvider implements ModelProvider {
  id = 'mock';
  name = 'Mock LLM';

  async generate(prompt: string, systemPrompt?: string, tools?: Tool[]): Promise<ModelResponse> {
    // Simulate network delay
    await new Promise(resolve => setTimeout(resolve, 500));

    let content = `[MockLLM] I heard you say: "${prompt}".`;
    if (systemPrompt) {
      content += ` (My instructions are: ${systemPrompt.substring(0, 20)}...)`;
    }
    
    if (tools && tools.length > 0) {
        content += `\n[System] I see ${tools.length} tools available but I am a mock provider and cannot call them.`;
    }

    return {
      content,
      usage: {
        promptTokens: prompt.length,
        completionTokens: content.length
      }
    };
  }
}
