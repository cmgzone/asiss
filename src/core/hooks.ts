import fs from 'fs';
import os from 'os';
import path from 'path';

import type { TaskEventName } from './task/task-events';

// Internal hook event names. Task/tool lifecycle events (TaskCreated,
// ToolFailed, ...) are forwarded onto the same bus by the task-hooks bridge so
// existing hook subscribers (audit file, telemetry, recovery) observe the
// canonical Task system without any direct coupling to it.
export type HookEventName =
  | 'before_tool'
  | 'after_tool'
  | 'tool_error'
  | 'model_fallback'
  | 'checkpoint_created'
  | 'agent_complete'
  | 'mcp_status'
  | TaskEventName;
export interface HookEvent {
  name: HookEventName;
  timestamp: number;
  sessionId?: string;
  data: Record<string, unknown>;
}
export type HookHandler = (event: HookEvent) => void | Promise<void>;

class HookManager {
  private handlers = new Map<HookEventName, Set<HookHandler>>();
  private readonly auditPath: string;

  constructor() {
    const oneDrive = String(process.env.OneDrive || process.env.ONEDRIVE || '').trim();
    const dataRoot = process.env.GITU_DATA_ROOT || path.join(oneDrive || path.join(os.homedir(), 'Documents'), 'Gitu Data');
    const hooksRoot = path.join(dataRoot, 'hooks');
    fs.mkdirSync(hooksRoot, { recursive: true });
    this.auditPath = path.join(hooksRoot, 'events.jsonl');
  }

  on(name: HookEventName, handler: HookHandler): () => void {
    const handlers = this.handlers.get(name) || new Set<HookHandler>();
    handlers.add(handler);
    this.handlers.set(name, handlers);
    return () => handlers.delete(handler);
  }

  async emit(name: HookEventName, data: Record<string, unknown>, sessionId?: string): Promise<void> {
    const event: HookEvent = { name, timestamp: Date.now(), sessionId, data: this.sanitize(data) };
    fs.appendFileSync(this.auditPath, `${JSON.stringify(event)}\n`);
    for (const handler of this.handlers.get(name) || []) {
      try {
        await handler(event);
      } catch (error) {
        console.warn(`[Hooks] ${name} handler failed:`, error);
      }
    }
  }

  status() {
    return {
      auditPath: this.auditPath,
      handlers: Array.from(this.handlers.entries()).map(([name, handlers]) => ({ name, count: handlers.size }))
    };
  }

  private sanitize(value: Record<string, unknown>): Record<string, unknown> {
    const text = JSON.stringify(value, (_key, item) => {
      if (typeof item !== 'string') return item;
      return item
        .replace(/sk-[A-Za-z0-9_-]{10,}/g, '[REDACTED]')
        .replace(/nvapi-[A-Za-z0-9_-]{10,}/g, '[REDACTED]')
        .replace(/xox[baprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED]')
        .slice(0, 20_000);
    });
    return JSON.parse(text || '{}');
  }
}

export const hookManager = new HookManager();
