import { checkpointManager } from '../core/checkpoint-manager';
import { Skill } from '../core/skills';

export class CheckpointsSkill implements Skill {
  name = 'checkpoints';
  description = 'Create, list, inspect, or roll back automatic workspace checkpoints. Rollback restores files and creates a safety checkpoint first.';
  inputSchema = {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'list', 'rollback', 'status'] },
      checkpointId: { type: 'string', description: 'Checkpoint id, prefix, or commit prefix for rollback.' },
      reason: { type: 'string', description: 'Reason for a manual checkpoint.' },
      limit: { type: 'number', minimum: 1, maximum: 100 }
    },
    required: ['action']
  };

  async execute(args: any) {
    const workspacePath = String(args?.__workspacePath || '').trim();
    const sessionId = String(args?.__sessionId || '').trim() || undefined;
    if (args?.action === 'status') return checkpointManager.status();
    if (!workspacePath) return { success: false, error: 'A project or General chat workspace is required.' };
    if (args?.action === 'create') {
      return { success: true, checkpoint: checkpointManager.create(workspacePath, args?.reason || 'Manual checkpoint', sessionId) };
    }
    if (args?.action === 'list') {
      return { success: true, checkpoints: checkpointManager.list(workspacePath, undefined, Number(args?.limit) || 30) };
    }
    if (args?.action === 'rollback') {
      return checkpointManager.rollback(workspacePath, String(args?.checkpointId || '').trim() || undefined, sessionId);
    }
    return { success: false, error: `Unknown checkpoint action: ${args?.action}` };
  }
}
