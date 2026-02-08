import fs from 'fs';
import path from 'path';

export interface Memory {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  metadata?: any;
}

export class MemoryManager {
  private filePath: string;
  private memories: Record<string, Memory[]> = {};

  constructor(filename: string = 'memory.json') {
    this.filePath = path.join(process.cwd(), filename);
    this.load();
  }

  private load() {
    if (fs.existsSync(this.filePath)) {
      try {
        const data = fs.readFileSync(this.filePath, 'utf-8');
        this.memories = JSON.parse(data);
      } catch (err) {
        console.error('[MemoryManager] Failed to load memory:', err);
        this.memories = {};
      }
    }
  }

  private save() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.memories, null, 2));
    } catch (err) {
      console.error('[MemoryManager] Failed to save memory:', err);
    }
  }

  public get(sessionId: string): Memory[] {
    return this.memories[sessionId] || [];
  }

  public add(sessionId: string, memory: Memory) {
    if (!this.memories[sessionId]) {
      this.memories[sessionId] = [];
    }
    this.memories[sessionId].push(memory);

    // Keep only last 50 messages to prevent context overflow (simple strategy)
    if (this.memories[sessionId].length > 50) {
      this.memories[sessionId] = this.memories[sessionId].slice(-50);
    }

    this.save();
  }
}
