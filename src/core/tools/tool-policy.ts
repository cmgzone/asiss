/**
 * Tool policy — Hermes Evolution Phase 4 (foundation for Phase 5's PolicyEngine).
 *
 * Authorize a tool call before execution: ALLOW or DENY. Today this enforces
 * the workspace requirement (moved unchanged from AgentRunner) and optionally
 * allow/deny tool lists (off by default — flipping it on changes behavior, so
 * that is gated behind `enforceAllowDeny` until Phase 5 wires it deliberately).
 */

import { ToolRequest, ToolContext } from './tool-result';

export type PolicyDecision = 'ALLOW' | 'DENY';

export interface PolicyVerdict {
  decision: PolicyDecision;
  reason?: string;
}

const WORKSPACE_REQUIRED_TOOLS = ['shell', 'apply_patch', 'write_file'];

export interface ToolPolicyOptions {
  enforceAllowDeny?: boolean;
  allowedTools?: string[];
  deniedTools?: string[];
}

/** Authorize a native tool call. MCP/dynamic tools are not workspace-gated. */
export function authorizeNativeTool(
  request: ToolRequest,
  ctx: ToolContext,
  options: ToolPolicyOptions = {}
): PolicyVerdict {
  const name = request.name;

  // Workspace guard (unchanged from AgentRunner): project-scoped missions must
  // have an attached local folder before running commands or editing files.
  if (ctx.projectId && !ctx.workspacePath && WORKSPACE_REQUIRED_TOOLS.includes(name)) {
    return {
      decision: 'DENY',
      reason: 'This project has no attached local workspace. Create or select a workspace from the Projects page before running commands or editing files.'
    };
  }

  if (options.enforceAllowDeny) {
    const denied = new Set(options.deniedTools || []);
    if (denied.has(name)) {
      return { decision: 'DENY', reason: `Tool '${name}' is denied by policy.` };
    }
    const allowed = options.allowedTools;
    if (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes(name)) {
      return { decision: 'DENY', reason: `Tool '${name}' is not in the allowed tool list.` };
    }
  }

  return { decision: 'ALLOW' };
}
