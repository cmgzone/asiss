import fs from 'fs';
import path from 'path';
import { Skill } from '../core/skills';
import { trustedActions } from '../core/trusted-actions';
import { A2A_JSONRPC_VERSION, A2AMessage, A2AMessagePart } from '../core/a2a-protocol';

interface A2APeerConfig {
  id: string;
  url: string;
  description?: string;
  authToken?: string;
  authTokenEnv?: string;
}

interface A2AConfig {
  peers?: A2APeerConfig[];
}

const loadConfig = (): A2AConfig => {
  const configPath = path.join(process.cwd(), 'config.json');
  if (!fs.existsSync(configPath)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return typeof raw?.a2a === 'object' ? raw.a2a : {};
  } catch {
    return {};
  }
};

const normalizeUrl = (input: string) => {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http/https URLs are allowed');
  }
  if (url.username || url.password) {
    throw new Error('URLs with embedded credentials are not allowed');
  }
  return url.toString();
};

const deriveBaseUrl = (input: string) => {
  const url = new URL(input);
  return `${url.protocol}//${url.host}`;
};

const resolvePeer = (peerId: string, config: A2AConfig): A2APeerConfig | null => {
  const peers = Array.isArray(config.peers) ? config.peers : [];
  return peers.find(p => p.id === peerId) || null;
};

const resolvePeerToken = (peer: A2APeerConfig): string | undefined => {
  if (peer.authTokenEnv && process.env[peer.authTokenEnv]) {
    return process.env[peer.authTokenEnv];
  }
  if (peer.authToken) return peer.authToken;
  return undefined;
};

const jsonRpcRequest = async (url: string, method: string, params?: any, token?: string) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: A2A_JSONRPC_VERSION,
      id: Date.now(),
      method,
      params: params ?? {}
    })
  });

  const text = await res.text();
  if (!text) {
    throw new Error(`Empty response (${res.status})`);
  }

  let payload: any;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response (${res.status})`);
  }

  if (!res.ok) {
    const errMsg = payload?.error?.message || `HTTP ${res.status}`;
    throw new Error(errMsg);
  }

  if (payload.error) {
    throw new Error(payload.error.message || 'Remote error');
  }

  return payload.result;
};

const extractLatestText = (task: any): string => {
  if (!task) return '';
  const statusMessage = task.status?.message;
  const history = Array.isArray(task.history) ? task.history : [];
  const candidate = statusMessage || history[history.length - 1];
  if (!candidate || !Array.isArray(candidate.parts)) return '';
  const parts = candidate.parts;
  const chunks: string[] = [];
  for (const part of parts) {
    if (part?.kind === 'text' && typeof part.text === 'string') {
      chunks.push(part.text);
    }
  }
  return chunks.join('\n').trim();
};

export class A2AClientSkill implements Skill {
  name = 'a2a_client';
  description = `Send or receive messages from other A2A agents.

ACTIONS:
- peer_list
- discover (peerId | url)
- send (peerId | url, message, optional taskId/contextId, optional blocking)
- task_get (peerId | url, taskId)
- task_cancel (peerId | url, taskId)

Use peerId for configured peers in config.json under a2a.peers.`;

  inputSchema = {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['peer_list', 'discover', 'send', 'task_get', 'task_cancel'] },
      peerId: { type: 'string', description: 'Configured peer id from config.json' },
      url: { type: 'string', description: 'Direct JSON-RPC endpoint URL (requires trustedActions)' },
      message: { type: 'string', description: 'Message text to send' },
      parts: { type: 'array', description: 'Optional A2A message parts' },
      taskId: { type: 'string', description: 'Task id to continue or query' },
      contextId: { type: 'string', description: 'Context id to group tasks' },
      blocking: { type: 'boolean', description: 'Wait for completion' },
      historyLength: { type: 'number', description: 'Limit history returned by remote' },
      blockingTimeoutMs: { type: 'number', description: 'Blocking wait timeout in ms' }
    },
    required: ['action']
  };

  async execute(params: any): Promise<any> {
    const action = params?.action;
    const config = loadConfig();

    if (action === 'peer_list') {
      const peers = Array.isArray(config.peers) ? config.peers : [];
      return {
        peers: peers.map(p => ({
          id: p.id,
          url: p.url,
          description: p.description || '',
          hasAuth: !!(p.authToken || p.authTokenEnv)
        }))
      };
    }

    const peerId = params?.peerId ? String(params.peerId) : '';
    const directUrl = params?.url ? String(params.url) : '';
    let endpoint = '';
    let token: string | undefined;

    if (peerId) {
      const peer = resolvePeer(peerId, config);
      if (!peer) return { error: `Unknown peer: ${peerId}` };
      endpoint = normalizeUrl(peer.url);
      token = resolvePeerToken(peer);
    } else if (directUrl) {
      if (!trustedActions.isAllowed('a2a_send')) {
        return { error: 'Trusted action "a2a_send" is not allowed. Enable it in config.json trustedActions.allow.' };
      }
      endpoint = normalizeUrl(directUrl);
      trustedActions.logRequest({
        action: 'a2a_send',
        sessionId: params?.__sessionId,
        payload: { url: endpoint, action },
        createdAt: Date.now()
      });
    } else {
      return { error: 'peerId or url is required' };
    }

    if (action === 'discover') {
      const baseUrl = deriveBaseUrl(endpoint);
      const candidates = [
        `${baseUrl}/.well-known/agent.json`,
        `${baseUrl}/.well-known/agent-card.json`
      ];
      for (const url of candidates) {
        try {
          const res = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : undefined });
          if (!res.ok) continue;
          const card = await res.json();
          if (card && card.name) {
            return { card, url };
          }
        } catch {
          // try next
        }
      }
      return { error: 'Failed to discover agent card' };
    }

    if (action === 'send') {
      const text = typeof params?.message === 'string' ? params.message.trim() : '';
      const parts = Array.isArray(params?.parts) ? params.parts as A2AMessagePart[] : null;
      if (!text && !parts) return { error: 'message or parts is required' };

      const message: A2AMessage = {
        kind: 'message',
        messageId: params?.messageId || undefined,
        role: 'user',
        parts: parts && parts.length > 0 ? parts : [{ kind: 'text', text }],
        taskId: params?.taskId,
        contextId: params?.contextId
      };

      const configuration: any = {};
      if (typeof params?.blocking === 'boolean') {
        configuration.blocking = params.blocking;
      } else {
        configuration.blocking = true;
      }
      if (Number.isFinite(params?.historyLength)) configuration.historyLength = Math.max(0, Math.floor(params.historyLength));
      if (Number.isFinite(params?.blockingTimeoutMs)) configuration.blockingTimeoutMs = Math.max(1000, Math.floor(params.blockingTimeoutMs));

      const result = await jsonRpcRequest(endpoint, 'message/send', {
        message,
        configuration
      }, token);

      const responseText = extractLatestText(result);
      return { task: result, responseText };
    }

    if (action === 'task_get') {
      const taskId = params?.taskId ? String(params.taskId) : '';
      if (!taskId) return { error: 'taskId is required' };
      const result = await jsonRpcRequest(endpoint, 'tasks/get', { id: taskId, historyLength: params?.historyLength }, token);
      const responseText = extractLatestText(result);
      return { task: result, responseText };
    }

    if (action === 'task_cancel') {
      const taskId = params?.taskId ? String(params.taskId) : '';
      if (!taskId) return { error: 'taskId is required' };
      const result = await jsonRpcRequest(endpoint, 'tasks/cancel', { id: taskId }, token);
      return { task: result };
    }

    return { error: `Unknown action: ${action}` };
  }
}
