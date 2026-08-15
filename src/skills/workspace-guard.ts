/**
 * Workspace guard — Phase 23 shared helper for native skills.
 *
 * Every filesystem skill receives `__projectContext` (canonical) plus the
 * legacy `__workspacePath` / `__projectId` pairs. This module is the ONE place
 * skills resolve user/model-supplied paths:
 *
 *   - relative paths resolve against the workspace root (never process.cwd());
 *   - absolute paths are verified inside the workspace via assertWorkspacePath;
 *   - when no project is attached (unbound tools), behavior falls back to the
 *     legacy process.cwd() resolution so existing callers keep working.
 */

import path from 'path';
import {
  ProjectContext,
  WorkspaceBoundaryViolationError,
  assertWorkspacePath,
  projectContextFromParts,
  validateProjectContext
} from '../core/project-context';

/** Extract the canonical ProjectContext from skill params (validated). */
export function projectContextFromParams(params: any): ProjectContext | undefined {
  if (params && typeof params === 'object' && params.__projectContext && typeof params.__projectContext === 'object') {
    try {
      return validateProjectContext(params.__projectContext);
    } catch {
      // Fall through to legacy parts below; malformed contexts are treated as
      // absent so the skill can still fail with a clear workspace error.
    }
  }
  const built = projectContextFromParts({
    projectId: params?.__projectId,
    workspacePath: params?.__workspacePath
  });
  if (!built) return undefined;
  try {
    return validateProjectContext(built);
  } catch {
    return undefined;
  }
}

/** True when the skill call is bound to a project workspace. */
export function isProjectBound(params: any): boolean {
  return Boolean(projectContextFromParams(params));
}

/**
 * Resolve a skill path under the workspace boundary:
 *  - bound: relative -> workspace root; absolute -> assertWorkspacePath.
 *  - unbound: legacy process.cwd() resolution (compat).
 * Returns the resolved absolute path; throws WorkspaceBoundaryViolationError
 * when the requested path is outside the active workspace.
 */
export function resolveSkillPath(value: unknown, params: any): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const ctx = projectContextFromParams(params);

  if (ctx) {
    // Bound to a project: resolve relative against the workspace root.
    const resolved = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(ctx.workspaceRoot, raw);
    return assertWorkspacePath(resolved, ctx);
  }

  // Unbound (general chat / no attached workspace): legacy behavior.
  // phase23-ok: unbound fallbacks — no project is attached, so there is no
  // project workspace to violate; the boundary applies to bound calls only.
  if (raw === '~') return process.env.HOME || process.cwd(); // phase23-ok
  if (raw.startsWith('~/')) {
    const home = process.env.HOME || process.cwd(); // phase23-ok
    return path.resolve(home, raw.slice(2));
  }
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(process.cwd(), raw); // phase23-ok
}

/** The effective workspace root for a bound skill call ('' when unbound). */
export function skillWorkspaceRoot(params: any): string {
  return projectContextFromParams(params)?.workspaceRoot || '';
}

/** Convert a boundary violation into a structured skill error result. */
export function boundaryErrorResult(error: unknown, tool: string): any {
  if (error instanceof WorkspaceBoundaryViolationError) {
    return {
      success: false,
      error: error.message,
      code: error.code,
      blocked: true,
      activeProject: error.projectContext.projectName || error.projectContext.projectId,
      activeWorkspace: error.projectContext.workspaceRoot,
      requestedPath: error.requestedPath
    };
  }
  return { success: false, error: `${tool} blocked: ${error instanceof Error ? error.message : String(error)}`, blocked: true };
}
