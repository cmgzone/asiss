/**
 * Phase 13 Step 4 — TaskProfile-based eligibility selection smoke.
 *
 * Proves selection answers "WHO CAN do this job?" through capability + role +
 * task-scope + tool-grant + permission + workspace filters — with NO
 * performance ranking (deterministic coverage/name tie-break only):
 *
 *   1. profileFromTask adapts a canonical Task into a TaskProfile.
 *   2. Capability filtering (explicit + goal-text hints).
 *   3. preferredRole filtering.
 *   4. taskScope filtering via profile.kind ('mission' vs 'delegation' vs
 *      'background' vs 'scheduled').
 *   5. requiredTools + permission filtering (deniedTools / allowedTools).
 *   6. Workspace grant filtering (allowedWorkspacePaths).
 *   7. selectForTask / selectForTaskId integrate with taskEngine.
 *   8. Deterministic best-first: capability coverage wins, name breaks ties.
 *   9. exclude option; no-match -> null.
 *
 * Run: npm run smoke:agent-task-profile
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitu-agent-profile-'));
  process.chdir(tempDir);
  fs.writeFileSync('SOUL.md', '# Test Soul\n');
  fs.writeFileSync('AGENTS.md', '# Test Workspace\n');
  fs.writeFileSync('USER.md', '# Test User\n');
  fs.writeFileSync('config.json', JSON.stringify({ agent: {} }, null, 2));
  process.env.GITU_DATA_ROOT = path.join(tempDir, 'gitu-data');

  const { AgentEngine } = await import('../src/core/agent/agent-engine');
  const { agentRegistry } = await import('../src/core/agent/agent-registry');
  const { profileFromTask } = await import('../src/core/agent/task-profile');
  const { taskEngine } = await import('../src/core/task');

  const engine = new AgentEngine();
  engine.configure({
    getModelById: () => { throw new Error('No model access in selection smoke.'); },
    getDefaultModel: () => { throw new Error('No model access in selection smoke.'); },
    listMcpTools: async () => [],
    toolEngine: undefined as any,
    taskEngine
  });

  // ------------------------------------------------------------ agent pool
  agentRegistry.register({
    name: 'Coder', role: 'general',
    description: 'Typescript coder',
    capabilities: ['coding', 'typescript', 'debugging'],
    tools: ['apply_patch', 'shell', 'read_file']
  });
  agentRegistry.register({
    name: 'Analyst', role: 'analyst',
    description: 'Data analyst',
    capabilities: ['math', 'analysis', 'coding'],
    tools: ['run_analysis', 'read_file']
  });
  agentRegistry.register({
    name: 'Reviewer', role: 'reviewer',
    description: 'Security reviewer',
    capabilities: ['security', 'reviewing'],
    tools: ['audit', 'code_search']
  });
  agentRegistry.register({
    name: 'TesterOnly', role: 'tester',
    description: 'Delegation-only tester',
    capabilities: ['testing'],
    tools: ['test_runner'],
    taskScope: 'delegation'
  });
  agentRegistry.register({
    name: 'MissionTester', role: 'tester',
    description: 'Mission tester',
    capabilities: ['testing'],
    tools: ['test_runner'],
    taskScope: 'mission'
  });
  agentRegistry.register({
    name: 'BackgroundTester', role: 'tester',
    description: 'Background-only tester',
    capabilities: ['testing'],
    tools: ['test_runner'],
    taskScope: 'background'
  });
  agentRegistry.register({
    name: 'ScheduledTester', role: 'tester',
    description: 'Scheduled-only tester',
    capabilities: ['testing'],
    tools: ['test_runner'],
    taskScope: 'scheduled'
  });
  agentRegistry.register({
    name: 'BroadCoder', role: 'general',
    description: 'Coder with broader coverage',
    capabilities: ['coding', 'typescript', 'debugging', 'repository-analysis'],
    tools: ['apply_patch', 'shell', 'read_file', 'code_search']
  });
  agentRegistry.register({
    name: 'WorkspaceBound', role: 'analyst',
    description: 'Analyst locked to C:/data',
    capabilities: ['analysis'],
    tools: ['run_analysis'],
    permissions: { allowedWorkspacePaths: ['C:/data'] }
  });
  agentRegistry.register({
    name: 'ToolDenied', role: 'general',
    description: 'Coder explicitly denied apply_patch',
    capabilities: ['coding'],
    tools: ['apply_patch', 'shell'],
    permissions: { deniedTools: ['apply_patch'] }
  });
  agentRegistry.register({
    name: 'Restricted', role: 'general',
    description: 'Coder with a narrow allowlist',
    capabilities: ['coding'],
    tools: ['apply_patch', 'shell'],
    permissions: { allowedTools: ['shell'] }
  });

  // ------------------------------------------------------------------ 1.
  const task = await taskEngine.create({
    goal: 'Audit the auth module.',
    kind: 'delegation',
    constraints: { allowedTools: ['audit'], maxTurns: 5 },
    context: { workspacePath: 'C:/work' },
    model: 'mock-v1'
  });
  const profile = profileFromTask(task);
  assert.strictEqual(profile.goal, 'Audit the auth module.', 'goal adapted');
  assert.strictEqual(profile.kind, 'delegation', 'kind adapted');
  assert.deepStrictEqual(profile.requiredTools, ['audit'], 'allowed tools adapted');
  assert.strictEqual(profile.workspace, 'C:/work', 'workspace adapted');
  assert.strictEqual(profile.modelRequirements?.preferredModelId, 'mock-v1', 'model pin adapted');
  assert.strictEqual(profile.constraints?.maxTurns, 5, 'constraints adapted');

  // ------------------------------------------------------------------ 2.
  const securityPick = engine.selectForProfile({ goal: 'x', requiredCapabilities: ['security'] });
  assert.strictEqual(securityPick!.agent.name, 'Reviewer', 'security capability filter');

  // ------------------------------------------------------------------ 3.
  const analystPick = engine.selectForProfile({ goal: 'x', preferredRole: 'analyst' });
  assert.strictEqual(analystPick!.agent.name, 'Analyst', 'role filter + coverage tie-break');

  // ------------------------------------------------------------------ 4.
  const delegationTester = engine.selectForProfile({ goal: 'run the tests', kind: 'delegation' });
  assert.strictEqual(delegationTester!.agent.name, 'TesterOnly', 'delegation scope filter');
  const missionTester = engine.selectForProfile({ goal: 'run the tests', kind: 'mission' });
  assert.strictEqual(missionTester!.agent.name, 'MissionTester', 'mission scope filter');
  const backgroundTester = engine.selectForProfile({ goal: 'run the tests', kind: 'background' });
  assert.strictEqual(backgroundTester!.agent.name, 'BackgroundTester', 'background scope filter');
  const scheduledTester = engine.selectForProfile({ goal: 'run the tests', kind: 'scheduled' });
  assert.strictEqual(scheduledTester!.agent.name, 'ScheduledTester', 'scheduled scope filter');

  // ------------------------------------------------------------------ 5.
  const auditPick = engine.selectForProfile({ goal: 'x', requiredTools: ['audit'] });
  assert.strictEqual(auditPick!.agent.name, 'Reviewer', 'required tool filter');

  const applyPatchCandidates = engine.candidatesForProfile({ goal: 'x', requiredTools: ['apply_patch'] })
    .map(r => r.agent.name).sort();
  assert.deepStrictEqual(
    applyPatchCandidates,
    ['BroadCoder', 'Coder'],
    'deniedTools/allowedTools exclude ToolDenied and Restricted'
  );

  // ------------------------------------------------------------------ 6.
  const workspaceCandidates = engine.candidatesForProfile({
    goal: 'x',
    workspace: 'C:/work',
    requiredCapabilities: ['analysis']
  }).filter(r => r.selected).map(r => r.agent.name);
  assert.deepStrictEqual(workspaceCandidates, ['Analyst'], 'workspace grants exclude WorkspaceBound');
  const workspaceAll = engine.candidatesForProfile({
    goal: 'x',
    workspace: 'C:/work',
    requiredCapabilities: ['analysis']
  });
  assert.strictEqual(
    workspaceAll.find(r => r.agent.name === 'WorkspaceBound'),
    undefined,
    'workspace grant excludes WorkspaceBound even when capable'
  );

  // ------------------------------------------------------------------ 7.
  const taskPick = engine.selectForTask(task);
  assert.strictEqual(taskPick!.agent.name, 'Reviewer', 'selectForTask via adapted profile');
  const taskIdPick = engine.selectForTaskId(task.id);
  assert.strictEqual(taskIdPick!.agent.name, 'Reviewer', 'selectForTaskId via taskEngine');

  // ------------------------------------------------------------------ 8.
  const codePick = engine.selectForProfile({ goal: 'x', requiredCapabilities: ['coding', 'typescript'] });
  assert.strictEqual(codePick!.agent.name, 'BroadCoder', 'coverage wins over name');
  const again = engine.selectForProfile({ goal: 'x', requiredCapabilities: ['coding', 'typescript'] });
  assert.strictEqual(again!.agent.name, 'BroadCoder', 'deterministic across calls');

  // ------------------------------------------------------------------ 9.
  const excluded = engine.selectForProfile(
    { goal: 'x', requiredCapabilities: ['security'] },
    { exclude: ['Reviewer'] }
  );
  assert.strictEqual(excluded, null, 'exclude removes the only candidate');
  const noMatch = engine.selectForProfile({ goal: 'x', requiredCapabilities: ['nonexistent-cap'] });
  assert.strictEqual(noMatch, null, 'no candidate for unknown capability');
  const unknownTask = engine.selectForTaskId('missing-task');
  assert.strictEqual(unknownTask, null, 'unknown task id yields null');

  console.log('\n{"success":true}');
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});