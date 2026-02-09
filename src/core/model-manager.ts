import fs from 'fs';
import path from 'path';

export interface ModelConfig {
    id: string;
    name: string;
    provider: 'openai' | 'ollama' | 'anthropic' | 'openrouter';
    baseUrl: string;
    apiKey?: string;     // If missing, check env var based on provider
    modelName: string;
    contextWindow?: number;
    enabled?: boolean;
}

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
                this.config = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
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
        this.config.push({ ...model, enabled: true });
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
