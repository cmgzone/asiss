import path from 'path';
import fs from 'fs';
import { bestEffortRenameSync } from './atomic-write';

type BetterSqliteModule = typeof import('better-sqlite3');
type BetterSqliteDatabase = import('better-sqlite3').Database;

export interface Memory {
  id?: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  metadata?: any;
  semanticScore?: number;
}

interface SemanticMemoryConfig {
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  maxChars: number;
  maxIndexPerSearch: number;
  minScore: number;
}

export class MemoryManager {
  private db: BetterSqliteDatabase | null = null;
  private dbPath: string;
  private jsonPath: string;
  private jsonData: Record<string, Memory[]> = {};
  private mode: 'sqlite' | 'json' = 'json';

  constructor(filename: string = 'memory.sqlite') {
    // phase23-ok: engine-root state files (the app's own memory store), never project context
    this.dbPath = path.join(process.cwd(), filename); // phase23-ok
    this.jsonPath = path.join(process.cwd(), 'memory.json'); // phase23-ok

    const dbExists = fs.existsSync(this.dbPath);
    const sqliteLoaded = this.initSqlite();
    if (!sqliteLoaded) {
      this.loadJson();
      return;
    }

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
    // Make message_embeddings.message_id CASCADE actually enforce on delete.
    this.db.pragma('foreign_keys = ON');
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

      CREATE TABLE IF NOT EXISTS message_embeddings (
        message_id INTEGER PRIMARY KEY,
        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        vector TEXT NOT NULL,
        indexed_at INTEGER NOT NULL,
        FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_message_embeddings_model ON message_embeddings(model);
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
        // Rename old file to backup (Phase 22: best-effort — a transient
        // OneDrive lock on the old JSON must not fail the migration).
        if (!bestEffortRenameSync(this.jsonPath, this.jsonPath + '.bak')) {
          console.warn('[MemoryManager] Could not back up legacy memory file; migration itself succeeded.');
        }
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
        SELECT id, session_id, role, content, metadata, timestamp
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
    // Surface the owning session on search/get results so consumers can build
    // stable cross-session ids (the unified memory catalog dedupes on them).
    if (row.session_id) {
      metadata = { ...(metadata || {}), sessionId: row.session_id };
    }
    return {
      id: row.id,
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
        const info = this.db.prepare(`
          INSERT INTO messages (session_id, role, content, metadata, timestamp)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          sessionId,
          normalized.role,
          normalized.content,
          normalized.metadata ? JSON.stringify(normalized.metadata) : null,
          normalized.timestamp
        ) as any;

        const messageId = Number(info?.lastInsertRowid);
        if (Number.isFinite(messageId)) {
          void this.indexMessageEmbedding(messageId);
        }
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
        // Escape LIKE wildcards so user queries like "100%" or "a_b" are matched literally.
        const escaped = query.replace(/[\\%_]/g, '\\$&');
        const rows = this.db.prepare(`
              SELECT id, session_id, role, content, metadata, timestamp
              FROM messages
              WHERE content LIKE ? ESCAPE '\\'
              ORDER BY timestamp DESC
              LIMIT ?
          `).all(`%${escaped}%`, limit);
        return rows.map(this.mapSqliteRow);
      } catch (err) {
        console.error('[MemoryManager] Search failed:', err);
        return [];
      }
    }

    try {
      const needle = query.toLowerCase();
      const matches: Memory[] = [];
      for (const [sessionKey, sessionMessages] of Object.entries(this.jsonData)) {
        for (const memory of sessionMessages) {
          if (String(memory.content || '').toLowerCase().includes(needle)) {
            // Carry the owning session so cross-session results keep a stable
            // identity for consumers (unified memory catalog dedupe).
            matches.push({ ...memory, metadata: { ...(memory.metadata || {}), sessionId: sessionKey } });
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

  private loadSemanticConfig(): SemanticMemoryConfig {
    const defaults: SemanticMemoryConfig = {
      enabled: false,
      baseUrl: 'https://api.openai.com/v1',
      model: 'text-embedding-3-small',
      apiKeyEnv: 'EMBEDDINGS_API_KEY',
      maxChars: 6000,
      maxIndexPerSearch: 25,
      minScore: 0.2
    };

    let config = { ...defaults };
    try {
      // phase23-ok: engine-root config file, not project context
      const configPath = path.join(process.cwd(), 'config.json');
      if (fs.existsSync(configPath)) {
        const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        if (raw.memory?.semantic && typeof raw.memory.semantic === 'object') {
          config = { ...config, ...raw.memory.semantic };
        }
      }
    } catch {
      // keep defaults
    }

    if (process.env.EMBEDDINGS_BASE_URL) config.baseUrl = process.env.EMBEDDINGS_BASE_URL;
    if (process.env.EMBEDDINGS_MODEL) config.model = process.env.EMBEDDINGS_MODEL;

    config.enabled = Boolean(config.enabled);
    config.baseUrl = String(config.baseUrl || defaults.baseUrl).replace(/\/+$/, '');
    config.model = String(config.model || defaults.model);
    config.apiKeyEnv = String(config.apiKeyEnv || defaults.apiKeyEnv);
    config.maxChars = Math.max(256, Math.floor(Number(config.maxChars) || defaults.maxChars));
    config.maxIndexPerSearch = Math.max(0, Math.floor(Number(config.maxIndexPerSearch) || defaults.maxIndexPerSearch));
    config.minScore = Number.isFinite(Number(config.minScore)) ? Number(config.minScore) : defaults.minScore;
    return config;
  }

  private isLocalEmbeddingBaseUrl(baseUrl: string) {
    try {
      const url = new URL(baseUrl);
      const host = url.hostname.toLowerCase();
      return host === 'localhost' || host === '127.0.0.1' || host === '::1';
    } catch {
      return false;
    }
  }

  private getEmbeddingApiKey(config: SemanticMemoryConfig) {
    return process.env[config.apiKeyEnv]
      || process.env.EMBEDDINGS_API_KEY
      || process.env.OPENAI_API_KEY
      || '';
  }

  private async embedText(text: string, config: SemanticMemoryConfig): Promise<number[]> {
    if (!config.enabled) {
      throw new Error('Semantic memory is disabled.');
    }

    const apiKey = this.getEmbeddingApiKey(config);
    if (!apiKey && !this.isLocalEmbeddingBaseUrl(config.baseUrl)) {
      throw new Error(`Semantic memory needs an embeddings key. Set ${config.apiKeyEnv} or OPENAI_API_KEY, or configure a local embeddings baseUrl.`);
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const res = await fetch(`${config.baseUrl}/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.model,
        input: String(text || '').slice(0, config.maxChars)
      })
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Embeddings request failed (${res.status}): ${detail}`);
    }

    const data: any = await res.json();
    const vector = data?.data?.[0]?.embedding || data?.embedding;
    if (!Array.isArray(vector) || vector.length === 0) {
      throw new Error('Embeddings response did not contain a vector.');
    }
    return vector.map((n: any) => Number(n)).filter((n: number) => Number.isFinite(n));
  }

  private async indexMessageEmbedding(messageId: number, config = this.loadSemanticConfig()) {
    if (!config.enabled || this.mode !== 'sqlite' || !this.db) return;

    try {
      const row = this.db.prepare(`
        SELECT id, content
        FROM messages
        WHERE id = ?
      `).get(messageId) as any;
      if (!row?.content) return;

      const existing = this.db.prepare(`
        SELECT message_id
        FROM message_embeddings
        WHERE message_id = ? AND model = ?
      `).get(messageId, config.model);
      if (existing) return;

      const vector = await this.embedText(row.content, config);
      if (vector.length === 0) return;

      this.db.prepare(`
        INSERT OR REPLACE INTO message_embeddings (message_id, model, dimensions, vector, indexed_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(messageId, config.model, vector.length, JSON.stringify(vector), Date.now());
    } catch (err: any) {
      const message = err?.message || String(err);
      if (!message.includes('Semantic memory needs an embeddings key')) {
        console.warn('[MemoryManager] Semantic indexing skipped:', message);
      }
    }
  }

  private async indexMissingEmbeddings(limit: number, config: SemanticMemoryConfig) {
    if (!config.enabled || this.mode !== 'sqlite' || !this.db || limit <= 0) return 0;
    const rows = this.db.prepare(`
      SELECT m.id
      FROM messages m
      LEFT JOIN message_embeddings e
        ON e.message_id = m.id AND e.model = ?
      WHERE e.message_id IS NULL
      ORDER BY m.timestamp DESC
      LIMIT ?
    `).all(config.model, limit) as Array<{ id: number }>;

    let indexed = 0;
    for (const row of rows) {
      await this.indexMessageEmbedding(Number(row.id), config);
      indexed += 1;
    }
    return indexed;
  }

  private cosineSimilarity(a: number[], b: number[]) {
    const len = Math.min(a.length, b.length);
    if (len === 0) return 0;
    let dot = 0;
    let aNorm = 0;
    let bNorm = 0;
    for (let i = 0; i < len; i++) {
      dot += a[i] * b[i];
      aNorm += a[i] * a[i];
      bNorm += b[i] * b[i];
    }
    if (!aNorm || !bNorm) return 0;
    return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
  }

  public async semanticSearch(query: string, limit: number = 5): Promise<{
    mode: 'semantic' | 'keyword';
    reason?: string;
    count: number;
    results: Memory[];
  }> {
    const config = this.loadSemanticConfig();
    if (!config.enabled) {
      const results = this.search(query, limit);
      return { mode: 'keyword', reason: 'Semantic memory is disabled.', count: results.length, results };
    }

    if (this.mode !== 'sqlite' || !this.db) {
      const results = this.search(query, limit);
      return { mode: 'keyword', reason: 'Semantic memory requires SQLite; using keyword fallback.', count: results.length, results };
    }

    try {
      const queryVector = await this.embedText(query, config);
      await this.indexMissingEmbeddings(config.maxIndexPerSearch, config);

      const rows = this.db.prepare(`
        SELECT m.id, m.role, m.content, m.metadata, m.timestamp, e.vector
        FROM message_embeddings e
        JOIN messages m ON m.id = e.message_id
        WHERE e.model = ?
      `).all(config.model) as any[];

      const scored = rows
        .map((row) => {
          try {
            const vector = JSON.parse(row.vector);
            const score = this.cosineSimilarity(queryVector, vector);
            const memory = this.mapSqliteRow(row);
            memory.semanticScore = score;
            return memory;
          } catch {
            return null;
          }
        })
        .filter((memory): memory is Memory => !!memory && (memory.semanticScore || 0) >= config.minScore)
        .sort((a, b) => (b.semanticScore || 0) - (a.semanticScore || 0))
        .slice(0, Math.max(1, limit));

      if (scored.length === 0) {
        const fallback = this.search(query, limit);
        return { mode: 'keyword', reason: 'No semantic matches met the score threshold.', count: fallback.length, results: fallback };
      }

      return { mode: 'semantic', count: scored.length, results: scored };
    } catch (err: any) {
      const fallback = this.search(query, limit);
      return {
        mode: 'keyword',
        reason: err?.message || 'Semantic memory unavailable; using keyword fallback.',
        count: fallback.length,
        results: fallback
      };
    }
  }
}
