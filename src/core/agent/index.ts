/**
 * Canonical Agent system — Hermes Evolution Phase 13 (Step 2).
 *
 * Public surface:
 *   agent-types.ts        — canonical Agent model, roles, policies, scopes
 *   agent-capabilities.ts — capability catalog + matching (capability-first)
 *   agent-registry.ts     — adapters over existing stores + unified lookup
 *   agent-engine.ts       — selection, assign/release, execution guard
 *   agent-result.ts       — canonical AgentResult (evidence, not "Done")
 *
 * Wrap-first: existing stores (custom agents, profiles, swarm, A2A) stay
 * authoritative; this module adapts them. No migration, no second
 * execution authority.
 */

export * from './agent-types';
export * from './agent-capabilities';
export * from './agent-registry';
export * from './agent-engine';
export * from './agent-result';
export * from './task-profile';
