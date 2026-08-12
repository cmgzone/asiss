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
import { ContextEngine } from '../src/core/context';

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
  /** System prompt of the last generate() call — lets smokes assert the
   *  child context (Phase 18 Move 4: the repository section). */
  lastSystemPrompt?: string;
  readonly id: string;
  readonly name: string;
  constructor(readonly options: StubModelOptions) {
    this.id = 'stub';
    this.name = 'Stub';
  }

  async generate(_prompt?: string, systemPrompt?: string) {
    this.calls += 1;
    this.lastSystemPrompt = systemPrompt;
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

  // ------------------------------------------------------------ 12. Phase 16 Move 3 — D1 removal
  // The runner's swarm executor has NO fallback execution path: if
  // delegate_agent is unavailable it logs loudly and THROWS instead of running
  // an untracked model.generate (no Task, no ToolEngine, no events, no
  // evidence). The swarm store's runAgent catch marks the task failed with the
  // error message, keeping swarm_data.json authoritative for swarm statuses —
  // the exact failure contract the removal relies on.
  const { agentSwarm } = await import('../src/core/agent-swarm');
  const fragAgent = agentSwarm.createAgent('FragBot', 'general', 'fragment guard', 'stub-model');
  agentSwarm.setExecutor(async () => {
    throw new Error(
      '[AgentRunner] delegate_agent skill is unavailable — cannot run swarm agent outside the canonical Task lifecycle.'
    );
  });
  agentSwarm.assignTask(fragAgent.id, 'Prove the D1 fragment is gone.');
  const fragResults = await agentSwarm.runAgent(fragAgent.id);
  assert.strictEqual(fragResults.length, 1, 'one swarm result');
  assert.strictEqual(fragResults[0].success, false, 'unavailable delegate fails the swarm task');
  assert.ok(
    String(fragResults[0].output).includes('delegate_agent skill is unavailable'),
    'loud failure message reaches the swarm result (no silent bare model.generate)'
  );
  const fragAgentAfter = agentSwarm.getAgent(fragAgent.id)!;
  assert.ok(
    fragAgentAfter.status === 'idle' || fragAgentAfter.status === 'completed',
    'swarm agent released from working after the failed run'
  );

  // ------------------------------------------------------------ 13. Phase 16 Move 4 — policies
  // (AUDIT_7 D2/D5): the child context assembles from the agent's
  // contextPolicy sources. 'memory' injects the unified-memory section per
  // memoryPolicy through the runtime retrieveMemory hook (policy decides, the
  // memory system executes — no new engine); 'attempts' feeds prior
  // failed-attempt outcomes to later attempts. executionLimits.maxAttempts
  // (Move 2) drives the two-attempt run.
  const move4Model = {
    id: 'move4-model',
    name: 'Move4 Model',
    calls: 0,
    systemPrompts: [] as string[],
    prompts: [] as string[],
    async generate(prompt: string, systemPrompt?: string) {
      this.calls += 1;
      this.systemPrompts.push(systemPrompt || '');
      this.prompts.push(prompt);
      if (this.calls === 1) {
        return {
          content: JSON.stringify({
            status: 'failed',
            summary: 'First attempt lacked context.',
            workDone: [], filesChanged: [], evidence: [], risks: [], nextSteps: [], finalOutput: ''
          })
        };
      }
      return {
        content: JSON.stringify({
          status: 'completed',
          summary: 'Second attempt succeeded with memory + prior-outcome context.',
          workDone: ['completed'], filesChanged: [], evidence: ['context injected'], risks: [], nextSteps: [], finalOutput: 'done'
        })
      };
    }
  };
  const policyEngine = new AgentEngine();
  policyEngine.configure({
    getModelById: () => move4Model as any,
    getDefaultModel: () => move4Model as any,
    listMcpTools: async () => [],
    toolEngine: { execute: async () => ({ success: false, error: 'unused' }) } as any,
    taskEngine,
    retrieveMemory: async (_query: string, _opts: any) => [
      {
        id: 'learning:rule-9',
        type: 'procedural',
        source: 'learning',
        scope: 'agent',
        importance: 3,
        confidence: 0.87,
        lifecycle: 'active',
        content: 'Verify after mutating files.',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        score: 0.91,
        scoreBreakdown: { semantic: undefined, lexical: 0.91, importance: 3, confidence: 0.87, recency: 1, access: 0 }
      } as any
    ]
  });
  agentRegistry.register({
    name: 'PolicyBot',
    role: 'general',
    description: 'Agent carrying full Move 4 policies.',
    capabilities: ['general'],
    instructions: 'Use context deliberately.',
    contextPolicy: { sources: ['task', 'instructions', 'history', 'memory', 'attempts'] },
    memoryPolicy: { injectLimit: 3, minScore: 0.5, types: ['procedural'], sources: ['learning'] },
    executionLimits: { maxTurns: 3, maxAttempts: 2 }
  });
  const policyRun = await policyEngine.executeTask({
    agentId: 'PolicyBot',
    task: 'Fix the flaky test.',
    sessionId: 'move4-session'
  });
  assert.strictEqual(policyRun.success, true, 'policy agent succeeds on the second attempt');
  assert.strictEqual(policyRun.attempts, 2, 'executionLimits.maxAttempts produced two attempts');
  assert.ok(
    move4Model.systemPrompts[0].includes('Memory context (unified):'),
    'child system prompt carries the unified-memory section'
  );
  assert.ok(
    move4Model.systemPrompts[0].includes('Verify after mutating files.'),
    'memory records render in the child system prompt'
  );
  assert.ok(
    move4Model.systemPrompts[0].includes('(87% confidence)'),
    'procedural confidence renders in the memory section'
  );
  assert.ok(
    move4Model.prompts[1].includes('Previous attempts:') && move4Model.prompts[1].includes('Attempt 1: First attempt lacked context.'),
    'prior failed-attempt outcome feeds the second attempt (attempts source)'
  );

  // ------------------------------------------------------------ 14. Phase 16 Move 5 — handoffPolicy
  // (AUDIT_7 Move 5): AgentEngine.executeTask enforces the delegating agent's
  // handoffPolicy — allowDelegation gates delegation at all, allowedRoles
  // restricts the target's role, maxDepth bounds the chain originating from
  // each ancestor. The delegator is the parent Task's assignedAgent; refusals
  // fail clearly and never create a child Task.
  const hfModel = {
    id: 'hf-probe',
    name: 'HF Probe',
    async generate() {
      return {
        content: JSON.stringify({
          status: 'completed',
          summary: 'Handoff allowed.',
          workDone: ['completed'], filesChanged: [], evidence: [], risks: [], nextSteps: [], finalOutput: 'done'
        })
      };
    }
  };
  const hfEngine = new AgentEngine();
  hfEngine.configure({
    getModelById: () => hfModel as any,
    getDefaultModel: () => hfModel as any,
    listMcpTools: async () => [],
    toolEngine: { execute: async () => ({ success: false, error: 'unused' }) } as any,
    taskEngine
  });
  const rootBot = agentRegistry.register({
    name: 'RootBot', role: 'general', description: 'Root delegator with a strict handoff policy.',
    capabilities: ['general'], tools: [], modelPolicy: { modelId: 'hf-probe' },
    handoffPolicy: { allowDelegation: true, allowedRoles: ['analyst'], maxDepth: 1 }
  });
  agentRegistry.register({
    name: 'ChildAnalyst', role: 'analyst', description: 'Allowed analyst target.',
    capabilities: ['analysis'], tools: [], modelPolicy: { modelId: 'hf-probe' }
  });
  agentRegistry.register({
    name: 'CoderTarget', role: 'coder', description: 'Role outside RootBot allowedRoles.',
    capabilities: ['coding'], tools: [], modelPolicy: { modelId: 'hf-probe' }
  });
  agentRegistry.register({
    name: 'GrandBot', role: 'analyst', description: 'Depth-2 target under RootBot maxDepth 1.',
    capabilities: ['analysis'], tools: [], modelPolicy: { modelId: 'hf-probe' }
  });
  const noDelegBot = agentRegistry.register({
    name: 'NoDelegBot', role: 'general', description: 'Delegator that forbids delegation.',
    capabilities: ['general'], tools: [], modelPolicy: { modelId: 'hf-probe' },
    handoffPolicy: { allowDelegation: false }
  });
  const rootMission = await taskEngine.create({
    goal: 'Root mission', kind: 'mission', assignedAgent: rootBot.id
  });
  // 14a. allowedRoles: RootBot may only hand off to analysts.
  const roleRefused = await hfEngine.executeTask({
    agentId: 'CoderTarget', task: 'Code something.', parentTaskId: rootMission.id, sessionId: 'move5-session'
  });
  assert.strictEqual(roleRefused.success, false, 'target outside allowedRoles is refused');
  assert.ok(String(roleRefused.error).includes('may only hand off to roles'), 'role refusal names the policy');
  // 14b. Allowed handoff (analyst, depth 1) succeeds; depth-2 from RootBot fails.
  const depthOk = await hfEngine.executeTask({
    agentId: 'ChildAnalyst', task: 'Analyze something.', parentTaskId: rootMission.id, sessionId: 'move5-session'
  });
  assert.strictEqual(depthOk.success, true, 'analyst handoff allowed (role + depth 1)');
  const depthRefused = await hfEngine.executeTask({
    agentId: 'GrandBot', task: 'Go deeper.', parentTaskId: depthOk.taskId, sessionId: 'move5-session'
  });
  assert.strictEqual(depthRefused.success, false, 'depth beyond RootBot maxDepth 1 is refused');
  assert.ok(String(depthRefused.error).includes('maxDepth'), 'depth refusal names maxDepth');
  // 14c. allowDelegation=false gates delegation entirely.
  const noDelegParent = await taskEngine.create({
    goal: 'No-deleg mission', kind: 'mission', assignedAgent: noDelegBot.id
  });
  const delegRefused = await hfEngine.executeTask({
    agentId: 'ChildAnalyst', task: 'Anything.', parentTaskId: noDelegParent.id, sessionId: 'move5-session'
  });
  assert.strictEqual(delegRefused.success, false, 'delegation from an agent that disallows it is refused');
  assert.ok(String(delegRefused.error).includes('does not allow delegation'), 'refusal names allowDelegation');

  // ------------------------------------------------------------ 15. Phase 18 Move 4 — child repo context ('repo' source)
  // (AUDIT_9 G3): the deferred 'repo' ContextPolicy source is live — a child
  // agent whose contextPolicy includes 'repo' gets the warmed, goal-matched
  // repository section in its system prompt; an agent without the source
  // gets none (control).
  {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gitu-child-repo-'));
    const repoData = fs.mkdtempSync(path.join(os.tmpdir(), 'gitu-child-repo-data-'));
    try {
      fs.mkdirSync(path.join(repoRoot, 'src', 'auth'), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, 'src/auth/auth.ts'), 'export function authenticate() { return true; }\n');
      fs.writeFileSync(path.join(repoRoot, 'src/auth/auth.test.ts'), 'test("auth works", () => {});\n');
      const ctxEngine = new ContextEngine({ config: { repository: { dataRoot: repoData } } });

      const repoModel = new StubModel({
        toolToCall: 'math_eval',
        toolArguments: { expression: '2+2' },
        reportJson: JSON.stringify({
          taskId: 'c', status: 'completed', summary: 'done', workDone: [], filesChanged: [], evidence: [], risks: [], nextSteps: []
        })
      });
      const controlModel = new StubModel({
        toolToCall: 'math_eval',
        toolArguments: { expression: '2+2' },
        reportJson: JSON.stringify({
          taskId: 'c', status: 'completed', summary: 'done', workDone: [], filesChanged: [], evidence: [], risks: [], nextSteps: []
        })
      });
      models.set('stub-repo', repoModel);
      models.set('stub-norepo', controlModel);
      agentRegistry.register({
        name: 'RepoBot', role: 'analyst', description: 'Child agent with the repo context source enabled.',
        capabilities: ['math', 'analysis'], tools: ['math_eval'], modelPolicy: { modelId: 'stub-repo' },
        contextPolicy: { sources: ['task', 'instructions', 'history', 'repo'] }
      });
      agentRegistry.register({
        name: 'NoRepoBot', role: 'analyst', description: 'Child agent without the repo source (control).',
        capabilities: ['math', 'analysis'], tools: ['math_eval'], modelPolicy: { modelId: 'stub-norepo' },
        contextPolicy: { sources: ['task', 'instructions', 'history'] }
      });
      const repoEngine = new AgentEngine();
      repoEngine.configure({
        getModelById: (id?: string) => {
          const found = id ? models.get(id) : undefined;
          if (found) return found;
          throw new Error(`Unknown model: ${id}`);
        },
        getDefaultModel: () => repoModel,
        listMcpTools: async () => [],
        toolEngine,
        taskEngine,
        contextEngine: ctxEngine
      });

      const repoParent = await taskEngine.create({ goal: 'Fix authentication.', kind: 'mission', constraints: { maxTurns: 2 } });
      const withRepo = await repoEngine.executeTask({
        agentId: 'RepoBot', task: 'Fix the authentication flow and report.', expectedOutput: 'fixed',
        maxTurns: 2, parentTaskId: repoParent.id, sessionId: 'move4-repo-session', workspacePath: repoRoot
      });
      assert.strictEqual(withRepo.success, true, 'repo-context delegation succeeds');
      assert.ok(repoModel.lastSystemPrompt?.includes('Repository context:'), 'repo source renders the repository section');
      assert.ok(repoModel.lastSystemPrompt!.includes('src/auth/auth.ts'), 'repo section names the goal-matched file');

      const controlParent = await taskEngine.create({ goal: 'Fix authentication.', kind: 'mission', constraints: { maxTurns: 2 } });
      const withoutRepo = await repoEngine.executeTask({
        agentId: 'NoRepoBot', task: 'Fix the authentication flow and report.', expectedOutput: 'fixed',
        maxTurns: 2, parentTaskId: controlParent.id, sessionId: 'move4-norepo-session', workspacePath: repoRoot
      });
      assert.strictEqual(withoutRepo.success, true, 'control delegation succeeds');
      assert.ok(!(controlModel.lastSystemPrompt || '').includes('Repository context:'), 'no repo section without the repo source');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(repoData, { recursive: true, force: true });
    }
  }

  console.log('\n{"success":true,"turns":' + (child.timing.turns || 0) + ',"childRepoContext":true}');
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
