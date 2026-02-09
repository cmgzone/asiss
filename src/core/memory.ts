import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

export interface Memory {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  metadata?: any;
}

export class MemoryManager {
  private db: Database.Database;
  private dbPath: string;

  constructor(filename: string = 'memory.sqlite') {
    this.dbPath = path.join(process.cwd(), filename);
    const dbExists = fs.existsSync(this.dbPath);

    this.db = new Database(this.dbPath);
    this.init();

    if (!dbExists) {
      this.migrateFromJson();
    }
  }

  private init() {
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
    const jsonPath = path.join(process.cwd(), 'memory.json');
    if (fs.existsSync(jsonPath)) {
      console.log('[MemoryManager] Migrating from memory.json to SQLite...');
      try {
        const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
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
        fs.renameSync(jsonPath, jsonPath + '.bak');
      } catch (e) {
        console.error('[MemoryManager] Migration failed:', e);
      }
    }
  }

  public get(sessionId: string, limit: number = 50): Memory[] {
    const rows = this.db.prepare(`
      SELECT role, content, metadata, timestamp 
      FROM messages 
      WHERE session_id = ? 
      ORDER BY timestamp ASC
    `).all(sessionId) as any[];

    // If we want only the last N messages to fit context
    // We should probably select them by DESC limit N and then reverse
    if (limit > 0 && rows.length > limit) {
      return rows.slice(-limit).map(this.mapRow);
    }

    return rows.map(this.mapRow);
  }

  public getAll(sessionId: string): Memory[] {
    return this.get(sessionId, 0);
  }

  private mapRow(row: any): Memory {
    return {
      role: row.role,
      content: row.content,
      timestamp: row.timestamp,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined
    };
  }

  public add(sessionId: string, memory: Memory) {
    try {
      this.db.prepare(`
        INSERT INTO messages (session_id, role, content, metadata, timestamp)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        sessionId,
        memory.role,
        memory.content,
        memory.metadata ? JSON.stringify(memory.metadata) : null,
        memory.timestamp
      );
    } catch (err) {
      console.error('[MemoryManager] Failed to save memory:', err);
    }
  }

  /**
   * Search for relevant memories using FTS (Full Text Search) or simple LIKE for now
   */
  public search(query: string, limit: number = 5): Memory[] {
    try {
      const rows = this.db.prepare(`
            SELECT role, content, metadata, timestamp 
            FROM messages 
            WHERE content LIKE ? 
            ORDER BY timestamp DESC 
            LIMIT ?
        `).all(`%${query}%`, limit);
      return rows.map(this.mapRow);
    } catch (err) {
      console.error('[MemoryManager] Search failed:', err);
      return [];
    }
  }
}
