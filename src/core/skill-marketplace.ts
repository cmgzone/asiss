import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import AdmZip = require('adm-zip');
import { Skill } from './skills';

export interface MarketplaceEntry {
  id: string;
  name: string;
  version: string;
  description?: string;
  archiveUrl: string;
  archiveSha256: string;
  signature: string;
  main: string;
  files?: Array<{ path: string; sha256: string }>;
}

interface MarketplaceConfig {
  enabled: boolean;
  manifestUrl?: string;
  publicKey?: string;
  allowList: string[];
  requireSignature: boolean;
  autoEnableOnInstall: boolean;
}

export class SkillMarketplaceManager {
  private configPath = path.join(process.cwd(), 'config.json');
  private manifestPath = path.join(process.cwd(), 'marketplace', 'skills.json');
  private installedDir = path.join(process.cwd(), 'marketplace', 'installed');
  private tempDir = path.join(process.cwd(), 'marketplace', 'tmp');
  private config: MarketplaceConfig = {
    enabled: true,
    manifestUrl: '',
    publicKey: '',
    allowList: [],
    requireSignature: true,
    autoEnableOnInstall: false
  };

  constructor() {
    this.ensureDir(path.join(process.cwd(), 'marketplace'));
    this.ensureDir(this.installedDir);
    this.ensureDir(this.tempDir);
    this.refreshConfig();
  }

  refreshConfig() {
    let cfg: any = {};
    if (fs.existsSync(this.configPath)) {
      try {
        cfg = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
      } catch {
        cfg = {};
      }
    }
    if (cfg.marketplace && typeof cfg.marketplace === 'object') {
      this.config = {
        ...this.config,
        ...cfg.marketplace
      };
      if (!Array.isArray(this.config.allowList)) this.config.allowList = [];
    }
  }

  private ensureDir(dir: string) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  private saveConfig() {
    let cfg: any = {};
    if (fs.existsSync(this.configPath)) {
      try {
        cfg = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
      } catch {
        cfg = {};
      }
    }
    cfg.marketplace = { ...this.config };
    fs.writeFileSync(this.configPath, JSON.stringify(cfg, null, 2));
  }

