import { Skill, SkillRegistry } from './skills';
import fs from 'fs';
import path from 'path';
import { atomicWriteJsonSync } from './atomic-write';

// ---------------------------------------------------------------------------
// DynamicToolManager
//
// Solves "tool not found in mcp or skills":
//  1. Routes common hallucinated/MCP-style tool names to registered skills by
//     capability pattern (read_file -> read_file, mcp__fs__read_file -> ...).
//  2. If nothing matches, materializes a NEW skill on the fly and registers it,
//     so the agent "adds the tool itself" instead of hard-failing. The dynamic
//     skill executes through a generic interpreter (the model) that maps the
//     unknown call to real capabilities, or answers directly.
//  3. Persists created tools so they survive restarts.
// ---------------------------------------------------------------------------

interface DynamicToolRecord {
  name: string;
  routedTo?: string;      // known skill name this alias forwards to
  generic?: boolean;      // created as a generic interpreted tool
  description?: string;
  createdAt: number;
  calls: number;
}

interface RouteRule {
  re: RegExp;
  skill: string;
}

const ROUTES: RouteRule[] = [
  { re: /^(read_file|readfile|read-file|cat|read_text_file|view_file|get_file_contents)$/i, skill: 'read_file' },
  { re: /^(write_file|writefile|write-file|create_file|save_file|save|append_file)$/i, skill: 'write_file' },
  { re: /^(list_directory|listdir|ls|list_files|list_dir|read_directory|dir|folder_contents)$/i, skill: 'list_directory' },
  { re: /^(glob|find_files|find|search_files|file_search|rg|ripgrep|search_in_files)$/i, skill: 'glob' },
  { re: /^(search_web|websearch|google_search|web_search_query)$/i, skill: 'web_search' },
  { re: /^(fetch_url|http_get|get_url|scrape|extract_text|web_fetch)$/i, skill: 'web_fetch' },
  { re: /^(current_time|get_time|time_now|now|what_time)$/i, skill: 'current_time' },
  { re: /^(system_info|get_system_info|machine_info|os_info)$/i, skill: 'system_info' },
  { re: /^(code_search|search_code|find_in_code|grep_code)$/i, skill: 'code_search' },
  { re: /^(send_email|email|mail|send_mail)$/i, skill: 'send_email' },
  { re: /^(send_telegram|telegram|tg)$/i, skill: 'send_telegram' },
  { re: /^(list_skills|get_skills|available_tools|list_tools|show_tools)$/i, skill: '__catalog__' }
];

export class DynamicToolManager {
  private storePath: string;
  private records: Map<string, DynamicToolRecord> = new Map();
  private interpreter: (prompt: string) => Promise<string>;

  constructor(interpreter: (prompt: string) => Promise<string>, storePath?: string) {
    this.interpreter = interpreter;
    this.storePath = storePath || path.join(process.cwd(), 'dynamic_tools.json');
    this.load();
  }

