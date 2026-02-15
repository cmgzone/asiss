import express from 'express';
import { Server } from 'http';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { ChannelAdapter, Message } from '../../core/types';
import {
  A2AAgentCard,
  A2AAgentCapabilities,
  A2AAgentSkill,
  A2AMessage,
  A2AMessagePart,
  A2ATask,
  A2ATaskStatus,
  A2A_JSONRPC_VERSION,
  A2A_PROTOCOL_VERSION_DEFAULT,
  JsonRpcRequest,
  JsonRpcResponse,
  coerceTextFromParts,
  nowIso
} from '../../core/a2a-protocol';

interface A2AChannelConfig {
  enabled?: boolean;
  port?: number;
  rpcPath?: string;
  baseUrl?: string;
  protocolVersion?: string;
  name?: string;
  description?: string;
  provider?: { name: string; url?: string };
  documentationUrl?: string;
  iconUrl?: string;
  skills?: A2AAgentSkill[];
  capabilities?: A2AAgentCapabilities;
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
  authToken?: string;
  protectAgentCard?: boolean;
  maxHistory?: number;
  blockingTimeoutMs?: number;
}

interface TaskRecord {
  task: A2ATask;
  history: A2AMessage[];
  createdAt: number;
  updatedAt: number;
}

const readPackageVersion = () => {
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw);
    return String(pkg.version || '0.0.0');
  } catch {
    return '0.0.0';
  }
};

export class A2AChannel implements ChannelAdapter {
  name = 'a2a';
  private app: express.Express;
  private server: Server | null = null;
  private handler: ((msg: Message) => void) | null = null;
  private isStarted = false;
  private port: number;
  private rpcPath: string;
  private baseUrl: string;
  private baseUrlFromConfig: boolean;
  private protocolVersion: string;
  private authToken: string | null = null;
  private protectAgentCard: boolean;
  private maxHistory: number;
  private blockingTimeoutMs: number;
  private agentCard: A2AAgentCard;
  private tasks: Map<string, TaskRecord> = new Map();
  private waiters: Map<string, Array<(task: A2ATask) => void>> = new Map();
  private activeTaskByContext: Map<string, string> = new Map();

