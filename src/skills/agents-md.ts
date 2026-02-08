import fs from 'fs';
import path from 'path';
import { Skill } from '../core/skills';

type AgentsMdAction =
  | 'status'
  | 'ensure'
  | 'read';

export class AgentsMdSkill implements Skill {
  name = 'agents_md';
  description =
    'Manages AGENTS.md workspace continuity files. Invoke when user asks to bootstrap/check AGENTS.md/SOUL.md/USER.md/MEMORY.md/HEARTBEAT.md.';

  inputSchema = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['status', 'ensure', 'read'],
        description: 'status=check files, ensure=create missing files, read=return contents'
      },
      files: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional list of files to ensure/read'
      },
      includeDaily: {
        type: 'boolean',
        description: 'If true, include today+esterday memory files in status/read'
      }
    },
    required: ['action']
  };

  private root = process.cwd();

  private defaultFiles() {
    return ['AGENTS.md', 'SOUL.md', 'USER.md', 'MEMORY.md', 'HEARTBEAT.md'];
  }

  private resolveFile(name: string) {
    return path.join(this.root, name);
  }

  private ensureDir(dirPath: string) {
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
  }

  private formatDateKey(d: Date) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  private dailyFiles(includeDaily: boolean) {
    if (!includeDaily) return [];
    const now = new Date();
    const todayKey = this.formatDateKey(now);
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const yesterdayKey = this.formatDateKey(yesterday);
    return [
      path.join('memory', `${yesterdayKey}.md`),
      path.join('memory', `${todayKey}.md`)
    ];
  }

  private readFileIfExists(filePath: string) {
    try {
      if (!fs.existsSync(filePath)) return null;
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }
  }

  private writeFileIfMissing(filePath: string, content: string) {
    if (fs.existsSync(filePath)) return false;
    this.ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, content);
    return true;
  }

  private templateFor(fileName: string) {
    if (fileName === 'AGENTS.md') {
      return `# AGENTS.md - Your Workspace

This folder is home. Treat it that way.

## Every Session
1. Read SOUL.md
2. Read USER.md
3. Read memory/YYYY-MM-DD.md (today + yesterday)
4. If in MAIN SESSION: read MEMORY.md
`;
    }
    if (fileName === 'SOUL.md') {
      return `# Core Identity
You are GituAI, a proactive personal AI assistant.
You run locally and respect user privacy.
`;
    }
    if (fileName === 'USER.md') {
      return `# USER.md
- Follow the project rules in AGENTS.md.
`;
    }
    if (fileName === 'MEMORY.md') {
      return `# MEMORY.md
- Long-term notes go here.
`;
    }
    if (fileName === 'HEARTBEAT.md') {
      return `# HEARTBEAT.md
- If nothing needs attention, reply: HEARTBEAT_OK
`;
    }
    return '';
  }

  async execute(params: any): Promise<any> {
    const action = String(params?.action || '').trim() as AgentsMdAction;
    const includeDaily = Boolean(params?.includeDaily);
    const list = Array.isArray(params?.files) && params.files.length > 0
      ? params.files.map((s: any) => String(s))
      : this.defaultFiles();

    const requested = [
      ...list,
      ...this.dailyFiles(includeDaily)
    ].map((f) => f.replace(/[\\/]+/g, path.sep));

    if (action === 'status') {
      const files = requested.map((name) => {
        const filePath = this.resolveFile(name);
        const exists = fs.existsSync(filePath);
        const size = exists ? fs.statSync(filePath).size : 0;
        return { name, exists, size };
      });
      return { success: true, files };
    }

    if (action === 'ensure') {
      const created: string[] = [];
      const skipped: string[] = [];
      for (const name of requested) {
        const filePath = this.resolveFile(name);
        const base = path.basename(name);
        const content = this.templateFor(base);
        if (!content) {
          skipped.push(name);
          continue;
        }
        const didCreate = this.writeFileIfMissing(filePath, content);
        if (didCreate) created.push(name);
        else skipped.push(name);
      }
      return { success: true, created, skipped };
    }

    if (action === 'read') {
      const contents = requested.map((name) => {
        const filePath = this.resolveFile(name);
        const text = this.readFileIfExists(filePath);
        return { name, exists: text !== null, content: text ?? '' };
      });
      return { success: true, contents };
    }

    return { error: `Unknown action: ${action}` };
  }
}

