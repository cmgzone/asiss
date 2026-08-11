export interface Message {
  id: string;
  channel: string;
  senderId: string;
  content: string;
  timestamp: number;
  metadata?: any;
}

export interface Session {
  id: string;
  userId: string;
  channel: string;
  context: Message[];
}

export interface MediaPayload {
  type: 'image' | 'file';
  path?: string;
  url?: string;
  caption?: string;
  filename?: string;
}

export type StreamEventType = 'assistant_start' | 'assistant_delta' | 'assistant_done' | 'assistant_error' | 'assistant_update' | 'tool_start' | 'tool_delta' | 'tool_done' | 'approval_required' | 'approval_granted' | 'approval_denied';

export interface StreamEventPayload {
  type: StreamEventType;
  runId: string;
  messageId: string;
  text?: string;
  finalText?: string;
  ok?: boolean;
  progress?: boolean;
  reasoning?: string;
  toolCallId?: string;
  name?: string;
  output?: string;
  status?: string;
  error?: string;
  /** Approval flow (ASK path): unique request id, tool, risk, decision. */
  approvalId?: string;
  tool?: string;
  risk?: number;
  riskLabel?: string;
  reasons?: string[];
  arguments?: unknown;
  allowed?: boolean;
}

export interface ChannelAdapter {
  name: string;
  start(): void;
  send(userId: string, text: string): void;
  sendStream?(userId: string, chunk: string): void;
  sendStreamEvent?(userId: string, event: StreamEventPayload): void;
  sendMedia?(userId: string, media: MediaPayload): void;
  onMessage(handler: (msg: Message) => void | Promise<void>): void;
}