  constructor(config: A2AChannelConfig = {}) {
    this.port = typeof config.port === 'number' ? config.port : 3210;
    this.rpcPath = typeof config.rpcPath === 'string' ? config.rpcPath : '/a2a';
    if (!this.rpcPath.startsWith('/')) this.rpcPath = `/${this.rpcPath}`;
    this.baseUrlFromConfig = typeof config.baseUrl === 'string';
    this.baseUrl = this.baseUrlFromConfig
      ? config.baseUrl!.replace(/\/+$/, '')
      : `http://localhost:${this.port}`;
    this.protocolVersion = config.protocolVersion || A2A_PROTOCOL_VERSION_DEFAULT;
    this.authToken = config.authToken ? String(config.authToken) : null;
    this.maxHistory = typeof config.maxHistory === 'number' ? Math.max(1, Math.floor(config.maxHistory)) : 50;
    this.blockingTimeoutMs = typeof config.blockingTimeoutMs === 'number'
      ? Math.max(1000, Math.floor(config.blockingTimeoutMs))
      : 60000;
    this.protectAgentCard = typeof config.protectAgentCard === 'boolean'
      ? config.protectAgentCard
      : false;

    const defaultSkill: A2AAgentSkill = {
      id: 'general-assistant',
      name: 'General Assistant',
      description: 'Handles general questions and task-oriented requests.'
    };

    const capabilities: A2AAgentCapabilities = {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
      ...config.capabilities
    };

    const version = readPackageVersion();
    const jsonRpcUrl = `${this.baseUrl}${this.rpcPath}`;
    const restUrl = `${this.baseUrl}/v1`;
    this.agentCard = {
      name: config.name || 'Gitu',
      description: config.description || 'Local assistant with task collaboration support.',
      url: jsonRpcUrl,
      version,
      protocolVersion: this.protocolVersion,
      preferredTransport: 'JSONRPC',
      supportsAuthenticatedExtendedCard: !!this.authToken,
      additionalInterfaces: [
        { url: jsonRpcUrl, transport: 'JSONRPC' },
        { url: restUrl, transport: 'HTTP+JSON' }
      ],
      provider: config.provider,
      documentationUrl: config.documentationUrl,
      iconUrl: config.iconUrl,
      capabilities,
      defaultInputModes: config.defaultInputModes || ['application/json'],
      defaultOutputModes: config.defaultOutputModes || ['application/json'],
      skills: (config.skills && config.skills.length > 0) ? config.skills : [defaultSkill]
    };

    if (this.authToken) {
      this.agentCard.securitySchemes = {
        bearerAuth: { type: 'http', scheme: 'bearer' }
      };
      this.agentCard.security = [{ bearerAuth: [] }];
    }

    this.app = express();
    this.app.use(express.json({ limit: '2mb' }));

    const sendAgentCard = (req: express.Request, res: express.Response) => {
      if (this.protectAgentCard && this.authToken && !this.isAuthorized(req)) {
        res.status(401).json({ error: 'Auth required' });
        return;
      }
      res.json(this.agentCard);
    };

    this.app.get('/.well-known/agent.json', sendAgentCard);
    this.app.get('/.well-known/agent-card.json', sendAgentCard);
    this.app.get('/v1/card', sendAgentCard);
    this.app.get('/agent/authenticatedExtendedCard', (req, res) => {
      if (this.authToken && !this.isAuthorized(req)) {
        res.status(401).json({ error: 'Auth required' });
        return;
      }
      res.json(this.agentCard);
    });

    this.app.post(this.rpcPath, async (req, res) => {
      if (!this.isAuthorized(req)) {
        res.status(401).json(this.jsonRpcError(null, -32001, 'Auth required'));
        return;
      }

      const payload = req.body;
      if (Array.isArray(payload)) {
        const results = await Promise.all(payload.map((item) => this.handleRpc(item, req)));
        const filtered = results.filter((item) => item !== null);
        if (filtered.length === 0) {
          res.status(204).send('');
        } else {
          res.json(filtered);
        }
        return;
      }

      const result = await this.handleRpc(payload, req);
      if (result === null) {
        res.status(204).send('');
        return;
      }
      res.json(result);
    });

    // REST-style endpoints (compatibility with non-JSON-RPC clients)
    this.app.post('/v1/message:send', async (req, res) => {
      if (!this.isAuthorized(req)) {
        res.status(401).json({ error: 'Auth required' });
        return;
      }
      try {
        const task = await this.handleMessageSend(req.body || {});
        res.json({ task });
      } catch (err: any) {
        res.status(400).json({ error: err.message || 'Invalid request' });
      }
    });

    this.app.post('/v1/message:stream', async (_req, res) => {
      res.status(501).json({ error: 'Streaming is not supported' });
    });

    this.app.get('/v1/tasks', (req, res) => {
      if (!this.isAuthorized(req)) {
        res.status(401).json({ error: 'Auth required' });
        return;
      }
      res.json(this.handleTasksList(req.query || {}));
    });

    this.app.get('/v1/tasks/:id', (req, res) => {
      if (!this.isAuthorized(req)) {
        res.status(401).json({ error: 'Auth required' });
        return;
      }
      try {
        const task = this.handleTaskGet({ id: req.params.id, historyLength: req.query?.historyLength });
        res.json({ task });
      } catch (err: any) {
        res.status(404).json({ error: err.message || 'Task not found' });
      }
    });

    this.app.post('/v1/tasks/:id:cancel', (req, res) => {
      if (!this.isAuthorized(req)) {
        res.status(401).json({ error: 'Auth required' });
        return;
      }
      try {
        const raw = (req.params as any).id ?? (req.params as any)['id:cancel'];
        const id = String(raw || '').replace(/:cancel$/i, '');
        const task = this.handleTaskCancel({ id });
        res.json({ task });
      } catch (err: any) {
        res.status(404).json({ error: err.message || 'Task not found' });
      }
    });
  }

  start() {
    if (this.isStarted) return;
    this.server = new Server(this.app);
    this.server.on('error', (e: any) => {
      if (e.code === 'EADDRINUSE') {
        console.log(`[A2AChannel] Port ${this.port} in use, trying ${this.port + 1}...`);
        this.port += 1;
        if (!this.baseUrlFromConfig) {
          this.baseUrl = `http://localhost:${this.port}`;
        }
        const jsonRpcUrl = `${this.baseUrl}${this.rpcPath}`;
        const restUrl = `${this.baseUrl}/v1`;
        this.agentCard.url = jsonRpcUrl;
        if (Array.isArray(this.agentCard.additionalInterfaces)) {
          this.agentCard.additionalInterfaces = [
            { url: jsonRpcUrl, transport: 'JSONRPC' },
            { url: restUrl, transport: 'HTTP+JSON' }
          ];
        }
        this.server?.listen(this.port);
      } else {
        console.error('[A2AChannel] Server error:', e);
      }
    });
    this.server.listen(this.port, () => {
      console.log(`[A2AChannel] A2A server running at ${this.baseUrl}${this.rpcPath}`);
    });
    this.isStarted = true;
  }

