export const A2A_JSONRPC_VERSION = '2.0';
export const A2A_PROTOCOL_VERSION_DEFAULT = '0.3.0';

export type A2AJsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: string;
  id?: A2AJsonRpcId;
  method: string;
  params?: any;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: any;
}

export interface JsonRpcResponse {
  jsonrpc: string;
  id: A2AJsonRpcId;
  result?: any;
  error?: JsonRpcError;
}

export type A2AMessageRole = 'user' | 'agent' | 'system';

export interface A2ATextPart {
  kind: 'text';
  text: string;
  metadata?: any;
}

export interface A2ADataPart {
  kind: 'data';
  data: any;
  mimeType?: string;
  metadata?: any;
}

export interface A2AFilePart {
  kind: 'file';
  file: {
    name?: string;
    mimeType?: string;
    bytes?: string;
    data?: string;
    uri?: string;
  };
  metadata?: any;
}

export type A2AMessagePart = A2ATextPart | A2ADataPart | A2AFilePart;

export interface A2AMessage {
  kind: 'message';
  messageId: string;
  role: A2AMessageRole;
  parts: A2AMessagePart[];
  taskId?: string;
  contextId?: string;
  metadata?: any;
}

export type A2ATaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'canceled'
  | 'failed'
  | 'rejected'
  | 'auth-required'
  | 'unknown';

export interface A2ATaskStatus {
  state: A2ATaskState;
  message?: A2AMessage;
  timestamp?: string;
}

export interface A2ATask {
  kind: 'task';
  id: string;
  contextId: string;
  status: A2ATaskStatus;
  history?: A2AMessage[];
  artifacts?: any[];
  metadata?: any;
}

export interface A2AAgentCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
  stateTransitionHistory?: boolean;
  extensions?: any[];
}

export interface A2AAgentSkill {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

export interface A2AAgentProvider {
  name: string;
  url?: string;
}

export interface A2ASecurityScheme {
  type: string;
  description?: string;
  name?: string;
  in?: string;
  scheme?: string;
  bearerFormat?: string;
}

export interface A2AAgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  protocolVersion: string;
  preferredTransport?: string;
  supportsAuthenticatedExtendedCard?: boolean;
  additionalInterfaces?: A2AAgentInterface[];
  provider?: A2AAgentProvider;
  documentationUrl?: string;
  iconUrl?: string;
  capabilities?: A2AAgentCapabilities;
  security?: Record<string, string[]>[];
  securitySchemes?: Record<string, A2ASecurityScheme>;
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
  skills?: A2AAgentSkill[];
}

export interface A2AAgentInterface {
  url: string;
  transport: string;
}

export const nowIso = () => new Date().toISOString();

export const coerceTextFromParts = (parts: A2AMessagePart[]): string => {
  if (!Array.isArray(parts)) return '';
  const chunks: string[] = [];
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    if (part.kind === 'text') {
      if (typeof part.text === 'string' && part.text.trim()) {
        chunks.push(part.text);
      }
      continue;
    }
    if (part.kind === 'data') {
      if (part.data !== undefined) {
        try {
          chunks.push(JSON.stringify(part.data));
        } catch {
          chunks.push(String(part.data));
        }
      }
      continue;
    }
    if (part.kind === 'file') {
      const uri = part.file?.uri;
      const name = part.file?.name;
      const data = part.file?.data || part.file?.bytes;
      if (uri) chunks.push(uri);
      else if (name) chunks.push(name);
      else if (data) chunks.push(String(data));
    }
  }
  return chunks.join('\n\n').trim();
};
