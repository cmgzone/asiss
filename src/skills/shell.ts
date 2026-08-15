import { Skill } from '../core/skills';
import { elevatedManager } from '../core/elevated';
import { SHELL_STREAM_END_MARKER, SHELL_STREAM_MARKER } from '../core/stream-markers';
import { execFile, spawn } from 'child_process';
import util from 'util';
import fs from 'fs';
import path from 'path';
import { executionBackendManager } from '../core/execution-backend';
import { inspectShellCommand, isPathInsideWorkspace, WorkspaceBoundaryViolationError } from '../core/project-context';
import { projectContextFromParams, boundaryErrorResult } from './workspace-guard';

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
    const { command: requestedCommand, __sessionId, __stream, __workspacePath, __signal: signalRef } = params;

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

    // Phase 23 §11 — the default shell cwd is the ACTIVE PROJECT WORKSPACE,
    // never process.cwd(). A command that would `cd` outside the workspace is
    // rejected before it can run, and the resolved plan cwd is re-asserted
    // inside the boundary right before spawn.
    const projectContext = projectContextFromParams(params);
    if (projectContext) {
      const violation = inspectShellCommand(command, projectContext);
      if (violation) {
        return {
          error: violation,
          code: 'WORKSPACE_BOUNDARY_VIOLATION',
          blocked: true,
          activeProject: projectContext.projectName || projectContext.projectId,
          activeWorkspace: projectContext.workspaceRoot
        };
      }
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
      plan = executionBackendManager.createPlan(command, projectContext?.workspaceRoot || __workspacePath);
      // Phase 23 — the plan's cwd must stay inside the active workspace.
      if (projectContext && !isPathInsideWorkspace(plan.cwd, projectContext.workspaceRoot)) {
        return boundaryErrorResult(
          new WorkspaceBoundaryViolationError(projectContext, plan.cwd),
          'shell'
        );
      }
    } catch (error: any) {
      if (error?.code === 'WORKSPACE_BOUNDARY_VIOLATION') {
        return boundaryErrorResult(error, 'shell');
      }
      return { error: error?.message || String(error), backend: backendStatus.backend };
    }

    if (streamFn) {
      const prompt = plan.backend === 'local' && process.platform === 'win32' ? 'PS>' : '$';
      const header = [SHELL_STREAM_MARKER, `# backend: ${plan.backend}`, `# cwd: ${plan.displayCwd}`, `${prompt} ${command}`].join('\n');
      streamFn(`${header}\n`);

      return await new Promise((resolve) => {
        // signalRef lets a user stop kill a long-running command mid-flight:
        // Node terminates the child (SIGTERM -> SIGKILL) when the signal aborts.
        const child = spawn(plan.executable, plan.args, {
          cwd: plan.cwd,
          env: plan.env,
          shell: false,
          windowsHide: true,
          signal: signalRef
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
          // On abort Node emits 'error' (AbortError) instead of 'close' for a
          // signal-interrupted child — report it as an interrupt, not a failure.
          if (signalRef?.aborted) {
            finalize({
              interrupted: true,
              error: 'Command interrupted by user stop.',
              stdout: stdout.trim(),
              stderr: stderr.trim(),
              exitCode: null,
              cwd: plan.displayCwd,
              backend: plan.backend,
              elevated: elevatedManager.getLevel(sessionId),
              streamed: true
            }, true);
            return;
          }
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

        child.on('close', (code, closeSignal) => {
          const interrupted = signalRef?.aborted || Boolean(closeSignal);
          if (interrupted) {
            finalize({
              interrupted: true,
              error: 'Command interrupted by user stop.',
              stdout: stdout.trim(),
              stderr: stderr.trim(),
              exitCode: typeof code === 'number' ? code : null,
              cwd: plan.displayCwd,
              backend: plan.backend,
              elevated: elevatedManager.getLevel(sessionId),
              streamed: true
            }, true);
            return;
          }
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
        maxBuffer: 20 * 1024 * 1024,
        signal: signalRef
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
      if (signalRef?.aborted) {
        return {
          interrupted: true,
          error: 'Command interrupted by user stop.',
          stdout: String(error?.stdout || '').trim(),
          stderr: String(error?.stderr || '').trim(),
          exitCode: null,
          cwd: plan.displayCwd,
          backend: plan.backend,
          elevated: elevatedManager.getLevel(sessionId),
          streamed: false
        };
      }
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
