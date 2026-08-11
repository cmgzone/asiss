import { Skill, SkillRegistry } from '../core/skills';
import type { ToolUsageStat } from '../core/analytics-tracker';

// ---------------------------------------------------------------------------
// Tool diagnostics: prints exactly which tools the model can call on the next
// turn (native skills + MCP servers + advertised list + alias coverage), so
// tool availability is never a mystery.
// ---------------------------------------------------------------------------

export interface AliasCoverage {
  pattern: string;
  target: string;
}

export interface ToolLimits {
  maxNativeTools: number;
  maxMcpToolsPerServer: number;
}

export interface ToolsDiagDeps {
  listMcpTools: () => Promise<any[]>;
  buildAdvertised: (sessionId: string, mcpTools: any[]) => any[];
  getAliasCoverage: () => AliasCoverage[];
  getLimits: () => ToolLimits;
  getUsageStats: () => ToolUsageStat[];
}

export interface ToolReport {
  report: string;
  advertised: any[];
  usage: ToolUsageStat[];
}

function clipList(names: string[], max = 900): string {
  if (names.length === 0) return '(none)';
  let out = names.join(', ');
  if (out.length > max) out = out.slice(0, max) + `… (+${names.length} total)`;
  return out;
}

export function buildToolReport(
  deps: ToolsDiagDeps,
  sessionId: string,
  mcpTools: any[],
  mcpListError?: string
): ToolReport {
  const advertised = deps.buildAdvertised(sessionId, mcpTools);
  const limits = deps.getLimits();
  // Mirror buildAdvertisedTools' session filtering so the denominator matches
  // the numerator (learned skills for other sessions are not counted).
  const nativeAll = SkillRegistry.getAll().filter((s) => {
    if (!Boolean(s.inputSchema)) return false;
    const learnedSessionId = (s as any).learnedSessionId;
    return !learnedSessionId || learnedSessionId === sessionId;
  });
  const nativeAdvertised = advertised.filter((t: any) => t.source === 'native');
  const mcpAdvertised = advertised.filter((t: any) => t.source !== 'native');

  const lines: string[] = [];
  lines.push('**🔧 Tool Diagnostics**');
  lines.push('');
  lines.push(`**Native skills:** ${nativeAdvertised.length}/${nativeAll.length} advertised (cap ${limits.maxNativeTools})`);
  lines.push(`> ${clipList(nativeAdvertised.map((t: any) => t.name).sort())}`);
  lines.push('');

  const byServer = new Map<string, any[]>();
  for (const tool of mcpTools || []) {
    const server = String(tool?.source || 'mcp');
    if (!byServer.has(server)) byServer.set(server, []);
    byServer.get(server)!.push(tool);
  }
  if (byServer.size > 0) {
    lines.push(`**MCP servers (${byServer.size}):**`);
    for (const [server, tools] of byServer.entries()) {
      const advertisedCount = mcpAdvertised.filter((t: any) => t.source === server).length;
      const serverNames = tools.map((t: any) => String(t?.name || '')).filter(Boolean).sort();
      lines.push(`- **${server}**: ${tools.length} tools (${advertisedCount} advertised, cap ${limits.maxMcpToolsPerServer}/server)`);
      lines.push(`  > ${clipList(serverNames)}`);
    }
    lines.push('');
  } else {
    lines.push('**MCP servers:** (none connected)');
    lines.push('');
  }
  if (mcpListError) {
    lines.push(`⚠️ **MCP listing failed:** ${mcpListError}`);
    lines.push('');
  }

  lines.push(`**Advertised to model on next turn: ${advertised.length} tools**`);
  lines.push(`> ${clipList(advertised.map((t: any) => t.name).sort(), 1200)}`);
  lines.push('');

  const aliases = deps.getAliasCoverage();
  if (aliases.length > 0) {
    lines.push(`**Alias coverage (${aliases.length} patterns) → target skill:**`);
    lines.push('```');
    for (const alias of aliases) {
      lines.push(`${alias.pattern}  →  ${alias.target}`);
    }
    lines.push('```');
  }

  // Usage stats: how often each advertised tool has been called (and with
  // what success), so unused tools stand out alongside what's available.
  const advertisedNames = new Set(advertised.map((t: any) => t.name));
  const usage = (deps.getUsageStats() || []).filter((u) => advertisedNames.has(u.toolName));
  if (usage.length > 0) {
    lines.push('');
    lines.push(`**Usage (calls → ok/err, top ${Math.min(15, usage.length)}):**`);
    lines.push('```');
    for (const u of usage.slice(0, 15)) {
      lines.push(`${u.toolName.slice(0, 28).padEnd(28)} ${String(u.calls).padStart(4)} calls  (${u.successes} ok / ${u.failures} err)`);
    }
    lines.push('```');
    const neverUsed = advertised.length - usage.filter((u) => u.calls > 0).length;
    if (neverUsed > 0) {
      lines.push(`_${neverUsed} advertised tool(s) have no recorded calls yet._`);
    }
  }

  return { report: lines.join('\n'), advertised, usage };
}

export class ToolsDiagSkill implements Skill {
  name = 'tools_diag';
  description = 'Diagnose tool availability: lists every tool the model can call on the next turn — native skills, connected MCP servers with their tools, the exact advertised list, and alias coverage. Use when a tool was not found or to check what is callable.';
  capabilities = ['tools_diag'];
  inputSchema = {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'Optional session id (usually provided automatically).' }
    },
    required: []
  };

  constructor(private deps: ToolsDiagDeps) {}

  async execute(params: any): Promise<any> {
    const sessionId = String(params?.__sessionId || params?.sessionId || 'default');
    let mcpTools: any[] = [];
    let mcpListError = '';
    try {
      mcpTools = await this.deps.listMcpTools();
    } catch (error: any) {
      mcpListError = error?.message || String(error);
      mcpTools = [];
    }
    const { report, advertised, usage } = buildToolReport(this.deps, sessionId, mcpTools, mcpListError || undefined);
    return {
      success: true,
      report,
      advertisedTools: advertised.map((t: any) => t.name).sort(),
      nativeSkillCount: advertised.filter((t: any) => t.source === 'native').length,
      mcpServers: Array.from(new Set((mcpTools || []).map((t: any) => String(t?.source || 'mcp')))),
      usageStats: usage.map((u) => ({ toolName: u.toolName, calls: u.calls, successes: u.successes, failures: u.failures })),
      mcpListError: mcpListError || undefined,
      hint: 'The "report" field is the human-readable version; pass it to the user when asked.'
    };
  }
}
