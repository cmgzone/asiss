import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { LearnedSkillsManager } from '../src/core/learned-skills';
import { SkillRegistry } from '../src/core/skills';

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitu-executable-skills-'));
  const sessionId = 'smoke-session';
  const manager = new LearnedSkillsManager(root, ['safe_test_tool']);
  let learnedToolName = '';

  try {
    SkillRegistry.register({
      name: 'safe_test_tool',
      description: 'Test-only safe tool.',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value']
      },
      async execute(args: any) {
        return {
          success: true,
          value: args.value,
          workspacePath: args.__workspacePath
        };
      }
    });

    const record = manager.upsert({
      name: 'repeat-safe-input',
      description: 'Runs a validated safe tool using the current task as its input.',
      instructions: ['Pass the current task to the safe test tool.', 'Return the verified result.'],
      keywords: ['safe', 'repeat'],
      sessionId,
      sourceEntryId: 'smoke-source',
      executableSpec: {
        allowedTools: ['safe_test_tool'],
        steps: [{
          tool: 'safe_test_tool',
          arguments: { value: '{{task}}', __workspacePath: 'must-not-override-runtime' },
          onError: 'stop'
        }]
      }
    });

    assert.equal(record.executable, true);
    assert.equal(record.validationStatus, 'validated');
    assert.ok(record.toolName);
    learnedToolName = record.toolName!;
    const learnedTool = SkillRegistry.get(learnedToolName);
    assert.ok(learnedTool, 'learned tool should be registered');

    const result = await learnedTool!.execute({
      task: 'hello executable skill',
      __sessionId: sessionId,
      __workspacePath: 'C:\\safe-workspace'
    });
    assert.equal(result.success, true);
    assert.equal(result.steps[0].output.value, 'hello executable skill');
    assert.equal(result.steps[0].output.workspacePath, 'C:\\safe-workspace');

    const wrongScope = await learnedTool!.execute({ task: 'blocked', __sessionId: 'other-session' });
    assert.equal(wrongScope.success, false);

    assert.equal(manager.setEnabled(record.name, false, sessionId), true);
    assert.equal(SkillRegistry.get(learnedToolName), undefined);
    assert.equal(manager.setEnabled(record.name, true, sessionId), true);
    assert.ok(SkillRegistry.get(learnedToolName));

    SkillRegistry.unregister(learnedToolName);
    const reloadedManager = new LearnedSkillsManager(root, ['safe_test_tool']);
    const startupRegistration = reloadedManager.registerExecutableSkills();
    assert.equal(startupRegistration.registered, 1);
    assert.ok(SkillRegistry.get(learnedToolName));

    const invalid = manager.upsert({
      name: 'unsafe-shell-workflow',
      description: 'Attempts to create an unsafe workflow and must remain declarative only.',
      instructions: ['Do not execute unsafe generated commands.'],
      sessionId,
      sourceEntryId: 'smoke-unsafe-source',
      executableSpec: {
        allowedTools: ['shell'],
        steps: [{ tool: 'shell', arguments: { command: 'echo unsafe' } }]
      }
    });
    assert.equal(invalid.executable, false);
    assert.equal(invalid.validationStatus, 'invalid');

    console.log(JSON.stringify({
      registered: true,
      executed: true,
      scopeIsolation: true,
      runtimeMetadataProtected: true,
      disableEnable: true,
      restartRegistration: true,
      unsafeToolRejected: true
    }));
  } finally {
    if (learnedToolName) SkillRegistry.unregister(learnedToolName);
    SkillRegistry.unregister('safe_test_tool');
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
