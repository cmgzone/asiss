import path from 'path';
import fs from 'fs';

type BetterSqliteModule = typeof import('better-sqlite3');
type BetterSqliteDatabase = import('better-sqlite3').Database;

export interface Memory {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  metadata?: any;
}

export class MemoryManager {
  private db: BetterSqliteDatabase | null = null;
  private dbPath: string;
  private jsonPath: string;
  private jsonData: Record<string, Memory[]> = {};
  private mode: 'sqlite' | 'json' = 'json';

  constructor(filename: string = 'memory.sqlite') {
    this.dbPath = path.join(process.cwd(), filename);
    this.jsonPath = path.join(process.cwd(), 'memory.json');

    const sqliteLoaded = this.initSqlite();
    if (!sqliteLoaded) {
      this.loadJson();
      return;
    }

    const dbExists = fs.existsSync(this.dbPath);
    this.initSqliteSchema();

    if (!dbExists) {
      this.migrateFromJson();
    }
  }

  private loadSqliteModule(): BetterSqliteModule | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('better-sqlite3') as BetterSqliteModule;
      return mod;
    } catch (err: any) {
      const message = err?.message ? ` (${err.message})` : '';
      console.warn(`[MemoryManager] SQLite unavailable, using JSON fallback${message}`);
      return null;
    }
  }

  private initSqlite(): boolean {
    const Database = this.loadSqliteModule();
    if (!Database) {
      this.mode = 'json';
      this.db = null;
      return false;
    }

    try {
      this.db = new Database(this.dbPath);
      this.mode = 'sqlite';
      return true;
    } catch (err: any) {
      const message = err?.message ? ` (${err.message})` : '';
      console.warn(`[MemoryManager] Failed to initialize SQLite, using JSON fallback${message}`);
      this.db = null;
      this.mode = 'json';
      return false;
    }
  }

  private initSqliteSchema() {
    if (!this.db) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT,
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_session_timestamp ON messages(session_id, timestamp);
    `);
  }

  private migrateFromJson() {
    if (!this.db) return;
    if (fs.existsSync(this.jsonPath)) {
      console.log('[MemoryManager] Migrating from memory.json to SQLite...');
      try {
        const data = JSON.parse(fs.readFileSync(this.jsonPath, 'utf-8'));
        const stmt = this.db.prepare(`
                INSERT INTO messages (session_id, role, content, metadata, timestamp)
                VALUES (?, ?, ?, ?, ?)
            `);

        const transaction = this.db.transaction((memories: any) => {
          for (const [sessionId, msgs] of Object.entries(memories)) {
            for (const msg of (msgs as any[])) {
              stmt.run(
                sessionId,
                msg.role,
                msg.content,
                msg.metadata ? JSON.stringify(msg.metadata) : null,
                msg.timestamp || Date.now()
              );
            }
          }
        });

        transaction(data);
        console.log('[MemoryManager] Migration complete.');
        // Rename old file to backup
        fs.renameSync(this.jsonPath, this.jsonPath + '.bak');
      } catch (e) {
        console.error('[MemoryManager] Migration failed:', e);
      }
    }
  }

  private loadJson() {
    if (!fs.existsSync(this.jsonPath)) {
      this.jsonData = {};
      return;
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(this.jsonPath, 'utf-8'));
      if (!parsed || typeof parsed !== 'object') {
        this.jsonData = {};
        return;
      }

      const normalized: Record<string, Memory[]> = {};
      for (const [sessionId, messages] of Object.entries(parsed)) {
        if (!Array.isArray(messages)) continue;
        normalized[sessionId] = messages
          .map((entry) => this.normalizeMemory(entry))
          .filter((entry): entry is Memory => entry !== null)
          .sort((a, b) => a.timestamp - b.timestamp);
      }
      this.jsonData = normalized;
    } catch (err) {
      console.error('[MemoryManager] Failed to load memory.json fallback:', err);
      this.jsonData = {};
    }
  }

  private normalizeMemory(entry: any): Memory | null {
    if (!entry || typeof entry !== 'object') return null;
    const roleRaw = String(entry.role || '').trim();
    const role: Memory['role'] =
      roleRaw === 'assistant' || roleRaw === 'system' ? roleRaw : 'user';
    const content = String(entry.content || '');
    if (!content) return null;

    const ts = Number(entry.timestamp);
    const timestamp = Number.isFinite(ts) ? ts : Date.now();
    const memory: Memory = {
      role,
      content,
      timestamp
    };
    if (entry.metadata !== undefined) {
      memory.metadata = entry.metadata;
    }
    return memory;
  }

  private persistJson() {
    try {
      fs.writeFileSync(this.jsonPath, JSON.stringify(this.jsonData, null, 2));
    } catch (err) {
      console.error('[MemoryManager] Failed to persist memory.json fallback:', err);
    }
  }

  public get(sessionId: string, limit: number = 50): Memory[] {
    if (this.mode === 'sqlite' && this.db) {
      const rows = this.db.prepare(`
        SELECT role, content, metadata, timestamp
        FROM messages
        WHERE session_id = ?
        ORDER BY timestamp ASC
      `).all(sessionId) as any[];

      if (limit > 0 && rows.length > limit) {
        return rows.slice(-limit).map(this.mapSqliteRow);
      }

      return rows.map(this.mapSqliteRow);
    }

    const rows = Array.isArray(this.jsonData[sessionId])
      ? [...this.jsonData[sessionId]]
      : [];
    rows.sort((a, b) => a.timestamp - b.timestamp);
    if (limit > 0 && rows.length > limit) {
      return rows.slice(-limit);
    }
    return rows;
  }

  public getAll(sessionId: string): Memory[] {
    return this.get(sessionId, 0);
  }

  private mapSqliteRow(row: any): Memory {
    let metadata: any = undefined;
    if (row.metadata) {
      try {
        metadata = JSON.parse(row.metadata);
      } catch {
        metadata = undefined;
      }
    }
    return {
      role: row.role,
      content: row.content,
      timestamp: row.timestamp,
      metadata
    };
  }

  public add(sessionId: string, memory: Memory) {
    const normalized = this.normalizeMemory(memory);
    if (!normalized) return;

    if (this.mode === 'sqlite' && this.db) {
      try {
        this.db.prepare(`
          INSERT INTO messages (session_id, role, content, metadata, timestamp)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          sessionId,
          normalized.role,
          normalized.content,
          normalized.metadata ? JSON.stringify(normalized.metadata) : null,
          normalized.timestamp
        );
      } catch (err) {
        console.error('[MemoryManager] Failed to save memory:', err);
      }
      return;
    }

    try {
      if (!Array.isArray(this.jsonData[sessionId])) {
        this.jsonData[sessionId] = [];
      }
      this.jsonData[sessionId].push(normalized);
      this.persistJson();
    } catch (err) {
      console.error('[MemoryManager] Failed to save memory:', err);
    }
  }

  /**
   * Search for relevant memories using FTS (Full Text Search) or simple LIKE for now
   */
  public search(query: string, limit: number = 5): Memory[] {
    if (!query) return [];

    if (this.mode === 'sqlite' && this.db) {
      try {
        const rows = this.db.prepare(`
              SELECT role, content, metadata, timestamp
              FROM messages
              WHERE content LIKE ?
              ORDER BY timestamp DESC
              LIMIT ?
          `).all(`%${query}%`, limit);
        return rows.map(this.mapSqliteRow);
      } catch (err) {
        console.error('[MemoryManager] Search failed:', err);
        return [];
      }
    }

    try {
      const needle = query.toLowerCase();
      const matches: Memory[] = [];
      for (const sessionMessages of Object.values(this.jsonData)) {
        for (const memory of sessionMessages) {
          if (String(memory.content || '').toLowerCase().includes(needle)) {
            matches.push(memory);
          }
        }
      }
      matches.sort((a, b) => b.timestamp - a.timestamp);
      return matches.slice(0, Math.max(0, limit));
    } catch (err) {
      console.error('[MemoryManager] Search failed:', err);
      return [];
    }
  }
}
