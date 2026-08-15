/**
 * Secret redaction for provider payload logging and error surfacing.
 *
 * Used before logging raw provider payloads (malformed tool-call arguments,
 * API error bodies) so that keys and tokens never reach the console, memory,
 * or the chat bubble. Redaction runs BEFORE truncation so a secret that is
 * cut in half by the truncation still matches a redaction pattern.
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = String(text);

  // sk-... / pk-... API keys
  out = out.replace(/\b(?:sk|pk)-[A-Za-z0-9_\-]{8,}\b/g, 'sk-[REDACTED]');
  // Bearer tokens
  out = out.replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]');
  // JWT-style tokens
  out = out.replace(/\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b/g, '[REDACTED]');
  // key: value / key=value assignments for common secret field names
  out = out.replace(
    /("?(?:api[_-]?key|apikey|secret|token|password|passwd|authorization|access[_-]?key|private[_-]?key|client[_-]?secret)"?\s*[:=]\s*"?)[^"'\s,}\]]{4,}/gi,
    '$1[REDACTED]'
  );

  return out;
}