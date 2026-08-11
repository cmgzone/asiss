import { Skill } from '../core/skills';
import { elevatedManager } from '../core/elevated';
import { SHELL_STREAM_END_MARKER, SHELL_STREAM_MARKER } from '../core/stream-markers';
import { execFile, spawn } from 'child_process';
import util from 'util';
import fs from 'fs';
import { executionBackendManager } from '../core/execution-backend';

const execFileAsync = util.promisify(execFile);

export class ShellSkill implements Skill {
  name = 'shell';
  description = 'Execute shell commands in the workspace. Requires elevated mode to be enabled via /elevated on or /elevated full.';

  inputSchema = {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The shell command to execute"
      }
    },
    required: ["command"]
  };

  async execute(params: any): Promise<any> {
    const { command: requestedCommand, __sessionId, __stream, __workspacePath } = params;

    if (!requestedCommand) {
      return { error: 'Command is required' };
    }
    const backendStatus = executionBackendManager.status();
    const command = backendStatus.backend === 'local'
      ? this.normalizeCommand(String(requestedCommand))
      : String(requestedCommand);
    const projectId = typeof params?.__projectId === 'string' ? params.__projectId.trim() : '';
    if (projectId && !this.isValidDirectory(__workspacePath)) {
      return {
        error: 'Project workspace required.',
        reason: 'This project is not attached to a valid local folder.',
        hint: 'Open Projects, then choose Create workspace or Browse folders.'
      };
    }

    // Check elevated level
    const sessionId = __sessionId || 'default';
    const execCheck = elevatedManager.shouldAllowExec(sessionId);

    if (!execCheck.allowed) {
      return {
        error: 'Shell execution blocked.',
        reason: execCheck.reason,
        hint: 'Send "/elevated on" or "/elevated full" to enable shell commands.'
      };
    }

    // Log based on auto-approve status
    if (execCheck.autoApprove) {
      console.log(`[ShellSkill] Auto-approved (elevated=full): ${command}`);
    } else {
      console.log(`[ShellSkill] Executing (elevated=on|ask): ${command}`);
    }

    const streamFn = typeof __stream === 'function' ? __stream : null;
    let plan;
    try {
      plan = executionBackendManager.createPlan(command, __workspacePath);
    } catch (error: any) {
      return { error: error?.message || String(error), backend: backendStatus.backend };
    }

    if (streamFn) {
      const prompt = plan.backend === 'local' && process.platform === 'win32' ? 'PS>' : '$';
      const header = [SHELL_STREAM_MARKER, `# backend: ${plan.backend}`, `# cwd: ${plan.displayCwd}`, `${prompt} ${command}`].join('\n');
      streamFn(`${header}\n`);

      return await new Promise((resolve) => {
        const child = spawn(plan.executable, plan.args, {
          cwd: plan.cwd,
          env: plan.env,
          shell: false,
          windowsHide: true
        });
        let stdout = '';
        let stderr = '';
        let hadOutput = false;
        let finalized = false;

        const normalize = (data: Buffer) => data.toString('utf8').replace(/\r\n/g, '\n');
        const pushChunk = (chunk: string) => {
          if (!chunk) return;
          hadOutput = true;
          streamFn(chunk);
        };

        const finalize = (payload: any, includeNoOutput: boolean) => {
          if (finalized) return;
          finalized = true;
          if (!hadOutput && includeNoOutput) {
            streamFn('# (no output)\n');
          }
          streamFn(SHELL_STREAM_END_MARKER);
          resolve(payload);
        };

        child.stdout?.on('data', (data) => {
          const chunk = normalize(data);
          stdout += chunk;
          pushChunk(chunk);
        });

        child.stderr?.on('data', (data) => {
          const chunk = normalize(data);
          stderr += chunk;
          pushChunk(chunk);
        });

        child.on('error', (err: any) => {
          const message = err?.message || String(err);
          if (message) {
            streamFn(`\n# error\n${message}\n`);
          }
          finalize({
            error: message,
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            exitCode: typeof err?.code === 'number' ? err.code : 1,
            cwd: plan.displayCwd,
            backend: plan.backend,
            elevated: elevatedManager.getLevel(sessionId),
            streamed: true
          }, false);
        });

        child.on('close', (code) => {
          const exitCode = typeof code === 'number' ? code : 0;
          const payload: any = {
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            exitCode,
            cwd: plan.displayCwd,
            backend: plan.backend,
            elevated: elevatedManager.getLevel(sessionId),
            streamed: true
          };
          if (exitCode !== 0) {
            payload.error = `Command failed with exit code ${exitCode}.`;
          }
          finalize(payload, true);
        });
      });
    }

    try {
      const { stdout, stderr } = await execFileAsync(plan.executable, plan.args, {
        cwd: plan.cwd,
        env: plan.env,
        windowsHide: true,
        maxBuffer: 20 * 1024 * 1024
      } as any);

      return {
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim(),
        exitCode: 0,
        cwd: plan.displayCwd,
        backend: plan.backend,
        elevated: elevatedManager.getLevel(sessionId),
        streamed: false
      };
    } catch (error: any) {
      return {
        error: error.message,
        stdout: error.stdout?.trim(),
        stderr: error.stderr?.trim(),
        exitCode: error.code,
        cwd: plan.displayCwd,
        backend: plan.backend,
        elevated: elevatedManager.getLevel(sessionId),
        streamed: false
      };
    }
  }

  private isValidDirectory(value: unknown): boolean {
    const directoryPath = typeof value === 'string' ? value.trim() : '';
    if (!directoryPath) return false;
    try {
      return fs.existsSync(directoryPath) && fs.statSync(directoryPath).isDirectory();
    } catch {
      return false;
    }
  }

  private normalizeCommand(command: string): string {
    if (process.platform !== 'win32') return command;
    const trimmed = command.trim();
    const listMatch = /^ls(?:\s+-[al]+)?(?:\s+(.+))?$/i.exec(trimmed);
    if (listMatch) {
      return listMatch[1]
        ? `Get-ChildItem -Force ${listMatch[1]}`
        : 'Get-ChildItem -Force';
    }
    if (/^pwd$/i.test(trimmed)) return '(Get-Location).Path';
    const whichMatch = /^which\s+(.+)$/i.exec(trimmed);
    if (whichMatch) return `Get-Command ${whichMatch[1]}`;
    return command;
  }
}
