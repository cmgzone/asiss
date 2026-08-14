/**
 * Phase 22 — conversational text sanitization.
 *
 * The model can emit agent-protocol markup inside its plain-text stream
 * (e.g. DeepSeek-style `<tool_call>name<arg_key>k</arg_key><arg_value>v</arg_value></tool_call>`
 * when tool calls arrive as text rather than structured `delta.tool_calls`).
 * That text is streamed to the chat and rendered by markdown, so the raw
 * protocol must be removed at the source (server) AND as a defense-in-depth
 * pass in the renderer (client), so `<tool_call>` / `<arg_key>` / `<arg_value>`
 * can never appear visibly in normal conversation.
 *
 * PURE: no imports, no I/O — extractable and unit-testable.
 */

const TOOL_CALL_BLOCK_RE = /<tool_call(?:\s[^>]*)?>[\s\S]*?<\/tool_call\s*>/gi;
const TOOL_CALL_SELFCLOSE_RE = /<tool_call(?:\s[^>]*)?\/>/gi;
const TOOL_CALL_OPEN_RE = /<\/?tool_call(?:\s[^>]*)?>/gi;
const ARG_TAG_RE = /<\/?(?:arg_key|arg_value|arg_name)(?:\s[^>]*)?>/gi;
// Chain-of-thought tags are protocol too — never surface private reasoning.
const COT_TAG_RE = /<\/?(?:thinking|reasoning)(?:\s[^>]*)?>/gi;

// Repeated structural noise the model occasionally emits around tool use:
// "Tool call: read_file" narration lines with no user value.
const TOOL_NARRATION_RE = /^\s*(?:tool(?: call|calls?)?|using tool|executing tool)\s*[:#-]?\s*[a-z_]+\s*$/gim;

/**
 * Remove every agent-protocol fragment from conversational text. Applies the
 * block removal first (so `<tool_call>...<arg_key>...</arg_key>...</tool_call>`
 * disappears wholesale), then mops up any dangling/self-closing tags. Multiple
 * passes make nested or interleaved markup impossible to survive.
 */
export function sanitizeConversationalText(input: unknown): string {
  let text = String(input ?? '');
  if (!text) return '';
  for (let pass = 0; pass < 3; pass++) {
    const before = text;
    text = text
      .replace(TOOL_CALL_BLOCK_RE, '')
      .replace(TOOL_CALL_SELFCLOSE_RE, '')
      .replace(TOOL_CALL_OPEN_RE, '')
      .replace(ARG_TAG_RE, '')
      .replace(COT_TAG_RE, '');
    if (text === before) break;
  }
  // Collapse the blank lines a removed block leaves behind (max 2 newlines).
  text = text.replace(/\n{3,}/g, '\n\n');
  // Drop stray "Tool call: read_file" narration leftovers only when they sit
  // on their own line and are the line's entire content.
  text = text.replace(TOOL_NARRATION_RE, '');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

/**
 * True when the text contains any agent-protocol markup — used by tests and by
 * callers that want to detect (rather than silently strip) protocol leakage.
 */
export function containsProtocolMarkup(input: unknown): boolean {
  const text = String(input ?? '');
  return (
    TOOL_CALL_OPEN_RE.test(text) ||
    ARG_TAG_RE.test(text) ||
    /<tool_call[\s\S]*?<\/tool_call\s*>/i.test(text)
  );
}