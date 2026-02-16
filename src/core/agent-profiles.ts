import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

export interface LearnedPreferences {
  codingStyle?: string;        // e.g., "functional", "OOP", "procedural"
  responseFormat?: string;     // e.g., "concise", "detailed", "bullet-points"
  domainExpertise?: string[];  // e.g., ["backend", "databases", "security"]
  preferredTools?: string[];   // tools this agent uses most effectively
  tone?: string;               // e.g., "formal", "casual", "technical"
  strengths?: string[];        // observed strengths
  weaknesses?: string[];       // observed weaknesses
  notes?: string;              // free-form notes
}

export interface PerformanceRecord {
  totalTasks: number;
  successes: number;
  failures: number;
  avgDurationMs: number;
  totalDurationMs: number;
  lastActiveAt: string;
  tasksByType: Record<string, { count: number; successes: number }>;
}

export interface AgentProfile {
  id: string;
  name: string;
  description?: string;
  modelId?: string;
  allowedSkills?: string[];
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, any>;
  learnedPreferences: LearnedPreferences;
  performance: PerformanceRecord;
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
      const raw = JSON.parse(fs.readFileSync(this.dataPath, 'utf-8'));
      this.data = raw;
      // Migrate older profiles missing new fields
      for (const p of this.data.profiles) {
        if (!p.learnedPreferences) p.learnedPreferences = {};
        if (!p.performance) p.performance = this.defaultPerformance();
      }
    } catch {
      this.data = { profiles: [] };
    }
  }

  private save() {
    fs.writeFileSync(this.dataPath, JSON.stringify(this.data, null, 2));
  }

  private defaultPerformance(): PerformanceRecord {
    return {
      totalTasks: 0,
      successes: 0,
      failures: 0,
      avgDurationMs: 0,
      totalDurationMs: 0,
      lastActiveAt: new Date().toISOString(),
      tasksByType: {}
    };
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
      metadata: {},
      learnedPreferences: {},
      performance: this.defaultPerformance()
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

  /**
   * Update learned preferences for an agent based on interaction outcomes.
   */
  updatePreferences(idOrName: string, prefs: Partial<LearnedPreferences>): boolean {
    const profile = this.get(idOrName);
    if (!profile) return false;

    // Merge arrays (don't overwrite, append unique values)
    if (prefs.domainExpertise) {
      profile.learnedPreferences.domainExpertise = [
        ...new Set([...(profile.learnedPreferences.domainExpertise || []), ...prefs.domainExpertise])
      ];
      delete prefs.domainExpertise;
    }
    if (prefs.preferredTools) {
      profile.learnedPreferences.preferredTools = [
        ...new Set([...(profile.learnedPreferences.preferredTools || []), ...prefs.preferredTools])
      ];
      delete prefs.preferredTools;
    }
    if (prefs.strengths) {
      profile.learnedPreferences.strengths = [
        ...new Set([...(profile.learnedPreferences.strengths || []), ...prefs.strengths])
      ];
      delete prefs.strengths;
    }

    // Scalar fields: overwrite
    Object.assign(profile.learnedPreferences, prefs);
    profile.updatedAt = new Date().toISOString();
    this.save();
    return true;
  }

  /**
   * Record a task completion for an agent's performance history.
   */
  recordPerformance(idOrName: string, success: boolean, durationMs: number = 0, taskType: string = 'general'): boolean {
    const profile = this.get(idOrName);
    if (!profile) return false;

    const perf = profile.performance;
    perf.totalTasks += 1;
    if (success) perf.successes += 1;
    else perf.failures += 1;

    if (durationMs > 0) {
      perf.totalDurationMs += durationMs;
      perf.avgDurationMs = Math.round(perf.totalDurationMs / perf.totalTasks);
    }

    perf.lastActiveAt = new Date().toISOString();

    // Track by task type
    if (!perf.tasksByType[taskType]) perf.tasksByType[taskType] = { count: 0, successes: 0 };
    perf.tasksByType[taskType].count += 1;
    if (success) perf.tasksByType[taskType].successes += 1;

    profile.updatedAt = new Date().toISOString();
    this.save();
    return true;
  }

  /**
   * Get a summary string of an agent's capabilities for inclusion in prompts.
   */
  getCapabilitySummary(idOrName: string): string {
    const profile = this.get(idOrName);
    if (!profile) return '';

    const parts: string[] = [];
    const prefs = profile.learnedPreferences;

    if (prefs.codingStyle) parts.push(`Coding style: ${prefs.codingStyle}`);
    if (prefs.responseFormat) parts.push(`Response format: ${prefs.responseFormat}`);
    if (prefs.tone) parts.push(`Tone: ${prefs.tone}`);
    if (prefs.domainExpertise?.length) parts.push(`Expertise: ${prefs.domainExpertise.join(', ')}`);
    if (prefs.strengths?.length) parts.push(`Strengths: ${prefs.strengths.join(', ')}`);

    const perf = profile.performance;
    if (perf.totalTasks > 0) {
      const rate = Math.round((perf.successes / perf.totalTasks) * 100);
      parts.push(`Success rate: ${rate}% (${perf.totalTasks} tasks)`);
    }

    return parts.join('. ');
  }
}

export const agentProfileManager = new AgentProfileManager();

