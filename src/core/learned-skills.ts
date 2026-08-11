import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Skill, SkillRegistry } from './skills';

export interface ExecutableSkillStep {
  tool: string;
  arguments: Record<string, unknown>;
  onError?: 'stop' | 'continue';
}

export interface ExecutableSkillSpec {
  steps: ExecutableSkillStep[];
  allowedTools: string[];
  maxOutputChars?: number;
}

export interface LearnedSkillRecord {
  name: string;
  description: string;
  sessionId: string;
  sourceEntryId: string;
  version: number;
  enabled: boolean;
  keywords: string[];
  createdAt: number;
  updatedAt: number;
  executable: boolean;
  toolName?: string;
  validationStatus?: 'validated' | 'invalid';
  validationErrors?: string[];
}

export interface LearnedSkillDraft {
  name: string;
  description: string;
  instructions: string[];
  sessionId: string;
  sourceEntryId: string;
  keywords?: string[];
  executableSpec?: ExecutableSkillSpec;
}

export class LearnedSkillsManager {
  private root: string;
  private manifestPath: string;
  private records: LearnedSkillRecord[] = [];
  private registeredTools = new Set<string>();
  private executableSafeTools = new Set([
    'system_info', 'current_time', 'web_search', 'web_fetch', 'brave_search',
    'serper_search', 'code_search', 'notes', 'memory', 'task_memory'
  ]);

  constructor(rootPath?: string, extraSafeTools: string[] = []) {
    this.root = rootPath ? path.resolve(rootPath) : path.join(process.cwd(), 'learning', 'skills');
    this.manifestPath = path.join(this.root, 'manifest.json');
    for (const tool of extraSafeTools) {
      if (/^[a-zA-Z0-9_-]{2,80}$/.test(tool)) this.executableSafeTools.add(tool);
    }
    this.ensureDir(this.root);
    this.load();
  }

