/**
 * ProjectContext — Phase 23 (Project Context & Workspace Isolation).
 *
 * The single canonical identity for "which project is this agent working on".
 * Every conversation, execution, sub-agent, memory lookup, repository lookup
 * and filesystem/tool operation must be bound to exactly one ProjectContext.
 *
 *   ASISS ENGINE (ENGINE_ROOT — this process)
 *        |  operates on
 *        v
 *   USER PROJECT (workspaceRoot)
 *        |
 *   Memory · Repo index · Tools · Sub-agents
 *        v
 *   SAME PROJECT ROOT
 *
 * The invariant this module enforces:
 *   Every piece of context an agent receives and every operation an agent
 *   performs belongs to the same active ProjectContext, unless the user
 *   explicitly authorizes cross-project access (request_cross_project_access /
 *   switch_project).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { atomicWriteJsonSync } from './atomic-write';

/** Identifier used when no user project is attached (General chats/workspace). */
export const GENERAL_PROJECT_ID = 'general';

/**
 * The one canonical project-context shape. Do NOT create competing
 * representations — migrate legacy `projectId` / `workspacePath` pairs into
 * this object.
 */
export interface ProjectContext {
  /** Stable project id ('general' for unbound general chats/workspace). */
  projectId: string;
  /** Human project name (e.g. 'PikiPOS'). Normalized contexts always carry it. */
  projectName?: string;
  /**
   * Absolute path to the project root. Every filesystem/tool operation an
   * agent performs must resolve inside this directory.
   */
  workspaceRoot: string;
  /** Optional repository root (must be inside workspaceRoot when supplied). */
  repositoryRoot?: string;
  /** Conversation this context is bound to, when any. */
  conversationId?: string;
}

/** A record that can carry project attribution (executions, tool calls). */
export interface ProjectAttribution {
  projectId?: string;
  projectName?: string;
  workspaceRoot?: string;
}

/** Validation failure. Thrown when a ProjectContext is malformed. */
export class ProjectContextError extends Error {
  readonly code = 'PROJECT_CONTEXT_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'ProjectContextError';
  }
}

/**
 * Structured workspace boundary violation. This is the enforcement error the
 * boundary returns when an operation targets a path outside the active
 * workspace:
 *
 *   WORKSPACE_BOUNDARY_VIOLATION
 *
 *   Active project: MyApp
 *   Active workspace: C:\Projects\MyApp
 *   Requested path: C:\Projects\ASISS\src\server.ts
 *
 *   The requested path belongs to another workspace.
 *   Explicit cross-project authorization is required.
 */
export class WorkspaceBoundaryViolationError extends Error {
  readonly code = 'WORKSPACE_BOUNDARY_VIOLATION' as const;
  readonly projectContext: ProjectContext;
  readonly requestedPath: string;
  readonly authorized: boolean;

  constructor(projectContext: ProjectContext, requestedPath: string, options: { authorized?: boolean } = {}) {
    const authorized = options.authorized === true;
    const lines = [
      'WORKSPACE_BOUNDARY_VIOLATION',
      '',
      `Active project: ${projectContext.projectName || projectContext.projectId}`,
      `Active workspace: ${projectContext.workspaceRoot}`,
      '',
      'Requested path:',
      requestedPath,
      '',
      'The requested path belongs to another workspace.',
      authorized
        ? 'Explicit cross-project authorization has been granted for this request.'
        : 'Explicit cross-project authorization is required.'
    ];
    super(lines.join('\n'));
    this.name = 'WorkspaceBoundaryViolationError';
    this.projectContext = projectContext;
    this.requestedPath = requestedPath;
    this.authorized = authorized;
  }
}

