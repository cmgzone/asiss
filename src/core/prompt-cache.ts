/**
 * Prompt (token) caching helpers.
 *
 * Gitu rebuilds the full prompt every turn (system prompt + tools + mission
 * history). The system prompt and tool definitions are stable across turns, so
 * marking them with a cache breakpoint lets providers reuse the cached prefix
 * instead of re-billing the input tokens each turn. This is critical for the
 * unlimitedTools mode where an agent can run hundreds of turns.
 *
 * Format follows the Anthropic/OpenRouter "cache_control: { type: 'ephemeral' }"
 * convention, which OpenRouter applies for Claude-family models and tolerates
 * (or ignores) for others. A no-cache retry fallback in each provider keeps
 * this safe for models that reject the marker.
 */

export function promptCachingEnabled(): boolean {
  const v = (process.env.GITU_PROMPT_CACHING ?? 'true').toLowerCase().trim();
  return v !== 'false' && v !== '0' && v !== 'no' && v !== 'off';
}

export function isCacheableProvider(baseURL: string, model: string): boolean {
  const u = (baseURL || '').toLowerCase();
  const m = (model || '').toLowerCase();
  if (u.includes('openrouter.ai')) return true;
  if (u.includes('api.anthropic.com')) return true;
  if (m.startsWith('claude') || m.includes('anthropic')) return true;
  return false;
}

/** Convert a plain system prompt into a cacheable content block. */
export function cacheSystem(systemPrompt?: string): any[] {
  if (!systemPrompt) return [];
  return [
    {
      role: 'system',
      content: [
        { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }
      ]
    }
  ];
}

/** Mark the last tool definition as a cache breakpoint (OpenRouter/Anthropic). */
export function cacheTools(tools: any[]): any[] {
  if (!tools || tools.length === 0) return tools;
  const out = tools.map(t => ({ ...t }));
  const last = out[out.length - 1];
  if (last && last.function) last.function.cache_control = { type: 'ephemeral' };
  else if (last) last.cache_control = { type: 'ephemeral' };
  return out;
}

/** Recursively strip cache_control markers (used for the no-cache fallback). */
export function stripCacheControl(obj: any): any {
  if (Array.isArray(obj)) return obj.map(stripCacheControl);
  if (obj && typeof obj === 'object') {
    const out: any = {};
    for (const k of Object.keys(obj)) {
      if (k === 'cache_control') continue;
      out[k] = stripCacheControl(obj[k]);
    }
    return out;
  }
  return obj;
}

/** Pull cached-token counts out of a provider usage object, if present. */
export function extractCacheUsage(usage: any): { cacheReadTokens?: number; cacheWriteTokens?: number } {
  if (!usage) return {};
  const details = usage.prompt_tokens_details || {};
  const cacheReadTokens = Number(details.cached_tokens ?? details.cache_read_tokens ?? 0) || undefined;
  const cacheWriteTokens = Number(details.cache_creation_tokens ?? details.cache_write_tokens ?? 0) || undefined;
  return { cacheReadTokens, cacheWriteTokens };
}
