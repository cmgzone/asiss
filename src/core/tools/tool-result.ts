/**
 * Tool result types — Hermes Evolution Phase 4.
 *
 * The canonical input/output shapes for the ToolEngine lifecycle:
 *   resolve -> validate -> authorize -> execute -> normalize -> record.
 */

export interface ToolRequest {
  name: string;
  arguments?: Record<string, unknown>;
}

/** Execution context supplied by the host (AgentRunner) per tool call. */
export interface ToolContext {
  sessionId?: string;
  /** Canonical Task to record tool executions through (Phase 2 wiring). */
  taskId?: string;
  projectId?: string;
  workspacePath?: string;
  /** App config (checkpoints / agent policy knobs). */
  config?: any;
  /** Live output sink (shell streaming). */
  stream?: (chunk: string) => void;
  /** Abort signal for long-running tools (shell commands) so a user stop can
   * interrupt execution mid-flight instead of waiting for the turn boundary. */
  signal?: AbortSignal;
  /** PolicyEngine overrides (Phase 5): per-call approval handler. */
  approve?: (verdict: any, ctx: any) => Promise<boolean> | boolean;
  /** Agent permission allow-list; tools outside it are DENIED when provided. */
  agentPermissions?: string[];
  /** Host-computed task risk for policy evaluation ('low' | 'medium' | 'high'). */
  taskRisk?: 'low' | 'medium' | 'high';
}

export type ToolSource = 'native' | 'mcp' | 'dynamic' | 'learned';

export interface ToolResult {
  success: boolean;
  /** Resolved (canonical) tool name. */
  name: string;
  source?: ToolSource;
  /** Normalized string output (JSON) — what the model sees. */
  output?: string;
  error?: string;
  checkpoint?: { id: string; reason: string };
  /** Semantic fallback: a capability-alternative skill replaced a failed call. */
  fallback?: { requested: string; resolved: string };
  /** Dynamic tool resolution: an unknown name was mapped/created at runtime. */
  dynamic?: { requested: string; resolved: string };
  /** True when the policy layer refused the call (workspace/allowlist). */
  denied?: boolean;
  reason?: string;
  /** The full PolicyEngine verdict (checks + risk) when policy ran. */
  policy?: any;
  /** Recorded canonical Task execution id (Phase 12 Move 3), when a taskId was
   *  supplied. Lets the host annotate the execution with its tool role. */
  executionId?: string;
}

/** JSON-stringify a raw tool output, passing strings through untouched. */
export function normalizeOutput(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function errorResult(name: string, error: string, extra: Partial<ToolResult> = {}): ToolResult {
  return { success: false, name, error, ...extra };
}
