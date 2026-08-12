/**
 * Capability catalog + matching — Phase 13 Step 2.
 *
 * Capability-only selection for the first cut: eligible == every required
 * capability is present on the agent. NO performance ranking yet —
 * performance metrics are not trustworthy until the measurement
 * infrastructure (confidence/artifacts/unified reports) lands.
 */

import type { Agent } from './agent-types';

/**
 * Canonical capability ids. Free-form strings are normalized onto this
 * catalog where a match exists; unknown strings are preserved as-is
 * (forward compatibility).
 */
export const CANONICAL_CAPABILITIES = [
  'coding',
  'typescript',
  'debugging',
  'repository-analysis',
  'testing',
  'web-research',
  'data-analysis',
  'writing',
  'planning',
  'reviewing',
  'security'
] as const;

export type CanonicalCapability = (typeof CANONICAL_CAPABILITIES)[number];

/** Keyword → canonical capability hints (used by text/task profiling). */
const CAPABILITY_KEYWORDS: Record<string, string[]> = {
  code: ['coding'],
  codes: ['coding'],
  coder: ['coding'],
  coding: ['coding'],
  program: ['coding'],
  implement: ['coding'],
  typescript: ['typescript'],
  ts: ['typescript'],
  debug: ['debugging'],
  debugs: ['debugging'],
  debugging: ['debugging'],
  bug: ['debugging'],
  bugs: ['debugging'],
  fix: ['debugging'],
  fixes: ['debugging'],
  'repository-analysis': ['repository-analysis'],
  search: ['repository-analysis', 'web-research'],
  analyze: ['data-analysis', 'repository-analysis'],
  analysis: ['data-analysis', 'repository-analysis'],
  test: ['testing'],
  tests: ['testing'],
  tester: ['testing'],
  testing: ['testing'],
  verify: ['testing'],
  research: ['web-research'],
  researcher: ['web-research'],
  web: ['web-research'],
  data: ['data-analysis'],
  write: ['writing'],
  writes: ['writing'],
  writer: ['writing'],
  document: ['writing'],
  plan: ['planning'],
  plans: ['planning'],
  planning: ['planning'],
  architecture: ['planning'],
  architect: ['planning'],
  review: ['reviewing'],
  reviews: ['reviewing'],
  reviewer: ['reviewing'],
  audit: ['reviewing'],
  security: ['security'],
  vulnerability: ['vulnerability'],
  vulnerabilities: ['security'],
  secure: ['security']
};

/** Normalize a raw capability string onto the canonical id when known. */
export function normalizeCapability(raw: string): string {
  const cleaned = String(raw || '').trim().toLowerCase().replace(/\s+/g, '-');
  if ((CANONICAL_CAPABILITIES as readonly string[]).includes(cleaned)) return cleaned;
  return cleaned;
}

/** Capability hints extracted from free text (goals, descriptions, tags). */
export function capabilityHintsFromText(text: string): string[] {
  const lower = String(text || '').toLowerCase();
  const hints = new Set<string>();
  for (const [keyword, caps] of Object.entries(CAPABILITY_KEYWORDS)) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(lower)) {
      for (const cap of caps) hints.add(cap);
    }
  }
  return Array.from(hints);
}

/** Merge + normalize a list of raw capability-ish strings. */
export function normalizeCapabilities(raw: string[] | undefined): string[] {
  const seen = new Set<string>();
  for (const item of raw || []) {
    const norm = normalizeCapability(item);
    if (norm) seen.add(norm);
  }
  return Array.from(seen);
}

/** All capabilities merged for one agent (deduped, normalized). */
export function agentCapabilities(agent: { capabilities?: string[] }): string[] {
  return normalizeCapabilities(agent?.capabilities);
}

/** True when the agent carries every required capability. */
export function hasAllCapabilities(
  agent: { capabilities?: string[] },
  required: string[] | undefined
): boolean {
  const need = normalizeCapabilities(required);
  if (need.length === 0) return true;
  const have = new Set(agentCapabilities(agent));
  return need.every((cap) => have.has(cap));
}

/** Number of required capabilities the agent satisfies (0..required.length). */
export function capabilityCoverage(
  agent: { capabilities?: string[] },
  required: string[] | undefined
): number {
  const need = normalizeCapabilities(required);
  if (need.length === 0) return 0;
  const have = new Set(agentCapabilities(agent));
  return need.filter((cap) => have.has(cap)).length;
}

/** Deterministic eligibility summary for one agent. */
export function eligibilityOf(
  agent: Agent,
  required: string[] | undefined
): { agent: Agent; eligible: boolean; missing: string[] } {
  const need = normalizeCapabilities(required);
  const have = new Set(agentCapabilities(agent));
  const missing = need.filter((cap) => !have.has(cap));
  return { agent, eligible: missing.length === 0, missing };
}

/** Stable ordering: eligible agents sorted by name (no performance ranking). */
export function sortDeterministic(agents: Agent[]): Agent[] {
  return [...agents].sort((a, b) => a.name.localeCompare(b.name));
}