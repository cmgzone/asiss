/**
 * ToolEngine — Hermes Evolution Phase 4.
 *
 * The single, consistent tool execution mechanism. Every tool call goes
 * through the same lifecycle regardless of where the tool comes from:
 *
 *   Discover -> Select (resolve name) -> Validate -> Authorize -> Execute
 *   -> Normalize result -> Record telemetry
 *
 * Native skills, MCP tools, dynamic tools and (later) learned skills are all
 * handled by one pipeline, extracted from AgentRunner. The host keeps the
 * mission-level orchestration (hooks, budgets, checkpoints' config policy is
 * read here) and simply calls `execute(request, ctx)`.
 */

import {
  ToolRequest,
  ToolContext,
  ToolResult,
  errorResult
} from './tool-result';
import {
  SkillRegistryLike,
  McpGateway,
  DynamicToolGateway,
  ToolDescriptor,
  listTools
} from './tool-registry';
import { normalizeToolRequest, getAliasCoverage } from './tool-selector';
import { validateToolArguments } from './tool-validator';
import { authorizeNativeTool } from './tool-policy';
import { executeNativeSkill, executeMcpTool, CheckpointGateway } from './tool-executor';
import { TaskEngine, taskEngine as defaultTaskEngine } from '../task';
import { analyticsTracker as defaultAnalytics } from '../analytics-tracker';

export interface ToolAnalytics {
  recordToolCallResult(sessionId: string, tool: string, success: boolean): void;
}

export interface ToolEngineDeps {
  skills: SkillRegistryLike;
  mcp: McpGateway;
  dynamicTools: DynamicToolGateway;
  /** Optional workspace checkpoints (Phase 12 integration point). */
  checkpoints?: CheckpointGateway;
  taskEngine?: TaskEngine;
  analytics?: ToolAnalytics;
  /** Off by default: enforcing allow/deny lists changes behavior; wired deliberately in Phase 5. */
  enforceAllowDeny?: boolean;
  allowedTools?: string[];
  deniedTools?: string[];
}

interface TaskToolRecord {
  id: string;
}

export class ToolEngine {
  private readonly skills: SkillRegistryLike;
  private readonly mcp: McpGateway;
  private readonly dynamicTools: DynamicToolGateway;
  private readonly checkpoints?: CheckpointGateway;
  private readonly taskEngine: TaskEngine;
  private readonly analytics: ToolAnalytics;
  private readonly enforceAllowDeny: boolean;
  private readonly allowedTools?: string[];
  private readonly deniedTools?: string[];

  constructor(deps: ToolEngineDeps) {
    this.skills = deps.skills;
    this.mcp = deps.mcp;
    this.dynamicTools = deps.dynamicTools;
    this.checkpoints = deps.checkpoints;
    this.taskEngine = deps.taskEngine || defaultTaskEngine;
    this.analytics = deps.analytics || defaultAnalytics;
    this.enforceAllowDeny = deps.enforceAllowDeny === true;
    this.allowedTools = deps.allowedTools;
    this.deniedTools = deps.deniedTools;
  }

  /** Unified catalog of every currently-known tool (native + MCP). */
  catalog(): ToolDescriptor[] {
    return listTools(this.skills, this.mcp.getKnownToolNames());
  }

  /** Alias patterns for diagnostics (tools_diag). */
  aliasCoverage(): Array<{ pattern: string; target: string }> {
    return getAliasCoverage();
  }

