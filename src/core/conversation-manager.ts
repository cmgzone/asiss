import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { workspaceManager } from './workspace-manager';
import { atomicWriteJsonSync } from './atomic-write';
import {
  ProjectContext,
  projectContextRegistry,
  validateProjectContext
} from './project-context';

export interface StoredConversationMessage {
  kind: string;
  text?: string;
  runId?: string;
  activityId?: string;
  name?: string;
  status?: string;
  output?: string;
  complete?: boolean;
  pending?: boolean;
  failed?: boolean;
  stopped?: boolean;
  // Phase 21 — the persisted execution snapshot (bounded shape, produced by
  // executionSnapshotFor in the web UI). Round-trips through this store so a
  // restored conversation can replay every tool row under its assistant turn.
  execution?: unknown;
  at: number;
}

export interface StoredConversation {
  id: string;
  userId: string;
  title: string;
  workspacePath: string;
  // Phase 23 §3 — the conversation is bound to exactly one project. Stored so
  // a reloaded conversation restores the correct project context.
  projectId?: string;
  projectName?: string;
  projectWorkspacePath?: string;
  createdAt: string;
  updatedAt: string;
  messages: StoredConversationMessage[];
}

interface ConversationData {
  conversations: StoredConversation[];
}

class ConversationManager {
  private readonly filePath: string;

  constructor() {
    const oneDrive = String(process.env.OneDrive || process.env.ONEDRIVE || '').trim();
    const dataRoot = process.env.GITU_DATA_ROOT
      ? path.resolve(process.env.GITU_DATA_ROOT)
      : path.join(oneDrive || path.join(os.homedir(), 'Documents'), 'Gitu Data');
    fs.mkdirSync(dataRoot, { recursive: true });
    this.filePath = path.join(dataRoot, 'conversations.json');
  }

  public list(userId: string) {
    return this.read().conversations
      .filter((conversation) => conversation.userId === userId)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .map(({ messages, ...conversation }) => ({
        ...conversation,
        messageCount: messages.length
      }));
  }

  public create(userId: string, projectContext?: ProjectContext): StoredConversation {
    const data = this.read();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const project = projectContext ? validateProjectContext(projectContext) : undefined;
    const conversation: StoredConversation = {
      id,
      userId,
      title: 'New conversation',
      workspacePath: project?.workspaceRoot || workspaceManager.createGeneralConversationWorkspace(id),
      projectId: project?.projectId,
      projectName: project?.projectName,
      projectWorkspacePath: project?.workspaceRoot,
      createdAt: now,
      updatedAt: now,
      messages: []
    };
    data.conversations.push(conversation);
    this.write(data);
    // Phase 23 §3 — conversationId -> projectId lives in the canonical
    // registry too, so execution/memory/tool layers resolve the project from
    // the conversation without re-reading message metadata.
    if (project) {
      projectContextRegistry.bindConversation(id, { ...project, conversationId: id });
    }
    return conversation;
  }

  /** Bind an existing conversation to a project (or clear it). */
  public bindProject(id: string, userId: string, projectContext?: ProjectContext): StoredConversation | undefined {
    const data = this.read();
    const conversation = data.conversations.find(
      (item) => item.id === id && item.userId === userId
    );
    if (!conversation) return undefined;
    const project = projectContext ? validateProjectContext(projectContext) : undefined;
    conversation.projectId = project?.projectId;
    conversation.projectName = project?.projectName;
    conversation.projectWorkspacePath = project?.workspaceRoot;
    if (project) {
      conversation.workspacePath = project.workspaceRoot;
      projectContextRegistry.bindConversation(id, { ...project, conversationId: id });
    } else {
      conversation.workspacePath = workspaceManager.createGeneralConversationWorkspace(id);
      // Unbinding a conversation removes it from the registry.
      projectContextRegistry.bindConversation(id, {
        projectId: 'general',
        projectName: 'General Workspace',
        workspaceRoot: conversation.workspacePath,
        conversationId: id
      });
    }
    conversation.updatedAt = new Date().toISOString();
    this.write(data);
    return conversation;
  }

  public getOwned(id: string, userId: string): StoredConversation | undefined {
    return this.read().conversations.find(
      (conversation) => conversation.id === id && conversation.userId === userId
    );
  }

  public update(
    id: string,
    userId: string,
    input: { title?: unknown; messages?: unknown }
  ): StoredConversation | undefined {
    const data = this.read();
    const conversation = data.conversations.find(
      (item) => item.id === id && item.userId === userId
    );
    if (!conversation) return undefined;

    if (typeof input.title === 'string') {
      const title = input.title.trim().replace(/\s+/g, ' ').slice(0, 80);
      if (title) conversation.title = title;
    }
    if (Array.isArray(input.messages)) {
      conversation.messages = input.messages
        .slice(-120)
        .map((message) => this.normalizeMessage(message))
        .filter((message): message is StoredConversationMessage => Boolean(message));
    }
    conversation.updatedAt = new Date().toISOString();
    this.write(data);
    return conversation;
  }

  public delete(id: string, userId: string): StoredConversation | undefined {
    const data = this.read();
    const index = data.conversations.findIndex(
      (conversation) => conversation.id === id && conversation.userId === userId
    );
    if (index < 0) return undefined;
    const [removed] = data.conversations.splice(index, 1);
    this.write(data);
    return removed;
  }

  private normalizeMessage(value: unknown): StoredConversationMessage | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const raw = value as Record<string, unknown>;
    const kind = this.text(raw.kind, 32);
    if (!kind) return undefined;
    const message: StoredConversationMessage = {
      kind,
      at: Number.isFinite(Number(raw.at)) ? Number(raw.at) : Date.now()
    };
    const fields: Array<[keyof StoredConversationMessage, number]> = [
      ['text', 100_000],
      ['runId', 200],
      ['activityId', 200],
      ['name', 200],
      ['status', 40],
      ['output', 100_000]
    ];
    for (const [field, maxLength] of fields) {
      const text = this.text(raw[field], maxLength);
      if (text) (message as any)[field] = text;
    }
    for (const field of ['complete', 'pending', 'failed', 'stopped'] as const) {
      if (typeof raw[field] === 'boolean') message[field] = raw[field] as boolean;
    }
    // Phase 21 execution snapshot: persisted as an opaque bounded object. The
    // UI produces it with executionSnapshotFor (outputs/tools/agents bounded),
    // so it round-trips as-is with a hard size cap as the safety net.
    if (raw.execution && typeof raw.execution === 'object') {
      try {
        const serialized = JSON.stringify(raw.execution);
        if (typeof serialized === 'string' && serialized.length <= 200_000) {
          message.execution = JSON.parse(serialized);
        }
      } catch {
        // A malformed snapshot must not reject the whole conversation update.
      }
    }
    return message;
  }

  private text(value: unknown, maxLength: number): string {
    return typeof value === 'string' ? value.slice(0, maxLength) : '';
  }

  private read(): ConversationData {
    if (!fs.existsSync(this.filePath)) return { conversations: [] };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return { conversations: Array.isArray(parsed?.conversations) ? parsed.conversations : [] };
    } catch {
      return { conversations: [] };
    }
  }

  private write(data: ConversationData): void {
    // Phase 22 — resilient atomic write (retry + copy fallback + deferred
    // retry). A transient OneDrive lock on conversations.json must not abort
    // the save path or reject the caller's conversation update.
    atomicWriteJsonSync(this.filePath, data);
  }
}

export const conversationManager = new ConversationManager();
