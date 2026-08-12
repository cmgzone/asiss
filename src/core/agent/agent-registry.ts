/**
 * AgentRegistry — Phase 13 Step 2.
 *
 * Wrap-first: adapts the existing stores (custom agents, agent profiles,
 * swarm agents, A2A cards) into the canonical `Agent` shape and exposes
 * unified lookup. Existing stores are NOT migrated or deleted; they stay
 * authoritative while the wrap surfaces incompatibilities.
 *
 *   Existing stores -> adapters/normalization -> AgentRegistry -> canonical Agent
 */

import { agentSwarm, type SwarmAgent } from '../agent-swarm';
import { customAgentManager, type CustomAgentConfig } from '../custom-agents';
import { agentProfileManager, type AgentProfile } from '../agent-profiles';
import type { A2AAgentCard } from '../a2a-protocol';
import {
  normalizeCapabilities,
  capabilityHintsFromText
} from './agent-capabilities';
import type {
  Agent,
  AgentContextSource,
  AgentInput,
  AgentRole,
  AgentSourceKind
} from './agent-types';

/** Phase 16 Move 2 — policy defaults so every wrapped/registered agent carries a complete contract. */
// task + instructions + history = the child mission's structural context today
// (identity, goal, conversation); memory/attempts/repo are policy-gated on top.
const DEFAULT_CONTEXT_POLICY = { sources: ['task', 'instructions', 'history'] as AgentContextSource[] };
const DEFAULT_MEMORY_POLICY = { injectLimit: 0 };
const DEFAULT_EXECUTION_LIMITS = {};
const DEFAULT_HANDOFF_POLICY = { allowDelegation: true, maxDepth: 3 };

/** Map a store kind to its namespace prefix in canonical ids. */
const KIND_PREFIX: Record<AgentSourceKind, string> = {
  custom_agent: 'custom',
  agent_profile: 'profile',
  swarm_agent: 'swarm',
  a2a_card: 'a2a',
  registry: 'reg'
};

function canonicalId(sourceKind: AgentSourceKind, sourceId: string): string {
  return `${KIND_PREFIX[sourceKind]}:${sourceId}`;
}

/** Convert a free-form role string onto the canonical role enum when known. */
export function roleFromString(raw: string | undefined): AgentRole {
  const normalized = String(raw || '').trim().toLowerCase();
  const known: AgentRole[] = [
    'general', 'researcher', 'coder', 'writer', 'analyst',
    'planner', 'reviewer', 'architect', 'tester', 'external'
  ];
  if (known.includes(normalized as AgentRole)) return normalized as AgentRole;
  if (normalized.includes('research')) return 'researcher';
  if (normalized.includes('code') || normalized.includes('engineer') || normalized.includes('dev')) return 'coder';
  if (normalized.includes('writer') || normalized.includes('copy')) return 'writer';
  if (normalized.includes('analyst') || normalized.includes('data')) return 'analyst';
  if (normalized.includes('plan') || normalized.includes('architect')) return 'architect';
  if (normalized.includes('review') || normalized.includes('audit')) return 'reviewer';
  if (normalized.includes('test') || normalized.includes('qa')) return 'tester';
  return 'general';
}

/**
 * Adapter: CustomAgentConfig -> Agent.
 * Capabilities are derived from persona/description text (keyword hints);
 * tools are the configured skills.
 */
export function fromCustomAgent(agent: CustomAgentConfig): Agent {
  const role = roleFromString(agent.name);
  const capabilityText = `${agent.name} ${agent.description || ''} ${agent.persona || ''}`;
  return {
    id: canonicalId('custom_agent', agent.id),
    sourceId: agent.id,
    sourceKind: 'custom_agent',
    name: agent.displayName || agent.name,
    role,
    description: agent.description,
    capabilities: normalizeCapabilities([...capabilityHintsFromText(capabilityText)]),
    tools: [...(agent.skills || [])],
    modelPolicy: { modelId: agent.model },
    permissions: {
      allowedTools: agent.skills && agent.skills.length > 0 ? agent.skills : undefined
    },
    memoryScope: 'session',
    taskScope: 'any',
    status: agent.enabled ? 'AVAILABLE' : 'RELEASED',
    persona: agent.persona,
    contextPolicy: { ...DEFAULT_CONTEXT_POLICY },
    memoryPolicy: { ...DEFAULT_MEMORY_POLICY },
    executionLimits: { ...DEFAULT_EXECUTION_LIMITS },
    handoffPolicy: { ...DEFAULT_HANDOFF_POLICY },
    profileId: agent.profileId,
    metadata: {
      displayName: agent.displayName,
      triggers: agent.triggers,
      enabled: agent.enabled,
      temperature: agent.temperature
    },
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt
  };
}

