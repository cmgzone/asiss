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

  const models = new Map<string, any>([
    ['stub-math', mathModel],
    ['stub-denial', denialModel]
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
  console.log('\n{"success":true,"turns":' + (child.timing.turns || 0) + '}');
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
