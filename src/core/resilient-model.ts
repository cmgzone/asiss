import { ModelProvider, ModelResponse, StreamCallback, Tool, ModelAttachment } from './models';
import { hookManager } from './hooks';

export interface ModelResilienceConfig {
  enabled?: boolean;
  cooldownMs?: number;
  fallbackModelIds?: string[];
  includeAllEnabledModels?: boolean;
}

export interface ModelProviderHealth {
  id: string;
  name: string;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  cooldownUntil?: number;
  lastError?: string;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

class ModelResilienceManager {
  private health = new Map<string, ModelProviderHealth>();
  private lastSuccessfulProviderId = '';

  public recordSuccess(provider: ModelProvider): void {
    const current = this.getOrCreate(provider);
    current.successes += 1;
    current.consecutiveFailures = 0;
    current.lastSuccessAt = Date.now();
    current.cooldownUntil = undefined;
    current.lastError = undefined;
    this.lastSuccessfulProviderId = provider.id;
  }

  public recordFailure(provider: ModelProvider, error: unknown, cooldownMs: number): void {
    const current = this.getOrCreate(provider);
    current.failures += 1;
    current.consecutiveFailures += 1;
    current.lastFailureAt = Date.now();
    current.lastError = String((error as any)?.message || error || 'Unknown model error').slice(0, 500);
    current.cooldownUntil = Date.now() + Math.max(1_000, cooldownMs);
  }

  public isCoolingDown(providerId: string): boolean {
    const until = this.health.get(providerId)?.cooldownUntil || 0;
    return until > Date.now();
  }

  public getLastSuccessfulProviderId(): string {
    return this.lastSuccessfulProviderId;
  }

  public list(): ModelProviderHealth[] {
    return Array.from(this.health.values()).map(item => ({ ...item }));
  }

  public reset(providerId?: string): void {
    if (providerId) this.health.delete(providerId);
    else this.health.clear();
  }

  private getOrCreate(provider: ModelProvider): ModelProviderHealth {
    let current = this.health.get(provider.id);
    if (!current) {
      current = {
        id: provider.id,
        name: provider.name,
        successes: 0,
        failures: 0,
        consecutiveFailures: 0
      };
      this.health.set(provider.id, current);
    }
    return current;
  }
}

export const modelResilienceManager = new ModelResilienceManager();

export class ResilientModelProvider implements ModelProvider {
  readonly id: string;
  readonly name: string;
  private readonly candidates: ModelProvider[];
  private readonly cooldownMs: number;
  private lastUsedProviderId = '';

  constructor(primary: ModelProvider, fallbacks: ModelProvider[], config: ModelResilienceConfig = {}) {
    const seen = new Set<string>();
    this.candidates = [primary, ...fallbacks].filter(provider => {
      if (!provider || seen.has(provider.id) || provider.id === 'mock' || provider.id === 'error' || provider.id.startsWith('resilient:')) return false;
      seen.add(provider.id);
      return true;
    });
    this.id = `resilient:${primary.id}`;
    this.name = `${primary.name} with automatic fallback`;
    this.cooldownMs = Math.max(5_000, Number(config.cooldownMs) || 5 * 60_000);
  }

  async generate(prompt: string, systemPrompt?: string, tools?: Tool[], attachments?: ModelAttachment[]): Promise<ModelResponse> {
    return this.run(provider => provider.generate(prompt, systemPrompt, tools, attachments));
  }

  async generateStream(prompt: string, systemPrompt?: string, tools?: Tool[], onChunk?: StreamCallback, attachments?: ModelAttachment[]): Promise<ModelResponse> {
    const response = await this.run(async provider => {
      if (!provider.generateStream) return provider.generate(prompt, systemPrompt, tools, attachments);
      const buffered: string[] = [];
      const result = await provider.generateStream(prompt, systemPrompt, tools, chunk => {
        if (chunk) buffered.push(chunk);
      }, attachments);
      if (!result.content && buffered.length) result.content = buffered.join('');
      return result;
    });
    if (onChunk && response.content) {
      for (let offset = 0; offset < response.content.length; offset += 160) {
        onChunk(response.content.slice(offset, offset + 160));
      }
    }
    return response;
  }

