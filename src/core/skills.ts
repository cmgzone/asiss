export interface Skill {
  name: string;
  description: string;
  inputSchema?: any; // Added to support LLM Tool Calling
  capabilities?: string[]; // Logical capabilities used for dynamic fallback (e.g. 'web_search')
  execute(params: any): Promise<any>;
}

export class SkillRegistry {
  private static skills: Map<string, Skill> = new Map();
  // capability -> set of skill names that provide it
  private static capabilityMap: Map<string, Set<string>> = new Map();

  static register(skill: Skill) {
    this.skills.set(skill.name, skill);
    if (Array.isArray((skill as any).capabilities)) {
      for (const cap of (skill as any).capabilities as string[]) {
        if (!this.capabilityMap.has(cap)) this.capabilityMap.set(cap, new Set());
        this.capabilityMap.get(cap)!.add(skill.name);
      }
    }
  }

  static skillsForCapability(cap: string): string[] {
    return Array.from(this.capabilityMap.get(cap) || []);
  }

  static get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  static getAll(): Skill[] {
    return Array.from(this.skills.values());
  }

  static unregister(name: string): boolean {
    return this.skills.delete(name);
  }
}
