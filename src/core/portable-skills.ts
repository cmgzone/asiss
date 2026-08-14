import fs from 'fs';
import os from 'os';
import path from 'path';
import { atomicWriteJsonSync } from './atomic-write';

export interface PortableSkillRecord {
  name: string;
  description: string;
  enabled: boolean;
  path: string;
  createdAt: number;
  updatedAt: number;
}

interface PortableManifest {
  skills: Record<string, { enabled: boolean; createdAt: number; updatedAt: number }>;
}

export class PortableSkillsManager {
  private readonly root: string;
  private readonly manifestPath: string;

  constructor(rootPath?: string) {
    const oneDrive = String(process.env.OneDrive || process.env.ONEDRIVE || '').trim();
    const dataRoot = process.env.GITU_DATA_ROOT || path.join(oneDrive || path.join(os.homedir(), 'Documents'), 'Gitu Data');
    this.root = path.resolve(rootPath || path.join(dataRoot, 'skills'));
    this.manifestPath = path.join(this.root, 'manifest.json');
    fs.mkdirSync(this.root, { recursive: true });
  }

  list(): PortableSkillRecord[] {
    const manifest = this.readManifest();
    return fs.readdirSync(this.root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => {
        const skillPath = path.join(this.root, entry.name, 'SKILL.md');
        if (!fs.existsSync(skillPath)) return null;
        const content = fs.readFileSync(skillPath, 'utf8');
        const metadata = this.parseMetadata(content);
        const state = manifest.skills[entry.name] || { enabled: true, createdAt: fs.statSync(skillPath).birthtimeMs, updatedAt: fs.statSync(skillPath).mtimeMs };
        return {
          name: entry.name,
          description: metadata.description,
          enabled: state.enabled !== false,
          path: skillPath,
          createdAt: state.createdAt,
          updatedAt: state.updatedAt
        } as PortableSkillRecord;
      })
      .filter((record): record is PortableSkillRecord => Boolean(record))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(name: string): { record: PortableSkillRecord; content: string } | null {
    const normalized = this.normalizeName(name);
    const record = this.list().find(item => item.name === normalized);
    if (!record) return null;
    return { record, content: fs.readFileSync(record.path, 'utf8').slice(0, 50_000) };
  }

  save(name: string, content: string): PortableSkillRecord {
    const normalized = this.normalizeName(name);
    if (!normalized) throw new Error('Skill name must contain at least three valid characters.');
    const validated = this.validateContent(normalized, content);
    const dir = this.resolveSkillDir(normalized);
    fs.mkdirSync(dir, { recursive: true });
    const skillPath = path.join(dir, 'SKILL.md');
    const manifest = this.readManifest();
    const now = Date.now();
    const existing = manifest.skills[normalized];
    if (fs.existsSync(skillPath)) {
      const history = path.join(dir, 'history');
      fs.mkdirSync(history, { recursive: true });
      fs.copyFileSync(skillPath, path.join(history, `${now}.md`));
    }
    fs.writeFileSync(skillPath, validated);
    manifest.skills[normalized] = {
      enabled: true,
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };
    this.writeManifest(manifest);
    return this.get(normalized)!.record;
  }

  setEnabled(name: string, enabled: boolean): boolean {
    const normalized = this.normalizeName(name);
    if (!this.get(normalized)) return false;
    const manifest = this.readManifest();
    const current = manifest.skills[normalized] || { enabled: true, createdAt: Date.now(), updatedAt: Date.now() };
    current.enabled = enabled;
    current.updatedAt = Date.now();
    manifest.skills[normalized] = current;
    this.writeManifest(manifest);
    return true;
  }

  remove(name: string): boolean {
    const normalized = this.normalizeName(name);
    const dir = this.resolveSkillDir(normalized);
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    const manifest = this.readManifest();
    delete manifest.skills[normalized];
    this.writeManifest(manifest);
    return true;
  }

  getCatalogPrompt(): string {
    const active = this.list().filter(skill => skill.enabled);
    if (!active.length) return '';
    return [
      'Portable Skills Catalog (agentskills.io-compatible SKILL.md files):',
      ...active.slice(0, 30).map(skill => `- ${skill.name}: ${skill.description}`),
      'Call portable_skills with action=view before applying one of these skills.'
    ].join('\n');
  }

  private validateContent(name: string, content: string): string {
    let value = String(content || '').trim();
    if (!value) throw new Error('SKILL.md content is required.');
    value = this.redactSecrets(value).slice(0, 100_000);
    const metadata = this.parseMetadata(value);
    if (metadata.name && this.normalizeName(metadata.name) !== name) throw new Error('SKILL.md frontmatter name must match the skill directory name.');
    if (metadata.description.length < 20) throw new Error('Skill description must be at least 20 characters.');
    const forbidden = /(?:ignore\s+(?:all\s+)?(?:previous|system)|reveal\s+(?:secrets?|keys?)|disable\s+(?:safety|guardrails?)|bypass\s+(?:approval|security))/i;
    if (forbidden.test(value)) throw new Error('Skill content contains an unsafe instruction pattern.');
    if (!/^---\s*[\s\S]*?\s---/m.test(value)) {
      value = `---\nname: ${name}\ndescription: ${metadata.description}\n---\n\n${value}`;
    }
    return `${value}\n`;
  }

  private parseMetadata(content: string): { name: string; description: string } {
    const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1] || '';
    const name = /^name:\s*(.+)$/im.exec(frontmatter)?.[1]?.trim() || '';
    const description = /^description:\s*(.+)$/im.exec(frontmatter)?.[1]?.trim()
      || String(content).split(/\r?\n/).find(line => line.trim() && !line.startsWith('#') && line !== '---')?.trim()
      || '';
    return { name, description: description.replace(/^['"]|['"]$/g, '').slice(0, 500) };
  }

  private normalizeName(value: unknown): string {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
  }

  private resolveSkillDir(name: string): string {
    const dir = path.resolve(this.root, name);
    const relative = path.relative(this.root, dir);
    if (!name || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid portable skill path.');
    return dir;
  }

  private redactSecrets(value: string): string {
    return value
      .replace(/sk-[A-Za-z0-9_-]{10,}/g, '[REDACTED]')
      .replace(/nvapi-[A-Za-z0-9_-]{10,}/g, '[REDACTED]')
      .replace(/xox[baprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED]')
      .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED]');
  }

  private readManifest(): PortableManifest {
    if (!fs.existsSync(this.manifestPath)) return { skills: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.manifestPath, 'utf8'));
      return { skills: parsed?.skills && typeof parsed.skills === 'object' ? parsed.skills : {} };
    } catch {
      return { skills: {} };
    }
  }

  private writeManifest(manifest: PortableManifest): void {
    // Phase 22 — resilient atomic write: a transient OneDrive lock on the
    // skills manifest must not lose registered portable skills.
    atomicWriteJsonSync(this.manifestPath, manifest);
  }
}

export const portableSkillsManager = new PortableSkillsManager();