  /**
   * Execute one tool call through the canonical lifecycle. Never throws for
   * tool failures — returns a normalized ToolResult; unexpected errors are
   * caught, recorded as FAILED on the task and returned as failures.
   */
  async execute(request: ToolRequest, ctx: ToolContext = {}): Promise<ToolResult> {
    const normalized = normalizeToolRequest(request, this.skills, (name) => this.dynamicTools.normalizeName(name));
    const nativeSkill = this.skills.get(normalized.name);
    const isNative = Boolean(nativeSkill);

    // Record STARTED before dispatch (matches the previous behavior where the
    // task record existed even for calls that then failed validation/policy).
    const taskRecord: TaskToolRecord | null = ctx.taskId
      ? await this.startTaskRecord(ctx.taskId, normalized)
      : null;

    try {
      // ---- Validate ----
      const validation = validateToolArguments(normalized, isNative ? { name: normalized.name, source: 'native' } : undefined);
      if (!validation.valid) {
        await this.finishTaskRecord(ctx.taskId, taskRecord, { status: 'FAILED', error: validation.reason });
        this.analytics.recordToolCallResult(ctx.sessionId || '', normalized.name, false);
        return errorResult(normalized.name, validation.reason || 'Invalid tool arguments.');
      }

      // ---- Authorize (native tools only; MCP/dynamic are not workspace-gated) ----
      if (isNative) {
        const verdict = authorizeNativeTool(normalized, ctx, {
          enforceAllowDeny: this.enforceAllowDeny,
          allowedTools: this.allowedTools,
          deniedTools: this.deniedTools
        });
        if (verdict.decision === 'DENY') {
          await this.finishTaskRecord(ctx.taskId, taskRecord, { status: 'FAILED', error: verdict.reason });
          this.analytics.recordToolCallResult(ctx.sessionId || '', normalized.name, false);
          return errorResult(normalized.name, verdict.reason || 'Tool call denied by policy.', {
            denied: true,
            reason: verdict.reason
          });
        }
      }

      // ---- Execute ----
      const executed = isNative
        ? await executeNativeSkill(normalized, nativeSkill!, ctx, this.skills, this.checkpoints)
        : await executeMcpTool(normalized, ctx, this.mcp, this.dynamicTools, this.skills);

      // ---- Record (checkpoint + telemetry) ----
      if (ctx.taskId && executed.checkpoint) {
        try {
          await this.taskEngine.recordCheckpoint(ctx.taskId, executed.checkpoint);
        } catch (taskError: any) {
          console.warn('[TaskEngine] record checkpoint failed:', taskError?.message || taskError);
        }
      }

      if (!executed.success) {
        await this.finishTaskRecord(ctx.taskId, taskRecord, { status: 'FAILED', error: executed.error });
        this.analytics.recordToolCallResult(ctx.sessionId || '', normalized.name, false);
        return {
          success: false,
          name: normalized.name,
          source: isNative ? 'native' : 'mcp',
          error: executed.error,
          fallback: executed.fallback,
          dynamic: executed.dynamic
        };
      }

      await this.finishTaskRecord(ctx.taskId, taskRecord, { status: 'COMPLETED', output: executed.output });
      this.analytics.recordToolCallResult(ctx.sessionId || '', normalized.name, true);
      return {
        success: true,
        name: normalized.name,
        source: isNative ? 'native' : 'mcp',
        output: executed.output,
        checkpoint: executed.checkpoint,
        fallback: executed.fallback,
        dynamic: executed.dynamic
      };
    } catch (error: any) {
      await this.finishTaskRecord(ctx.taskId, taskRecord, { status: 'FAILED', error: error?.message || String(error) });
      this.analytics.recordToolCallResult(ctx.sessionId || '', normalized.name, false);
      return errorResult(normalized.name, error?.message || String(error));
    }
  }

  private async startTaskRecord(taskId: string, request: ToolRequest): Promise<TaskToolRecord | null> {
    try {
      const exec = await this.taskEngine.recordToolExecution(taskId, {
        name: request.name,
        arguments: request.arguments || {},
        status: 'STARTED'
      });
      return { id: exec.id };
    } catch (taskError: any) {
      console.warn('[TaskEngine] record tool start failed:', taskError?.message || taskError);
      return null;
    }
  }

  private async finishTaskRecord(
    taskId: string | undefined,
    record: TaskToolRecord | null,
    patch: { status: 'COMPLETED' | 'FAILED'; output?: string; error?: string }
  ): Promise<void> {
    if (!taskId || !record) return;
    try {
      await this.taskEngine.completeToolExecution(taskId, record.id, patch);
    } catch (taskError: any) {
      console.warn('[TaskEngine] record tool completion failed:', taskError?.message || taskError);
    }
  }
}