  send(userId: string, text: string) {
    const cleaned = String(text || '').trim();
    if (!cleaned) return;
    if (cleaned.startsWith('__DEBUG__')) return;

    const contextId = userId.startsWith('a2a:') ? userId.slice(4) : userId;
    const taskId = this.activeTaskByContext.get(contextId);
    if (!taskId) return;
    const record = this.tasks.get(taskId);
    if (!record) return;

    const message: A2AMessage = {
      kind: 'message',
      messageId: uuidv4(),
      role: 'agent',
      parts: [{ kind: 'text', text: cleaned }],
      taskId,
      contextId
    };

    this.appendHistory(record, message);

    if (this.isPauseMessage(cleaned)) {
      this.updateStatus(record, 'input-required', message);
    } else {
      this.updateStatus(record, 'completed', message);
    }
    this.resolveWaiters(taskId, record.task);
  }

  onMessage(handler: (msg: Message) => void) {
    this.handler = handler;
  }

  private isAuthorized(req: express.Request): boolean {
    if (!this.authToken) return true;
    const header = String(req.headers.authorization || '');
    if (!header.toLowerCase().startsWith('bearer ')) return false;
    const token = header.slice(7).trim();
    return token === this.authToken;
  }

  private async handleRpc(payload: any, req?: express.Request): Promise<JsonRpcResponse | null> {
    if (!payload || typeof payload !== 'object') {
      return this.jsonRpcError(null, -32600, 'Invalid Request');
    }

    const request = payload as JsonRpcRequest;
    if (request.jsonrpc !== A2A_JSONRPC_VERSION || typeof request.method !== 'string') {
      return this.jsonRpcError(request.id ?? null, -32600, 'Invalid Request');
    }

    const id = request.id ?? null;
    const method = request.method;
    const params = request.params || {};

    try {
      let result: any;
      switch (method) {
        case 'agent/authenticatedExtendedCard':
        case 'agent/getAuthenticatedExtendedCard': {
          if (this.protectAgentCard && this.authToken && req && !this.isAuthorized(req)) {
            return this.jsonRpcError(id, -32001, 'Auth required');
          }
          result = this.agentCard;
          break;
        }
        case 'message/send':
          result = await this.handleMessageSend(params);
          break;
        case 'tasks/get':
          result = this.handleTaskGet(params);
          break;
        case 'tasks/cancel':
          result = this.handleTaskCancel(params);
          break;
        case 'tasks/list':
          result = this.handleTasksList(params);
          break;
        default:
          return this.jsonRpcError(id, -32601, `Method not found: ${method}`);
      }

      if (id === null || id === undefined) return null;
      return { jsonrpc: A2A_JSONRPC_VERSION, id, result };
    } catch (err: any) {
      const message = err?.message || 'Internal error';
      return this.jsonRpcError(id, -32603, message);
    }
  }