/**
 * Adapter: AgentProfile -> Agent.
 * Capabilities from allowed skills + learned preferences (expertise,
 * strengths); tools from allowedSkills + preferredTools.
 */
export function fromProfile(profile: AgentProfile): Agent {
  const prefs = profile.learnedPreferences || {};
  const capabilityText = [
    profile.name,
    profile.description || '',
    ...(prefs.domainExpertise || []),
    ...(prefs.strengths || [])
  ].join(' ');
  const tools = [
    ...(profile.allowedSkills || []),
    ...(prefs.preferredTools || [])
  ];
  return {
    id: canonicalId('agent_profile', profile.id),
    sourceId: profile.id,
    sourceKind: 'agent_profile',
    name: profile.name,
    role: roleFromString(profile.name),
    description: profile.description,
    capabilities: normalizeCapabilities(capabilityHintsFromText(capabilityText)),
    tools: tools.length > 0 ? Array.from(new Set(tools)) : [],
    modelPolicy: { modelId: profile.modelId },
    permissions: {
      allowedTools: profile.allowedSkills && profile.allowedSkills.length > 0 ? profile.allowedSkills : undefined
    },
    memoryScope: 'agent',
    taskScope: 'any',
    status: 'AVAILABLE',
    persona: profile.description
      ? `# Agent Profile: ${profile.name}\n${profile.description}`
      : undefined,
    contextPolicy: { ...DEFAULT_CONTEXT_POLICY },
    memoryPolicy: { ...DEFAULT_MEMORY_POLICY },
    executionLimits: { ...DEFAULT_EXECUTION_LIMITS },
    handoffPolicy: { ...DEFAULT_HANDOFF_POLICY },
    metadata: {
      performance: profile.performance,
      learnedPreferences: prefs
    },
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt
  };
}

/** Adapter: SwarmAgent -> Agent. Tools follow the linked profile when present. */
export function fromSwarmAgent(agent: SwarmAgent): Agent {
  const profile = agent.profileId ? agentProfileManager.get(agent.profileId) : undefined;
  const capabilityText = [agent.role, agent.specialization].join(' ');
  const tools = [
    ...(profile?.allowedSkills || []),
    ...(profile?.learnedPreferences?.preferredTools || [])
  ];
  const base: Agent = {
    id: canonicalId('swarm_agent', agent.id),
    sourceId: agent.id,
    sourceKind: 'swarm_agent',
    name: agent.name,
    role: roleFromString(agent.role),
    description: `Role: ${agent.role}. Specialization: ${agent.specialization}`,
    capabilities: normalizeCapabilities(capabilityHintsFromText(capabilityText)),
    tools: tools.length > 0 ? Array.from(new Set(tools)) : [],
    modelPolicy: { modelId: agent.modelId || profile?.modelId },
    permissions: {},
    memoryScope: 'agent',
    taskScope: 'any',
    status: agent.status === 'completed' ? 'COMPLETED' : agent.status === 'working' ? 'WORKING' : agent.status === 'error' ? 'RELEASED' : 'AVAILABLE',
    persona: `# Swarm Agent: ${agent.name}\nRole: ${agent.role}\nSpecialization: ${agent.specialization}`,
    contextPolicy: { ...DEFAULT_CONTEXT_POLICY },
    memoryPolicy: { ...DEFAULT_MEMORY_POLICY },
    executionLimits: { ...DEFAULT_EXECUTION_LIMITS },
    handoffPolicy: { ...DEFAULT_HANDOFF_POLICY },
    profileId: agent.profileId,
    metadata: {
      specialization: agent.specialization,
      assignedTasks: agent.assignedTasks,
      completedTasks: agent.completedTasks,
      parentId: agent.parentId
    },
    createdAt: agent.createdAt,
    updatedAt: agent.createdAt
  };
  return base;
}