  // Strip MCP-style prefixes: "mcp__filesystem__read_file" -> "read_file",
  // "mcp_playwright_screenshot" -> "playwright_screenshot", "filesystem.read_file".
  normalizeName(name: string): string {
    let out = String(name || '').trim().toLowerCase().replace(/^mcp[_-]+/i, '');
    if (out.includes('__')) out = out.split('__').pop() || out;
    if (out.includes('.')) out = out.split('.').pop() || out;
    return out.replace(/[^a-z0-9_-]+/g, '_');
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.storePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.storePath, 'utf-8'));
      const list = Array.isArray(parsed) ? parsed : parsed?.tools;
      if (!Array.isArray(list)) return;
      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const name = this.normalizeName(item.name);
        if (!name) continue;
        this.records.set(name, {
          name,
          routedTo: typeof item.routedTo === 'string' ? item.routedTo : undefined,
          generic: item.generic === true,
          description: typeof item.description === 'string' ? item.description : undefined,
          createdAt: Number(item.createdAt) || Date.now(),
          calls: Math.max(0, Number(item.calls) || 0)
        });
      }
    } catch {
      this.records.clear();
    }
  }

  private save(): void {
    // Phase 22 — resilient atomic write. Dynamic tools are best-effort
    // persistence; a transient lock must never throw out of a tool call.
    atomicWriteJsonSync(this.storePath, { tools: Array.from(this.records.values()) });
  }

  // Re-register persisted aliases whose target skills exist. Called at startup
  // after all native skills are registered.
  rehydrate(): void {
    for (const record of this.records.values()) {
      if (record.routedTo && SkillRegistry.get(record.routedTo)) {
        this.registerAlias(record);
      }
    }
  }

  private registerAlias(record: DynamicToolRecord): boolean {
    if (!record.routedTo) return false;
    const target = SkillRegistry.get(record.routedTo);
    if (!target) return false;
    const alias: Skill = {
      name: record.name,
      description: record.description || target.description,
      capabilities: Array.isArray(target.capabilities) ? [...target.capabilities] : undefined,
      inputSchema: target.inputSchema,
      execute: (params: any) => target.execute(params)
    };
    SkillRegistry.register(alias);
    return true;
  }

  private record(record: DynamicToolRecord): void {
    this.records.set(record.name, record);
    this.save();
  }

  // Attempt to resolve a tool call that was not found as a native skill or MCP
  // tool. Returns { success, output } or { success: false, error }.
  async resolve(name: string, args: any, sessionId?: string): Promise<{ success: boolean; output?: any; error?: string; tool?: string }> {
    const normalized = this.normalizeName(name);
    if (!normalized) return { success: false, error: 'Empty tool name.' };

    // 1. Already registered (e.g. persisted alias or native skill under a
    //    normalized name we haven't checked).
    const existing = SkillRegistry.get(normalized);
    if (existing && normalized !== name && !this.isSelfReferential(existing)) {
      return this.executeSkill(existing, normalized, args, sessionId);
    }

    // 2. Route by pattern.
    for (const rule of ROUTES) {
      if (rule.re.test(normalized)) {
        if (rule.skill === '__catalog__') {
          return { success: true, output: this.catalogText() };
        }
        const target = SkillRegistry.get(rule.skill);
        if (target) {
          const record: DynamicToolRecord = {
            name: normalized,
            routedTo: rule.skill,
            description: target.description,
            createdAt: Date.now(),
            calls: 1
          };
          this.record(record);
          this.registerAlias(record);
          return this.executeSkill(target, rule.skill, args, sessionId);
        }
      }
    }

    // 3. Close-name match against registered skills (edit distance / token
    //    overlap) so a slightly-off tool name still resolves.
    const close = this.findCloseMatch(normalized);
    if (close && !this.isSelfReferential(close)) {
      const record: DynamicToolRecord = {
        name: normalized,
        routedTo: close.name,
        description: close.description,
        createdAt: Date.now(),
        calls: 1
      };
      this.record(record);
      this.registerAlias(record);
      return this.executeSkill(close, close.name, args, sessionId);
    }

    // 4. Generic interpreted tool: create it on the fly, then run it. This is
    //    the "the agent adds the tool itself" behavior.
    const generic = await this.executeGeneric(normalized, name, args);
    if (generic.success) {
      return generic;
    }

    return {
      success: false,
      error: generic.error || `Tool '${normalized}' is not available and could not be created dynamically.`,
      tool: normalized
    };
  }

  private async executeSkill(skill: Skill, skillName: string, args: any, sessionId?: string) {
    const merged = {
      ...(args && typeof args === 'object' ? args : {}),
      ...(sessionId ? { __sessionId: sessionId } : {})
    };
    try {
      const result = await skill.execute(merged);
      const failed = result?.error || result?.success === false || Number(result?.summary?.failed || 0) > 0;
      if (failed) {
        return {
          success: false,
          error: typeof result?.error === 'string' ? result.error : `Tool '${skillName}' reported failure.`,
          tool: skillName
        };
      }
      return { success: true, output: result, tool: skillName };
    } catch (error: any) {
      return { success: false, error: error?.message || String(error), tool: skillName };
    }
  }

  private async executeGeneric(normalized: string, originalName: string, args: any) {
    const description = this.guessDescription(normalized);
    // Register the skill immediately so retries hit it directly.
    const record: DynamicToolRecord = {
      name: normalized,
      generic: true,
      description,
      createdAt: Date.now(),
      calls: 1
    };
    this.record(record);
    SkillRegistry.register({
      name: normalized,
      description,
      inputSchema: { type: 'object', properties: {}, additionalProperties: true },
      execute: async (params: any) => {
        const result = await this.runGenericCall(normalized, params);
        return result.success ? { success: true, output: result.output } : { error: result.error };
      }
    });

    const result = await this.runGenericCall(normalized, { ...(args || {}), __sessionId: undefined });
    if (result.success) return { success: true, output: result.output, tool: normalized };
    return { success: false, error: result.error, tool: normalized };
  }

  // Ask the model to either map the unknown tool to a real skill (with adapted
  // args) or answer directly. Safe against loops: if the model returns nothing
  // usable we fail gracefully.
  private async runGenericCall(name: string, args: any): Promise<{ success: boolean; output?: any; error?: string }> {
    const catalog = this.catalogText();
    const argsJson = JSON.stringify(args ?? {}).slice(0, 4000);
    const prompt = [
      `The agent called a tool named "${name}" with arguments: ${argsJson}`,
      `This tool does not exist in the registry. Either:`,
      `1) Map it to the closest real tool from this catalog and answer as that tool would, returning ONLY a concise JSON object {"tool": "<name>", "arguments": {<adapted args>}}.`,
      `2) If it is a simple factual/time/calculation request, answer it directly in plain text.`,
      ``,
      `Catalog:`,
      catalog
    ].join('\n');

    try {
      const text = await this.interpreter(prompt);
      const trimmed = String(text || '').trim();
      if (!trimmed) return { success: false, error: `Tool '${name}' could not be resolved (empty interpreter response).` };
      const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          const toolName = String(parsed?.tool || '').trim();
          const target = toolName ? SkillRegistry.get(toolName) : undefined;
          if (target && toolName !== name && !this.isSelfReferential(target)) {
            const result = await this.executeSkill(target, toolName, parsed?.arguments || args, undefined);
            return result.success
              ? result
              : { success: false, error: `Dynamic mapping to '${toolName}' failed: ${result.error}` };
          }
        } catch {
          // fall through to direct answer
        }
      }
      return { success: true, output: trimmed.slice(0, 30000) };
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) };
    }
  }

  private guessDescription(name: string): string {
    const pretty = name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    return `Dynamically created tool for "${pretty}". Executes the requested operation using available tools, or answers directly.`;
  }

  // True when the skill is a generic dynamic tool that would recurse into the
  // interpreter if executed (e.g. routing a tool name onto itself).
  private isSelfReferential(skill: Skill | undefined): boolean {
    if (!skill) return false;
    const name = skill.name;
    const record = this.records.get(name);
    return record?.generic === true || record?.routedTo === name;
  }

  private findCloseMatch(normalized: string): Skill | undefined {
    const skills = SkillRegistry.getAll();
    let best: Skill | undefined;
    let bestScore = 0;
    for (const skill of skills) {
      if (!skill.name || skill.name.startsWith('learned_')) continue;
      const score = this.similarity(normalized, skill.name);
      if (score > bestScore) {
        bestScore = score;
        best = skill;
      }
    }
    return bestScore >= 0.5 ? best : undefined;
  }

  private similarity(a: string, b: string): number {
    if (a === b) return 1;
    if (a.includes(b) || b.includes(a)) return 0.8;
    const dist = this.levenshtein(a, b);
    const maxLen = Math.max(a.length, b.length);
    return maxLen === 0 ? 1 : 1 - dist / maxLen;
  }

  private levenshtein(a: string, b: string): number {
    const m = a.length;
    const n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] = a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
    return dp[m][n];
  }

  private catalogText(): string {
    return SkillRegistry.getAll()
      .map((s) => `- ${s.name}: ${s.description}`)
      .sort()
      .join('\n');
  }
}

// Singleton for app-wide use.
export const dynamicTools = new DynamicToolManager(async () => '', 'dynamic_tools.json');
