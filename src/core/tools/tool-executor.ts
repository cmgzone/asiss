/**
 * Tool executor — Hermes Evolution Phase 4.
 *
 * The actual dispatch, moved unchanged from AgentRunner:
 *   - native skills, with semantic-error fallback to capability-alternative
 *     skills, automatic workspace checkpoints and session-arg injection;
 *   - MCP tools, with dynamic resolution of unknown names and closest-name
 *     suggestions when even that fails.
 */

import { ToolRequest, ToolContext, normalizeOutput } from './tool-result';
import {
  NativeSkillLike,
  McpGateway,
  DynamicToolGateway,
  SkillRegistryLike
} from './tool-registry';
import { fallbackSkillsFor, adaptFallbackArgs, closestToolNames } from './tool-selector';

export interface CheckpointGateway {
  create(workspacePath: string, reason: string, sessionId?: string): { id: string; reason: string };
  shouldCheckpointShell(command: string): boolean;
}

export interface NativeExecution {
  success: boolean;
  output?: string;
  error?: string;
  checkpoint?: { id: string; reason: string };
  fallback?: { requested: string; resolved: string };
  dynamic?: { requested: string; resolved: string };
}

export interface McpExecution {
  success: boolean;
  output?: string;
  error?: string;
  checkpoint?: { id: string; reason: string };
  fallback?: { requested: string; resolved: string };
  dynamic?: { requested: string; resolved: string };
}

/** Execute a native skill with the full AgentRunner behavior. */
export async function executeNativeSkill(
  request: ToolRequest,
  skill: NativeSkillLike,
  ctx: ToolContext,
  skills: SkillRegistryLike,
  checkpoints?: CheckpointGateway
): Promise<NativeExecution> {
  const name = request.name;
  const projectId = ctx.projectId || '';
  const workspacePath = ctx.workspacePath;
  const checkpointConfig = ctx.config?.checkpoints || {};
  const shellCommand = String(request.arguments?.command || '');
  const mutatesWorkspace = (name === 'apply_patch' && checkpointConfig.automaticBeforePatch !== false)
    || (name === 'shell'
      && checkpointConfig.automaticBeforeDestructiveShell !== false
      && (checkpoints?.shouldCheckpointShell(shellCommand) ?? false));

  let automaticCheckpoint: { id: string; reason: string } | null = null;
  if (checkpointConfig.enabled !== false && workspacePath && mutatesWorkspace && checkpoints) {
    try {
      automaticCheckpoint = checkpoints.create(
        workspacePath,
        `Before ${name}: ${name === 'shell' ? shellCommand : 'file patch'}`,
        ctx.sessionId
      );
    } catch (checkpointError: any) {
      if (checkpointConfig.required === true) throw checkpointError;
      console.warn(`[Checkpoints] Could not create automatic checkpoint: ${checkpointError?.message || checkpointError}`);
    }
  }

  const args: Record<string, any> = {
    ...(request.arguments || {}),
    __sessionId: ctx.sessionId,
    __projectId: projectId || undefined,
    __workspacePath: workspacePath
  };
  if (workspacePath && name === 'apply_patch') args.basePath = workspacePath;
  if (name === 'shell') args.__stream = ctx.stream;

  let nativeResult: any = await skill.execute(args);
  const failedPatchCount = Number(nativeResult?.summary?.failed || 0);
  let semanticError = nativeResult?.error
    || nativeResult?.success === false
    || failedPatchCount > 0;
  let fallbackUsed: { requested: string; resolved: string } | undefined;

  if (semanticError) {
    const requestedName = name;
    for (const altName of fallbackSkillsFor(requestedName, skills)) {
      const altSkill = skills.get(altName);
      if (!altSkill) continue;
      let altResult: any;
      try {
        altResult = await altSkill.execute(adaptFallbackArgs(altName, args));
      } catch {
        continue;
      }
      const altFailed = altResult?.error
        || altResult?.success === false
        || Number(altResult?.summary?.failed || 0) > 0;
      if (!altFailed) {
        nativeResult = altResult;
        semanticError = false;
        fallbackUsed = { requested: requestedName, resolved: altName };
        break;
      }
    }
  }

  if (semanticError) {
    const detail = typeof nativeResult?.error === 'string'
      ? [nativeResult.error, nativeResult.stderr, nativeResult.stdout]
          .map((value) => String(value || '').trim())
          .filter(Boolean)
          .join('\n')
      : (failedPatchCount > 0
        ? `${failedPatchCount} patch operation(s) failed: ${JSON.stringify(nativeResult?.results || [])}`
        : `Tool '${name}' reported failure.`);
    // The automatic checkpoint is still reported on failure so the host can
    // record it on the task (matches AgentRunner's pre-extraction behavior).
    return { success: false, error: detail, fallback: fallbackUsed, checkpoint: automaticCheckpoint || undefined };
  }

  return {
    success: true,
    output: normalizeOutput(automaticCheckpoint ? { result: nativeResult, checkpoint: automaticCheckpoint } : nativeResult),
    checkpoint: automaticCheckpoint || undefined,
    fallback: fallbackUsed
  };
}

/** Execute an MCP tool, falling back to dynamic resolution for unknown names. */
export async function executeMcpTool(
  request: ToolRequest,
  ctx: ToolContext,
  mcp: McpGateway,
  dynamicTools: DynamicToolGateway,
  skills: SkillRegistryLike
): Promise<McpExecution> {
  const name = request.name;
  let mcpResult: any;
  let dynamicOutput: string | null = null;
  let dynamicUsed: { requested: string; resolved: string } | undefined;

  try {
    mcpResult = await mcp.callTool(name, request.arguments);
  } catch (mcpErr: any) {
    const mcpMsg = String(mcpErr?.message || mcpErr);
    if (/not found in any connected MCP server/i.test(mcpMsg)) {
      const dynamic = await dynamicTools.resolve(name, request.arguments || {}, ctx.sessionId);
      if (dynamic.success) {
        dynamicOutput = normalizeOutput(dynamic.output);
        if (dynamic.tool && dynamic.tool !== name) {
          dynamicUsed = { requested: name, resolved: dynamic.tool };
        }
      } else {
        const skillNames = skills.getAll().map((s) => s.name);
        const mcpNames = mcp.getKnownToolNames();
        const available = Array.from(new Set([...skillNames, ...mcpNames])).sort();
        const closest = closestToolNames(name, available);
        const hint = closest.length > 0 ? ` Did you mean: ${closest.join(', ')}?` : '';
        return {
          success: false,
          error: `Tool '${name}' is not available: it is neither a registered skill nor provided by any connected MCP server, and could not be created dynamically.` +
            `${hint} Run the tools_diag skill to see exactly which tools are callable. Available tools: ${available.join(', ')}.`
        };
      }
    } else {
      return { success: false, error: String(mcpErr?.message || mcpErr) };
    }
  }

  if (dynamicOutput !== null) {
    return { success: true, output: dynamicOutput, dynamic: dynamicUsed };
  }
  if (mcpResult?.isError || mcpResult?.error || mcpResult?.success === false) {
    return {
      success: false,
      error: String(mcpResult?.error || mcpResult?.message || `MCP tool '${name}' reported failure.`)
    };
  }
  return { success: true, output: normalizeOutput(mcpResult), dynamic: dynamicUsed };
}
