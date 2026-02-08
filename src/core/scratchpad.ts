import fs from 'fs';
import path from 'path';

export interface ScratchpadEntry {
    value: string;
    updatedAt: number;
}

export class Scratchpad {
    private filePath: string;
    private data: Record<string, ScratchpadEntry> = {};

    constructor(filename: string = 'scratchpad.json') {
        this.filePath = path.join(process.cwd(), filename);
        this.load();
    }

    private load() {
        if (fs.existsSync(this.filePath)) {
            try {
                const raw = fs.readFileSync(this.filePath, 'utf-8');
                this.data = JSON.parse(raw);
                console.log(`[Scratchpad] Loaded ${Object.keys(this.data).length} notes.`);
            } catch (err) {
                console.error('[Scratchpad] Failed to load:', err);
                this.data = {};
            }
        }
    }

    private save() {
        try {
            fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
        } catch (err) {
            console.error('[Scratchpad] Failed to save:', err);
        }
    }

    public set(key: string, value: string): void {
        this.data[key] = { value, updatedAt: Date.now() };
        this.save();
        console.log(`[Scratchpad] Saved: "${key}"`);
    }

    public get(key: string): string | undefined {
        return this.data[key]?.value;
    }

    public delete(key: string): boolean {
        if (this.data[key]) {
            delete this.data[key];
            this.save();
            return true;
        }
        return false;
    }

    public list(): Record<string, string> {
        const result: Record<string, string> = {};
        for (const key in this.data) {
            result[key] = this.data[key].value;
        }
        return result;
    }

    public getSummary(): string {
        const notes = this.list();
        const keys = Object.keys(notes);
        if (keys.length === 0) return '';

        let summary = '## Your Notes (Long-Term Memory)\n';
        for (const key of keys) {
            summary += `- **${key}**: ${notes[key]}\n`;
        }
        return summary;
    }
}

export const scratchpad = new Scratchpad();
