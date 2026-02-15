import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { MemoryManager } from './memory';
import { ModelProvider } from './models';
import { WebFetchSkill, WebSearchSkill } from '../skills/web';

type LearningEntryType = 'self_review' | 'external';

export interface LearningEntry {
  id: string;
  type: LearningEntryType;
  sessionId: string;
  title: string;
  summary: string;
  improvements?: string;
  sources?: Array<{ title: string; url: string }>;
  createdAt: number;
}

interface LearningConfig {
  enabled: boolean;
  mode: 'light' | 'medium' | 'strong';
  selfReview: {
    enabled: boolean;
    maxPerHour: number;
  };
  external: {
    enabled: boolean;
    intervalMs: number;
    maxTopics: number;
    maxSources: number;
    maxCharsPerSource: number;
    recentMessages: number;
  };
  report: boolean;
  summaryMaxEntries: number;
}

interface LearningState {
  lastExternalAt: Record<string, number>;
  lastReviewAt: Record<string, number>;
}

interface ReviewTask {
  sessionId: string;
  userText: string;
  assistantText: string;
  createdAt: number;
}

interface AutoTopic {
  query: string;
  reason?: string;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
}

export class LearningManager {
  private configPath = path.join(process.cwd(), 'config.json');
  private dataDir = path.join(process.cwd(), 'learning');
  private entriesPath = path.join(this.dataDir, 'learning_entries.json');
  private statePath = path.join(this.dataDir, 'learning_state.json');
  private summaryPath = path.join(process.cwd(), 'LEARNING.md');

  private config: LearningConfig;
  private state: LearningState = { lastExternalAt: {}, lastReviewAt: {} };
  private entries: LearningEntry[] = [];
  private pendingReviews: ReviewTask[] = [];
  private runningReview = false;
  private runningExternal = false;
  private lastActivityAt: Map<string, number> = new Map();

  private searchSkill = new WebSearchSkill();
  private fetchSkill = new WebFetchSkill();

  constructor(
    private getModel: () => ModelProvider,
    private memory: MemoryManager,
    private report?: (sessionId: string, message: string) => Promise<void>
  ) {
    this.config = this.getDefaultConfig();
    this.ensureDir(this.dataDir);
    this.loadState();
    this.loadEntries();
  }

  recordActivity(sessionId: string) {
    this.lastActivityAt.set(sessionId, Date.now());
  }

  recordInteraction(sessionId: string, userText: string, assistantText: string) {
    this.refreshConfig();
    if (!this.config.enabled) return;
    this.recordActivity(sessionId);

    const safeUser = this.redactSecrets(userText || '');
    const safeAssistant = this.redactSecrets(assistantText || '');
    if (!safeUser.trim() || !safeAssistant.trim()) return;

    if (this.config.selfReview.enabled) {
      this.pendingReviews.push({
        sessionId,
        userText: safeUser,
        assistantText: safeAssistant,
        createdAt: Date.now()
      });
      if (this.pendingReviews.length > 20) {
        this.pendingReviews = this.pendingReviews.slice(-20);
      }
    }
  }

  async tick() {
    this.refreshConfig();
    if (!this.config.enabled) return;
    await this.processNextReview();
    await this.processExternalLearning();
  }

  private getDefaultConfig(): LearningConfig {
    return {
      enabled: false,
      mode: 'light',
      selfReview: {
        enabled: false,
        maxPerHour: 10
      },
      external: {
        enabled: false,
        intervalMs: 30 * 60 * 1000,
        maxTopics: 2,
        maxSources: 4,
        maxCharsPerSource: 4000,
        recentMessages: 12
      },
      report: false,
      summaryMaxEntries: 200
    };
  }

  private refreshConfig() {
    const defaults = this.getDefaultConfig();
    let config = { ...defaults };
    if (fs.existsSync(this.configPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
        if (raw.learning && typeof raw.learning === 'object') {
          config = {
            ...config,
            ...raw.learning,
            selfReview: { ...config.selfReview, ...(raw.learning.selfReview || {}) },
            external: { ...config.external, ...(raw.learning.external || {}) }
          };
        }
      } catch {
        // keep defaults
      }
    }
    this.config = config;
  }

  private ensureDir(dir: string) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  private loadState() {
    if (!fs.existsSync(this.statePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf-8'));
      this.state = {
        lastExternalAt: parsed?.lastExternalAt || {},
        lastReviewAt: parsed?.lastReviewAt || {}
      };
    } catch {
      this.state = { lastExternalAt: {}, lastReviewAt: {} };
    }
  }

  private saveState() {
    try {
      fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
    } catch {
      // ignore
    }
  }

  private loadEntries() {
    if (!fs.existsSync(this.entriesPath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.entriesPath, 'utf-8'));
      if (Array.isArray(parsed)) {
        this.entries = parsed;
      }
    } catch {
      this.entries = [];
    }
  }

  private saveEntries() {
    try {
      fs.writeFileSync(this.entriesPath, JSON.stringify(this.entries, null, 2));
    } catch {
      // ignore
    }
  }

