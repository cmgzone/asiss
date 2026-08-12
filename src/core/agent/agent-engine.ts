/**
 * AgentEngine — Phase 13 Step 2.
 *
 * TaskEngine owns WHAT WORK HAPPENS. AgentEngine owns WHO DOES THE WORK.
 *
 * Step 2 scope (per plan: wrap first, migrate gradually):
 *   - register / get / list agents
 *   - capability-only selection (NO performance ranking yet)
 *   - assign / release lifecycle state
 *
 * NOT in Step 2 (Step 3):
 *   - executeTask: child work must flow through TaskEngine as canonical
 *     Tasks (`kind: 'delegation'`) — never a second `runChildLoop`-style
 *     execution authority. `executeTask` is a guard that refuses to
 *     run until Step 3 wires it onto TaskEngine.
 */

import { AgentRegistry, agentRegistry } from './agent-registry';
import { capabilityHintsFromText } from './agent-capabilities';
import type { Agent, AgentInput } from './agent-types';

export {
  hasAllCapabilities,
  sortDeterministic,
  eligibilityOf
} from './agent-capabilities';

export interface SelectAgentOptions {
  /** Explicit required capabilities (normalized against the catalog). */
  requiredCapabilities?: string[];
  /** Free-text goal — capability hints extracted when required is absent. */
  goalText?: string;
  /** Restrict to this role. */
  role?: string;
  /** Candidate names/ids to exclude. */
  exclude?: string[];
  /** Only agents that can carry out this task scope. */
  taskScope?: string;
}

export interface SelectResult {
  agent: Agent;
  /** True when every required capability is satisfied. */
  selected: boolean;
  /** Capabilities required but missing on the agent. */
  missing: string[];
}

export class AgentEngine {
  constructor(private registry: AgentRegistry = agentRegistry) {}

  registerAgent(input: AgentInput, sourceId?: string): Agent {
    return this.registry.register(input, sourceId);
  }

  getAgent(idOrName: string): Agent | undefined {
    return this.registry.get(idOrName);
  }

  listAgents(): Agent[] {
    return this.registry.list();
  }

  refresh(): void {
    this.registry.refresh();
  }

  /** Eligibility report for one agent against required capabilities. */
  eligible(agent: Agent, requiredCapabilities?: string[]): SelectResult {
    const need = requiredCapabilities || [];
    const have = new Set(agent.capabilities.map(c => c.toLowerCase()));
    const missing = need.filter(c => !have.has(c.toLowerCase()));
    return { agent, selected: missing.length === 0, missing };
  }

  /** All agents that satisfy the required capabilities (capability-only). */
  candidates(options: SelectAgentOptions = {}): SelectResult[] {
    const required = options.requiredCapabilities?.length
      ? options.requiredCapabilities
      : capabilityHintsFromText(options.goalText || '');

    const excludeSet = new Set((options.exclude || []).map(s => s.toLowerCase()));

    return this.registry
      .list()
      .filter(a => a.status !== 'RELEASED')
      .filter(a => !options.role || a.role === options.role)
      .filter(a => !options.taskScope || a.taskScope === options.taskScope ||
        a.taskScope === 'any')
      .filter(a => !excludeSet.has(a.id.toLowerCase()) && !excludeSet.has(a.name.toLowerCase()))
      .map(a => this.eligible(a, required))
      .sort((a, b) => {
        // Add a deterministic quality signal: agents matching more
        // capabilities first (still capability-only — no performance data).
        const coverageA = a.agent.capabilities.length;
        const coverageB = b.agent.capabilities.length;
        if (coverageB !== coverageA) return coverageB - coverageA;
        return a.agent.name.localeCompare(b.agent.name);
      });
  }

  /**
   * Select the best eligible agent for a task (capability-first, no
   * performance ranking). Returns the first fully-eligible candidate.
   */
  selectAgent(options: SelectAgentOptions = {}): SelectResult | null {
    const first = this.candidates(options).find(r => r.selected);
    return first || null;
  }

  /** Assign a task to an agent — lifecycle state only, no execution (Step 3). */
  assignAgent(agentId: string, taskId: string | null): Agent | undefined {
    const agent = this.registry.get(agentId);
    if (!agent || agent.status === 'RELEASED') return undefined;
    agent.status = taskId ? 'ASSIGNED' : 'AVAILABLE';
    agent.metadata = {
      ...agent.metadata,
      assignedTaskId: taskId || undefined
    };
    return agent;
  }

  /** Release an agent back to AVAILABLE. */
  releaseAgent(agentId: string): Agent | undefined {
    const agent = this.registry.get(agentId);
    if (!agent) return undefined;
    agent.status = 'AVAILABLE';
    delete agent.metadata.assignedTaskId;
    return agent;
  }

  /**
   * Guard: child work must be executed through TaskEngine as canonical
   * Tasks (Step 3). This method refuses to host a second execution loop.
   */
  executeTask(_agentId: string, _task: unknown): Promise<never> {
    return Promise.reject(
      new Error(
        'AgentEngine.executeTask is Step 3: delegated work must flow through ' +
        'TaskEngine as canonical Tasks (kind: delegation). No second ' +
        'execution authority is permitted.'
      )
    );
  }
}

/** Singleton over the global registry (matches existing manager conventions). */
export const agentEngine = new AgentEngine();