/** True when a workspace path exists and is a directory. */
export function isExistingDirectory(value: unknown): boolean {
  const candidate = typeof value === 'string' ? value.trim() : '';
  if (!candidate) return false;
  try {
    return fs.existsSync(candidate) && fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/** Case-normalized path comparison (Windows is case-insensitive). */
export function comparePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Resolve a path and answer whether it is inside the workspace root. */
export function isPathInsideWorkspace(requestedPath: string, workspaceRoot: string): boolean {
  const root = comparePath(workspaceRoot);
  const candidate = comparePath(requestedPath);
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

/**
 * Validate a ProjectContext. Enforces:
 *   - projectId exists
 *   - workspaceRoot exists, is absolute and is an existing directory
 *   - repositoryRoot, when supplied, is inside workspaceRoot
 * Returns the context (for chaining); throws ProjectContextError otherwise.
 */
export function validateProjectContext(ctx: ProjectContext | undefined | null): ProjectContext {
  if (!ctx || typeof ctx !== 'object') {
    throw new ProjectContextError('A ProjectContext is required for this operation.');
  }
  const projectId = String(ctx.projectId || '').trim();
  if (!projectId) {
    throw new ProjectContextError('ProjectContext.projectId is required.');
  }
  const workspaceRoot = typeof ctx.workspaceRoot === 'string' ? ctx.workspaceRoot.trim() : '';
  if (!workspaceRoot) {
    throw new ProjectContextError(`ProjectContext.workspaceRoot is required (project '${projectId}').`);
  }
  if (!path.isAbsolute(workspaceRoot)) {
    throw new ProjectContextError(`ProjectContext.workspaceRoot must be absolute (project '${projectId}': '${workspaceRoot}').`);
  }
  if (!isExistingDirectory(workspaceRoot)) {
    throw new ProjectContextError(`ProjectContext.workspaceRoot does not exist or is not a directory (project '${projectId}': '${workspaceRoot}').`);
  }
  if (ctx.repositoryRoot) {
    const repositoryRoot = String(ctx.repositoryRoot).trim();
    if (!path.isAbsolute(repositoryRoot)) {
      throw new ProjectContextError(`ProjectContext.repositoryRoot must be absolute (project '${projectId}': '${repositoryRoot}').`);
    }
    if (!isPathInsideWorkspace(repositoryRoot, workspaceRoot)) {
      throw new ProjectContextError(`ProjectContext.repositoryRoot must be inside workspaceRoot (project '${projectId}': '${repositoryRoot}' not inside '${workspaceRoot}').`);
    }
  }
  const normalized: ProjectContext = {
    projectId,
    projectName: String(ctx.projectName || projectId).trim() || projectId,
    workspaceRoot,
    repositoryRoot: ctx.repositoryRoot,
    conversationId: ctx.conversationId
  };
  return normalized;
}

/** Build a ProjectContext from legacy parts (projectId + workspacePath + name). */
export function projectContextFromParts(parts: {
  projectId?: string | null;
  projectName?: string | null;
  workspacePath?: string | null;
  conversationId?: string | null;
}): ProjectContext | undefined {
  const workspaceRoot = typeof parts.workspacePath === 'string' ? parts.workspacePath.trim() : '';
  const projectId = String(parts.projectId || '').trim() || (workspaceRoot ? GENERAL_PROJECT_ID : '');
  if (!projectId || !workspaceRoot) return undefined;
  return {
    projectId,
    projectName: String(parts.projectName || '').trim() || projectId,
    workspaceRoot,
    conversationId: parts.conversationId ? String(parts.conversationId).trim() : undefined
  };
}

/**
 * The workspace security boundary — the most important enforcement point.
 * Resolves `requestedPath` and verifies it is inside `projectContext.workspaceRoot`.
 * Returns the resolved, normalized path on success; throws
 * WorkspaceBoundaryViolationError otherwise.
 *
 * When `authorized` is true (explicit cross-project access granted), the
 * boundary still reports the violation shape but marks it authorized — callers
 * that truly need ENGINE_ROOT access (e.g. "modify ASISS itself") can catch and
 * allow with audit, but the request must have passed through
 * request_cross_project_access first.
 */
export function assertWorkspacePath(
  requestedPath: string,
  projectContext: ProjectContext,
  options: { authorized?: boolean; allowEngineRoot?: boolean } = {}
): string {
  const ctx = projectContext && projectContext.workspaceRoot ? projectContext : validateProjectContext(projectContext);
  const raw = String(requestedPath || '').trim();
  if (!raw) {
    throw new ProjectContextError('assertWorkspacePath: a path is required.');
  }
  const resolved = path.resolve(raw);
  if (isPathInsideWorkspace(resolved, ctx.workspaceRoot)) return resolved;

  // Engine-root operations (modifying ASISS itself) are only reachable via an
  // explicit cross-project authorization; a bare call is never silently allowed.
  if (options.authorized === true) {
    throw new WorkspaceBoundaryViolationError(ctx, resolved, { authorized: true });
  }
  throw new WorkspaceBoundaryViolationError(ctx, resolved);
}

/** The directory the ASISS engine itself runs from (this process). */
export function engineRoot(): string {
  return path.resolve(process.cwd());
}

/** Normalize a workspace path for attribution comparisons. */
export function workspaceRootOf(value: string): string {
  return path.resolve(String(value || '').trim());
}

/**
 * Pre-execution context sanity check (Phase 23 §16). Verifies a tool call's
 * project attribution matches the execution's ProjectContext before any
 * filesystem work happens. Catches context corruption before it becomes a
 * filesystem mistake.
 */
export function validateToolContext(
  tool: ProjectAttribution,
  execution: ProjectContext | ProjectAttribution,
  toolName?: string
): void {
  const execProjectId = String(execution.projectId || '').trim();
  const toolProjectId = String(tool.projectId || '').trim();
  const execWorkspace = String(execution.workspaceRoot || '').trim();
  const toolWorkspace = String(tool.workspaceRoot || '').trim();

  if (execProjectId && toolProjectId && toolProjectId !== execProjectId) {
    throw new WorkspaceBoundaryViolationError(
      { projectId: execProjectId, projectName: String(execution.projectName || execProjectId), workspaceRoot: execWorkspace || process.cwd() },
      `tool '${toolName || tool.projectId || '?'}' attributed to project '${toolProjectId}'`
    );
  }
  if (execWorkspace && toolWorkspace && comparePath(toolWorkspace) !== comparePath(execWorkspace)) {
    throw new WorkspaceBoundaryViolationError(
      { projectId: execProjectId || GENERAL_PROJECT_ID, projectName: String(execution.projectName || execProjectId || 'General'), workspaceRoot: execWorkspace },
      `tool '${toolName || '?'}' workspace '${toolWorkspace}' does not match execution workspace '${execWorkspace}'`
    );
  }
}

/** Strip surrounding quotes from a shell word (PowerShell/cmd/posix). */
function stripShellQuotes(value: string): string {
  let out = value.trim();
  while (
    (out.startsWith('"') && out.endsWith('"')) ||
    (out.startsWith("'") && out.endsWith("'"))
  ) {
    if (out.length < 2) break;
    out = out.slice(1, -1).trim();
  }
  return out;
}

/**
 * Shell boundary: reject a command that would move the shell working directory
 * outside the active workspace (Phase 23 §11). Detects `cd <path>` /
 * `Set-Location <path>` / `cd ..` chains that escape the root. Returns null
 * when the command is safe, otherwise the violation message.
 */
export function inspectShellCommand(command: string, projectContext: ProjectContext): string | null {
  const ctx = projectContext && projectContext.workspaceRoot ? projectContext : validateProjectContext(projectContext);
  const lines = String(command || '').split(/[\r\n;&&||]+/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    // cd <path> | Set-Location <path> | Set-Location -Path <path>
    const cdMatch = /^(?:cd|Set-Location|pushd|popd)(?:\s+-Path\s+|\s+)(.+)$/i.exec(line)
      || /^(?:cd|Set-Location|pushd)(?:\s*=\s*)(.+)$/i.exec(line);
    if (!cdMatch) continue;

    const target = stripShellQuotes(cdMatch[1].trim());
    if (!target) continue;
    // Interpolated/relative-to-home targets can't be statically verified — the
    // final cwd is still validated by execution-backend before spawn.
    if (target.startsWith('$') || target.startsWith('%') || target.startsWith('~')) continue;

    let resolved: string;
    try {
      resolved = path.resolve(ctx.workspaceRoot, target);
    } catch {
      continue;
    }
    if (!isPathInsideWorkspace(resolved, ctx.workspaceRoot)) {
      return new WorkspaceBoundaryViolationError(ctx, resolved).message;
    }
  }
  return null;
}

/** ------------------------------------------------------------------ */
/* Project context registry — conversation → project, active project,   */
/* explicit cross-project authorization (Phase 23 §3 / §13).            */
/** ------------------------------------------------------------------ */

export interface ProjectContextRegistryOptions {
  /** Path for the durable conversation→project binding store. */
  bindingsPath?: string;
}

/**
 * Binds conversations to projects, tracks the active project per user, and
 * records explicit cross-project authorizations. The active project is NEVER
 * inferred from process.cwd() or "the last project used" — it comes from this
 * registry (populated by Select/Create Project → ProjectContext → Conversation).
 */
export class ProjectContextRegistry {
  private readonly conversationBindings = new Map<string, ProjectContext>();
  private readonly userActive = new Map<string, ProjectContext>();
  /** user -> set of projectIds the user has explicitly authorized. */
  private readonly crossProjectGrants = new Map<string, Set<string>>();
  private readonly bindingsPath: string;

  constructor(options: ProjectContextRegistryOptions = {}) {
    const oneDrive = String(process.env.OneDrive || process.env.ONEDRIVE || '').trim();
    const dataRoot = process.env.GITU_DATA_ROOT
      ? path.resolve(process.env.GITU_DATA_ROOT)
      : path.join(oneDrive || path.join(os.homedir(), 'Documents'), 'Gitu Data');
    this.bindingsPath = options.bindingsPath || path.join(dataRoot, 'project-bindings.json');
    this.load();
  }

  /** Bind conversationId → projectContext (Phase 23 §3). */
  bindConversation(conversationId: string, projectContext: ProjectContext): ProjectContext {
    const validated = validateProjectContext(projectContext);
    const key = String(conversationId || '').trim();
    if (!key) throw new ProjectContextError('bindConversation requires a conversation id.');
    this.conversationBindings.set(key, { ...validated, conversationId: key });
    this.save();
    return this.conversationBindings.get(key)!;
  }

  /** The project a conversation is bound to (undefined when unbound). */
  projectForConversation(conversationId: string): ProjectContext | undefined {
    return this.conversationBindings.get(String(conversationId || '').trim());
  }

  /** True when a conversation is bound to a project. */
  isConversationBound(conversationId: string): boolean {
    return this.conversationBindings.has(String(conversationId || '').trim());
  }

  /** Set the active project for a user (Select/Create Project). */
  setActiveProject(userId: string, projectContext: ProjectContext): ProjectContext {
    const validated = validateProjectContext(projectContext);
    this.userActive.set(String(userId || '').trim(), validated);
    return validated;
  }

  /** The active project for a user (undefined when none selected). */
  activeProjectFor(userId: string): ProjectContext | undefined {
    return this.userActive.get(String(userId || '').trim());
  }

  /**
   * Explicit project switch (Phase 23 §13). Old context disappears from the
   * active execution — the new project becomes the only active identity.
   */
  switchProject(userId: string, projectContext: ProjectContext): ProjectContext {
    const validated = validateProjectContext(projectContext);
    const key = String(userId || '').trim();
    this.userActive.delete(key);
    this.userActive.set(key, validated);
    return validated;
  }

  /** Explicitly authorize cross-project access to a project (Phase 23 §13). */
  authorizeCrossProjectAccess(userId: string, projectId: string): void {
    const key = String(userId || '').trim();
    const grants = this.crossProjectGrants.get(key) || new Set<string>();
    grants.add(String(projectId || '').trim());
    this.crossProjectGrants.set(key, grants);
  }

  /** Whether a user has explicitly authorized access to a project. */
  isCrossProjectAuthorized(userId: string, projectId: string): boolean {
    return Boolean(this.crossProjectGrants.get(String(userId || '').trim())?.has(String(projectId || '').trim()));
  }

  /** Resolve a project for an execution: conversation binding, else active. */
  resolveFor(userId: string, conversationId?: string): ProjectContext | undefined {
    if (conversationId) {
      const bound = this.projectForConversation(conversationId);
      if (bound) return bound;
    }
    return this.activeProjectFor(userId);
  }

  /** All conversation bindings (for diagnostics). */
  bindings(): Array<{ conversationId: string; project: ProjectContext }> {
    return [...this.conversationBindings.entries()].map(([conversationId, project]) => ({ conversationId, project }));
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.bindingsPath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.bindingsPath, 'utf8'));
      const bindings = Array.isArray(parsed?.conversations) ? parsed.conversations : [];
      for (const entry of bindings) {
        if (!entry || typeof entry !== 'object') continue;
        const conversationId = String(entry.conversationId || '').trim();
        const project = entry.project as ProjectContext | undefined;
        if (!conversationId || !project || typeof project.workspaceRoot !== 'string') continue;
        try {
          this.conversationBindings.set(conversationId, validateProjectContext({ ...project, conversationId }));
        } catch {
          // A stale binding to a deleted/moved workspace is dropped, never
          // resurrected as an active project.
        }
      }
      const users = parsed?.users && typeof parsed.users === 'object' ? parsed.users : {};
      for (const [userId, raw] of Object.entries(users)) {
        const active = (raw as any)?.activeProject as ProjectContext | undefined;
        if (active && typeof active.workspaceRoot === 'string') {
          try {
            this.userActive.set(userId, validateProjectContext(active));
          } catch {
            // stale active project — ignored; the user must re-select.
          }
        }
        const grants = (raw as any)?.grants;
        if (Array.isArray(grants)) this.crossProjectGrants.set(userId, new Set(grants.map(String)));
      }
    } catch (err: any) {
      console.warn('[ProjectContextRegistry] load failed:', err?.message || err);
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.bindingsPath), { recursive: true });
      const payload = {
        conversations: [...this.conversationBindings.entries()].map(([conversationId, project]) => ({ conversationId, project })),
        users: Object.fromEntries(
          [...this.userActive.entries()].map(([userId, project]) => [
            userId,
            { activeProject: project, grants: [...(this.crossProjectGrants.get(userId) || [])] }
          ])
        )
      };
      // Phase 22 discipline — resilient atomic write (retry + copy fallback):
      // a transient OneDrive lock must not lose conversation->project bindings.
      atomicWriteJsonSync(this.bindingsPath, payload);
    } catch (err: any) {
      console.warn('[ProjectContextRegistry] save failed:', err?.message || err);
    }
  }
}

/** Process-wide registry (matches existing manager conventions). */
export const projectContextRegistry = new ProjectContextRegistry();
