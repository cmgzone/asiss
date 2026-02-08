export interface Skill {
  name: string;
  description: string;
  inputSchema?: any; // Added to support LLM Tool Calling
  execute(params: any): Promise<any>;
}

export class SkillRegistry {
  private static skills: Map<string, Skill> = new Map();

  static register(skill: Skill) {
    this.skills.set(skill.name, skill);
  }

  static get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  static getAll(): Skill[] {
    return Array.from(this.skills.values());
  }
}
