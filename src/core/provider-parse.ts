import { redactSecrets } from './redact';

/**
 * Guarded parsing of provider tool-call arguments.
 *
 * The OpenAI-compatible contract delivers tool arguments as a JSON *string*
 * (`tool_calls[].function.arguments`) that the model serialized during
 * generation. When generation is truncated (e.g. a max-token cutoff in the
 * middle of a `write`/`apply_patch` call) or an SSE fragment was lost, that
 * string is not valid JSON — V8 reports "Unterminated string in JSON at
 * position N".
 *
 * Rules enforced here:
 *  - NEVER silently repair malformed JSON (no string patching, no silent `{}`
 *    fallback) — the model turn must be retried or failed in a controlled way.
 *  - Log the raw payload BEFORE the error propagates, secrets redacted.
 *  - Throw a typed error the retry layer can recognize and retry at most once.
 */
export interface ToolArgumentsParseError extends Error {
  code: 'TOOL_ARGUMENTS_JSON_PARSE';
  provider: string;
  toolName?: string;
  rawLength: number;
  parsePosition?: number;
}

export function parseToolCallArguments(raw: any, ctx: { provider: string; toolName?: string }): any {
  // Structured responses (already-parsed objects) pass through untouched.
  if (typeof raw !== 'string') {
    return raw && typeof raw === 'object' ? raw : {};
  }
  const trimmed = raw.trim();
  if (!trimmed) return {};

  try {
    return JSON.parse(trimmed);
  } catch (e: any) {
    const positionMatch = /position (\d+)/i.exec(String(e?.message || e));
    const parsePosition = positionMatch ? Number(positionMatch[1]) : undefined;
    const redacted = redactSecrets(raw);
    const preview = redacted.length > 2000 ? `${redacted.slice(0, 2000)}...[truncated]` : redacted;
    const where = ctx.toolName ? ` (tool: ${ctx.toolName})` : '';
    console.warn(
      `[ProviderParse] Malformed tool-call arguments from ${ctx.provider}${where}: ` +
      `length=${raw.length}${parsePosition !== undefined ? `, parsePosition=${parsePosition}` : ''} -> ${preview}`
    );

    const err: any = new Error(
      `Tool arguments JSON parse error from ${ctx.provider}${where}: ${String(e?.message || e)}`
    );
    err.code = 'TOOL_ARGUMENTS_JSON_PARSE';
    err.provider = ctx.provider;
    err.toolName = ctx.toolName;
    err.rawLength = raw.length;
    err.parsePosition = parsePosition;
    throw err;
  }
}