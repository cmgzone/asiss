/**
 * Phase 13 Step 3 — delegated execution acceptance smoke.
 *
 * PROVES: a delegated agent completes a real child Task through the canonical
 * pipeline (TaskEngine + ToolEngine + PolicyEngine) WITHOUT runChildLoop()
 * being involved. runChildLoop (delegate-agent.ts) is never imported here —
 * there is no second execution authority.
 *
 * Acceptance gate (docs/hermes/CHILD_LOOP_MIGRATION_MAP.md §"Acceptance gate"):
 *   1. Child Task reaches COMPLETED with outcome SUCCESS (engine-owned).
 *   2. timing.turns > 0 — the multi-turn turn contract drove the mission.
 *   3. Tool calls route through ToolEngine with ctx.taskId: the ToolExecution
 *      is recorded on the child Task (STARTED -> COMPLETED).
 *   4. ctx.agentPermissions is populated from the canonical Agent: a tool
 *      outside the agent's grants is DENIED by PolicyEngine's
 *      agent-permissions rule (previously dead plumbing — now live).
 *   5. AgentEngine returns a canonical AgentResult (evidence, not "Done").
 *   6. The child Task is a subtask of the parent (parent.subtasks includes it).
 *   7. The agent lifecycle moved ASSIGNED -> AVAILABLE across the run.
 *   8. (Step 8) The canonical AgentResult is registered as a task artifact.
 *   9. (Step 7) modelPolicy.fallbackModelIds is honored: a pinned model that
 *      fails falls through to the declared fallback and the mission completes.
 *   10. (Step 9) Hosts can label the child Task kind — swarm jobs run as
 *      canonical kind-'swarm' Tasks on the same engine path.
 *   11. (Step 9.3) Scheduled jobs run as canonical kind-'scheduled' Tasks
 *      with schedulerJobId linkage on the child Task.
 *
 * Run: npm run smoke:agent-execution
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

interface StubModelOptions {
  /** Tool the model requests on its first (tool) turn. */
  toolToCall: string;
  toolArguments: Record<string, unknown>;
  /** Final report JSON the model returns on its second turn. */
  reportJson: string;
}

/** Model that always throws (network-style) — proves Step 7 fallback. */
class FailingModel {
  calls = 0;
  readonly id: string;
  readonly name: string;
  constructor() {
    this.id = 'stub-fail';
    this.name = 'StubFail';
  }

  async generate() {
    this.calls += 1;
    throw new Error('Network error from stub model');
  }
}

/** Scripted model: turn 1 = one tool call, turn 2 = final JSON report. */
class StubModel {
  calls = 0;
  readonly id: string;
  readonly name: string;
  constructor(readonly options: StubModelOptions) {
    this.id = 'stub';
    this.name = 'Stub';
  }

