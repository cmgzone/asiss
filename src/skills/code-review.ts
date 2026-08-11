import { Skill } from '../core/skills';
import { execFile } from 'child_process';
import util from 'util';
import fs from 'fs';
import path from 'path';
import { GitSkill } from './git';

const execFileAsync = util.promisify(execFile);
const git = new GitSkill();

export class CodeReviewSkill implements Skill {
  name = 'code_review';
  description = 'Gather a structured diff for review (working tree, staged, a branch range, or a commit) and optionally run project checks (lint/typecheck/test). Returns the diff plus any check output so you can give line-by-line review feedback before a PR is opened. Does NOT commit or push.';
  capabilities = ['code_review'];

  inputSchema = {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        description: "What to diff. 'unstaged' (default, all uncommitted), 'staged', 'branch:<base>' (e.g. 'branch:main'), 'range:<a>..<b>', or 'commit:<sha>'."
      },
      checks: {
        type: 'array',
        items: { type: 'string' },
        description: "Optional shell-safe commands to run as part of the review, e.g. ['npm run lint','npm run typecheck']. Each runs in the repo root with a timeout."
      },
      checkTimeoutMs: { type: 'number', description: 'Per-check timeout in ms (default 120000)' }
    },
    required: []
  };

  async execute(params: any): Promise<any> {
    const target = typeof params?.target === 'string' && params.target.trim() ? params.target.trim() : 'unstaged';
    const checks = Array.isArray(params?.checks) ? params.checks.filter((c: any) => typeof c === 'string') : [];
    const checkTimeoutMs = typeof params?.checkTimeoutMs === 'number' ? params.checkTimeoutMs : 120000;

    const repo = this.resolveRepo(params);
    if (!repo) return { error: 'A valid repository path (workspace or repo) is required.' };

    const diffResult = await this.buildDiff(target, repo);
    if (diffResult.error) return diffResult;

    const diff = diffResult.diff as string;
    const checkResults: Array<{ command: string; exitCode: number; stdout: string; stderr: string; error?: string }> = [];
    for (const command of checks.slice(0, 6)) {
      checkResults.push(await this.runCheck(command, repo, checkTimeoutMs));
    }

    const added = (diff.match(/^\+(?!\+\+)/gm) || []).length;
    const removed = (diff.match(/^-(?!--)/gm) || []).length;

    return {
      repo,
      target,
      diff,
      summary: { addedLines: added, removedLines: removed, diffLength: diff.length },
      checks: checkResults,
      _synthesisInstructions: 'You are reviewing this diff before a pull request is opened. Provide line-by-line feedback: call out bugs, edge cases, security issues, missing error handling, and unclear logic. Group feedback by file:line. End with a short verdict: Approve, Approve with nits, or Request changes.'
    };
  }

  private async buildDiff(target: string, repo: string): Promise<{ diff?: string; error?: string }> {
    let args: string;
    if (target === 'unstaged' || target === '' || target === 'working') {
      args = 'diff HEAD';
    } else if (target === 'staged') {
      args = 'diff --cached';
    } else if (target.startsWith('branch:')) {
      const base = target.slice('branch:'.length).trim();
      args = `diff ${base}...HEAD`;
    } else if (target.startsWith('range:')) {
      const range = target.slice('range:'.length).trim();
      args = `diff ${range}`;
    } else if (target.startsWith('commit:')) {
      const sha = target.slice('commit:'.length).trim();
      args = `show ${sha}`;
    } else {
      args = 'diff HEAD';
    }

    const res: any = await git.execute({ args, __workspacePath: repo });
    if (res?.error) {
      return { error: `Failed to build diff ('git ${args}'): ${res.error}${res.stderr ? ' — ' + res.stderr : ''}` };
    }
    return { diff: res?.stdout || '' };
  }

  private async runCheck(command: string, repo: string, timeoutMs: number): Promise<any> {
    const tokens = this.tokenize(command);
    if (tokens.length === 0) return { command, error: 'empty check command' };
    try {
      const { stdout, stderr } = await execFileAsync(tokens[0], tokens.slice(1), {
        cwd: repo,
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 20 * 1024 * 1024
      } as any);
      return {
        command,
        exitCode: 0,
        stdout: String(stdout || '').trim().slice(0, 8000),
        stderr: String(stderr || '').trim().slice(0, 4000)
      };
    } catch (err: any) {
      return {
        command,
        exitCode: typeof err?.code === 'number' ? err.code : 1,
        stdout: String(err?.stdout || '').trim().slice(0, 8000),
        stderr: String(err?.stderr || '').trim().slice(0, 4000),
        error: err?.killed ? `Timed out after ${timeoutMs}ms` : (err?.message || String(err))
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
