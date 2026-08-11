import fs from 'fs';
import path from 'path';
import { ModelLevel } from './models';

export interface ModelConfig {
    id: string;
    name: string;
    provider: 'openai' | 'ollama' | 'anthropic' | 'openrouter';
    baseUrl: string;
    apiKey?: string;     // If missing, check env var based on provider
    modelName: string;
    contextWindow?: number;
    maxOutputTokens?: number;
    enabled?: boolean;
    level?: ModelLevel;  // Explicit capability tier; inferred from model name when absent
}

export const resolveModelApiKey = (provider: string, explicit?: string): string => {
    if (explicit) return explicit;
    const normalized = String(provider || '').toLowerCase();
    if (normalized === 'openrouter') return process.env.OPENROUTER_API_KEY || '';
    if (normalized === 'anthropic') return process.env.ANTHROPIC_API_KEY || '';
    if (normalized === 'ollama') return '';
    return process.env.OPENAI_API_KEY || '';
};

/**
 * True only when the key looks usable for the given provider. Providers with
 * known key formats (OpenRouter sk-or-v1-, NVIDIA nvapi-) are validated so a
 * placeholder or fragment cannot be registered as a working provider (which
 * would 401 on every request and push the provider into cooldown).
 */
export const isProviderKeyValid = (provider: string, key?: string): boolean => {
    const value = String(key || '').trim();
    if (!value) return false;
    const normalized = String(provider || '').toLowerCase();
    if (normalized === 'openrouter') return value.startsWith('sk-or-v1-') && value.length > 20;
    if (normalized === 'nvidia') return value.startsWith('nvapi-') && value.length > 20;
    return true;
};

export class ModelManager {
    private configPath: string;
    private config: ModelConfig[] = [];

    constructor() {
        this.configPath = path.join(process.cwd(), 'models.json');
        this.load();
    }

    private load() {
        if (fs.existsSync(this.configPath)) {
            try {
                const parsed = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
                this.config = Array.isArray(parsed)
                    ? parsed.map(({ apiKey: _legacySecret, ...model }: ModelConfig) => model as ModelConfig)
                    : [];
                if (Array.isArray(parsed) && parsed.some((model: ModelConfig) => Boolean(model.apiKey))) {
                    this.save();
                }
            } catch {
                this.config = [];
            }
        }
    }

    private save() {
        fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
    }

    addModel(model: ModelConfig): boolean {
        if (this.config.find(m => m.id === model.id)) return false;
        const { apiKey: _runtimeOnly, ...safeModel } = model;
        this.config.push({ ...safeModel, enabled: true });
        this.save();
        return true;
    }

    removeModel(id: string): boolean {
        const idx = this.config.findIndex(m => m.id === id);
        if (idx === -1) return false;
        this.config.splice(idx, 1);
        this.save();
        return true;
    }

    listModels(): ModelConfig[] {
        return this.config;
    }

    getModel(id: string): ModelConfig | undefined {
        return this.config.find(m => m.id === id);
    }
}

export const modelManager = new ModelManager();