  async generate() {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        content: '',
        toolCalls: [
          { id: 'call_1', name: this.options.toolToCall, arguments: this.options.toolArguments }
        ]
      };
    }
    return { content: this.options.reportJson };
  }
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitu-agent-execution-'));
  process.chdir(tempDir);
  fs.writeFileSync('SOUL.md', '# Test Soul\n');
  fs.writeFileSync('AGENTS.md', '# Test Workspace\n');
  fs.writeFileSync('USER.md', '# Test User\n');
  fs.writeFileSync('config.json', JSON.stringify({ agent: {} }, null, 2));
  process.env.GITU_DATA_ROOT = path.join(tempDir, 'gitu-data');

  const { AgentEngine } = await import('../src/core/agent/agent-engine');
  const { agentRegistry } = await import('../src/core/agent/agent-registry');
  const { taskEngine } = await import('../src/core/task');
  const { ToolEngine } = await import('../src/core/tools');
  const { SkillRegistry } = await import('../src/core/skills');

  // ------------------------------------------------------------ tool fixtures
  // Native skills with a plain-object result (no filesystem, no eval).
  const mathSkill = {
    name: 'math_eval',
    description: 'Evaluate a simple math expression',
    inputSchema: { type: 'object', properties: { expression: { type: 'string' } } },
    async execute(args: any) {
      const expression = String(args.expression || '').trim();
      if (expression === '2+2') return { result: 4, expression };
      return { result: null, expression, error: 'Unknown expression' };
    }
  };
  const dangerSkill = {
    name: 'dangerous_op',
    description: 'A tool outside the child agent grants (must be denied by policy)',
    async execute() {
      return { result: 'boom' };
    }
  };

  // Real SkillRegistry so the tool surface is the same one the model sees.
  SkillRegistry.register(mathSkill);
  SkillRegistry.register(dangerSkill);

  const skills = { get: (n: string) => SkillRegistry.get(n), getAll: () => SkillRegistry.getAll() };

  const mcp = { callTool: async () => ({}), getKnownToolNames: () => [] as string[] };
  const dynamicTools = {
    resolve: async () => ({ success: false, error: 'not available' }),
    normalizeName: () => null as string | null
  };

  const toolEngine = new ToolEngine({ skills, mcp, dynamicTools });

  // ------------------------------------------------------------ model fixtures
  const mathModel = new StubModel({
    toolToCall: 'math_eval',
    toolArguments: { expression: '2+2' },
    reportJson: JSON.stringify({
      taskId: 'child-ignored',
      status: 'completed',
      summary: 'Calculated 2+2 = 4.',
      workDone: ['Evaluated expression 2+2'],
      filesChanged: [],
      evidence: ['Tool math_eval output: {"result":4}'],
      risks: [],
      nextSteps: []
    })
  });

  const denialModel = new StubModel({
    toolToCall: 'dangerous_op',
    toolArguments: {},
    reportJson: JSON.stringify({
      taskId: 'child-ignored',
      status: 'completed',
      summary: 'Reported despite denied tool call.',
      workDone: ['Attempted dangerous_op; policy refused'],
      filesChanged: [],
      evidence: ['PolicyEngine agent-permissions DENY recorded on task'],
      risks: [],
      nextSteps: []
    })
  });
  const failModel = new FailingModel();

  const models = new Map<string, any>([
    ['stub-math', mathModel],
    ['stub-denial', denialModel],
    ['stub-fail', failModel]
  ]);

  // ------------------------------------------------------------ wiring
  const engine = new AgentEngine();
  engine.configure({
    getModelById: (id?: string) => {
      const found = id ? models.get(id) : undefined;
      if (found) return found;
      throw new Error(`Unknown model: ${id}`);
    },
    getDefaultModel: () => mathModel,
    listMcpTools: async () => [],
    toolEngine,
    taskEngine
  });

  // Canonical agents: math agent (granted math_eval), locked agent (granted
  // math_eval only — dangerous_op must be denied by the agent-permissions rule).
  agentRegistry.register({
    name: 'MathBot',
    role: 'analyst',
    description: 'Evaluates math expressions',
    capabilities: ['math', 'analysis'],
    tools: ['math_eval'],
    modelPolicy: { modelId: 'stub-math' }
  });
  agentRegistry.register({
    name: 'LockedBot',
    role: 'analyst',
    description: 'Agent whose tool grants exclude dangerous_op',
    capabilities: ['math', 'analysis'],
    tools: ['math_eval'],
    modelPolicy: { modelId: 'stub-denial' }
  });
  agentRegistry.register({
    name: 'FallbackBot',
    role: 'analyst',
    description: 'Agent whose pinned model fails and must fall back to the declared fallback',
    capabilities: ['math', 'analysis'],
    tools: ['math_eval'],
    modelPolicy: { modelId: 'stub-fail', fallbackModelIds: ['stub-math'] }
  });

  // ------------------------------------------------------------ 1. happy path
  const parent = await taskEngine.create({
    goal: 'Calculate 2+2.',
    kind: 'mission',
    constraints: { maxTurns: 2 }
  });

  const exec = await engine.executeTask({
    agentId: 'MathBot',
    task: 'Evaluate 2+2 and report.',
    expectedOutput: '4',
    maxTurns: 2,
    parentTaskId: parent.id,
    sessionId: 's1'
  });

  assert.strictEqual(exec.success, true, `delegation succeeded (${exec.error || ''})`);
  assert.strictEqual(exec.attempts, 1, 'one attempt on success');

  // 1a. engine-owned terminal state: child Task COMPLETED + SUCCESS outcome
  const child = taskEngine.get(exec.taskId!)!;
  assert.ok(child, 'child task exists');
  assert.strictEqual(child.status, 'COMPLETED', `child task COMPLETED (got ${child.status})`);
  assert.strictEqual(child.outcome?.status, 'SUCCESS', 'outcome SUCCESS');
  assert.strictEqual(child.kind, 'delegation', 'child kind is delegation');

  // 1b. multi-turn turn contract drove the mission
  assert.ok((child.timing.turns || 0) >= 2, `turns recorded (got ${child.timing.turns})`);

  // 1c. ToolEngine route: execution recorded on the child Task
  const execs = child.toolExecutions.filter((t) => t.name === 'math_eval');
  assert.strictEqual(execs.length, 1, 'math_eval recorded on child task');
  assert.strictEqual(execs[0].status, 'COMPLETED', 'tool execution COMPLETED');
  assert.ok(String(execs[0].output || '').includes('4'), 'tool output recorded');

  // 1d. canonical AgentResult — evidence, not "Done"
  assert.strictEqual(exec.result.status, 'completed', 'result status completed');
  assert.ok(exec.result.summary.includes('4'), 'summary carries the answer');
  assert.deepStrictEqual(exec.result.findings, ['Evaluated expression 2+2'], 'findings from report');
  assert.ok(exec.result.evidence.some((e) => e.includes('math_eval')), 'evidence preserved');

  // 1e. parent linkage (re-fetch: the returned snapshot predates the child)
  const parentAfter = taskEngine.get(parent.id)!;
  assert.ok(parentAfter.subtasks.includes(child.id), 'child registered as subtask of parent');

  // 1f. lifecycle ASSIGNED -> AVAILABLE
  const after = agentRegistry.get('MathBot')!;
  assert.strictEqual(after.status, 'AVAILABLE', 'agent released after run');

  // 1g. Step 8: the canonical AgentResult is registered as a task artifact
  const resultArtifacts = child.artifacts.filter((a) => a.kind === 'agent-result');
  assert.ok(resultArtifacts.length >= 1, 'agent-result artifact recorded on child task');
  assert.ok(String(resultArtifacts[0].summary || '').includes('4'), 'artifact carries the result summary');

  // ------------------------------------------------------------ 2. policy denial
  // The model requests dangerous_op, which is NOT in LockedBot's grants.
  // PolicyEngine's agent-permissions rule (previously dead plumbing) denies it;
  // the ToolExecution is recorded FAILED on the task, and the mission continues
  // to a completed report — policy refused the call without crashing the loop.
  const parent2 = await taskEngine.create({ goal: 'Try dangerous op.', kind: 'mission' });
  const deniedExec = await engine.executeTask({
    agentId: 'LockedBot',
    task: 'Attempt the dangerous operation and report.',
    maxTurns: 2,
    parentTaskId: parent2.id
  });

  assert.strictEqual(deniedExec.success, true, 'denied tool does not abort the mission');
  assert.strictEqual(deniedExec.result.status, 'completed', 'report still completes');

  const child2 = taskEngine.get(deniedExec.taskId!)!;
  const deniedRecord = child2.toolExecutions.find((t) => t.name === 'dangerous_op');
  assert.ok(deniedRecord, 'dangerous_op execution recorded');
  assert.strictEqual(deniedRecord.status, 'FAILED', 'denied tool recorded FAILED on the task');
  assert.ok(String(deniedRecord.error || '').includes('agent'), 'denial reason recorded');

  // ------------------------------------------------------------ 3. no second authority
  // runChildLoop() (delegate-agent.ts) is never imported or invoked in this
  // process. The delegated agent completed its task through TaskEngine +
  // ToolEngine + PolicyEngine alone.

  // ------------------------------------------------------------ 4. Step 7 — model fallback
  // FallbackBot pins a model that throws on every call but declares stub-math
  // as a fallback; the child mission must complete through the fallback
  // provider instead of failing the attempt.
  const fallbackParent = await taskEngine.create({ goal: 'Fallback math.', kind: 'mission' });
  const fallbackExec = await engine.executeTask({
    agentId: 'FallbackBot',
    task: 'Evaluate 2+2 and report via the fallback model.',
    maxTurns: 2,
    parentTaskId: fallbackParent.id
  });
  assert.strictEqual(fallbackExec.success, true, `fallback model completes the mission (${fallbackExec.error || ''})`);
  assert.ok(failModel.calls > 0, 'pinned model was attempted before falling back');
  const fallbackChild = taskEngine.get(fallbackExec.taskId!)!;
  assert.strictEqual(fallbackChild.outcome?.status, 'SUCCESS', 'fallback mission SUCCESS');

  // ------------------------------------------------------------ 5. Step 9 — swarm kind
  // Hosts label the child Task kind; swarm jobs run as canonical kind-'swarm'
  // Tasks on the same engine path (the runner's swarm executor passes __kind).
  const swarmParent = await taskEngine.create({ goal: 'Swarm math.', kind: 'mission' });
  const swarmExec = await engine.executeTask({
    agentId: 'MathBot',
    task: 'Evaluate 2+2 for the swarm.',
    kind: 'swarm',
    maxTurns: 2,
    parentTaskId: swarmParent.id
  });
  assert.strictEqual(swarmExec.success, true, `swarm-kind delegation succeeded (${swarmExec.error || ''})`);
  const swarmChild = taskEngine.get(swarmExec.taskId!)!;
  assert.strictEqual(swarmChild.kind, 'swarm', 'child task kind is swarm');

  // ------------------------------------------------------------ 6. Step 9 — background kind
  // Background goals run as canonical kind-'background' Tasks; host linkage
  // metadata (backgroundGoalId) rides on the child Task so the canonical
  // record points back to background_goals.json.
  const bgParent = await taskEngine.create({ goal: 'Background math.', kind: 'mission' });
  const bgExec = await engine.executeTask({
    agentId: 'MathBot',
    task: 'Evaluate 2+2 for the background goal.',
    kind: 'background',
    metadata: { backgroundGoalId: 'bg-test-1', backgroundGoalTitle: 'Math check' },
    maxTurns: 2,
    parentTaskId: bgParent.id
  });
  assert.strictEqual(bgExec.success, true, `background-kind delegation succeeded (${bgExec.error || ''})`);
  const bgChild = taskEngine.get(bgExec.taskId!)!;
  assert.strictEqual(bgChild.kind, 'background', 'child task kind is background');
  assert.strictEqual(bgChild.metadata?.backgroundGoalId, 'bg-test-1', 'background goal id linked on the task');
  assert.strictEqual(bgChild.metadata?.backgroundGoalTitle, 'Math check', 'background goal title linked on the task');

  // ------------------------------------------------------------ 7. Step 9.3 — scheduled kind
  // Scheduled jobs run as canonical kind-'scheduled' Tasks; the scheduler job
  // id rides on the child Task metadata so the canonical record points back
  // to scheduler.json.
  const schedParent = await taskEngine.create({ goal: 'Scheduled math.', kind: 'mission' });
  const schedExec = await engine.executeTask({
    agentId: 'MathBot',
    task: 'Evaluate 2+2 at the scheduled time.',
    kind: 'scheduled',
    metadata: { schedulerJobId: 'job-1', schedulerJobType: 'agent_prompt' },
    maxTurns: 2,
    parentTaskId: schedParent.id
  });
  assert.strictEqual(schedExec.success, true, `scheduled-kind delegation succeeded (${schedExec.error || ''})`);
  const schedChild = taskEngine.get(schedExec.taskId!)!;
  assert.strictEqual(schedChild.kind, 'scheduled', 'child task kind is scheduled');
  assert.strictEqual(schedChild.metadata?.schedulerJobId, 'job-1', 'scheduler job id linked on the task');
  assert.strictEqual(schedChild.metadata?.schedulerJobType, 'agent_prompt', 'scheduler job type linked on the task');

  console.log('\n{"success":true,"turns":' + (child.timing.turns || 0) + '}');
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
