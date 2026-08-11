import { checkpointManager } from '../core/checkpoint-manager';
import { Skill, SkillRegistry } from '../core/skills';
import { Tool } from '../core/models';

interface WorkflowDeps {
  listMcpTools: () => Promise<Tool[]>;
  callMcpTool: (name: string, args: any) => Promise<any>;
}

export class ExecuteWorkflowSkill implements Skill {
  name = 'execute_workflow';
  description = 'Execute a validated multi-step workflow of existing tools in one agent turn. Steps run sequentially and can reference prior outputs without evaluating arbitrary code.';
  inputSchema = {
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        minItems: 1,
        maxItems: 20,
        items: {
          type: 'object',
          properties: {
            tool: { type: 'string' },
            arguments: { type: 'object' },
            onError: { type: 'string', enum: ['stop', 'continue'] }
          },
          required: ['tool', 'arguments']
        }
      }
    },
    required: ['steps']
  };

  constructor(private readonly deps: WorkflowDeps) {}

  async execute(params: any) {
    const steps = Array.isArray(params?.steps) ? params.steps.slice(0, 20) : [];
    if (!steps.length) return { success: false, error: 'At least one workflow step is required.' };
    const denied = new Set([
      this.name, 'delegate_agent', 'models', 'skill_marketplace', 'trusted_actions',
      'send_email', 'send_telegram', 'webhook_post', 'a2a_client'
    ]);
    const mcpTools = await this.deps.listMcpTools();
    const mcpNames = new Set(mcpTools.map(tool => tool.name));
    const results: Array<{ tool: string; success: boolean; output?: any; error?: string }> = [];
    const input = Object.fromEntries(Object.entries(params || {}).filter(([key]) => !key.startsWith('__') && key !== 'steps'));
    const runtime = Object.fromEntries(Object.entries(params || {}).filter(([key]) => key.startsWith('__')));

    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index] || {};
      const tool = String(step.tool || '').trim();
      if (!tool || denied.has(tool) || tool.startsWith('learned_')) {
        return { success: false, error: `Workflow step ${index + 1} uses a disallowed tool: ${tool || '(missing)'}`, steps: results };
      }
      const native = SkillRegistry.get(tool);
      if (!native && !mcpNames.has(tool)) {
        return { success: false, error: `Workflow step ${index + 1} references an unavailable tool: ${tool}`, steps: results };
      }
      const args = this.render(step.arguments || {}, { input, steps: results, lastOutput: results[results.length - 1]?.output });
      const runtimeArgs: any = { ...(args as any), ...runtime };
      if (runtime.__workspacePath && tool === 'apply_patch') runtimeArgs.basePath = runtime.__workspacePath;

      try {
        if (runtime.__workspacePath && (tool === 'apply_patch' || (tool === 'shell' && checkpointManager.shouldCheckpointShell(String(runtimeArgs.command || ''))))) {
          checkpointManager.create(String(runtime.__workspacePath), `Before workflow ${tool}: ${String(runtimeArgs.command || 'file patch')}`, String(runtime.__sessionId || 'workflow'));
        }
        const output = native
          ? await native.execute(runtimeArgs)
          : await this.deps.callMcpTool(tool, args || {});
        if (output?.error || output?.success === false || Number(output?.summary?.failed || 0) > 0) {
          throw new Error(String(output?.error || `Tool '${tool}' reported failure.`));
        }
        results.push({ tool, success: true, output });
      } catch (error: any) {
        results.push({ tool, success: false, error: error?.message || String(error) });
        if (step.onError !== 'continue') {
          return { success: false, failedAt: index, steps: results, error: results[results.length - 1]?.error };
        }
      }
    }
    return { success: results.every(result => result.success), count: results.length, steps: results, output: results[results.length - 1]?.output };
  }

  private render(value: unknown, context: Record<string, any>): unknown {
    if (typeof value === 'string') {
      const exact = /^\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}$/.exec(value);
      if (exact) return this.resolve(exact[1], context);
      return value.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, key) => {
        const resolved = this.resolve(key, context);
        return typeof resolved === 'string' ? resolved : JSON.stringify(resolved ?? '');
      });
    }
    if (Array.isArray(value)) return value.map(item => this.render(item, context));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !key.startsWith('__') && !['__proto__', 'prototype', 'constructor'].includes(key))
        .map(([key, child]) => [key, this.render(child, context)]));
    }
    return value;
  }

  private resolve(key: string, context: Record<string, any>): unknown {
    const normalized = key.startsWith('input.') || key.startsWith('steps.') || key === 'lastOutput' ? key : `input.${key}`;
    return normalized.split('.').reduce((current: any, part: string) => current == null ? undefined : current[part], context);
  }
}
