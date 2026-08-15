import fs from 'fs';
import path from 'path';
import { ProjectContext, isPathInsideWorkspace, validateProjectContext } from './project-context';

export type ExecutionBackendName = 'local' | 'docker' | 'ssh';

export interface ExecutionPlan {
  backend: ExecutionBackendName;
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  displayCwd: string;
}

interface ExecutionConfig {
  backend?: ExecutionBackendName;
  allowProcessCwd?: boolean;
  envAllowlist?: string[];
  docker?: {
    image?: string;
    network?: string;
    cpus?: number;
    memoryMb?: number;
    readOnlyRoot?: boolean;
    extraArgs?: string[];
  };
  ssh?: {
    host?: string;
    user?: string;
    port?: number;
    identityFile?: string;
    remoteWorkspace?: string;
  };
}

export class ExecutionBackendManager {
  private readonly configPath: string;

  constructor(configPath?: string) {
    // phase23-ok: engine-root config file, not project context
    this.configPath = configPath ? path.resolve(configPath) : path.join(process.cwd(), 'config.json');
  }

  /**
   * Build an execution plan. Phase 23: when a ProjectContext is supplied, the
   * resolved cwd MUST stay inside projectContext.workspaceRoot — the shell
   * layer never escapes the active project. Without a context, legacy
   * behavior applies (attached workspace path, or process.cwd() only when
   * allowProcessCwd is explicitly configured).
   */
  public createPlan(command: string, workspacePath?: string, projectContext?: ProjectContext): ExecutionPlan {
    const config = this.loadConfig();
    const backend = config.backend === 'docker' || config.backend === 'ssh' ? config.backend : 'local';
    const cwd = this.resolveWorkspace(workspacePath, config.allowProcessCwd === true, projectContext);
    const env = this.filteredEnvironment(config.envAllowlist || []);
    if (backend === 'docker') return this.dockerPlan(command, cwd, env, config);
    if (backend === 'ssh') return this.sshPlan(command, cwd, env, config);
    return this.localPlan(command, cwd, env);
  }

  public status() {
    const config = this.loadConfig();
    return {
      backend: config.backend || 'local',
      allowProcessCwd: config.allowProcessCwd === true,
      envAllowlist: config.envAllowlist || [],
      dockerImage: config.docker?.image || null,
      sshConfigured: Boolean(config.ssh?.host && config.ssh?.remoteWorkspace)
    };
  }

  private localPlan(command: string, cwd: string, env: NodeJS.ProcessEnv): ExecutionPlan {
    return process.platform === 'win32'
      ? {
          backend: 'local',
          executable: 'powershell.exe',
          args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
          cwd,
          env,
          displayCwd: cwd
        }
      : {
          backend: 'local',
          executable: '/bin/sh',
          args: ['-lc', command],
          cwd,
          env,
          displayCwd: cwd
        };
  }

  private dockerPlan(command: string, cwd: string, env: NodeJS.ProcessEnv, config: ExecutionConfig): ExecutionPlan {
    const docker = config.docker || {};
    const image = String(docker.image || '').trim();
    if (!image) throw new Error('Docker execution requires execution.docker.image in config.json.');
    const args = ['run', '--rm', '--workdir', '/workspace', '--volume', `${cwd}:/workspace`];
    if (docker.readOnlyRoot !== false) args.push('--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=512m');
    if (docker.network) args.push('--network', String(docker.network));
    else args.push('--network', 'none');
    if (Number(docker.cpus) > 0) args.push('--cpus', String(docker.cpus));
    if (Number(docker.memoryMb) > 0) args.push('--memory', `${Math.floor(Number(docker.memoryMb))}m`);
    for (const [key, value] of Object.entries(env)) {
      if (value !== undefined) args.push('--env', `${key}=${value}`);
    }
    if (Array.isArray(docker.extraArgs)) {
      args.push(...docker.extraArgs.map(String).filter(arg => arg && !/[\r\n]/.test(arg)).slice(0, 20));
    }
    args.push(image, '/bin/sh', '-lc', command);
    return { backend: 'docker', executable: 'docker', args, cwd, env: this.minimumHostEnvironment(), displayCwd: '/workspace' };
  }

  private sshPlan(command: string, cwd: string, env: NodeJS.ProcessEnv, config: ExecutionConfig): ExecutionPlan {
    const ssh = config.ssh || {};
    const host = String(ssh.host || '').trim();
    const remoteWorkspace = String(ssh.remoteWorkspace || '').trim();
    if (!host || !remoteWorkspace) throw new Error('SSH execution requires execution.ssh.host and execution.ssh.remoteWorkspace.');
    const target = ssh.user ? `${String(ssh.user).trim()}@${host}` : host;
    const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new'];
    if (Number(ssh.port) > 0) args.push('-p', String(Math.floor(Number(ssh.port))));
    if (ssh.identityFile) args.push('-i', path.resolve(String(ssh.identityFile)));
    const remoteEnv = Object.entries(env)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${this.shellQuote(String(value))}`)
      .join(' ');
    args.push(target, `${remoteEnv ? `${remoteEnv} ` : ''}cd -- ${this.shellQuote(remoteWorkspace)} && ${command}`);
    return { backend: 'ssh', executable: 'ssh', args, cwd, env: this.minimumHostEnvironment(), displayCwd: `${target}:${remoteWorkspace}` };
  }

  private resolveWorkspace(workspacePath: string | undefined, allowProcessCwd: boolean, projectContext?: ProjectContext): string {
    const requested = String(workspacePath || '').trim();
    if (!requested) {
      if (projectContext) {
        // The active project owns the default cwd — never process.cwd().
        return projectContext.workspaceRoot;
      }
      // phase23-ok: explicit allowProcessCwd config opt-in (no project attached)
      if (allowProcessCwd) return process.cwd();
      throw new Error('Shell execution requires an attached project or General chat workspace.');
    }
    const resolved = path.resolve(requested);
    if (projectContext) {
      const ctx = validateProjectContext(projectContext);
      if (!isPathInsideWorkspace(resolved, ctx.workspaceRoot)) {
        const error: any = new Error(
          `WORKSPACE_BOUNDARY_VIOLATION\n\nActive project: ${ctx.projectName || ctx.projectId}\nActive workspace: ${ctx.workspaceRoot}\n\nRequested path:\n${resolved}\n\nThe requested path belongs to another workspace. Explicit cross-project authorization is required.`
        );
        error.code = 'WORKSPACE_BOUNDARY_VIOLATION';
        throw error;
      }
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error('Shell workspace does not exist or is not a directory.');
    }
    return resolved;
  }

  private filteredEnvironment(allowlist: string[]): NodeJS.ProcessEnv {
    const safeNames = new Set([
      'PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC',
      'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'USERNAME', 'USER', 'LANG', 'TERM'
    ]);
    for (const name of allowlist) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) safeNames.add(name);
    }
    const output: NodeJS.ProcessEnv = {};
    for (const name of safeNames) {
      const value = process.env[name];
      if (value === undefined) continue;
      if (/(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE)/i.test(name) && !allowlist.includes(name)) continue;
      output[name] = value;
    }
    return output;
  }

  private minimumHostEnvironment(): NodeJS.ProcessEnv {
    const output: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) {
      if (process.env[key] !== undefined) output[key] = process.env[key];
    }
    return output;
  }

  private shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'"'"'`)}'`;
  }

  private loadConfig(): ExecutionConfig {
    try {
      const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      return raw?.execution && typeof raw.execution === 'object' ? raw.execution : {};
    } catch {
      return {};
    }
  }
}

export const executionBackendManager = new ExecutionBackendManager();