  /** Provider that fulfilled the latest successful request (for ModelEngine). */
  getLastUsedProviderId(): string {
    return this.lastUsedProviderId;
  }

  private async run(action: (provider: ModelProvider) => Promise<ModelResponse>): Promise<ModelResponse> {
    if (this.candidates.length === 0) throw new Error('No configured model providers are available.');
    const available = this.candidates.filter(provider => !modelResilienceManager.isCoolingDown(provider.id));
    const ordered = available.length > 0 ? available : [...this.candidates];
    const lastGood = modelResilienceManager.getLastSuccessfulProviderId();
    if (lastGood) {
      ordered.sort((a, b) => Number(b.id === lastGood) - Number(a.id === lastGood));
    }

    const failures: string[] = [];
    let rateLimitRetried = false;
    for (const provider of ordered) {
      try {
        const response = await action(provider);
        this.assertUsableResponse(response, provider);
        modelResilienceManager.recordSuccess(provider);
        this.lastUsedProviderId = provider.id;
        return response;
      } catch (error: any) {
        const cooldown = this.cooldownFor(error);
        modelResilienceManager.recordFailure(provider, error, cooldown);
        failures.push(`${provider.name}: ${String(error?.message || error).slice(0, 300)}`);
        if (!this.isProviderFailure(error)) throw error;
        // A 429 is usually a transient rate limit: wait briefly and retry the
        // same provider once before falling through to the next candidate, so
        // a momentary throttle doesn't cascade into "all providers failed".
        if (Number(error?.status || error?.statusCode || 0) === 429 && !rateLimitRetried) {
          rateLimitRetried = true;
          await sleep(Math.min(10_000, this.cooldownMs / 6));
          try {
            const retry = await action(provider);
            this.assertUsableResponse(retry, provider);
            modelResilienceManager.recordSuccess(provider);
            this.lastUsedProviderId = provider.id;
            return retry;
          } catch (retryError: any) {
            failures.push(`${provider.name} (retry): ${String(retryError?.message || retryError).slice(0, 300)}`);
            modelResilienceManager.recordFailure(provider, retryError, this.cooldownFor(retryError));
          }
        }
        void hookManager.emit('model_fallback', {
          failedProviderId: provider.id,
          failedProviderName: provider.name,
          error: String(error?.message || error).slice(0, 500)
        });
        console.warn(`[ModelFallback] ${provider.name} failed; trying the next configured provider.`);
      }
    }
    const error: any = new Error(`All configured model providers failed. ${failures.join(' | ')}`);
    error.code = 'ALL_MODEL_PROVIDERS_FAILED';
    throw error;
  }

  private assertUsableResponse(response: ModelResponse, provider: ModelProvider): void {
    if (!response) throw new Error(`${provider.name} returned no response.`);
    const content = String(response.content || '').trim();
    if (!content && (!response.toolCalls || response.toolCalls.length === 0)) {
      throw new Error(`${provider.name} returned an empty response.`);
    }
    if (/^(?:\[Error\]|⚠️?\s*\*\*Model Error\*\*|Configuration Error:|Model Error:)/i.test(content)) {
      const error: any = new Error(content.slice(0, 1_000));
      const statusMatch = /(?:status[= :]|API error \()(\d{3})/i.exec(content);
      if (statusMatch) error.status = Number(statusMatch[1]);
      throw error;
    }
  }

  private isProviderFailure(error: any): boolean {
    const status = Number(error?.status || error?.statusCode || 0);
    if ([401, 403, 404, 408, 409, 429].includes(status) || status >= 500) return true;
    const text = String(error?.message || error || '').toLowerCase();
    return [
      'rate limit', 'quota', 'authentication', 'unauthorized', 'forbidden',
      'model not found', 'empty response', 'econn', 'etimedout', 'network',
      'fetch failed', 'socket', 'provider', 'api error'
    ].some(token => text.includes(token));
  }

  private cooldownFor(error: any): number {
    const status = Number(error?.status || error?.statusCode || 0);
    if (status === 401 || status === 403 || status === 404) return Math.max(this.cooldownMs, 60 * 60_000);
    if (status === 429 || /rate limit|quota/i.test(String(error?.message || error || ''))) return Math.max(this.cooldownMs, 15 * 60_000);
    return this.cooldownMs;
  }
}
