/**
 * Relevance — Hermes Evolution Phase 7.
 *
 * Lightweight, dependency-free scoring for selecting the most relevant pieces
 * of context (memories, files, tools) for the current task goal. This is the
 * "Relevant memory / Relevant files / Relevant tools" step of the pipeline:
 * instead of dumping everything, rank first and budget second.
 */

/** Tokenize a query into significant lowercase tokens. */
export function significantTokens(text: string): string[] {
  const stop = new Set([
    'this', 'that', 'with', 'from', 'have', 'will', 'your', 'please',
    'the', 'and', 'for', 'are', 'was', 'you', 'not', 'but', 'can'
  ]);
  return String(text || '')
    .toLowerCase()
    .match(/[a-z0-9_]{3,}/g)
    ?.filter((token) => !stop.has(token)) || [];
}

/** Keyword-overlap score between a query and a haystack (0..n hits). */
export function keywordOverlap(query: string, haystack: string): number {
  const tokens = significantTokens(query);
  if (tokens.length === 0) return 0;
  const lower = haystack.toLowerCase();
  let hits = 0;
  for (const token of tokens) {
    if (lower.includes(token)) hits += 1;
  }
  return hits;
}

/** Normalized 0-1 relevance: overlap hits weighted by query size. */
export function relevanceScore(query: string, haystack: string): number {
  const tokens = significantTokens(query);
  if (tokens.length === 0) return 0;
  return keywordOverlap(query, haystack) / tokens.length;
}

export interface Scored<T> {
  item: T;
  score: number;
}

/**
 * Rank items by relevance to the query and return the top `limit` above the
 * optional threshold. `extract` maps an item to its searchable text.
 */
export function selectRelevant<T>(
  items: T[],
  query: string,
  limit: number,
  extract: (item: T) => string
): T[] {
  if (!query || items.length === 0) return [];
  const scored: Scored<T>[] = items
    .map((item) => ({ item, score: relevanceScore(query, extract(item)) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.item);
}

/**
 * Recency-weighted recency boost: combines relevance with how recent an item
 * is (0 = oldest, 1 = newest) so the mission and latest turns win ties.
 */
export function selectRelevantWithRecency<T>(
  items: T[],
  query: string,
  limit: number,
  extract: (item: T) => string,
  indexOf: (item: T) => number
): T[] {
  if (!query || items.length === 0) return [];
  const maxIndex = items.length - 1;
  const scored = items
    .map((item) => {
      const relevance = relevanceScore(query, extract(item));
      const recency = maxIndex > 0 ? indexOf(item) / maxIndex : 1;
      // Recency only breaks ties: relevance dominates until it reaches 0.
      const score = relevance > 0 ? relevance * 0.8 + recency * 0.2 : 0;
      return { item, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.item);
}
