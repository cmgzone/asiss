import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CheckpointManager } from '../src/core/checkpoint-manager';

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitu-checkpoint-store-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gitu-checkpoint-workspace-'));
  const manager = new CheckpointManager(root);

  try {
    const filePath = path.join(workspace, 'example.txt');
    const createdLater = path.join(workspace, 'created-later.txt');
    fs.writeFileSync(filePath, 'original');
    const first = manager.create(workspace, 'Before smoke mutation', 'smoke-session');

    fs.writeFileSync(filePath, 'changed');
    fs.writeFileSync(createdLater, 'remove on rollback');
    const rollback = manager.rollback(workspace, first.id, 'smoke-session');

    assert.equal(rollback.success, true);
    assert.equal(fs.readFileSync(filePath, 'utf8'), 'original');
    assert.equal(fs.existsSync(createdLater), false);
    assert.ok(rollback.safetyCheckpoint.id);
    assert.ok(manager.list(workspace).length >= 2);
    assert.equal(manager.shouldCheckpointShell('Get-ChildItem'), false);
    assert.equal(manager.shouldCheckpointShell('Remove-Item -LiteralPath test.txt'), true);
    assert.equal(manager.shouldCheckpointShell('git reset --hard HEAD~1'), true);

    console.log(JSON.stringify({
      checkpointCreated: true,
      contentRestored: true,
      newFilesRemoved: true,
      rollbackSafetyCheckpoint: true,
      mutationDetection: true
    }));
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
