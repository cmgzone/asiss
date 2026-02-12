import { Skill } from '../core/skills';
import { elevatedManager } from '../core/elevated';
import { SHELL_STREAM_END_MARKER, SHELL_STREAM_MARKER } from '../core/stream-markers';
import { exec, spawn } from 'child_process';
import util from 'util';

const execAsync = util.promisify(exec);

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
    const { command, __sessionId, __stream } = params;

    if (!command) {
      return { error: 'Command is required' };
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

    if (streamFn) {
      const cwd = process.cwd();
      const prompt = process.platform === 'win32' ? 'PS>' : '$';
      const header = [SHELL_STREAM_MARKER, `# cwd: ${cwd}`, `${prompt} ${command}`].join('\n');
      streamFn(`${header}\n`);

      return await new Promise((resolve) => {
        const child = spawn(command, { cwd, shell: true, windowsHide: true });
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
      const { stdout, stderr } = await execAsync(command, { cwd: process.cwd() });

      return {
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: 0,
        elevated: elevatedManager.getLevel(sessionId),
        streamed: false
      };
    } catch (error: any) {
      return {
        error: error.message,
        stdout: error.stdout?.trim(),
        stderr: error.stderr?.trim(),
        exitCode: error.code,
        elevated: elevatedManager.getLevel(sessionId),
        streamed: false
      };
    }
  }
}
