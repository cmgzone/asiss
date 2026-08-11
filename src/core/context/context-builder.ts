/**
 * Context builder — Hermes Evolution Phase 7.
 *
 * Assembles the final context package from sources (history, tools, project,
 * repository, notes, decisions), each rendered into a section with a priority,
 * then fits everything into a token budget. The output is a ContextPackage:
 * ordered, budgeted, observable (per-section tokens, total tokens, warnings).
 */

import { BudgetSection, fitToBudget, estimateTokens } from './context-budget';
import { Summarizer } from './summarizer';

export type MemoryRole = 'user' | 'assistant' | 'system';

export interface ContextMemory {
  role: MemoryRole;
  content: string;
  /** True when this is the current mission's user message. */
  missionMarker?: boolean;
  /** Optional label override, e.g. 'User (Current Mission)'. */
  label?: string;
}

export interface ContextTool {
  name: string;
  description?: string;
}

export interface ContextSourceInput {
  goal: string;
  history?: ContextMemory[];
  tools?: ContextTool[];
  project?: string;            // pre-rendered project prompt block
  repository?: string;         // pre-rendered repository block
  notes?: string;              // scratchpad / long-term notes
  decisions?: string[];        // recent task decisions
  /** Extra sections: { name, text, priority }. */
  extra?: Array<{ name: string; text: string; priority: number }>;
}

export interface ContextSection {
  name: string;
  text: string;
  tokens: number;
  priority: number;
  /** True when the budget dropped or trimmed this section. */
  trimmed?: boolean;
}

export interface ContextPackage {
  /** Ordered sections (priority order) with per-section stats. */
  sections: ContextSection[];
  /** Full assembled context text (empty sections omitted). */
  text: string;
  /** Estimated total tokens of the assembled text. */
  totalTokens: number;
  /** Original tokens across all inputs before budgeting (observability). */
  inputTokens: number;
  budget: number;
  warnings: string[];
}

const HISTORY_PRIORITY = 40;
const PROJECT_PRIORITY = 30;
const REPOSITORY_PRIORITY = 25;
const TOOLS_PRIORITY = 20;
const NOTES_PRIORITY = 15;
const DECISIONS_PRIORITY = 35;

/** Default labels for history roles (byte-identical to AgentRunner's renderer). */
export function historyLabel(role: MemoryRole, missionMarker: boolean): string {
  if (role === 'user') return missionMarker ? 'User (Current Mission)' : 'User';
  if (role === 'assistant') return 'Assistant';
  return 'System';
}

/** Build the token-budgeted context package from raw sources. */
export async function buildContextPackage(
  input: ContextSourceInput,
  options: { maxTokens?: number; summarizer?: Summarizer } = {}
): Promise<ContextPackage> {
  const maxTokens = options.maxTokens ?? 32_000;
  const summarizer = options.summarizer;

  const warnings: string[] = [];
  const sections: BudgetSection[] = [];
  let inputTokens = 0;

  // History: mission-marker messages and the latest turns get a priority boost.
  if (input.history && input.history.length > 0) {
    const boosts = new Map<number, number>();
    input.history.forEach((_, index) => {
      let boost = 0;
      if (input.history![index].missionMarker) boost += 20;
      if (index >= Math.max(0, input.history!.length - 4)) boost += 10;
      boosts.set(index, boost);
    });
    const text = input.history
      .map((m, index) => {
        const label = m.label || historyLabel(m.role, m.missionMarker === true);
        return `${label}: ${m.content}`;
      })
      .join('\n');
    const summarized = summarizer
      ? await summarizer.summarize(text, 'Preserve the mission, user requests, decisions, results and open questions.')
      : text;
    if (summarized !== text) warnings.push('history: summarized long conversation');
    inputTokens += estimateTokens(text);
    sections.push({ name: 'history', text: summarized, priority: HISTORY_PRIORITY + Math.max(...boosts.values()) });
  }

  if (input.project) {
    inputTokens += estimateTokens(input.project);
    sections.push({ name: 'project', text: input.project, priority: PROJECT_PRIORITY });
  }
  if (input.repository) {
    inputTokens += estimateTokens(input.repository);
    sections.push({ name: 'repository', text: input.repository, priority: REPOSITORY_PRIORITY });
  }
  if (input.decisions && input.decisions.length > 0) {
    const text = input.decisions.map((d) => `- ${d}`).join('\n');
    inputTokens += estimateTokens(text);
    sections.push({ name: 'decisions', text, priority: DECISIONS_PRIORITY });
  }
  if (input.tools && input.tools.length > 0) {
    const text = input.tools
      .map((tool) => `${tool.name}${tool.description ? ` — ${tool.description}` : ''}`)
      .join('\n');
    inputTokens += estimateTokens(text);
    sections.push({ name: 'tools', text, priority: TOOLS_PRIORITY });
  }
  if (input.notes) {
    inputTokens += estimateTokens(input.notes);
    sections.push({ name: 'notes', text: input.notes, priority: NOTES_PRIORITY });
  }
  for (const extra of input.extra || []) {
    inputTokens += estimateTokens(extra.text);
    sections.push({ name: extra.name, text: extra.text, priority: extra.priority });
  }

  const byName = new Map(sections.map((s) => [s.name, s]));
  const budget = fitToBudget(sections, maxTokens);
  for (const section of budget.sections) {
    const original = byName.get(section.name);
    if (section.dropped) warnings.push(`${section.name}: dropped (over budget)`);
    else if (original && section.text.length < original.text.length) {
      warnings.push(`${section.name}: trimmed to fit budget`);
    }
  }

  const orderedSections = budget.sections
    .filter((s) => s.text !== '')
    .sort((a, b) => (byName.get(b.name)?.priority || 0) - (byName.get(a.name)?.priority || 0));

  return {
    sections: orderedSections.map((s) => {
      const original = byName.get(s.name);
      return {
        name: s.name,
        text: s.text,
        tokens: s.tokens,
        priority: original?.priority || 0,
        trimmed: s.dropped || (original ? s.text.length < original.text.length : false)
      };
    }),
    text: orderedSections.map((s) => s.text).join('\n\n'),
    totalTokens: budget.totalTokens,
    inputTokens,
    budget: maxTokens,
    warnings
  };
}
