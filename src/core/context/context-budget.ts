/**
 * Context budget — Hermes Evolution Phase 7.
 *
 * Token budgeting for the assembled context. Instead of unbounded context,
 * every section gets an allocation: high-priority sections (mission, latest
 * turns) keep everything up to their share, low-priority sections (old
 * memories, tool catalogs) are trimmed first when the budget runs out.
 *
 * Token estimation matches the rest of the codebase (~4 chars per token).
 */

export interface BudgetSection {
  /** Section identifier, e.g. 'history', 'tools', 'project', 'repository'. */
  name: string;
  /** Full (untrimmed) text. */
  text: string;
  /** Priority: higher = survives trimming first. 0 = droppable entirely. */
  priority: number;
}

export interface BudgetResult {
  /** Trimmed sections (same order as input; dropped sections have text ''). */
  sections: Array<{ name: string; text: string; tokens: number; dropped: boolean }>;
  /** Total tokens after budgeting. */
  totalTokens: number;
  /** How much was trimmed away (chars). */
  trimmedChars: number;
}

export function estimateTokens(text: string): number {
  return Math.ceil((text || '').length / 4);
}

const DEFAULT_MAX_TOKENS = 32_000;
const HEAD_TAIL_RATIO = 0.6; // keep 60% head, 40% tail when mid-trimming

/**
 * Fit sections into a token budget. Sections are trimmed in reverse priority
 * order; within a section, text is cut head+tail with a marker (never a hard
 * cut that loses both ends of meaning). Priority-0 sections are dropped first.
 */
export function fitToBudget(
  sections: BudgetSection[],
  maxTokens: number = DEFAULT_MAX_TOKENS
): BudgetResult {
  let remaining = maxTokens;
  let trimmedChars = 0;

  // Greedy allocation in priority order: highest priority keeps its text up to
  // the remaining budget; lower priorities get whatever is left.
  const ordered = [...sections].sort((a, b) => b.priority - a.priority);
  const allocation = new Map<string, string>();
  for (const section of ordered) {
    const tokens = estimateTokens(section.text);
    if (tokens <= remaining) {
      allocation.set(section.name, section.text);
      remaining -= tokens;
    } else if (section.priority > 0 && remaining > 64) {
      const trimmed = trimToTokens(section.text, remaining);
      trimmedChars += section.text.length - trimmed.length;
      allocation.set(section.name, trimmed);
      remaining = 0;
    } else {
      trimmedChars += section.text.length;
      allocation.set(section.name, '');
    }
  }

  const resultSections = sections.map((section) => {
    const text = allocation.get(section.name) || '';
    return {
      name: section.name,
      text,
      tokens: estimateTokens(text),
      dropped: text === '' && section.text !== ''
    };
  });

  return {
    sections: resultSections,
    totalTokens: resultSections.reduce((sum, s) => sum + s.tokens, 0),
    trimmedChars
  };
}

/** Trim text to an approximate token budget, keeping head + tail. */
export function trimToTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  // Reserve room for the marker so head+tail+marker never exceed the budget.
  const markerBudget = 96;
  const body = Math.max(0, maxChars - markerBudget);
  const head = Math.floor(body * HEAD_TAIL_RATIO);
  const tail = body - head;
  return `${text.slice(0, head)}\n... [context trimmed, ${text.length - body} chars removed] ...\n${text.slice(-tail)}`;
}

/** Hard truncation used by renderers (matches AgentRunner's legacy 20k cap). */
export function truncateChars(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + `\n... [Truncated ${text.length - maxLen} chars] ...`;
}