  private async handleMessageSend(params: any): Promise<A2ATask> {
    const message = params?.message && typeof params.message === 'object'
      ? params.message
      : params;
    if (!message || typeof message !== 'object') {
      throw new Error('Invalid params: message is required');
    }

    const parts: A2AMessagePart[] = Array.isArray(message.parts) ? message.parts : [];
    const text = coerceTextFromParts(parts);
    if (!text) {
      throw new Error('Invalid params: message parts contained no usable content');
    }

    const incomingTaskId = typeof message.taskId === 'string' ? message.taskId : undefined;
    const incomingContextId = typeof message.contextId === 'string' ? message.contextId : undefined;

    const taskId = incomingTaskId || uuidv4();
    const contextId = incomingContextId || taskId;
    let record = this.tasks.get(taskId);
    if (!record) {
      const task: A2ATask = {
        kind: 'task',
        id: taskId,
        contextId,
        status: { state: 'submitted', timestamp: nowIso() },
        history: [],
        artifacts: []
      };
      record = {
        task,
        history: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      this.tasks.set(taskId, record);
    }

    const normalized: A2AMessage = {
      kind: 'message',
      messageId: message.messageId || uuidv4(),
      role: message.role || 'user',
      parts,
      taskId,
      contextId,
      metadata: message.metadata
    };

    this.appendHistory(record, normalized);
    this.activeTaskByContext.set(contextId, taskId);
    this.updateStatus(record, 'working');

    if (!this.handler) {
      this.updateStatus(record, 'failed', {
        kind: 'message',
        messageId: uuidv4(),
        role: 'agent',
        parts: [{ kind: 'text', text: 'Agent handler is unavailable.' }],
        taskId,
        contextId
      });
      return this.buildTaskResponse(record, params?.historyLength);
    }

    const msg: Message = {
      id: uuidv4(),
      channel: 'a2a',
      senderId: `a2a:${contextId}`,
      content: text,
      timestamp: Date.now(),
      metadata: {
        a2a: {
          taskId,
          contextId,
          messageId: normalized.messageId
        }
      }
    };

    this.handler(msg);

    const configuration = typeof params?.configuration === 'object' ? params.configuration : {};
    const blocking = !!configuration.blocking;
    const historyLength = configuration.historyLength ?? params?.historyLength;

    if (blocking) {
      const timeoutMs = Number.isFinite(configuration.blockingTimeoutMs)
        ? Math.max(1000, Math.floor(configuration.blockingTimeoutMs))
        : this.blockingTimeoutMs;
      const completed = await this.waitForCompletion(taskId, timeoutMs);
      if (completed) {
        return this.buildTaskResponse(record, historyLength);
      }
    }

    return this.buildTaskResponse(record, historyLength);
  }

  private handleTaskGet(params: any): A2ATask {
    const id = params?.id || params?.taskId;
    if (!id || typeof id !== 'string') {
      throw new Error('Invalid params: id is required');
    }
    const record = this.tasks.get(id);
    if (!record) {
      throw new Error('Task not found');
    }
    return this.buildTaskResponse(record, params?.historyLength);
  }

  private handleTaskCancel(params: any): A2ATask {
    const id = params?.id || params?.taskId;
    if (!id || typeof id !== 'string') {
      throw new Error('Invalid params: id is required');
    }
    const record = this.tasks.get(id);
    if (!record) {
      throw new Error('Task not found');
    }
    this.updateStatus(record, 'canceled');
    return this.buildTaskResponse(record, params?.historyLength);
  }

  private handleTasksList(params: any): { tasks: { id: string; contextId: string; status: A2ATaskStatus }[] } {
    const rawLimit = params?.limit;
    const numeric = typeof rawLimit === 'string' ? Number(rawLimit) : rawLimit;
    const limit = Number.isFinite(numeric) ? Math.max(1, Math.floor(numeric)) : 100;
    const tasks = Array.from(this.tasks.values())
      .slice(-limit)
      .map(record => ({
        id: record.task.id,
        contextId: record.task.contextId,
        status: record.task.status
      }));
    return { tasks };
  }

  private appendHistory(record: TaskRecord, message: A2AMessage) {
    record.history.push(message);
    const cap = Math.max(this.maxHistory * 5, 200);
    if (record.history.length > cap) {
      record.history = record.history.slice(-cap);
    }
    record.task.history = record.history;
    record.updatedAt = Date.now();
  }

  private updateStatus(record: TaskRecord, state: A2ATaskStatus['state'], message?: A2AMessage) {
    record.task.status = {
      state,
      message,
      timestamp: nowIso()
    };
    record.updatedAt = Date.now();
  }

  private isPauseMessage(text: string): boolean {
    const lowered = text.toLowerCase();
    if (lowered.includes('automation step limit reached')) return true;
    if (lowered.includes('automation paused without a final message')) return true;
    if (lowered.includes('send "continue"')) return true;
    return false;
  }

  private buildTaskResponse(record: TaskRecord, historyLength?: number): A2ATask {
    const raw = historyLength as any;
    const numeric = typeof raw === 'string' ? Number(raw) : raw;
    const limit = Number.isFinite(numeric)
      ? Math.max(0, Math.floor(Number(numeric)))
      : this.maxHistory;
    const history = limit > 0 ? record.history.slice(-limit) : [];
    const task: A2ATask = {
      ...record.task,
      history
    };
    return task;
  }

  private jsonRpcError(id: any, code: number, message: string, data?: any): JsonRpcResponse {
    return {
      jsonrpc: A2A_JSONRPC_VERSION,
      id: id ?? null,
      error: { code, message, data }
    };
  }

  private async waitForCompletion(taskId: string, timeoutMs: number): Promise<boolean> {
    const record = this.tasks.get(taskId);
    if (!record) return false;
    const state = record.task.status?.state;
    if (state === 'completed' || state === 'failed' || state === 'canceled' || state === 'rejected') {
      return true;
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.removeWaiter(taskId, waiter);
        resolve(false);
      }, timeoutMs);

      const waiter = (task: A2ATask) => {
        if (task.status.state === 'completed' || task.status.state === 'failed' || task.status.state === 'canceled' || task.status.state === 'rejected') {
          clearTimeout(timer);
          this.removeWaiter(taskId, waiter);
          resolve(true);
        }
      };

      const list = this.waiters.get(taskId) || [];
      list.push(waiter);
      this.waiters.set(taskId, list);
    });
  }

  private resolveWaiters(taskId: string, task: A2ATask) {
    const list = this.waiters.get(taskId);
    if (!list || list.length === 0) return;
    list.forEach((cb) => cb(task));
  }

  private removeWaiter(taskId: string, cb: (task: A2ATask) => void) {
    const list = this.waiters.get(taskId);
    if (!list) return;
    const next = list.filter((item) => item !== cb);
    if (next.length === 0) {
      this.waiters.delete(taskId);
    } else {
      this.waiters.set(taskId, next);
    }
  }
}
