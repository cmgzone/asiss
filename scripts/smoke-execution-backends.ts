import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ExecutionBackendManager } from '../src/core/execution-backend';
import { ShellSkill } from '../src/skills/shell';

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitu-execution-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  process.env.SMOKE_SECRET_TOKEN = 'must-not-leak';
  process.env.SMOKE_SAFE_VALUE = 'safe-value';

  try {
    const configPath = path.join(root, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      execution: {
        backend: 'local',
        allowProcessCwd: false,
        envAllowlist: ['SMOKE_SAFE_VALUE']
      }
    }));
    const local = new ExecutionBackendManager(configPath);
    const localPlan = local.createPlan('echo test', workspace);
    assert.equal(localPlan.backend, 'local');
    assert.equal(localPlan.env.SMOKE_SECRET_TOKEN, undefined);
    assert.equal(localPlan.env.SMOKE_SAFE_VALUE, 'safe-value');
    assert.throws(() => local.createPlan('echo blocked'), /requires an attached/i);

    fs.writeFileSync(configPath, JSON.stringify({
      execution: {
        backend: 'docker',
        envAllowlist: ['SMOKE_SAFE_VALUE'],
        docker: { image: 'node:22-bookworm', network: 'none', cpus: 1, memoryMb: 512 }
      }
    }));
    const dockerPlan = new ExecutionBackendManager(configPath).createPlan('node --version', workspace);
    assert.equal(dockerPlan.backend, 'docker');
    assert.ok(dockerPlan.args.includes('--read-only'));
    assert.ok(dockerPlan.args.includes('none'));
    assert.ok(dockerPlan.args.some(arg => arg === 'SMOKE_SAFE_VALUE=safe-value'));
    assert.ok(!dockerPlan.args.some(arg => arg.includes('must-not-leak')));

    fs.writeFileSync(configPath, JSON.stringify({
      execution: {
        backend: 'ssh',
        ssh: { host: 'example.test', user: 'agent', port: 22, remoteWorkspace: '/workspace' }
      }
    }));
    const sshPlan = new ExecutionBackendManager(configPath).createPlan('pwd', workspace);
    assert.equal(sshPlan.backend, 'ssh');
    assert.ok(sshPlan.args.includes('agent@example.test'));

    const shell = new ShellSkill();
    const secretCheck = process.platform === 'win32'
      ? "if ($env:SMOKE_SECRET_TOKEN) { 'LEAK' } else { 'SAFE' }"
      : "if [ -n \"$SMOKE_SECRET_TOKEN\" ]; then echo LEAK; else echo SAFE; fi";
    const shellResult = await shell.execute({
      command: secretCheck,
      __sessionId: 'smoke-execution',
      __workspacePath: workspace
    });
    assert.equal(shellResult.exitCode, 0);
    assert.equal(shellResult.stdout, 'SAFE');
    assert.equal(shellResult.backend, 'local');

    console.log(JSON.stringify({
      workspaceRequired: true,
      secretsFiltered: true,
      localExecution: true,
      dockerPlan: true,
      sshPlan: true
    }));
  } finally {
    delete process.env.SMOKE_SECRET_TOKEN;
    delete process.env.SMOKE_SAFE_VALUE;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
