import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

export interface AgentProfile {
  id: string;
  name: string;
  description?: string;
  modelId?: string;
  allowedSkills?: string[];
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, any>;
}

interface AgentProfileData {
  profiles: AgentProfile[];
}

export class AgentProfileManager {
  private dataPath: string;
  private data: AgentProfileData;

  constructor() {
    this.dataPath = path.join(process.cwd(), 'agent_profiles.json');
    this.data = { profiles: [] };
    this.load();
  }

  private load() {
    if (!fs.existsSync(this.dataPath)) return;
    try {
      this.data = JSON.parse(fs.readFileSync(this.dataPath, 'utf-8'));
    } catch {
      this.data = { profiles: [] };
    }
  }

  private save() {
    fs.writeFileSync(this.dataPath, JSON.stringify(this.data, null, 2));
  }

  list(): AgentProfile[] {
    return [...this.data.profiles];
  }

  get(idOrName: string): AgentProfile | undefined {
    const needle = idOrName.toLowerCase();
    return this.data.profiles.find(p => p.id === idOrName || p.name.toLowerCase() === needle);
  }

  create(params: {
    name: string;
    description?: string;
    modelId?: string;
    allowedSkills?: string[];
  }): AgentProfile {
    const profile: AgentProfile = {
      id: uuidv4().slice(0, 8),
      name: params.name.trim(),
      description: params.description?.trim(),
      modelId: params.modelId?.trim(),
      allowedSkills: params.allowedSkills || [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {}
    };
    this.data.profiles.push(profile);
    this.save();
    return profile;
  }

  update(idOrName: string, updates: Partial<AgentProfile>): boolean {
    const profile = this.get(idOrName);
    if (!profile) return false;
    Object.assign(profile, updates, { updatedAt: new Date().toISOString() });
    this.save();
    return true;
  }

  delete(idOrName: string): boolean {
    const idx = this.data.profiles.findIndex(p => p.id === idOrName || p.name.toLowerCase() === idOrName.toLowerCase());
    if (idx < 0) return false;
    this.data.profiles.splice(idx, 1);
    this.save();
    return true;
  }
}

export const agentProfileManager = new AgentProfileManager();