  async loadManifest(): Promise<MarketplaceEntry[]> {
    this.refreshConfig();
    if (!this.config.enabled) return [];

    if (this.config.manifestUrl) {
      const res = await fetch(this.config.manifestUrl);
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data?.skills) ? data.skills : [];
    }
    if (fs.existsSync(this.manifestPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.manifestPath, 'utf-8'));
        return Array.isArray(data?.skills) ? data.skills : [];
      } catch {
        return [];
      }
    }
    return [];
  }

  async listAvailable() {
    const skills = await this.loadManifest();
    return skills;
  }

  listInstalled() {
    if (!fs.existsSync(this.installedDir)) return [];
    const dirs = fs.readdirSync(this.installedDir).filter(d => fs.statSync(path.join(this.installedDir, d)).isDirectory());
    return dirs.map(id => {
      const skillPath = path.join(this.installedDir, id, 'skill.json');
      if (!fs.existsSync(skillPath)) return { id, error: 'Missing skill.json' };
      try {
        const data = JSON.parse(fs.readFileSync(skillPath, 'utf-8'));
        return { id, ...data };
      } catch {
        return { id, error: 'Invalid skill.json' };
      }
    });
  }

  private verifySignature(entry: MarketplaceEntry): boolean {
    if (!this.config.requireSignature) return true;
    if (!entry.signature) return false;
    if (!this.config.publicKey) return false;

    const payload = `${entry.id}|${entry.version}|${entry.archiveUrl}|${entry.archiveSha256}|${entry.main}`;
    const signature = Buffer.from(entry.signature, 'base64');
    const publicKey = Buffer.from(this.config.publicKey, 'base64').toString('utf-8');
    try {
      return crypto.verify(null, Buffer.from(payload), publicKey, signature);
    } catch {
      return false;
    }
  }

  private sha256File(filePath: string): string {
    const hash = crypto.createHash('sha256');
    const data = fs.readFileSync(filePath);
    hash.update(data);
    return hash.digest('hex');
  }

  private sha256Buffer(buf: Buffer): string {
    const hash = crypto.createHash('sha256');
    hash.update(buf);
    return hash.digest('hex');
  }

  async install(id: string): Promise<{ success: boolean; error?: string; skill?: any }> {
    this.refreshConfig();
    if (!this.config.enabled) return { success: false, error: 'Marketplace is disabled' };

    const manifest = await this.loadManifest();
    const entry = manifest.find(s => s.id === id);
    if (!entry) return { success: false, error: `Skill not found in manifest: ${id}` };

    if (!this.verifySignature(entry)) {
      return { success: false, error: 'Signature verification failed. Check marketplace.publicKey.' };
    }

    const res = await fetch(entry.archiveUrl);
    if (!res.ok) return { success: false, error: `Failed to download: ${res.status}` };
    const buffer = Buffer.from(await res.arrayBuffer());
    const hash = this.sha256Buffer(buffer);
    if (hash !== entry.archiveSha256) {
      return { success: false, error: 'Archive hash mismatch' };
    }

    const zipPath = path.join(this.tempDir, `${entry.id}.zip`);
    fs.writeFileSync(zipPath, buffer);

    const destDir = path.join(this.installedDir, entry.id);
    if (fs.existsSync(destDir)) {
      fs.rmSync(destDir, { recursive: true, force: true });
    }
    this.ensureDir(destDir);

    const zip = new AdmZip(zipPath);
    zip.extractAllTo(destDir, true);

    const skillJsonPath = path.join(destDir, 'skill.json');
    if (!fs.existsSync(skillJsonPath)) {
      return { success: false, error: 'skill.json missing in package' };
    }
    const skillJson = JSON.parse(fs.readFileSync(skillJsonPath, 'utf-8'));
    if (skillJson?.files && Array.isArray(skillJson.files)) {
      for (const file of skillJson.files) {
        const filePath = path.join(destDir, file.path);
        if (!fs.existsSync(filePath)) return { success: false, error: `Missing file ${file.path}` };
        const fileHash = this.sha256File(filePath);
        if (fileHash !== file.sha256) return { success: false, error: `Hash mismatch for ${file.path}` };
      }
    }

    if (this.config.autoEnableOnInstall && !this.config.allowList.includes(entry.id)) {
      this.config.allowList.push(entry.id);
      this.saveConfig();
    }

    return { success: true, skill: skillJson };
  }

  enable(id: string) {
    if (!this.config.allowList.includes(id)) {
      this.config.allowList.push(id);
      this.saveConfig();
    }
    return { success: true };
  }

  disable(id: string) {
    this.config.allowList = this.config.allowList.filter(s => s !== id);
    this.saveConfig();
    return { success: true };
  }

  remove(id: string) {
    const destDir = path.join(this.installedDir, id);
    if (fs.existsSync(destDir)) {
      fs.rmSync(destDir, { recursive: true, force: true });
    }
    this.disable(id);
    return { success: true };
  }

  loadEnabledSkills(): Skill[] {
    this.refreshConfig();
    if (!this.config.enabled) return [];
    const installed = this.listInstalled();
    const loaded: Skill[] = [];
    for (const entry of installed) {
      const id = entry.id;
      if (!this.config.allowList.includes(id)) continue;
      const mainRel = entry.main || entry.entry || 'index.js';
      const mainPath = path.join(this.installedDir, id, mainRel);
      if (!fs.existsSync(mainPath)) continue;
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require(mainPath);
        const candidate = mod?.default || mod?.skill || mod;
        let instance: any = candidate;
        if (typeof candidate === 'function') {
          instance = new candidate();
        }
        if (instance && typeof instance.execute === 'function' && instance.name) {
          loaded.push(instance);
        }
      } catch (e) {
        // Ignore invalid marketplace skills
      }
    }
    return loaded;
  }
}
