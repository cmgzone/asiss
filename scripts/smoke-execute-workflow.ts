import assert from 'assert';
import { SkillRegistry } from '../src/core/skills';
import { ExecuteWorkflowSkill } from '../src/skills/execute-workflow';

async function main() {
  SkillRegistry.register({
    name: 'workflow_echo',
    description: 'Test workflow echo.',
    inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    async execute(args: any) {
      return { success: true, value: args.value, sessionId: args.__sessionId, workspacePath: args.__workspacePath };
    }
  });
  SkillRegistry.register({
    name: 'workflow_finish',
    description: 'Test workflow finish.',
    inputSchema: { type: 'object', properties: { previous: {} }, required: ['previous'] },
    async execute(args: any) {
      return { success: true, final: args.previous.value };
    }
  });

  try {
    const workflow = new ExecuteWorkflowSkill({
      listMcpTools: async () => [],
      callMcpTool: async () => { throw new Error('No MCP tool expected.'); }
    });
    const result = await workflow.execute({
      task: 'workflow input',
      steps: [
        { tool: 'workflow_echo', arguments: { value: '{{task}}', __sessionId: 'must-not-override' } },
        { tool: 'workflow_finish', arguments: { previous: '{{steps.0.output}}' } }
      ],
      __sessionId: 'workflow-session',
      __workspacePath: 'C:\\safe-workspace'
    });
    assert.equal(result.success, true);
    assert.equal(result.count, 2);
    assert.equal(result.output.final, 'workflow input');
    assert.equal(result.steps[0].output.sessionId, 'workflow-session');
    assert.equal(result.steps[0].output.workspacePath, 'C:\\safe-workspace');

    const denied = await workflow.execute({
      steps: [{ tool: 'delegate_agent', arguments: {} }],
      __sessionId: 'workflow-session'
    });
    assert.equal(denied.success, false);

    console.log(JSON.stringify({
      sequentialTools: true,
      outputTemplates: true,
      runtimeMetadataProtected: true,
      recursiveDelegationBlocked: true
    }));
  } finally {
    SkillRegistry.unregister('workflow_echo');
    SkillRegistry.unregister('workflow_finish');
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
