/**
 * Tool selector — Hermes Evolution Phase 4.
 *
 * Name resolution and fallback selection, moved out of AgentRunner:
 *   - normalizeToolRequest: map hallucinated / MCP-prefixed / aliased names to
 *     real skills (single source of truth; AgentRunner delegates to this).
 *   - fallbackSkillsFor / adaptFallbackArgs: capability-alternative skills for
 *     semantic recovery after a failed call.
 *   - closestToolNames: suggest likely-intended tools for unknown names.
 */

import { ToolRequest } from './tool-result';
import { SkillRegistryLike } from './tool-registry';

/** Alias patterns: models emit these variants instead of the registered names. */
export const TOOL_ALIAS_PATTERNS: Array<[RegExp, string]> = [
  [/(^|[_-])(delegate|subagent|sub_agent|spawn_agent|spawn_subagent|research_agent|worker|agent)([_-]|$)/i, 'delegate_agent'],
  [/(^|[_-])(research|deep_research|literature_review)([_-]|$)/i, 'web_search'],
  [/(^|[_-])(grep|code_search|find_in_files|rg|ripgrep)([_-]|$)/i, 'code_search'],
  [/(^|[_-])(git|github)([_-]|$)/i, 'git'],
  [/(^|[_-])(fetch|scrape|http_get)([_-]|$)/i, 'web_fetch'],
  [/(^|[_-])(read_file|readfile|read-file|read_text_file|read-text-file|cat|view_file|get_file_contents|file_contents|read_text|read_file_contents)([_-]|$)/i, 'read_file'],
  [/(^|[_-])(write_file|writefile|write-file|create_file|create-file|save_file|save-file|append_file|append-file|edit_file|edit-file|update_file|update-file|modify_file|put_file|overwrite_file)([_-]|$)/i, 'write_file'],
  [/(^|[_-])(list_directory|list-dir|listdir|list_dir|list_files|list-files|ls|dir|read_directory|folder_contents|list_directories)([_-]|$)/i, 'list_directory'],
  [/(^|[_-])(glob|search_files|search-files|find_files|find-files|file_search|find_file|list_matching_files|locate_file)([_-]|$)/i, 'glob']
];

/** Report alias patterns (regex sources) for diagnostics (tools_diag). */
export function getAliasCoverage(): Array<{ pattern: string; target: string }> {
  return TOOL_ALIAS_PATTERNS.map(([re, target]) => ({ pattern: re.source, target }));
}

/** Resolve a possibly-hallucinated tool name to a real registered skill. */
export function resolveAlias(name: string, registry: SkillRegistryLike): string | null {
  const lower = String(name || '').trim().toLowerCase();
  if (!lower) return null;
  if (registry.get(lower)) return lower;
  for (const [re, target] of TOOL_ALIAS_PATTERNS) {
    if (re.test(lower)) return target;
  }
  return null;
}

/**
 * Canonical name normalization. Mirrors the previous AgentRunner logic exactly:
 * registered names pass through; MCP-style prefixes are stripped; playwright
 * and browser aliases are folded onto the native playwright skill (with action
 * + url adaptation); other hallucinated names are alias-resolved.
 */
export function normalizeToolRequest(
  request: ToolRequest,
  registry: SkillRegistryLike,
  dynamicNormalize: (name: string) => string | null
): ToolRequest {
  const originalName = String(request.name || '').trim();
  const args: Record<string, any> =
    request.arguments && typeof request.arguments === 'object' ? { ...(request.arguments as Record<string, any>) } : {};
  if (!originalName) return { name: originalName, arguments: args };
  if (registry.get(originalName)) return { name: originalName, arguments: args };

  const normalizedBase = dynamicNormalize(originalName);
  if (normalizedBase && registry.get(normalizedBase)) {
    return { name: normalizedBase, arguments: args };
  }

  const lower = normalizedBase || originalName.toLowerCase().replace(/^mcp_/, '').replace(/_+/g, '_');
  const isPlaywrightAlias = /^playwright(_[a-z0-9_]+)?$/.test(lower)
    || /^browser(_[a-z0-9_]+)?$/.test(lower);
  if (isPlaywrightAlias) {
    if (!args.action) {
      const suffix = lower.replace(/^(playwright|browser)_?/, '');
      let action = 'extract_text';
      if (/screenshot|shot/.test(suffix)) action = 'screenshot';
      else if (/navigate|goto|open|visit|go_/.test(suffix)) action = 'extract_text';
      else if (/snapshot|scrape|extract|text|content|get_/.test(suffix)) action = 'extract_text';
      args.action = action;
    }
    if (!args.url) {
      args.url = args.link || args.href || args.page || args.target || args.website || '';
    }
    return { name: 'playwright', arguments: args };
  }

  const resolved = resolveAlias(originalName, registry);
  if (resolved) return { name: resolved, arguments: args };
  return { name: originalName, arguments: args };
}

/** Ordered fallback chains per capability (first entry preferred). */
const CAPABILITY_FALLBACK: Record<string, string[]> = {
  web_search: ['web_search', 'playwright'],
  web_fetch: ['web_fetch', 'playwright', 'web_search']
};

/** Which other skills can satisfy the same job when `name` fails. */
export function fallbackSkillsFor(name: string, registry: SkillRegistryLike): string[] {
  const skill: any = registry.get(name);
  const caps: string[] = Array.isArray(skill?.capabilities) ? skill.capabilities : [];
  const order: string[] = [];
  for (const cap of caps) {
    const list = CAPABILITY_FALLBACK[cap] || registry.skillsForCapability?.(cap) || [];
    for (const n of list) if (!order.includes(n)) order.push(n);
  }
  return order.filter((n) => n !== name);
}

/** Adapt the original arguments to the argument shape of an alternative skill. */
export function adaptFallbackArgs(altName: string, original: any): any {
  const query = original?.query ?? original?.q ?? '';
  if (altName === 'playwright') {
    if (query) return { action: 'search', query, maxResults: original?.num ?? original?.maxResults ?? 5 };
    if (original?.url) return { action: 'extract_text', url: original.url, selector: original?.selector };
  }
  if (altName === 'web_search') return { query, maxResults: original?.num ?? original?.maxResults ?? 5 };
  if (altName === 'web_fetch') return { url: original?.url };
  return { query, num: original?.num ?? 10, type: original?.type ?? 'search', maxResults: original?.maxResults };
}

/**
 * Score how close a requested tool name is to a candidate: shared-prefix bonus
 * plus character-overlap (Jaccard), so mid-word typos still rank high.
 */
export function nameSimilarity(requested: string, candidate: string): number {
  const a = requested.toLowerCase();
  const b = candidate.toLowerCase();
  if (a === b) return 100;
  if (b.includes(a) || a.includes(b)) return 60 + Math.min(a.length, b.length);
  const maxLen = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < maxLen && a[prefix] === b[prefix]) prefix += 1;
  const setA = new Set(a);
  const setB = new Set(b);
  let overlap = 0;
  for (const ch of setA) if (setB.has(ch)) overlap += 1;
  const union = setA.size + setB.size - overlap;
  const jaccard = union > 0 ? overlap / union : 0;
  return prefix + Math.round(jaccard * 40);
}

export function closestToolNames(requested: string, available: string[], max = 5): string[] {
  const scored = (available || [])
    .map((name) => ({ name, score: nameSimilarity(requested, name) }))
    .filter((s) => s.score >= 15)
    .sort((x, y) => y.score - x.score);
  return scored.slice(0, max).map((s) => s.name);
}