  private ensureDir(dir: string) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  private load() {
    if (!fs.existsSync(this.manifestPath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.manifestPath, 'utf-8'));
      this.records = Array.isArray(parsed)
        ? parsed.filter(item => item && typeof item === 'object').map(item => ({
            name: this.normalizeName(item.name),
            description: String(item.description || '').trim(),
            sessionId: String(item.sessionId || 'default'),
            sourceEntryId: String(item.sourceEntryId || ''),
            version: Math.max(1, Math.floor(Number(item.version) || 1)),
            enabled: item.enabled !== false,
            keywords: this.normalizeKeywords(item.keywords),
            createdAt: Number(item.createdAt) || Date.now(),
            updatedAt: Number(item.updatedAt) || Date.now(),
            executable: item.executable === true,
            toolName: typeof item.toolName === 'string' ? item.toolName : undefined,
            validationStatus: (item.validationStatus === 'validated' ? 'validated' : (item.validationStatus === 'invalid' ? 'invalid' : undefined)) as LearnedSkillRecord['validationStatus'],
            validationErrors: Array.isArray(item.validationErrors) ? item.validationErrors.map(String).slice(0, 10) : undefined
          })).filter(item => item.name && item.description)
        : [];
    } catch {
      this.records = [];
    }
  }

  private save() {
    fs.writeFileSync(this.manifestPath, JSON.stringify(this.records, null, 2));
  }

  private normalizeName(value: unknown) {
    return String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 63);
  }

  private normalizeKeywords(value: unknown): string[] {
    const raw = Array.isArray(value) ? value : [];
    return Array.from(new Set(raw
      .map(item => String(item || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '').trim())
      .filter(item => item.length >= 3)))
      .slice(0, 16);
  }

  private redactSecrets(value: string) {
    return String(value || '')
      .replace(/sk-[A-Za-z0-9_-]{10,}/g, '[REDACTED]')
      .replace(/nvapi-[A-Za-z0-9_-]{10,}/g, '[REDACTED]')
      .replace(/xox[baprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED]')
      .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED]');
  }

  private validateDraft(draft: LearnedSkillDraft) {
    const name = this.normalizeName(draft.name);
    const description = this.redactSecrets(String(draft.description || '').replace(/[\r\n]+/g, ' ').trim());
    const instructions = (Array.isArray(draft.instructions) ? draft.instructions : [])
      .map(line => this.redactSecrets(String(line || '').replace(/[\r\n]+/g, ' ').trim()))
      .filter(Boolean)
      .slice(0, 20);
    const sessionId = String(draft.sessionId || '').trim();
    const sourceEntryId = String(draft.sourceEntryId || '').trim();

    if (!name || name.length < 3) throw new Error('Learned skill name must contain at least 3 valid characters.');
    if (description.length < 20 || description.length > 500) throw new Error('Learned skill description must be 20-500 characters.');
    if (instructions.length === 0) throw new Error('Learned skill needs at least one instruction.');
    if (!sessionId) throw new Error('Learned skill must be scoped to a session.');
    if (!sourceEntryId) throw new Error('Learned skill must reference its source learning entry.');

    const forbidden = /(?:ignore\s+(?:all\s+)?(?:previous|system)|reveal\s+(?:secrets?|keys?)|disable\s+(?:safety|guardrails?)|bypass\s+(?:approval|security))/i;
    if (forbidden.test(`${description}\n${instructions.join('\n')}`)) {
      throw new Error('Learned skill contains an unsafe instruction pattern.');
    }

    return {
      name,
      description,
      instructions,
      sessionId,
      sourceEntryId,
      keywords: this.normalizeKeywords(draft.keywords)
    };
  }

  private validateExecutableSpec(spec: ExecutableSkillSpec | undefined, name: string, sessionId: string) {
    if (!spec) return { spec: undefined, toolName: undefined, errors: [] as string[] };
    const errors: string[] = [];
    const allowedTools = Array.from(new Set((Array.isArray(spec.allowedTools) ? spec.allowedTools : [])
      .map(tool => String(tool || '').trim())
      .filter(tool => /^[a-zA-Z0-9_-]{2,80}$/.test(tool) && this.executableSafeTools.has(tool))))
      .slice(0, 20);
    const rawSteps = Array.isArray(spec.steps) ? spec.steps.slice(0, 8) : [];
    if (rawSteps.length === 0) errors.push('Executable skill needs at least one tool step.');

    const steps: ExecutableSkillStep[] = rawSteps.map((raw, index) => {
      const tool = String(raw?.tool || '').trim();
      if (!allowedTools.includes(tool)) errors.push(`Step ${index + 1} uses a tool outside the allowlist: ${tool || '(missing)'}.`);
      const target = SkillRegistry.get(tool);
      if (!target) errors.push(`Step ${index + 1} references an unavailable tool: ${tool || '(missing)'}.`);
      const args = this.sanitizeTemplateValue(raw?.arguments, 0) as Record<string, unknown>;
      const required = Array.isArray(target?.inputSchema?.required) ? target!.inputSchema.required : [];
      for (const key of required) {
        if (!Object.prototype.hasOwnProperty.call(args, key)) {
          errors.push(`Step ${index + 1} is missing required argument '${key}' for ${tool}.`);
        }
      }
      return {
        tool,
        arguments: args,
        onError: raw?.onError === 'continue' ? 'continue' : 'stop'
      };
    });
    const toolName = this.buildToolName(name, sessionId);
    return {
      spec: errors.length === 0 ? {
        steps,
        allowedTools,
        maxOutputChars: Math.max(1_000, Math.min(100_000, Number(spec.maxOutputChars) || 30_000))
      } : undefined,
      toolName,
      errors: Array.from(new Set(errors)).slice(0, 10)
    };
  }

  private buildToolName(name: string, sessionId: string): string {
    const digest = crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 8);
    return `learned_${name.replace(/-/g, '_').slice(0, 40)}_${digest}`;
  }

  private sanitizeTemplateValue(value: unknown, depth: number): unknown {
    if (depth > 6) return null;
    if (typeof value === 'string') return this.redactSecrets(value).slice(0, 10_000);
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
    if (Array.isArray(value)) return value.slice(0, 30).map(item => this.sanitizeTemplateValue(item, depth + 1));
    if (!value || typeof value !== 'object') return {};
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      if (key.startsWith('__') || ['__proto__', 'constructor', 'prototype'].includes(key)) continue;
      output[key] = this.sanitizeTemplateValue(child, depth + 1);
    }
    return output;
  }

  private renderSkill(name: string, description: string, instructions: string[]) {
    return [
      '---',
      `name: ${name}`,
      `description: ${description.replace(/:/g, ' -')}`,
      '---',
      '',
      '# Workflow',
      '',
      ...instructions.map(line => `- ${line}`),
      '',
      '# Validation',
      '',
      '- Verify the result with evidence appropriate to the task before reporting completion.',
      '- If the workflow conflicts with the current user request or system safety rules, follow the higher-priority instruction.',
      ''
    ].join('\n');
  }

  public upsert(draft: LearnedSkillDraft): LearnedSkillRecord {
    const valid = this.validateDraft(draft);
    const executable = this.validateExecutableSpec(draft.executableSpec, valid.name, valid.sessionId);
    const existing = this.records.find(item => item.name === valid.name && item.sessionId === valid.sessionId);
    const now = Date.now();
    const nextVersion = existing ? existing.version + 1 : 1;
    const skillDir = path.join(this.root, valid.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_'), valid.name);
    const historyDir = path.join(skillDir, 'history');
    this.ensureDir(historyDir);
    const skillPath = path.join(skillDir, 'SKILL.md');
    const executablePath = path.join(skillDir, 'EXECUTABLE.json');

    if (existing && fs.existsSync(skillPath)) {
      fs.copyFileSync(skillPath, path.join(historyDir, `v${existing.version}.md`));
    }
    if (existing && fs.existsSync(executablePath)) {
      fs.copyFileSync(executablePath, path.join(historyDir, `v${existing.version}.executable.json`));
    }

    fs.writeFileSync(skillPath, this.renderSkill(valid.name, valid.description, valid.instructions));
    if (executable.spec) {
      fs.writeFileSync(executablePath, JSON.stringify(executable.spec, null, 2));
    } else if (fs.existsSync(executablePath)) {
      fs.unlinkSync(executablePath);
    }
    const record: LearnedSkillRecord = existing || {
      name: valid.name,
      description: valid.description,
      sessionId: valid.sessionId,
      sourceEntryId: valid.sourceEntryId,
      version: nextVersion,
      enabled: true,
      keywords: valid.keywords,
      createdAt: now,
      updatedAt: now,
      executable: false
    };
    record.description = valid.description;
    record.sourceEntryId = valid.sourceEntryId;
    record.version = nextVersion;
    record.enabled = true;
    record.keywords = valid.keywords;
    record.updatedAt = now;
    record.executable = Boolean(executable.spec);
    record.toolName = executable.spec ? executable.toolName : undefined;
    record.validationStatus = executable.spec ? 'validated' : (draft.executableSpec ? 'invalid' : undefined);
    record.validationErrors = executable.errors.length ? executable.errors : undefined;
    if (!existing) this.records.push(record);
    this.save();
    if (record.enabled && record.executable) this.registerRecord(record);
    else this.unregisterRecord(record);
    return { ...record };
  }

  public list(sessionId?: string): LearnedSkillRecord[] {
    return this.records
      .filter(item => !sessionId || item.sessionId === sessionId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(item => ({ ...item, keywords: [...item.keywords] }));
  }

  public registerExecutableSkills(): { registered: number; invalid: number } {
    let registered = 0;
    let invalid = 0;
    for (const record of this.records) {
      if (!record.enabled || !record.executable) continue;
      if (this.registerRecord(record)) registered += 1;
      else invalid += 1;
    }
    return { registered, invalid };
  }

  private registerRecord(record: LearnedSkillRecord): boolean {
    if (!record.toolName || !record.executable) return false;
    const executablePath = this.getExecutablePath(record);
    if (!fs.existsSync(executablePath)) return false;
    let raw: ExecutableSkillSpec;
    try {
      raw = JSON.parse(fs.readFileSync(executablePath, 'utf8'));
    } catch {
      return false;
    }
    const validated = this.validateExecutableSpec(raw, record.name, record.sessionId);
    if (!validated.spec || validated.toolName !== record.toolName) {
      record.validationStatus = 'invalid';
      record.validationErrors = validated.errors.length ? validated.errors : ['Executable skill validation failed.'];
      this.save();
      this.unregisterRecord(record);
      return false;
    }
    const manager = this;
    const skill: Skill & { learnedSessionId: string; learnedSkillName: string } = {
      name: record.toolName,
      description: `${record.description} This is a validated executable learned skill.`,
      learnedSessionId: record.sessionId,
      learnedSkillName: record.name,
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The current task or desired outcome.' },
          query: { type: 'string', description: 'An optional search query or primary input.' },
          context: { type: 'string', description: 'Optional context needed by the workflow.' }
        },
        additionalProperties: true
      },
      async execute(params: any) {
        return manager.executeSpec(record, validated.spec!, params || {});
      }
    };
    SkillRegistry.register(skill);
    this.registeredTools.add(record.toolName);
    record.validationStatus = 'validated';
    record.validationErrors = undefined;
    this.save();
    return true;
  }

  private unregisterRecord(record: LearnedSkillRecord): void {
    if (!record.toolName || !this.registeredTools.has(record.toolName)) return;
    SkillRegistry.unregister(record.toolName);
    this.registeredTools.delete(record.toolName);
  }

  private async executeSpec(record: LearnedSkillRecord, spec: ExecutableSkillSpec, params: Record<string, unknown>) {
    const runtimeSessionId = String(params.__sessionId || '');
    if (!runtimeSessionId || runtimeSessionId !== record.sessionId) {
      return { success: false, error: 'This learned skill is not available in the current conversation scope.' };
    }
    const runtimeMetadata = Object.fromEntries(Object.entries(params).filter(([key]) => key.startsWith('__')));
    const input = Object.fromEntries(Object.entries(params).filter(([key]) => !key.startsWith('__')));
    const results: Array<{ tool: string; success: boolean; output?: unknown; error?: string }> = [];
    let lastOutput: unknown = '';

    for (let index = 0; index < spec.steps.length; index += 1) {
      const step = spec.steps[index];
      if (!spec.allowedTools.includes(step.tool)) {
        return { success: false, error: `Executable skill step is not allowed: ${step.tool}`, steps: results };
      }
      const target = SkillRegistry.get(step.tool);
      if (!target || step.tool.startsWith('learned_')) {
        return { success: false, error: `Executable skill tool is unavailable: ${step.tool}`, steps: results };
      }
      const rendered = this.renderTemplateValue(step.arguments, { input, steps: results, lastOutput });
      const stepArgs = {
        ...(rendered && typeof rendered === 'object' && !Array.isArray(rendered) ? rendered as Record<string, unknown> : {}),
        ...runtimeMetadata
      };
      try {
        const output = await target.execute(stepArgs);
        if (output?.error || output?.success === false) {
          throw new Error(String(output?.error || `Tool '${step.tool}' reported failure.`));
        }
        lastOutput = output;
        results.push({ tool: step.tool, success: true, output });
      } catch (error: any) {
        const failure = { tool: step.tool, success: false, error: error?.message || String(error) };
        results.push(failure);
        if (step.onError !== 'continue') {
          return { success: false, skill: record.name, toolName: record.toolName, steps: results, error: failure.error };
        }
      }
    }

    const serialized = JSON.stringify(lastOutput ?? '');
    const maxChars = Math.max(1_000, Math.min(100_000, Number(spec.maxOutputChars) || 30_000));
    return {
      success: results.every(result => result.success),
      skill: record.name,
      toolName: record.toolName,
      steps: results,
      output: serialized.length > maxChars ? `${serialized.slice(0, maxChars)}\n[truncated]` : lastOutput
    };
  }

  private renderTemplateValue(value: unknown, context: Record<string, unknown>): unknown {
    if (typeof value === 'string') {
      const exact = /^\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}$/.exec(value);
      if (exact) return this.resolveTemplatePath(exact[1], context);
      return value.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, key) => {
        const resolved = this.resolveTemplatePath(key, context);
        return typeof resolved === 'string' ? resolved : JSON.stringify(resolved ?? '');
      });
    }
    if (Array.isArray(value)) return value.map(item => this.renderTemplateValue(item, context));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !key.startsWith('__'))
        .map(([key, child]) => [key, this.renderTemplateValue(child, context)]));
    }
    return value;
  }

  private resolveTemplatePath(key: string, context: Record<string, unknown>): unknown {
    const normalized = key.startsWith('input.') || key.startsWith('steps.') || key === 'lastOutput'
      ? key
      : `input.${key}`;
    return normalized.split('.').reduce<unknown>((current, part) => {
      if (current === null || current === undefined) return undefined;
      if (Array.isArray(current) && /^\d+$/.test(part)) return current[Number(part)];
      if (typeof current === 'object') return (current as Record<string, unknown>)[part];
      return undefined;
    }, context);
  }

  private getExecutablePath(record: Pick<LearnedSkillRecord, 'sessionId' | 'name'>): string {
    return path.join(this.root, record.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_'), record.name, 'EXECUTABLE.json');
  }

  public getContent(name: string, sessionId: string): string {
    const normalized = this.normalizeName(name);
    const record = this.records.find(item => item.name === normalized && item.sessionId === sessionId);
    if (!record) return '';
    const skillPath = path.join(this.root, sessionId.replace(/[^a-zA-Z0-9_-]/g, '_'), normalized, 'SKILL.md');
    if (!fs.existsSync(skillPath)) return '';
    return fs.readFileSync(skillPath, 'utf-8').slice(0, 12000);
  }

  public setEnabled(name: string, enabled: boolean, sessionId: string) {
    const normalized = this.normalizeName(name);
    const record = this.records.find(item => item.name === normalized && item.sessionId === sessionId);
    if (!record) return false;
    record.enabled = enabled;
    record.updatedAt = Date.now();
    this.save();
    if (enabled && record.executable) this.registerRecord(record);
    else this.unregisterRecord(record);
    return true;
  }

  public rollback(name: string, sessionId: string): LearnedSkillRecord | null {
    const normalized = this.normalizeName(name);
    const record = this.records.find(item => item.name === normalized && item.sessionId === sessionId);
    if (!record || record.version <= 1) return null;
    const skillDir = path.join(this.root, sessionId.replace(/[^a-zA-Z0-9_-]/g, '_'), normalized);
    const previousPath = path.join(skillDir, 'history', `v${record.version - 1}.md`);
    const previousExecutablePath = path.join(skillDir, 'history', `v${record.version - 1}.executable.json`);
    const executablePath = path.join(skillDir, 'EXECUTABLE.json');
    if (!fs.existsSync(previousPath)) return null;
    this.unregisterRecord(record);
    fs.copyFileSync(previousPath, path.join(skillDir, 'SKILL.md'));
    if (fs.existsSync(previousExecutablePath)) {
      fs.copyFileSync(previousExecutablePath, executablePath);
      record.executable = true;
      record.toolName = this.buildToolName(record.name, record.sessionId);
      record.validationStatus = 'validated';
      record.validationErrors = undefined;
    } else {
      if (fs.existsSync(executablePath)) fs.unlinkSync(executablePath);
      record.executable = false;
      record.toolName = undefined;
      record.validationStatus = undefined;
      record.validationErrors = undefined;
    }
    record.version -= 1;
    record.enabled = true;
    record.updatedAt = Date.now();
    this.save();
    if (record.executable) this.registerRecord(record);
    else this.unregisterRecord(record);
    return { ...record };
  }

  public getPrompt(sessionId: string, query = '', limit = 3): string {
    const active = this.list(sessionId).filter(item => item.enabled);
    if (active.length === 0) return '';
    const tokens = Array.from(new Set(String(query || '')
      .toLowerCase()
      .match(/[a-z0-9_-]{3,}/g) || []));
    const relevant = active
      .map(record => {
        const metadata = `${record.name} ${record.description} ${record.keywords.join(' ')}`.toLowerCase();
        const score = tokens.reduce((total, token) => total + (metadata.includes(token) ? 1 : 0), 0);
        return { record, score };
      })
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score || b.record.updatedAt - a.record.updatedAt)
      .slice(0, Math.max(1, limit))
      .map(item => item.record);

    const catalog = active.slice(0, 12).map(record => `- ${record.name}${record.executable && record.toolName ? ` (callable tool: ${record.toolName})` : ''}: ${record.description}`).join('\n');
    const sections: string[] = [];
    for (const record of relevant) {
      const skillPath = path.join(this.root, sessionId.replace(/[^a-zA-Z0-9_-]/g, '_'), record.name, 'SKILL.md');
      if (!fs.existsSync(skillPath)) continue;
      const content = fs.readFileSync(skillPath, 'utf-8').trim();
      if (content) sections.push(content.slice(0, 5000));
    }
    return [
      'Learned Skills Catalog (session-scoped):',
      catalog,
      sections.length > 0 ? `\nRelevant Learned Skill Instructions:\n\n${sections.join('\n\n')}` : ''
    ].filter(Boolean).join('\n');
  }
}

export const learnedSkillsManager = new LearnedSkillsManager();