/** Adapter: A2AAgentCard -> Agent (external agents). */
export function fromA2ACard(card: A2AAgentCard): Agent {
  const skills = card.skills || [];
  const capabilityText = [
    card.name,
    card.description || '',
    ...skills.map(s => `${s.name || ''} ${(s.tags || []).join(' ')}`),
  ].join(' ');
  return {
    id: canonicalId('a2a_card', card.name),
    sourceId: card.name,
    sourceKind: 'a2a_card',
    name: card.name,
    role: 'external',
    description: card.description,
    capabilities: normalizeCapabilities(capabilityHintsFromText(capabilityText)),
    tools: skills.map(s => s.name).filter((n): n is string => Boolean(n)),
    modelPolicy: {},
    permissions: {},
    memoryScope: 'none',
    taskScope: 'delegation',
    status: 'AVAILABLE',
    contextPolicy: { ...DEFAULT_CONTEXT_POLICY },
    memoryPolicy: { ...DEFAULT_MEMORY_POLICY },
    executionLimits: { ...DEFAULT_EXECUTION_LIMITS },
    handoffPolicy: { allowDelegation: false, maxDepth: 1 },
    metadata: { url: card.url, version: card.version },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

export class AgentRegistry {
  private agents: Map<string, Agent> = new Map();

  /** Re-read all wrapped stores and normalize into canonical agents. */
  refresh(): void {
    this.agents.clear();

    for (const a of customAgentManager.listAgents()) {
      this.upsert(fromCustomAgent(a));
    }
    for (const p of agentProfileManager.list()) {
      this.upsert(fromProfile(p));
    }
    for (const s of agentSwarm.listAgents()) {
      this.upsert(fromSwarmAgent(s));
    }
  }

  /** Register (or update) a canonical agent — used for registry-born agents. */
  upsert(agent: Agent): Agent {
    this.agents.set(agent.id, agent);
    return agent;
  }

  /** Create + register a registry-born agent from a plain input. */
  register(input: AgentInput, sourceId?: string): Agent {
    const id = input.id || canonicalId('registry', sourceId || input.name.toLowerCase().replace(/\s+/g, '-'));
    const agent: Agent = {
      id,
      sourceId: input.sourceId || sourceId,
      sourceKind: input.sourceKind || 'registry',
      name: input.name,
      role: input.role || 'general',
      description: input.description,
      capabilities: normalizeCapabilities(input.capabilities),
      tools: [...(input.tools || [])],
      modelPolicy: input.modelPolicy || {},
      permissions: input.permissions || {},
      memoryScope: input.memoryScope || 'session',
      taskScope: input.taskScope || 'any',
      status: 'AVAILABLE',
      persona: input.persona,
      instructions: input.instructions,
      contextPolicy: input.contextPolicy || { ...DEFAULT_CONTEXT_POLICY },
      memoryPolicy: input.memoryPolicy || { ...DEFAULT_MEMORY_POLICY },
      executionLimits: input.executionLimits || { ...DEFAULT_EXECUTION_LIMITS },
      handoffPolicy: input.handoffPolicy || { ...DEFAULT_HANDOFF_POLICY },
      profileId: input.profileId,
      metadata: input.metadata || {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    return this.upsert(agent);
  }

  unregister(id: string): boolean {
    return this.agents.delete(id);
  }

  get(idOrName: string): Agent | undefined {
    const direct = this.agents.get(idOrName);
    if (direct) return direct;
    const lower = idOrName.toLowerCase();
    return Array.from(this.agents.values()).find(
      (a) => a.sourceId === idOrName || a.name.toLowerCase() === lower
    );
  }

  list(): Agent[] {
    return Array.from(this.agents.values());
  }

  get size(): number {
    return this.agents.size;
  }
}

/** Singleton over the global stores (matches existing manager conventions). */
export const agentRegistry = new AgentRegistry();