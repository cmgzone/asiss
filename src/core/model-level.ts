import { ModelLevel, ModelProvider, LEVEL_RANK } from './models';

/**
 * Infer a model's capability level from its id/name and provider. Heuristics
 * key off common tier markers, so the level stays "dynamic" — adding a new
 * model id requires no config as long as it follows naming conventions.
 */

const LOW_HINTS = /(^|[_-])(tiny|nano|mini|micro|flash|lite|small|pico|haiku)([_-]|$)/i;
const MAX_HINTS = /(^|[_-])max([_-]|$)/i;
const OPUS_HINTS = /\b(opus|ultra|supreme)\b/i;
const O_HINTS = /^o[134](\b|-|$)/i;
const PRO_HINTS = /-pro\b/i;
const HIGH_NAMES = /\b(gpt-4(?:o|\.1|o-mini-preview)?|gpt-5(?:\.[0-9]+)?|claude-3-5-sonnet|claude-sonnet|sonnet|deepseek-v[0-9]|deepseek-r[0-9]|qwen3?\.5?-coder|gemini-[0-9.]+-pro|kimi-k[0-9]|glm-[45]|mistral-large|grok-[0-9])(?:\b|$)/i;
const MEDIUM_NAMES = /\b(qwen[23]|deepseek-v3|llama-3(?:\.[0-9])?)\b/i;
const PARAM_B = /-(\d{1,3}(?:\.\d+)?)b(?:-|$)/i;

export function inferModelLevel(modelName: string, provider: string = ''): ModelLevel {
  let model = String(modelName || '').trim();
  if (!model) return 'medium';
  const prov = String(provider || '').toLowerCase();

  // OpenRouter `:free` / `:extended` tiers are capped or smaller.
  const freeTier = /:free\b/i.test(model);
  const extendedTier = /:extended\b/i.test(model);
  model = model.replace(/:(free|extended)\b/gi, '').trim();

  let level: ModelLevel;
  if (O_HINTS.test(model)) {
    level = 'max';
  } else if (MAX_HINTS.test(model) || OPUS_HINTS.test(model)) {
    level = 'max';
  } else if (LOW_HINTS.test(model)) {
    // Versioned current-gen flash/lite models (deepseek-v3/v4-flash, gpt-4-flash)
    // are mid-tier workhorses, not toys. mini/tiny/nano variants stay low.
    level = /(flash|lite)/i.test(model) && /^(deepseek|gpt|claude)-[v]?[0-9]/.test(model)
      ? 'medium'
      : 'low';
  } else {
    const param = PARAM_B.exec(model);
    if (param) {
      const size = Number(param[1]);
      if (size <= 14) level = 'low';
      else if (size <= 40) level = 'medium';
      else level = 'high';
    } else if (PRO_HINTS.test(model) || HIGH_NAMES.test(model)) {
      level = 'high';
    } else if (MEDIUM_NAMES.test(model)) {
      level = 'medium';
    } else {
      level = 'medium';
    }
  }

  // Free/extended tiers never count as max-grade, and `:free` workhorse
  // models shouldn't be treated as tiny toys.
  if (freeTier && level === 'max') level = 'high';
  if (freeTier && level === 'high') level = 'medium';
  if (freeTier && level === 'low') level = 'medium';
  if (extendedTier && level === 'low') level = 'medium';

  // Provider nuance: local models (ollama) are rarely max-grade by naming.
  if (prov === 'ollama' && level === 'max') level = 'high';

  return level;
}

/**
 * Pick the best registered provider for a desired level:
 *  1. exact level match
 *  2. the weakest provider stronger than desired
 *  3. the strongest available provider
 * Internal/resilience providers (mock, resilient:, pool, error) are excluded.
 */
export function providerLevel(provider: ModelProvider): ModelLevel {
  if (provider.level) return provider.level;
  return inferModelLevel(provider.name, provider.id);
}

export function selectProviderForLevel(
  providers: ModelProvider[],
  desired: ModelLevel
): ModelProvider | null {
  const available = providers.filter(p =>
    p && p.id &&
    p.id !== 'mock' &&
    !p.id.startsWith('resilient:') &&
    !p.id.startsWith('error') &&
    !/_pool_\d+$/.test(p.id)
  );
  if (available.length === 0) return null;

  const desiredRank = LEVEL_RANK[desired];
  const exact = available.filter(p => LEVEL_RANK[providerLevel(p)] === desiredRank);
  if (exact.length > 0) return exact[0];

  const stronger = available
    .filter(p => LEVEL_RANK[providerLevel(p)] > desiredRank)
    .sort((a, b) => LEVEL_RANK[providerLevel(a)] - LEVEL_RANK[providerLevel(b)]);
  if (stronger.length > 0) return stronger[0];

  return available
    .slice()
    .sort((a, b) => LEVEL_RANK[providerLevel(b)] - LEVEL_RANK[providerLevel(a)])[0];
}