  private appendEntry(entry: LearningEntry) {
    this.entries.push(entry);
    if (this.entries.length > this.config.summaryMaxEntries * 2) {
      this.entries = this.entries.slice(-this.config.summaryMaxEntries * 2);
    }
    this.saveEntries();
    this.writeSummary();
  }

  private writeSummary() {
    const max = this.config.summaryMaxEntries || 200;
    const entries = this.entries.slice(-max).reverse();
    const lines: string[] = [];
    lines.push('# LEARNING.md');
    lines.push('');
    lines.push(`Updated: ${new Date().toISOString()}`);
    lines.push('');
    for (const entry of entries) {
      const when = new Date(entry.createdAt).toLocaleString();
      lines.push(`## ${when} - ${entry.title}`);
      lines.push(`Type: ${entry.type}`);
      lines.push('');
      if (entry.summary) lines.push(entry.summary.trim());
      if (entry.improvements) {
        lines.push('');
        lines.push('Improvements:');
        lines.push(entry.improvements.trim());
      }
      if (entry.sources && entry.sources.length > 0) {
        lines.push('');
        lines.push('Sources:');
        for (const s of entry.sources) {
          lines.push(`- ${s.title} (${s.url})`);
        }
      }
      lines.push('');
    }
    try {
      fs.writeFileSync(this.summaryPath, lines.join('\n'));
    } catch {
      // ignore
    }
  }

  private async processNextReview() {
    if (!this.config.selfReview.enabled) return;
    if (this.runningReview) return;
    const task = this.pendingReviews.shift();
    if (!task) return;

    const lastAt = this.state.lastReviewAt[task.sessionId] || 0;
    const now = Date.now();
    const minGapMs = Math.floor(60 * 60 * 1000 / Math.max(1, this.config.selfReview.maxPerHour));
    if (now - lastAt < minGapMs) return;

    this.runningReview = true;
    try {
      const systemPrompt = [
        'You are a quality reviewer.',
        'Identify improvements based only on the conversation.',
        'Do not invent facts.',
        'Return JSON only.'
      ].join(' ');

      const prompt = [
        'Review the assistant response and extract improvements.',
        'Return JSON: {"issueSummary":"","improvements":["..."],"lesson":""}',
        'If nothing to improve, return {"issueSummary":"none","improvements":[],"lesson":""}.',
        '',
        `User: ${task.userText}`,
        '',
        `Assistant: ${task.assistantText}`
      ].join('\n');

      const model = this.getModel();
      const resp = await model.generate(prompt, systemPrompt, []);
      const payload = this.safeJsonParse(resp?.content || '');
      if (!payload) return;

      const improvements = Array.isArray(payload.improvements) ? payload.improvements.filter(Boolean) : [];
      const lesson = typeof payload.lesson === 'string' ? payload.lesson.trim() : '';
      const issueSummary = typeof payload.issueSummary === 'string' ? payload.issueSummary.trim() : '';

      if (improvements.length === 0 && !lesson) return;

      const summaryLines: string[] = [];
      if (issueSummary && issueSummary !== 'none') {
        summaryLines.push(`Issue: ${issueSummary}`);
      }
      if (lesson) {
        summaryLines.push(`Lesson: ${lesson}`);
      }
      const summary = summaryLines.length ? summaryLines.map(l => `- ${l}`).join('\n') : '';
      const improvementsText = improvements.length ? improvements.map((i: string) => `- ${i}`).join('\n') : '';

      this.appendEntry({
        id: uuidv4(),
        type: 'self_review',
        sessionId: task.sessionId,
        title: 'Self-review feedback',
        summary,
        improvements: improvementsText,
        createdAt: Date.now()
      });

      this.state.lastReviewAt[task.sessionId] = Date.now();
      this.saveState();

      if (this.config.report && this.report) {
        const note = improvements[0] ? `Learning update saved: ${improvements[0]}` : 'Learning update saved.';
        await this.report(task.sessionId, note);
      }
    } finally {
      this.runningReview = false;
    }
  }

  private async processExternalLearning() {
    if (!this.config.external.enabled) return;
    if (this.runningExternal) return;
    const sessionId = this.getMostRecentSessionId();
    if (!sessionId) return;

    const lastAt = this.state.lastExternalAt[sessionId] || 0;
    if (Date.now() - lastAt < this.config.external.intervalMs) return;

    this.runningExternal = true;
    try {
      const topics = await this.extractTopicsFromMemory(sessionId);
      if (topics.length === 0) {
        this.state.lastExternalAt[sessionId] = Date.now();
        this.saveState();
        return;
      }

      for (const topic of topics) {
        const entry = await this.learnFromTopic(sessionId, topic);
        if (entry) {
          this.appendEntry(entry);
          if (this.config.report && this.report) {
            await this.report(sessionId, `Learning update saved: ${entry.title}`);
          }
        }
      }

      this.state.lastExternalAt[sessionId] = Date.now();
      this.saveState();
    } finally {
      this.runningExternal = false;
    }
  }

