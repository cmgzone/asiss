/**
 * Phase 13 Step 2 — AgentEngine wrap + capability-only selection smokes.
 *
 * Verifies the canonical Agent system (docs/hermes/AGENT_ARCHITECTURE_AUDIT.md
 * §6, ROADMAP.md Phase 13 Step 2):
 *
 *   1. Adapters normalize the existing stores (custom agents, profiles,
 *      swarm agents) into canonical Agents without touching the sources.
 *   2. AgentRegistry registers/refreshes/lists canonical agents.
 *   3. AgentEngine selects by capability ONLY — no performance ranking.
 *   4. AgentResult adapters round-trip legacy AgentTaskReport data.
 *   5. executeTask is a guard (Step 3 wires execution onto TaskEngine).
 *   6. assign/release lifecycle state transitions.
 *   7. Phase 16 Move 2 (AUDIT_7.md §4): the extended Agent contract —
 *      instructions, contextPolicy, memoryPolicy, executionLimits,
 *      handoffPolicy — defaults on wrapped agents, storage on registry-born
 *      agents, and the two Move 2 wirings: executionLimits feed
 *      executeTask's mission budgets, instructions render in the child
 *      system prompt. Task-as-run kept (no AgentRun record).
 *
 * Run: npm run smoke:agent-engine
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitu-agent-engine-'));
  process.chdir(tempDir);
  fs.writeFileSync('SOUL.md', '# Test Soul\n');
  fs.writeFileSync('AGENTS.md', '# Test Workspace\n');
  fs.writeFileSync('USER.md', '# Test User\n');
  fs.writeFileSync('config.json', JSON.stringify({ agent: {} }, null, 2));

  // Keep all data-root managers (task store, checkpoints, hooks) hermetic.
  process.env.GITU_DATA_ROOT = path.join(tempDir, 'gitu-data');

  const { customAgentManager } = await import('../src/core/custom-agents');
  const { agentProfileManager } = await import('../src/core/agent-profiles');
  const { agentSwarm } = await import('../src/core/agent-swarm');
  const { agentRegistry, fromCustomAgent } = await import('../src/core/agent/agent-registry');
  const { AgentEngine, agentEngine } = await import('../src/core/agent/agent-engine');
  const {
    capabilityHintsFromText,
    hasAllCapabilities,
    normalizeCapability
  } = await import('../src/core/agent/agent-capabilities');
  const { agentResultFromTaskReport, taskReportFromAgentResult } =
    await import('../src/core/agent/agent-result');
  const { taskEngine } = await import('../src/core/task');

  const coderAgent = customAgentManager.createAgent({
    name: 'coder',
    displayName: 'Coder',
    description: 'Expert TypeScript programmer who writes code, debugs and fixes bugs.',
    persona: 'You are a coding specialist.',
    skills: ['apply_patch', 'read_file', 'write_file', 'typescript_analyze']
  });

  const researcherAgent = customAgentManager.createAgent({
    name: 'researcher',
    displayName: 'Researcher',
    description: 'Expert web researcher who searches for information and analyzes data.',
    persona: 'You are a research specialist.',
    skills: ['web_search', 'web_fetch', 'brave_search']
  });

  agentProfileManager.create({
    name: 'reviewer',
    description: 'Code reviewer with security expertise.',
    allowedSkills: ['code_search', 'git', 'audit']
  });

  const swarmProfileId = agentProfileManager.create({
    name: 'qa_profile',
    description: 'Quality assurance specialist.',
    allowedSkills: ['test_runner', 'shell_check']
  }).id;

  agentSwarm.createAgent('tester', 'tester', 'testing', undefined, swarmProfileId);

  // ------------------------------------------------------------------
  // 1. Adapters: legacy stores -> canonical Agents (no mutation of sources)
  // ------------------------------------------------------------------
  const canonicalCoder = fromCustomAgent(coderAgent);
  assert.strictEqual(canonicalCoder.sourceKind, 'custom_agent', 'source kind');
  assert.strictEqual(canonicalCoder.sourceId, coderAgent.id, 'source id preserved');
  assert.ok(canonicalCoder.id.startsWith('custom:'), 'namespaced id');
  assert.ok(canonicalCoder.capabilities.includes('coding'), 'capability from description');
  assert.ok(canonicalCoder.capabilities.includes('typescript'), 'capability from description');

  // Reflect the legacy label once the test asserts persona passthrough
  assert.strictEqual(canonicalCoder.persona, 'You are a coding specialist.', 'persona passthrough');

  // ------------------------------------------------------------------
  // 2. Registry refresh wraps ALL stores
  // ------------------------------------------------------------------
  agentRegistry.refresh();
  const all = agentRegistry.list();
  assert.ok(all.length >= 4, `expected >=4 wrapped agents, got ${all.length}`);
  assert.ok(all.some(a => a.name === 'Coder' && a.sourceKind === 'custom_agent'), 'custom agent wrapped');
  assert.ok(all.some(a => a.name === 'Researcher' && a.sourceKind === 'custom_agent'), 'researcher wrapped');
  assert.ok(all.some(a => a.name === 'reviewer' && a.sourceKind === 'agent_profile'), 'profile wrapped');
  assert.ok(all.some(a => a.name === 'tester' && a.sourceKind === 'swarm_agent'), 'swarm agent wrapped');

  const byName = agentRegistry.get('tester');
  assert.ok(byName, 'name lookup');
  const byId = agentRegistry.get(`swarm:${agentSwarm.listAgents()[0].id}`);
  assert.ok(byId, 'id lookup');

  // Swarm agent draws tools from its linked profile (audit finding: zero
  // tools without a profile)
  const swarmCanonical = all.find(a => a.sourceKind === 'swarm_agent')!;
  assert.ok(swarmCanonical.tools.includes('test_runner'), 'profile tools on swarm agent');

  // ------------------------------------------------------------------
  // 3. Capability-first selection (NO performance ranking)
  // ------------------------------------------------------------------
  const engine = new AgentEngine();
  const codingPick = engine.selectAgent({ requiredCapabilities: ['coding', 'typescript'] });
  assert.ok(codingPick, 'a coding candidate is eligible');
  assert.strictEqual(codingPick!.agent.name, 'Coder', 'coder wins on name tie-break');

  const researchPick = engine.selectAgent({ requiredCapabilities: ['web-research'] });
  assert.strictEqual(researchPick!.agent.name, 'Researcher', 'researcher selected for web-research');

  const reviewerPick = engine.selectAgent({ requiredCapabilities: ['security'] });
  assert.ok(reviewerPick, 'reviewer eligible for security');
  assert.strictEqual(reviewerPick!.agent.name, 'reviewer', 'reviewer selected');

  const noMatch = engine.selectAgent({ requiredCapabilities: ['nonexistent-cap'] });
  assert.strictEqual(noMatch, null, 'no candidate for unknown capability');

  const excluded = engine.selectAgent({
    requiredCapabilities: ['coding'],
    exclude: ['Coder']
  });
  assert.ok(excluded, 'alternate candidate after exclude');

  // Role filter + goal text hints
  const rolePick = engine.selectAgent({ requiredCapabilities: ['testing'] });
  assert.ok(rolePick && ['tester', 'reviewer'].includes(rolePick.agent.name), 'testing-capable agent');
  const goalPick = engine.selectAgent({ goalText: 'fix a typescript bug in the auth module' });
  assert.ok(goalPick, 'goal text produces hints');
  assert.ok(
    hasAllCapabilities(goalPick!.agent, ['debugging']),
    'goal hints map to debugging'
  );

  // ------------------------------------------------------------------
  // Registry-born (canonical-only) agents
  // ------------------------------------------------------------------
  agentRegistry.register({
    name: 'Architect',
    role: 'architect',
    description: 'Systems architect planning architecture.',
    capabilities: ['planning', 'coding', 'repository-analysis'],
    tools: ['plan_mode', 'code_search']
  });
  const architectPick = agentEngine.selectAgent({ requiredCapabilities: ['planning', 'repository-analysis'] });
  assert.strictEqual(architectPick!.agent.name, 'Architect', 'canonical-only agent selectable');

  // ------------------------------------------------------------------
  // 4. AgentResult — evidence-shaped reports, canonical adapters
  // ------------------------------------------------------------------
  const hints = capabilityHintsFromText('fix the typescript bug, run the tests and audit security');
  assert.ok(hints.includes('typescript') && hints.includes('debugging'), 'multi-cap text hints');
  assert.strictEqual(normalizeCapability('Web Research'), 'web-research', 'normalize');

  const legacyReport = {
    taskId: 't1',
    agentId: 'coder',
    status: 'completed' as const,
    summary: 'Fixed auth.',
    workDone: ['Refactored token validation'],
    filesChanged: ['src/auth.ts'],
    toolCalls: [],
    evidence: ['npm test passes'],
    risks: ['One edge case remains'],
    nextSteps: ['Add unit test'],
    finalOutput: 'Fixed auth.',
    startedAt: '2026-01-01T00:00:00Z',
    completedAt: '2026-01-01T00:01:00Z'
  };
  const canonical = agentResultFromTaskReport(legacyReport);
  assert.strictEqual(canonical.status, 'completed', 'result status');
  assert.deepStrictEqual(canonical.findings, ['Refactored token validation'], 'findings from workDone');
  assert.deepStrictEqual(canonical.evidence, ['npm test passes'], 'evidence preserved');
  assert.deepStrictEqual(canonical.artifacts, [{ name: 'src/auth.ts' }], 'artifacts from filesChanged');
  assert.ok(canonical.confidence === undefined, 'no invented confidence in Step 2');

  const roundTrip = taskReportFromAgentResult(canonical);
  assert.strictEqual(roundTrip.summary, 'Fixed auth.', 'summaries round-trip');
  assert.strictEqual(roundTrip.status, 'completed', 'status round-trips');

  // ------------------------------------------------------------------
  // 5. executeTask requires configure() wiring before real execution.
  //    (Step 3 execution smoke lives in scripts/smoke-agent-delegation.ts.)
  // ------------------------------------------------------------------
  let guardThrew = false;
  try {
    await agentEngine.executeTask({ agentId: 'custom:coder-id', task: 'x' });
  } catch (err: any) {
    guardThrew = /not configured/.test(String(err?.message));
  }
  assert.strictEqual(guardThrew, true, 'executeTask requires configure() wiring before execution');

  // ------------------------------------------------------------------
  // 6. assign / release lifecycle state
  // ------------------------------------------------------------------
  const assigned = agentEngine.assignAgent('Coder', 'task-123');
  assert.strictEqual(assigned!.status, 'ASSIGNED', 'assigned status');
  assert.strictEqual(assigned!.metadata.assignedTaskId, 'task-123', 'assignment recorded');
  const released = agentEngine.releaseAgent('Coder');
  assert.strictEqual(released!.status, 'AVAILABLE', 'released status');
  assert.strictEqual(released!.metadata.assignedTaskId, undefined, 'assignment cleared');

  // Released agents (disabled custom agents) are excluded from selection
  customAgentManager.updateAgent(researcherAgent.id!, { enabled: false });
  engine.refresh();
  assert.strictEqual(
    engine.selectAgent({ requiredCapabilities: ['web-research'] }),
    null,
    'disabled agent excluded from selection'
  );

  // ------------------------------------------------------------------
  // 7. Phase 16 Move 2 — the extended Agent contract (docs/hermes/AUDIT_7.md §4)
  // ------------------------------------------------------------------
  // 7a. Wrapped agents carry contract defaults (no policy left undefined).
  const wrapped = fromCustomAgent(coderAgent);
  assert.deepStrictEqual(
    wrapped.contextPolicy.sources,
    ['task', 'instructions', 'history'],
    'default context sources on wrapped agents (task + identity + loop history)'
  );
  assert.strictEqual(wrapped.memoryPolicy.injectLimit, 0, 'children default to no memory injection (D5)');
  assert.deepStrictEqual(wrapped.executionLimits, {}, 'no hard limits by default');
  assert.strictEqual(wrapped.handoffPolicy.allowDelegation, true, 'delegation allowed by default');
  assert.strictEqual(wrapped.instructions, undefined, 'no instructions unless the source store has one');

  // 7b. register() stores the full contract from AgentInput.
  agentRegistry.register({
    name: 'ContractBot',
    role: 'analyst',
    description: 'Agent carrying the full Phase 16 contract.',
    capabilities: ['analysis'],
    tools: ['math_eval'],
    instructions: 'Always verify results twice before reporting.',
    contextPolicy: {
      sources: ['task', 'instructions', 'repo', 'memory', 'history', 'attempts'],
      maxContextChars: 8000
    },
    memoryPolicy: { injectLimit: 5, minScore: 0.5, minImportance: 3, types: ['lesson'], sources: ['learning'] },
    executionLimits: { maxTurns: 2, maxAttempts: 1, maxOutputTokens: 2000, timeoutMs: 30000, maxContextChars: 8000 },
    handoffPolicy: { allowDelegation: false, allowedRoles: ['researcher'], maxDepth: 1 }
  });
  const contractAgent = agentRegistry.get('ContractBot')!;
  assert.ok(contractAgent, 'contract agent registered');
  assert.strictEqual(contractAgent.instructions, 'Always verify results twice before reporting.', 'instructions stored');
  assert.deepStrictEqual(
    contractAgent.contextPolicy.sources,
    ['task', 'instructions', 'repo', 'memory', 'history', 'attempts'],
    'contextPolicy stored'
  );
  assert.strictEqual(contractAgent.contextPolicy.maxContextChars, 8000, 'context budget stored');
  assert.strictEqual(contractAgent.memoryPolicy.injectLimit, 5, 'memoryPolicy stored');
  assert.deepStrictEqual(contractAgent.memoryPolicy.sources, ['learning'], 'memoryPolicy sources stored');
  assert.strictEqual(contractAgent.executionLimits.maxTurns, 2, 'executionLimits stored');
  assert.deepStrictEqual(contractAgent.handoffPolicy.allowedRoles, ['researcher'], 'handoffPolicy stored');

  // 7c. Move 2 wirings — executionLimits feed executeTask budgets; instructions
  //     render into the child system prompt. Task-as-run: the run IS the child
  //     canonical Task (no AgentRun record created).
  let childSystemPrompt = '';
  const promptProbe = {
    id: 'prompt-probe',
    name: 'Prompt Probe',
    generate: async (_prompt: string, systemPrompt?: string) => {
      childSystemPrompt = systemPrompt || '';
      return {
        content: JSON.stringify({
          status: 'completed',
          summary: 'Contract verified.',
          workDone: ['Ran with the extended contract'],
          filesChanged: [],
          evidence: ['system prompt carried the instructions'],
          risks: [],
          nextSteps: [],
          finalOutput: 'done'
        })
      };
    }
  };
  const contractEngine = new AgentEngine();
  contractEngine.configure({
    getModelById: () => promptProbe as any,
    getDefaultModel: () => promptProbe as any,
    listMcpTools: async () => [],
    toolEngine: { execute: async () => ({ success: false, error: 'unused' }) } as any,
    taskEngine
  });
  const contractRun = await contractEngine.executeTask({
    agentId: 'ContractBot',
    task: 'Verify the contract.',
    sessionId: 'move2-session'
  });
  assert.strictEqual(contractRun.success, true, 'contract agent executes');
  assert.ok(
    childSystemPrompt.includes('Always verify results twice before reporting.'),
    'instructions rendered in the child system prompt'
  );
  const contractChild = taskEngine.get(contractRun.taskId!)!;
  assert.strictEqual(contractChild.constraints?.maxTurns, 2, 'executionLimits.maxTurns feeds the child mission budget');
  assert.strictEqual(contractChild.assignedAgent, 'reg:contractbot', 'child assigned to the contract agent');
  assert.ok(contractRun.taskIds.length === 1, 'one child task = one run (Task-as-run)');

  // ------------------------------------------------------------------
  // 8. Phase 16 Move 3b — the designated default agent (mission-loop contract)
  // ------------------------------------------------------------------
  // 8a. No designation -> no default, even with AVAILABLE wrapped agents.
  assert.strictEqual(agentEngine.resolveDefaultAgent(), undefined, 'no default agent before designation');
  assert.strictEqual(
    agentEngine.resolveDefaultAgent(),
    undefined,
    'wrapped AVAILABLE agents are never implicit defaults (designation-only)'
  );

  // 8b. Designation resolves deterministically; released designated agents are
  //     skipped.
  const mainAgent = agentRegistry.register({
    name: 'MainAgent',
    role: 'general',
    description: 'The designated default host-driven agent.',
    capabilities: ['general'],
    instructions: 'Coordinate the mission and drive it to completion.',
    modelPolicy: { modelId: 'prompt-probe' },
    taskScope: 'mission',
    metadata: { default: true }
  });
  agentRegistry.register({
    name: 'OfflineMain',
    role: 'general',
    description: 'Designated but disabled.',
    metadata: { default: true }
  });
  agentRegistry.get('OfflineMain')!.status = 'RELEASED';
  const defaultResolved = agentEngine.resolveDefaultAgent();
  assert.ok(defaultResolved, 'designated default resolves');
  assert.strictEqual(defaultResolved!.id, mainAgent.id, 'the designated AVAILABLE agent is returned');
  assert.strictEqual(defaultResolved!.instructions, 'Coordinate the mission and drive it to completion.', 'default carries its contract');

  // 8c. The mission loop (runner) uses the same contract — the mission Task is
  //     assigned to the default agent and its modelPolicy pin lands as the
  //     model selection pin. Verified end-to-end in smoke:runtime; here we
  //     assert the engine surface is complete.
  assert.strictEqual(defaultResolved!.taskScope, 'mission', 'default agent is mission-scoped');
  assert.strictEqual(defaultResolved!.modelPolicy.modelId, 'prompt-probe', 'default agent carries its model pin');

  console.log('\n{"success":true}');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});