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

export type StreamEventType = 'assistant_start' | 'assistant_delta' | 'assistant_done' | 'assistant_error' | 'assistant_update' | 'assistant_stopped' | 'mission_start' | 'mission_end' | 'tool_start' | 'tool_delta' | 'tool_done' | 'approval_required' | 'approval_granted' | 'approval_denied' | 'repository_refreshed' | 'recovery';

/**
 * Canonical execution contract (Phase 2): ONE executionId -> MANY dynamic
 * events. An execution spans mission_start -> tool_* / assistant_* / recovery
 * -> mission_end. Tool events carry a unique per-call toolCallId (not the tool
 * name), so the UI can update one card per call. `mission_end.status`
 * distinguishes completed | failed | cancelled | blocked.
 *
 * Plan mapping: mission_start = execution.started · tool_start = tool.started ·
 * tool_delta = tool.progress · tool_done = tool.completed|failed · recovery =
 * error-recovery narration · mission_end = execution.completed|cancelled.
 */
export interface StreamEventPayload {
  type: StreamEventType;
  runId: string;
  messageId: string;
  /** Mission-scoped anchor shared by every event of one execution. */
  executionId?: string;
  text?: string;
  finalText?: string;
  ok?: boolean;
  /** assistant_done: true folds the final text into a progress bubble. */
  progress?: boolean;
  /** tool_delta: numeric 0-100 completion estimate (kept separate from the boolean progress). */
  progressPct?: number;
  reasoning?: string;
  /** Unique per-call id for tool_start/tool_delta/tool_done of ONE tool call. */
  toolCallId?: string;
  /** Human label for a tool call, e.g. 'Reading repository'. */
  label?: string;
  /** Delegation identity: the sub-agent's display name (tool_start). */
  agentName?: string;
  /** Hierarchy: the execution this one was spawned from. */
  parentExecutionId?: string;
  name?: string;
  output?: string;
  status?: string;
  error?: string;
  /** recovery: 'diagnosing' | 'fixing' | 'verified' — the autonomous recovery stage. */
  phase?: string;
  /** Approval flow (ASK path): unique request id, tool, risk, decision. */
  approvalId?: string;
  tool?: string;
  risk?: number;
  riskLabel?: string;
  reasons?: string[];
  arguments?: unknown;
  allowed?: boolean;
  /** Repository index warmth (Phase 9 telemetry): refresh stats per workspace. */
  root?: string;
  fileCount?: number;
  filesReParsed?: number;
  symbolsRefreshed?: number;
  timestamp?: number;
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