  private async extractTopicsFromMemory(sessionId: string): Promise<AutoTopic[]> {
    const recent = this.memory.get(sessionId, this.config.external.recentMessages) || [];
    if (recent.length === 0) return [];

    const convo = recent
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${this.redactSecrets(m.content)}`)
      .join('\n');

    if (!convo.trim()) return [];

    const systemPrompt = [
      'You are a topic extractor.',
      'Only include topics that are explicitly requested or clearly needed based on the conversation.',
      'Do not invent new tasks.',
      'Return JSON only.'
    ].join(' ');

    const prompt = [
      `Extract up to ${this.config.external.maxTopics} research topics.`,
      'Return JSON: {"topics":[{"query":"","reason":"","priority":"normal"}]}',
      'If none, return {"topics":[]}.',
      '',
      'Conversation:',
      convo
    ].join('\n');

    const model = this.getModel();
    const resp = await model.generate(prompt, systemPrompt, []);
    const payload = this.safeJsonParse(resp?.content || '');
    if (!payload || !Array.isArray(payload.topics)) return [];

    const topics: AutoTopic[] = [];
    for (const t of payload.topics) {
      const query = typeof t?.query === 'string' ? t.query.trim() : '';
      if (!query) continue;
      topics.push({
        query: this.redactSecrets(query),
        reason: typeof t?.reason === 'string' ? t.reason.trim() : undefined,
        priority: t?.priority
      });
    }
    return topics.slice(0, this.config.external.maxTopics);
  }

  private async learnFromTopic(sessionId: string, topic: AutoTopic): Promise<LearningEntry | null> {
    const searchRes = await this.searchSkill.execute({
      query: topic.query,
      maxResults: this.config.external.maxSources
    });

    const results = Array.isArray(searchRes?.results) ? searchRes.results : [];
    if (results.length === 0) return null;

    const sources: Array<{ title: string; url: string; text?: string }> = [];
    for (const result of results.slice(0, this.config.external.maxSources)) {
      try {
        const fetched = await this.fetchSkill.execute({
          url: result.url,
          maxChars: this.config.external.maxCharsPerSource,
          timeoutMs: 12000
        });
        const text = typeof fetched?.text === 'string' ? fetched.text.slice(0, this.config.external.maxCharsPerSource) : '';
        sources.push({ title: result.title, url: result.url, text });
      } catch {
        sources.push({ title: result.title, url: result.url, text: '' });
      }
    }

    const sourcesBlock = sources
      .map((s, i) => {
        const idx = i + 1;
        const snippet = s.text ? s.text.slice(0, 2000) : '';
        return `[${idx}] ${s.title}\nURL: ${s.url}\n${snippet}`;
      })
      .join('\n\n');

    const systemPrompt = [
      'You are a learning summarizer.',
      'Use only the provided sources.',
      'Return JSON only.'
    ].join(' ');

    const prompt = [
      `Create a short learning note for: ${topic.query}`,
      'Return JSON: {"title":"","summary":["- ..."],"improvements":["- ..."]}',
      'Keep it concise and actionable.',
      '',
      'Sources:',
      sourcesBlock
    ].join('\n');

    const model = this.getModel();
    const resp = await model.generate(prompt, systemPrompt, []);
    const payload = this.safeJsonParse(resp?.content || '');
    if (!payload) return null;

    const title = typeof payload.title === 'string' && payload.title.trim() ? payload.title.trim() : topic.query;
    const summaryLines = Array.isArray(payload.summary) ? payload.summary.filter(Boolean) : [];
    const improvementsLines = Array.isArray(payload.improvements) ? payload.improvements.filter(Boolean) : [];

    const summary = summaryLines.length ? summaryLines.join('\n') : '';
    const improvements = improvementsLines.length ? improvementsLines.join('\n') : '';

    return {
      id: uuidv4(),
      type: 'external',
      sessionId,
      title: this.redactSecrets(title),
      summary: this.redactSecrets(summary),
      improvements: this.redactSecrets(improvements),
      sources: sources.map(s => ({ title: s.title, url: s.url })),
      createdAt: Date.now()
    };
  }

  private safeJsonParse(raw: string) {
    if (!raw) return null;
    const cleaned = raw
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim();
    try {
      return JSON.parse(cleaned);
    } catch {
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(cleaned.slice(start, end + 1));
        } catch {
          return null;
        }
      }
      return null;
    }
  }

  private getMostRecentSessionId(): string | null {
    let best: string | null = null;
    let bestTime = 0;
    for (const [sessionId, time] of this.lastActivityAt.entries()) {
      if (time > bestTime) {
        bestTime = time;
        best = sessionId;
      }
    }
    return best;
  }

  private redactSecrets(text: string) {
    let t = String(text || '');
    const patterns: RegExp[] = [
      /sk-[A-Za-z0-9]{10,}/g,
      /nvapi-[A-Za-z0-9_-]{10,}/g,
      /AIza[0-9A-Za-z\-_]{20,}/g,
      /xox[baprs]-[A-Za-z0-9-]{10,}/g,
      /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g
    ];
    for (const pattern of patterns) {
      t = t.replace(pattern, '[REDACTED]');
    }
    return t;
  }
}
