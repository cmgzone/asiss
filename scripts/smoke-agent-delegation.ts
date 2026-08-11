import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert';

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitu-agent-delegation-'));
  process.chdir(tempDir);

  const { customAgentManager } = await import('../src/core/custom-agents');
  const { agentRunManager } = await import('../src/core/agent-run-manager');
  const { SkillRegistry } = await import('../src/core/skills');
  const { DelegateAgentSkill } = await import('../src/skills/delegate-agent');

  let activeParallelTools = 0;
  let maxActiveParallelTools = 0;
  SkillRegistry.register({
    name: 'smoke_echo',
    description: 'Echoes a smoke-test payload.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' }
      }
    },
    execute: async (params: any) => ({
      echoed: params.text,
      proof: 'tool loop executed'
    })
  });

  let modelTurns = 0;
  const fakeModel = {
    id: 'fake-smoke-model',
    name: 'Fake Smoke Model',
    generate: async () => {
      modelTurns += 1;
      if (modelTurns === 1) {
        return {
          content: null,
          toolCalls: [
            {
              id: 'call-1',
              name: 'smoke_echo',
              arguments: { text: 'delegation proof' }
            }
          ]
        };
      }

      return {
        content: JSON.stringify({
          taskId: 'model-filled-by-manager',
          agentId: 'model-filled-by-manager',
          status: 'completed',
          summary: 'The custom agent used the smoke tool and produced reviewed output.',
          workDone: ['Created a custom child agent', 'Delegated the task', 'Called smoke_echo', 'Prepared final output'],
          filesChanged: [],
          toolCalls: [],
          evidence: ['smoke_echo returned "tool loop executed"'],
          risks: [],
          nextSteps: [],
          finalOutput: 'Reviewed child output: delegation proof'
        })
      };
    }
  };

  const delegate = new DelegateAgentSkill({
    getModelById: () => fakeModel,
    getDefaultModel: () => fakeModel,
    listMcpTools: async () => [],
    callMcpTool: async () => {
      throw new Error('No MCP tools expected in smoke test.');
    }
  });

  const agent = customAgentManager.createAgent({
    name: 'Smoke Delegate',
    displayName: 'Smoke Delegate',
    description: 'Smoke-test child agent',
    persona: 'You are a smoke-test child agent. Use tools when needed and return structured reports.',
    skills: ['smoke_echo']
  });

  assert(customAgentManager.getAgent(agent.id), 'custom agent can be created');

  const result = await delegate.execute({
    agentId: agent.id,
    task: 'Use the smoke tool and report the result.',
    expectedOutput: 'A reviewed final output mentioning delegation proof.',
    allowedTools: ['smoke_echo'],
    maxTurns: 4,
    reviewCriteria: ['tool was called', 'report is structured'],
    retries: 0,
    __sessionId: 'smoke-session'
  });

  assert.strictEqual(result.success, true, 'main agent delegates task successfully');
  assert(result.report, 'main agent receives report');
  assert.strictEqual(result.report.status, 'completed', 'child report completed');
  assert(result.report.finalOutput.includes('delegation proof'), 'final answer includes reviewed output');
  assert(result.report.toolCalls.some((call: any) => call.name === 'smoke_echo' && call.success), 'child tool call is recorded');

  const savedRun = agentRunManager.getRun(result.taskId);
  assert(savedRun?.report, 'child report is saved in manager');
  assert(fs.existsSync(path.join(tempDir, 'agent_runs.json')), 'agent_runs.json is written');

  const reviewPrompt = agentRunManager.buildReviewPrompt('smoke-session');
  assert(reviewPrompt.includes('Reviewed child output: delegation proof'), 'main agent review prompt includes child output');

  SkillRegistry.register({
    name: 'slow_probe',
    description: 'Waits briefly and returns evidence for parallel delegation testing.',
    inputSchema: { type: 'object', properties: { label: { type: 'string' } } },
    execute: async (params: any) => {
      activeParallelTools += 1;
      maxActiveParallelTools = Math.max(maxActiveParallelTools, activeParallelTools);
      await new Promise(resolve => setTimeout(resolve, 300));
      activeParallelTools -= 1;
      return { label: params.label, proof: 'parallel child tool completed' };
    }
  });

  const parallelTurns = new Map<string, number>();
  const parallelModel = {
    id: 'parallel-smoke-model',
    name: 'Parallel Smoke Model',
    generate: async (prompt: string) => {
      const label = prompt.includes('parallel alpha') ? 'alpha' : 'beta';
      const turn = (parallelTurns.get(label) || 0) + 1;
      parallelTurns.set(label, turn);
      if (turn === 1) {
        return {
          content: null,
          toolCalls: [{ id: `slow-${label}`, name: 'slow_probe', arguments: { label } }]
        };
      }
      return {
        content: JSON.stringify({
          status: 'completed',
          summary: `${label} completed`,
          workDone: [`Ran ${label} independently`],
          filesChanged: [],
          toolCalls: [],
          evidence: ['parallel child tool completed'],
          risks: [],
          nextSteps: [],
          finalOutput: `${label} result`
        })
      };
    }
  };

  const parallelDelegate = new DelegateAgentSkill({
    getModelById: () => parallelModel,
    getDefaultModel: () => parallelModel,
    listMcpTools: async () => [],
    callMcpTool: async () => { throw new Error('No MCP tools expected in parallel smoke test.'); }
  });
  const parallelAgent = customAgentManager.createAgent({
    name: 'Parallel Delegate',
    displayName: 'Parallel Delegate',
    description: 'Runs independent child tasks concurrently.',
    persona: 'Complete the delegated task and return evidence.',
    skills: ['slow_probe']
  });

  const parallelStartedAt = Date.now();
  const parallelResult = await parallelDelegate.execute({
    tasks: [
      { agentId: parallelAgent.id, task: 'Run parallel alpha.', allowedTools: ['slow_probe'], retries: 0 },
      { agentId: parallelAgent.id, task: 'Run parallel beta.', allowedTools: ['slow_probe'], retries: 0 }
    ],
    __sessionId: 'parallel-smoke-session'
  });
  const parallelDurationMs = Date.now() - parallelStartedAt;
  assert.strictEqual(parallelResult.parallel, true, 'batch delegation reports parallel execution');
  assert.strictEqual(parallelResult.results.length, 2, 'both child tasks return reports');
  assert(parallelResult.results.every((item: any) => item.success), 'both parallel child tasks complete');
  assert.strictEqual(maxActiveParallelTools, 2, 'both child-agent tools overlap in flight');

  console.log(JSON.stringify({
    success: true,
    tempDir,
    taskId: result.taskId,
    modelTurns,
    toolCalls: result.report.toolCalls.length,
    reviewPromptContainsFinalOutput: reviewPrompt.includes('delegation proof'),
    parallelChildren: parallelResult.results.length,
    parallelDurationMs,
    maxActiveParallelTools
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
