import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { workspaceManager } from './workspace-manager';
import { hookManager } from './hooks';
import { atomicWriteJsonSync } from './atomic-write';

export interface WorkspaceCheckpoint {
  id: string;
  workspacePath: string;
  workspaceKey: string;
  commit: string;
  reason: string;
  sessionId?: string;
  createdAt: number;
}

interface CheckpointData {
  checkpoints: WorkspaceCheckpoint[];
}

export class CheckpointManager {
  private readonly root: string;
  private readonly metadataPath: string;

  constructor(rootPath?: string) {
    const oneDrive = String(process.env.OneDrive || process.env.ONEDRIVE || '').trim();
    const dataRoot = rootPath || process.env.GITU_DATA_ROOT || path.join(oneDrive || path.join(os.homedir(), 'Documents'), 'Gitu Data');
    this.root = path.join(path.resolve(dataRoot), 'checkpoints');
    this.metadataPath = path.join(this.root, 'manifest.json');
    fs.mkdirSync(this.root, { recursive: true });
  }

  public create(workspacePath: string, reason: string, sessionId?: string): WorkspaceCheckpoint {
    const workspace = this.resolveWorkspace(workspacePath);
    const workspaceKey = this.workspaceKey(workspace);
    const gitDir = path.join(this.root, workspaceKey, 'repo.git');
    this.ensureRepository(gitDir);
    this.runGit(gitDir, workspace, ['add', '-A', '--', '.']);
    this.runGit(gitDir, workspace, [
      '-c', 'user.name=Gitu Checkpoints',
      '-c', 'user.email=gitu-checkpoints@local',
      'commit', '--allow-empty', '-m', this.cleanReason(reason)
    ]);
    const commit = this.runGit(gitDir, workspace, ['rev-parse', 'HEAD']).trim();
    const checkpoint: WorkspaceCheckpoint = {
      id: crypto.randomUUID(),
      workspacePath: workspace,
      workspaceKey,
      commit,
      reason: this.cleanReason(reason),
      sessionId: sessionId || undefined,
      createdAt: Date.now()
    };
    const data = this.read();
    data.checkpoints.push(checkpoint);
    data.checkpoints = data.checkpoints.slice(-500);
    this.write(data);
    void hookManager.emit('checkpoint_created', {
      checkpointId: checkpoint.id,
      workspacePath: checkpoint.workspacePath,
      reason: checkpoint.reason
    }, sessionId);
    return checkpoint;
  }

  public list(workspacePath?: string, sessionId?: string, limit = 30): WorkspaceCheckpoint[] {
    const normalizedWorkspace = workspacePath ? this.resolveWorkspace(workspacePath) : '';
    return this.read().checkpoints
      .filter(item => !normalizedWorkspace || this.samePath(item.workspacePath, normalizedWorkspace))
      .filter(item => !sessionId || item.sessionId === sessionId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, Math.max(1, Math.min(100, limit)))
      .map(item => ({ ...item }));
  }

  public rollback(workspacePath: string, checkpointId?: string, sessionId?: string) {
    const workspace = this.resolveWorkspace(workspacePath);
    const candidates = this.list(workspace, undefined, 100);
    const target = checkpointId
      ? candidates.find(item => item.id === checkpointId || item.id.startsWith(checkpointId) || item.commit.startsWith(checkpointId))
      : candidates[0];
    if (!target) throw new Error('No checkpoint was found for this workspace.');

    const safetyCheckpoint = this.create(workspace, `Before rollback to ${target.id.slice(0, 8)}`, sessionId);
    const gitDir = path.join(this.root, target.workspaceKey, 'repo.git');
    const cleanPreview = this.runGit(gitDir, workspace, ['clean', '-nd']).split(/\r?\n/).filter(Boolean);
    if (cleanPreview.some(line => /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(line))) {
      throw new Error('Rollback safety check rejected a path outside the workspace.');
    }
    this.runGit(gitDir, workspace, ['reset', '--hard', target.commit]);
    this.runGit(gitDir, workspace, ['clean', '-fd']);
    return { success: true, restored: target, safetyCheckpoint, removedPreview: cleanPreview };
  }

  public shouldCheckpointShell(command: string): boolean {
    const text = String(command || '').trim();
    if (!text) return false;
    return /(?:^|[;&|]\s*)(?:remove-item|move-item|copy-item|rename-item|set-content|add-content|new-item|clear-content|out-file|rm|rmdir|mv|cp|install|truncate|dd|shred)\b|\bsed\s+-i\b|\bgit\s+(?:reset|clean|checkout|restore)\b|(?:^|[^<])>{1,2}(?!>)/i.test(text);
  }

  public status() {
    const checkpoints = this.read().checkpoints;
    return {
      root: this.root,
      count: checkpoints.length,
      workspaces: new Set(checkpoints.map(item => item.workspaceKey)).size,
      latest: checkpoints.length ? checkpoints[checkpoints.length - 1] : null
    };
  }

  private resolveWorkspace(workspacePath: string): string {
    const workspace = path.resolve(String(workspacePath || ''));
    workspaceManager.assertAllowed(workspace);
    if (!workspaceManager.isExistingDirectory(workspace)) throw new Error('Checkpoint workspace does not exist.');
    return workspace;
  }

  private workspaceKey(workspacePath: string): string {
    return crypto.createHash('sha256').update(workspacePath.toLowerCase()).digest('hex').slice(0, 24);
  }

  private ensureRepository(gitDir: string): void {
    if (!fs.existsSync(path.join(gitDir, 'HEAD'))) {
      fs.mkdirSync(path.dirname(gitDir), { recursive: true });
      execFileSync('git', ['init', '--bare', gitDir], { windowsHide: true, stdio: 'pipe' });
    }
    const excludePath = path.join(gitDir, 'info', 'exclude');
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    if (!fs.existsSync(excludePath)) {
      fs.writeFileSync(excludePath, [
        '.git/', 'node_modules/', 'dist/', 'build/', '.next/', '.cache/',
        '.wwebjs_auth/', '.wwebjs_cache/', '*.log', '.env', '.env.*', '*.key', '*.pem',
        '__pycache__/', '.venv/', 'venv/'
      ].join('\n'));
    }
  }

  private runGit(gitDir: string, workspace: string, args: string[]): string {
    try {
      return execFileSync('git', ['--git-dir', gitDir, '--work-tree', workspace, ...args], {
        cwd: workspace,
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 20 * 1024 * 1024
      });
    } catch (error: any) {
      const detail = String(error?.stderr || error?.message || error).trim();
      throw new Error(`Checkpoint operation failed: ${detail.slice(0, 2_000)}`);
    }
  }

  private cleanReason(reason: string): string {
    return String(reason || 'Before file change').replace(/[\r\n]+/g, ' ').trim().slice(0, 200) || 'Before file change';
  }

  private samePath(a: string, b: string): boolean {
    return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  }

  private read(): CheckpointData {
    if (!fs.existsSync(this.metadataPath)) return { checkpoints: [] };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.metadataPath, 'utf8'));
      return { checkpoints: Array.isArray(parsed?.checkpoints) ? parsed.checkpoints : [] };
    } catch {
      return { checkpoints: [] };
    }
  }

  private write(data: CheckpointData): void {
    // Phase 22 — resilient atomic write (retry + copy fallback + warn, never
    // throw): a transient OneDrive lock on checkpoint metadata must not
    // abort a rollback or checkpoint creation.
    atomicWriteJsonSync(this.metadataPath, data);
  }
}

export const checkpointManager = new CheckpointManager();
