import { Skill } from '../core/skills';
import { execFile } from 'child_process';
import util from 'util';
import fs from 'fs';
import path from 'path';

const execFileAsync = util.promisify(execFile);

// Read-only or routine git operations. Deliberately excludes destructive
// commands (e.g. reset --hard, clean -f, push --force) to keep the skill safe.
const ALLOWED_COMMANDS = new Set([
  'status', 'diff', 'log', 'show', 'branch', 'add', 'commit', 'checkout',
  'switch', 'merge', 'tag', 'stash', 'pull', 'fetch', 'push', 'restore',
  'revert', 'remote', 'blame', 'rev-parse', 'rev-list', 'ls-files', 'config',
  'mv', 'rm', 'reset', 'cherry', 'shortlog', 'describe'
]);

// Argument tokens that are never permitted through this skill.
const BLOCKED_TOKENS = new Set([
  '--hard', '--force', '-f', '--no-verify', '--delete', '-D', '--orphan'
]);

export class GitSkill implements Skill {
  name = 'git';
  description = 'Run safe Git operations in the workspace repository: status, diff, log, show, branch, add, commit, checkout, switch, merge, tag, stash, pull, fetch, push, restore, revert, remote, blame, reset (soft/mixed only), and more. Destructive flags (--hard, --force, -f, --no-verify, --delete) are blocked. Uses the workspace repo root.';
  capabilities = ['git'];

  inputSchema = {
    type: 'object',
    properties: {
      args: { type: 'string', description: 'Git arguments, e.g. "status --short" or "diff main...HEAD". The first token must be an allowed subcommand.' },
      command: { type: 'string', description: 'Alternative: a single subcommand, e.g. "status".' },
      repo: { type: 'string', description: 'Repository path (default: workspace root / cwd)' }
    },
    required: []
  };

  async execute(params: any): Promise<any> {
    const repo = this.resolveRepo(params);
    if (!repo) return { error: 'A valid repository path (workspace or repo) is required.' };

    const raw = typeof params?.args === 'string' && params.args.trim()
      ? params.args.trim()
      : (typeof params?.command === 'string' && params.command.trim() ? params.command.trim() : '');
    if (!raw) return { error: 'Provide git args or command, e.g. args: "status --short".' };

    const tokens = this.tokenize(raw);
    if (tokens.length === 0) return { error: 'Empty git command.' };

    const subcommand = tokens[0];
    if (!ALLOWED_COMMANDS.has(subcommand)) {
      return {
        error: `Git subcommand '${subcommand}' is not permitted through this skill.`,
        allowed: Array.from(ALLOWED_COMMANDS).sort()
      };
    }
    for (const token of tokens) {
      if (BLOCKED_TOKENS.has(token)) {
        return {
          error: `Argument '${token}' is blocked for safety (destructive). Use the shell with elevated mode if you really intend this.`
        };
      }
    }
    // reset is only allowed in non-destructive modes
    if (subcommand === 'reset' && tokens.includes('--hard')) {
      return { error: 'git reset --hard is blocked for safety.' };
    }

    try {
      const { stdout, stderr } = await execFileAsync('git', tokens, {
        cwd: repo,
        windowsHide: true,
        maxBuffer: 20 * 1024 * 1024
      } as any);
      return {
        repo,
        command: `git ${tokens.join(' ')}`,
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim(),
        exitCode: 0
      };
    } catch (err: any) {
      return {
        repo,
        command: `git ${tokens.join(' ')}`,
        error: err?.message || String(err),
        stdout: String(err?.stdout || '').trim(),
        stderr: String(err?.stderr || '').trim(),
        exitCode: typeof err?.code === 'number' ? err.code : 1
      };
    }
  }

  private resolveRepo(params: any): string | null {
    const candidates = [
      typeof params?.repo === 'string' ? params.repo.trim() : '',
      typeof params?.__workspacePath === 'string' ? params.__workspacePath : '',
      process.cwd()
    ].filter(Boolean);

    for (const candidate of candidates) {
      let dir = candidate;
      // Walk up until we find a .git directory or file.
      for (let i = 0; i < 8; i++) {
        try {
          if (fs.existsSync(path.join(dir, '.git'))) return dir;
        } catch { /* ignore */ }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
    return null;
  }

  private tokenize(input: string): string[] {
    const tokens: string[] = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(input)) !== null) {
      tokens.push(m[1] ?? m[2] ?? m[3]);
    }
    return tokens;
  }
}
