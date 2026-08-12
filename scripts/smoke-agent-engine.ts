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

  console.log('\n{"success":true}');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});