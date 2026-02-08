import { Skill } from '../core/skills';
import { elevatedManager } from '../core/elevated';
import { exec } from 'child_process';
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
    const { command, __sessionId } = params;

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

    try {
      const { stdout, stderr } = await execAsync(command, { cwd: process.cwd() });

      return {
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: 0,
        elevated: elevatedManager.getLevel(sessionId)
      };
    } catch (error: any) {
      return {
        error: error.message,
        stdout: error.stdout?.trim(),
        stderr: error.stderr?.trim(),
        exitCode: error.code,
        elevated: elevatedManager.getLevel(sessionId)
      };
    }
  }
}

