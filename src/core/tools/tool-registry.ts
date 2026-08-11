/**
 * Tool registry — Hermes Evolution Phase 4.
 *
 * The unified tool catalog: native skills (SkillRegistry), MCP tools and
 * dynamic/learned tools all become ToolDescriptors so discovery and selection
 * don't care where a tool came from. The ToolEngine holds a thin facade over
 * the existing singletons rather than re-registering them (the original
 * registries keep working; the old paths are removed only after the new one
 * is stable).
 */

import { ToolSource } from './tool-result';

/** Structural view of a native skill (SkillRegistry-compatible). */
export interface NativeSkillLike {
  name: string;
  description?: string;
  inputSchema?: any;
  capabilities?: string[];
  execute(params: any): Promise<any> | any;
}

/** Structural view of the MCP manager (McpManager-compatible). */
export interface McpGateway {
  callTool(name: string, args?: any): Promise<any>;
  getKnownToolNames(): string[];
}

/** Structural view of the dynamic-tool manager (DynamicToolManager-compatible). */
export interface DynamicToolGateway {
  resolve(name: string, args: any, sessionId?: string): Promise<{ success: boolean; output?: any; tool?: string; error?: string }>;
  normalizeName(name: string): string | null;
}

export interface SkillRegistryLike {
  get(name: string): NativeSkillLike | undefined;
  getAll(): NativeSkillLike[];
  skillsForCapability?(cap: string): string[];
}

export interface ToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: any;
  capabilities?: string[];
  source: ToolSource;
}

export function describeSkill(skill: NativeSkillLike, source: ToolSource = 'native'): ToolDescriptor {
  return {
    name: skill.name,
    description: skill.description,
    inputSchema: skill.inputSchema,
    capabilities: skill.capabilities,
    source
  };
}

/** Flat, deduplicated catalog of every currently-known tool. */
export function listTools(registry: SkillRegistryLike, mcpNames: string[] = []): ToolDescriptor[] {
  const byName = new Map<string, ToolDescriptor>();
  for (const skill of registry.getAll()) {
    byName.set(skill.name, describeSkill(skill, 'native'));
  }
  for (const name of mcpNames) {
    if (!byName.has(name)) byName.set(name, { name, source: 'mcp' });
  }
  return Array.from(byName.values());
}
