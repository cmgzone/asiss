import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { MemoryManager } from './memory';
import { ModelProvider } from './models';
import { WebFetchSkill, WebSearchSkill } from '../skills/web';
import { backgroundWorker, BackgroundGoal, GoalPriority } from './background-worker';
import { dndManager } from './dnd';
import { learnedSkillsManager } from './learned-skills';
import { SkillRegistry } from './skills';

type LearningEntryType = 'self_review' | 'external';
type PendingLearningActionType = 'background_goal' | 'auto_update';
type PendingLearningActionStatus = 'pending' | 'applied' | 'rejected';

export interface LearningEntry {
  id: string;
  type: LearningEntryType;
  sessionId: string;
  title: string;
  summary: string;
  improvements?: string;
  recommendations?: string;
  sources?: Array<{ title: string; url: string }>;
  createdAt: number;
}

export interface PendingLearningAction {
  id: string;
  type: PendingLearningActionType;
  status: PendingLearningActionStatus;
  sessionId: string;
  entryId: string;
  entryTitle: string;
  summary?: string;
  action: string;
  createdAt: number;
  appliedAt?: number;
  rejectedAt?: number;
  timesUsed: number;
  successCount: number;
  failureCount: number;
  confidence: number;
  lastFeedbackAt?: number;
  feedback: Array<{
    outcome: 'success' | 'failure';
    note?: string;
    createdAt: number;
  }>;
  target?: 'USER.md' | 'AGENTS.md';
  sectionTitle?: string;
  lines?: string[];
  goal?: {
    title: string;
    description: string;
    priority: GoalPriority;
    estimatedMinutes?: number;
    tags: string[];
  };
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
  autoGoals: {
    enabled: boolean;
    includeSelfReview: boolean;
    includeExternal: boolean;
    maxPerEntry: number;
    priority: GoalPriority;
  };
  autoUpdate: {
    enabled: boolean;
    target: 'USER.md' | 'AGENTS.md';
    maxPerEntry: number;
    maxPerDay: number;
  };
  skillCreation: {
    enabled: boolean;
    includeSelfReview: boolean;
    includeExternal: boolean;
    maxPerEntry: number;
    minActionChars: number;
    executable: {
      enabled: boolean;
      maxSteps: number;
      allowedTools: string[];
    };
  };
  approval: {
    enabled: boolean;
  };
  selfTraining: {
    enabled: boolean;
    minConfidence: number;
    minSuccesses: number;
    maxPromptLessons: number;
    exportPath: string;
    includeFailures: boolean;
  };
  dailySummary: {
    enabled: boolean;
    hourLocal: number;
    minuteLocal: number;
    includeRecommendations: boolean;
    includeGoals: boolean;
  };
}

interface LearningState {
  lastExternalAt: Record<string, number>;
  lastReviewAt: Record<string, number>;
  lastSummaryAt: Record<string, string>;
  autoGoalsForEntry: Record<string, boolean>;
  autoUpdatesForEntry: Record<string, boolean>;
  autoUpdatesPerDay: Record<string, number>;
  skillGoalsForEntry: Record<string, boolean>;
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

interface LearningModeProfile {
  mode: LearningConfig['mode'];
  reviewMaxImprovements: number;
  externalMaxTopics: number;
  externalMaxSources: number;
  externalMaxCharsPerSource: number;
  autoGoalMaxPerEntry: number;
  autoUpdateMaxPerEntry: number;
  reviewGuidance: string;
  externalGuidance: string;
}

export class LearningManager {
  private configPath = path.join(process.cwd(), 'config.json');
  private dataDir = path.join(process.cwd(), 'learning');
  private entriesPath = path.join(this.dataDir, 'learning_entries.json');
  private statePath = path.join(this.dataDir, 'learning_state.json');
  private pendingPath = path.join(this.dataDir, 'pending_lessons.json');
  private reviewsPath = path.join(this.dataDir, 'pending_reviews.json');
  private summaryPath = path.join(process.cwd(), 'LEARNING.md');

  private config: LearningConfig;
  private state: LearningState = {
    lastExternalAt: {},
    lastReviewAt: {},
    lastSummaryAt: {},
    autoGoalsForEntry: {},
    autoUpdatesForEntry: {},
    autoUpdatesPerDay: {},
    skillGoalsForEntry: {}
  };
  private entries: LearningEntry[] = [];
  private pendingActions: PendingLearningAction[] = [];
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
    this.loadPendingActions();
    this.loadPendingReviews();
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
    const meaningfulTask = safeUser.trim().length >= 20
      && safeAssistant.trim().length >= 80
      && /\b(fix|create|build|implement|debug|research|analy[sz]e|review|refactor|test|deploy|configure|automate|integrate|design|write|update|add|remove|enable|disable|migrate|optimi[sz]e)\b/i.test(safeUser);
    if (!meaningfulTask) return;

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
      this.savePendingReviews();
    }
  }

  async tick() {
    this.refreshConfig();
    if (!this.config.enabled) return;
    await this.processNextReview();
    await this.processExternalLearning();
    await this.maybeSendDailySummary();
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
      summaryMaxEntries: 200,
      autoGoals: {
        enabled: false,
        includeSelfReview: true,
        includeExternal: true,
        maxPerEntry: 2,
        priority: 'normal'
      },
      autoUpdate: {
        enabled: false,
        target: 'USER.md',
        maxPerEntry: 2,
        maxPerDay: 5
      },
      skillCreation: {
        enabled: false,
        includeSelfReview: true,
        includeExternal: false,
        maxPerEntry: 1,
        minActionChars: 24,
        executable: {
          enabled: false,
          maxSteps: 6,
          allowedTools: ['system_info', 'current_time', 'web_search', 'web_fetch', 'brave_search', 'serper_search', 'code_search', 'notes', 'memory', 'task_memory']
        }
      },
      approval: {
        enabled: true
      },
      selfTraining: {
        enabled: true,
        minConfidence: 0.66,
        minSuccesses: 1,
        maxPromptLessons: 8,
        exportPath: 'learning/training_examples.jsonl',
        includeFailures: false
      },
      dailySummary: {
        enabled: false,
        hourLocal: 20,
        minuteLocal: 0,
        includeRecommendations: true,
        includeGoals: true
      }
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
            external: { ...config.external, ...(raw.learning.external || {}) },
            autoGoals: { ...config.autoGoals, ...(raw.learning.autoGoals || {}) },
            autoUpdate: { ...config.autoUpdate, ...(raw.learning.autoUpdate || {}) },
            skillCreation: {
              ...config.skillCreation,
              ...(raw.learning.skillCreation || {}),
              executable: {
                ...config.skillCreation.executable,
                ...(raw.learning.skillCreation?.executable || {})
              }
            },
            approval: { ...config.approval, ...(raw.learning.approval || {}) },
            selfTraining: { ...config.selfTraining, ...(raw.learning.selfTraining || {}) },
            dailySummary: { ...config.dailySummary, ...(raw.learning.dailySummary || {}) }
          };
        }
      } catch {
        // keep defaults
      }
    }
    this.config = config;
  }

  private getSelfTrainingConfig() {
    const cfg = this.config.selfTraining || this.getDefaultConfig().selfTraining;
    return {
      enabled: cfg.enabled !== false,
      minConfidence: Number.isFinite(Number(cfg.minConfidence)) ? Number(cfg.minConfidence) : 0.66,
      minSuccesses: Math.max(0, Math.floor(Number(cfg.minSuccesses) || 0)),
      maxPromptLessons: Math.max(0, Math.floor(Number(cfg.maxPromptLessons) || 8)),
      exportPath: String(cfg.exportPath || 'learning/training_examples.jsonl'),
      includeFailures: Boolean(cfg.includeFailures)
    };
  }

  private getModeProfile(): LearningModeProfile {
    const mode: LearningConfig['mode'] =
      this.config.mode === 'medium' || this.config.mode === 'strong'
        ? this.config.mode
        : 'light';

    const configuredTopics = Math.max(1, Math.floor(this.config.external.maxTopics || 1));
    const configuredSources = Math.max(1, Math.floor(this.config.external.maxSources || 1));
    const configuredChars = Math.max(500, Math.floor(this.config.external.maxCharsPerSource || 1000));
    const configuredGoalActions = Math.max(1, Math.floor(this.config.autoGoals.maxPerEntry || 1));
    const configuredUpdateActions = Math.max(1, Math.floor(this.config.autoUpdate.maxPerEntry || 1));

    if (mode === 'strong') {
      return {
        mode,
        reviewMaxImprovements: 5,
        externalMaxTopics: Math.min(5, Math.max(configuredTopics, configuredTopics * 2)),
        externalMaxSources: Math.min(8, Math.max(configuredSources + 2, configuredSources)),
        externalMaxCharsPerSource: Math.min(12000, Math.max(configuredChars, Math.floor(configuredChars * 1.5))),
        autoGoalMaxPerEntry: Math.min(6, Math.max(configuredGoalActions, configuredGoalActions * 2)),
        autoUpdateMaxPerEntry: Math.min(6, Math.max(configuredUpdateActions, configuredUpdateActions * 2)),
        reviewGuidance: [
          'Use strong review depth.',
          'Find root causes, durable behavior rules, and testable correction signals.',
          'Prefer lessons that would measurably improve future responses.'
        ].join(' '),
        externalGuidance: [
          'Use strong synthesis depth.',
          'Cross-check sources, call out uncertainty, and produce recommendations that can be verified later.'
        ].join(' ')
      };
    }

    if (mode === 'medium') {
      return {
        mode,
        reviewMaxImprovements: 3,
        externalMaxTopics: configuredTopics,
        externalMaxSources: configuredSources,
        externalMaxCharsPerSource: configuredChars,
        autoGoalMaxPerEntry: configuredGoalActions,
        autoUpdateMaxPerEntry: configuredUpdateActions,
        reviewGuidance: 'Use medium review depth. Extract clear, reusable lessons without overfitting.',
        externalGuidance: 'Use medium synthesis depth. Summarize sources and produce practical recommendations.'
      };
    }

    return {
      mode,
      reviewMaxImprovements: 1,
      externalMaxTopics: Math.min(1, configuredTopics),
      externalMaxSources: Math.min(2, configuredSources),
      externalMaxCharsPerSource: Math.min(2500, configuredChars),
      autoGoalMaxPerEntry: 1,
      autoUpdateMaxPerEntry: 1,
      reviewGuidance: 'Use light review depth. Only extract a lesson when there is a clear, concrete improvement.',
      externalGuidance: 'Use light synthesis depth. Keep notes brief and avoid speculative recommendations.'
    };
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
        lastReviewAt: parsed?.lastReviewAt || {},
        lastSummaryAt: parsed?.lastSummaryAt || {},
        autoGoalsForEntry: parsed?.autoGoalsForEntry || {},
        autoUpdatesForEntry: parsed?.autoUpdatesForEntry || {},
        autoUpdatesPerDay: parsed?.autoUpdatesPerDay || {},
        skillGoalsForEntry: parsed?.skillGoalsForEntry || {}
      };
    } catch {
      this.state = {
        lastExternalAt: {},
        lastReviewAt: {},
        lastSummaryAt: {},
        autoGoalsForEntry: {},
        autoUpdatesForEntry: {},
        autoUpdatesPerDay: {},
        skillGoalsForEntry: {}
      };
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

  private loadPendingActions() {
    if (!fs.existsSync(this.pendingPath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.pendingPath, 'utf-8'));
      if (Array.isArray(parsed)) {
        this.pendingActions = parsed
          .filter((item) => item && typeof item === 'object')
          .map((item) => ({
            ...item,
            status: item.status === 'applied' || item.status === 'rejected' ? item.status : 'pending',
            timesUsed: Math.max(0, Math.floor(Number(item.timesUsed) || 0)),
            successCount: Math.max(0, Math.floor(Number(item.successCount) || 0)),
            failureCount: Math.max(0, Math.floor(Number(item.failureCount) || 0)),
            confidence: Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : 0.5,
            feedback: Array.isArray(item.feedback) ? item.feedback : []
          }));
      }
    } catch {
      this.pendingActions = [];
    }
  }

  private savePendingActions() {
    try {
      fs.writeFileSync(this.pendingPath, JSON.stringify(this.pendingActions, null, 2));
    } catch {
      // ignore
    }
  }

  private loadPendingReviews() {
    if (!fs.existsSync(this.reviewsPath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.reviewsPath, 'utf-8'));
      this.pendingReviews = Array.isArray(parsed)
        ? parsed.filter(item => item && typeof item === 'object').map(item => ({
            sessionId: String(item.sessionId || ''),
            userText: this.redactSecrets(String(item.userText || '')),
            assistantText: this.redactSecrets(String(item.assistantText || '')),
            createdAt: Number(item.createdAt) || Date.now()
          })).filter(item => item.sessionId && item.userText && item.assistantText).slice(-20)
        : [];
    } catch {
      this.pendingReviews = [];
    }
  }

  private savePendingReviews() {
    try {
      fs.writeFileSync(this.reviewsPath, JSON.stringify(this.pendingReviews.slice(-20), null, 2));
    } catch {
      // keep learning available even if review persistence fails
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
    this.handleAutoGoals(entry);
    this.handleAutoUpdate(entry);
    this.handleSkillCreation(entry);
  }

  private approvalsEnabled() {
    return this.config.approval?.enabled !== false;
  }

  private queuePendingAction(action: Omit<
    PendingLearningAction,
    'id' | 'status' | 'createdAt' | 'timesUsed' | 'successCount' | 'failureCount' | 'confidence' | 'feedback'
  >) {
    const pending: PendingLearningAction = {
      ...action,
      id: uuidv4(),
      status: 'pending',
      createdAt: Date.now(),
      timesUsed: 0,
      successCount: 0,
      failureCount: 0,
      confidence: 0.5,
      feedback: []
    };
    this.pendingActions.push(pending);
    this.savePendingActions();
    return pending;
  }

  public listPendingLearningActions(sessionId?: string, includeResolved = false): PendingLearningAction[] {
    return this.pendingActions
      .filter((action) => includeResolved || action.status === 'pending')
      .filter((action) => !sessionId || action.sessionId === sessionId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  public getPendingLearningAction(id: string, sessionId?: string): PendingLearningAction | undefined {
    return this.pendingActions.find((action) =>
      action.id === id &&
      action.status === 'pending' &&
      (!sessionId || action.sessionId === sessionId)
    );
  }

  public getLearningAction(id: string, sessionId?: string): PendingLearningAction | undefined {
    return this.pendingActions.find((action) =>
      action.id === id &&
      (!sessionId || action.sessionId === sessionId)
    );
  }

  public approvePendingLearningAction(id: string, sessionId?: string): { success: boolean; message: string; action?: PendingLearningAction } {
    const action = this.getPendingLearningAction(id, sessionId);
    if (!action) {
      return { success: false, message: `Pending learning action not found: ${id}` };
    }

    const applied = this.applyPendingAction(action);
    if (!applied.success) {
      return { success: false, message: applied.message, action };
    }

    action.status = 'applied';
    action.appliedAt = Date.now();
    action.timesUsed = Math.max(0, action.timesUsed || 0) + 1;
    action.confidence = this.calculateConfidence(action);
    this.savePendingActions();
    return { success: true, message: applied.message, action };
  }

  public rejectPendingLearningAction(id: string, sessionId?: string): { success: boolean; message: string; action?: PendingLearningAction } {
    const action = this.getPendingLearningAction(id, sessionId);
    if (!action) {
      return { success: false, message: `Pending learning action not found: ${id}` };
    }

    action.status = 'rejected';
    action.rejectedAt = Date.now();
    this.savePendingActions();
    return { success: true, message: `Rejected learning action: ${action.action}`, action };
  }

  public recordLearningFeedback(
    id: string,
    outcome: 'success' | 'failure',
    note?: string,
    sessionId?: string
  ): { success: boolean; message: string; action?: PendingLearningAction } {
    const action = this.getLearningAction(id, sessionId);
    if (!action) {
      return { success: false, message: `Learning action not found: ${id}` };
    }

    if (outcome === 'success') {
      action.successCount = Math.max(0, action.successCount || 0) + 1;
    } else {
      action.failureCount = Math.max(0, action.failureCount || 0) + 1;
    }
    action.lastFeedbackAt = Date.now();
    action.feedback = Array.isArray(action.feedback) ? action.feedback : [];
    action.feedback.push({
      outcome,
      note: note?.trim() || undefined,
      createdAt: Date.now()
    });
    if (action.feedback.length > 20) {
      action.feedback = action.feedback.slice(-20);
    }
    action.confidence = this.calculateConfidence(action);
    this.savePendingActions();

    const score = Math.round(action.confidence * 100);
    return {
      success: true,
      message: `Recorded ${outcome} feedback for "${action.action}". Confidence is now ${score}%.`,
      action
    };
  }

  private calculateConfidence(action: PendingLearningAction) {
    const successes = Math.max(0, action.successCount || 0);
    const failures = Math.max(0, action.failureCount || 0);
    // Laplace smoothing: a new lesson starts neutral, then moves with evidence.
    return (successes + 1) / (successes + failures + 2);
  }

  private isSelfTrainingCandidate(action: PendingLearningAction) {
    const cfg = this.getSelfTrainingConfig();
    if (!cfg.enabled) return false;
    if (action.status !== 'applied') return false;
    if ((action.successCount || 0) < cfg.minSuccesses) return false;
    if ((action.confidence || 0) < cfg.minConfidence) return false;
    if (!cfg.includeFailures && (action.failureCount || 0) > 0) return false;
    return true;
  }

  private getActionLines(action: PendingLearningAction): string[] {
    if (Array.isArray(action.lines) && action.lines.length > 0) {
      return action.lines.map(line => String(line).trim()).filter(Boolean);
    }
    const actionText = String(action.action || '').trim();
    return actionText ? [actionText] : [];
  }

  public getPromptLessons(sessionId?: string): string {
    this.refreshConfig();
    const cfg = this.getSelfTrainingConfig();
    if (!cfg.enabled || cfg.maxPromptLessons <= 0) return '';

    const candidates = this.pendingActions
      .filter(action => !sessionId || action.sessionId === sessionId)
      .filter(action => this.isSelfTrainingCandidate(action))
      .sort((a, b) => {
        const confidenceDiff = (b.confidence || 0) - (a.confidence || 0);
        if (confidenceDiff !== 0) return confidenceDiff;
        return (b.successCount || 0) - (a.successCount || 0);
      })
      .slice(0, cfg.maxPromptLessons);

    if (candidates.length === 0) return '';

    for (const action of candidates) {
      action.timesUsed = Math.max(0, action.timesUsed || 0) + 1;
    }
    this.savePendingActions();

    const lines = candidates.flatMap((action) => {
      const score = Math.round((action.confidence || 0) * 100);
      return this.getActionLines(action).map(line =>
        `- ${line} (confidence ${score}%, ${action.successCount || 0} success / ${action.failureCount || 0} failure)`
      );
    });

    return lines.length > 0 ? `Proven Learned Rules:\n${lines.join('\n')}` : '';
  }

  public exportSelfTrainingExamples(sessionId?: string): { success: boolean; message: string; path?: string; count: number } {
    this.refreshConfig();
    const cfg = this.getSelfTrainingConfig();
    const actions = this.pendingActions
      .filter(action => !sessionId || action.sessionId === sessionId)
      .filter(action => this.isSelfTrainingCandidate(action));

    const filePath = path.resolve(process.cwd(), cfg.exportPath);
    this.ensureDir(path.dirname(filePath));

    const examples = actions.flatMap((action) => {
      const lines = this.getActionLines(action);
      return lines.map((line) => ({
        messages: [
          {
            role: 'system',
            content: 'You are Gitu. Apply approved, high-confidence lessons from prior user feedback.'
          },
          {
            role: 'user',
            content: [
              `Context: ${action.entryTitle}`,
              action.summary ? `Summary: ${action.summary}` : '',
              'What rule should guide future behavior?'
            ].filter(Boolean).join('\n')
          },
          {
            role: 'assistant',
            content: line
          }
        ]
      }));
    });

    try {
      fs.writeFileSync(filePath, examples.map(ex => JSON.stringify(ex)).join('\n') + (examples.length ? '\n' : ''));
      return {
        success: true,
        message: `Exported ${examples.length} self-training example(s).`,
        path: filePath,
        count: examples.length
      };
    } catch (err: any) {
      return {
        success: false,
        message: `Failed to export self-training examples: ${err.message || err}`,
        path: filePath,
        count: 0
      };
    }
  }

  public getSelfTrainingStatus(sessionId?: string): {
    enabled: boolean;
    minConfidence: number;
    minSuccesses: number;
    maxPromptLessons: number;
    exportPath: string;
    candidates: number;
    applied: number;
    promptPreview: string;
  } {
    this.refreshConfig();
    const cfg = this.getSelfTrainingConfig();
    const scoped = this.pendingActions.filter(action => !sessionId || action.sessionId === sessionId);
    const applied = scoped.filter(action => action.status === 'applied').length;
    const candidates = scoped.filter(action => this.isSelfTrainingCandidate(action)).length;
    const promptPreview = this.getPromptLessons(sessionId);
    return {
      enabled: cfg.enabled,
      minConfidence: cfg.minConfidence,
      minSuccesses: cfg.minSuccesses,
      maxPromptLessons: cfg.maxPromptLessons,
      exportPath: path.resolve(process.cwd(), cfg.exportPath),
      candidates,
      applied,
      promptPreview
    };
  }

  private applyPendingAction(action: PendingLearningAction): { success: boolean; message: string } {
    if (action.type === 'background_goal') {
      if (!action.goal) return { success: false, message: 'Pending goal is missing goal details.' };
      const goal = backgroundWorker.addGoal({
        title: action.goal.title,
        description: action.goal.description,
        sessionId: action.sessionId,
        priority: action.goal.priority,
        estimatedMinutes: action.goal.estimatedMinutes,
        tags: action.goal.tags
      });
      return { success: true, message: `Queued background goal: ${goal.title}` };
    }

    if (action.type === 'auto_update') {
      if (!action.target || !action.sectionTitle || !Array.isArray(action.lines)) {
        return { success: false, message: 'Pending update is missing target details.' };
      }
      const inserted = this.upsertSectionLines(action.target, action.sectionTitle, action.lines);
      if (inserted === 0) {
        return { success: true, message: `No new lines needed in ${action.target}.` };
      }
      return { success: true, message: `Applied ${inserted} learned line(s) to ${action.target}.` };
    }

    return { success: false, message: `Unknown learning action type: ${action.type}` };
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
      if (entry.recommendations) {
        lines.push('');
        lines.push('Recommendations:');
        lines.push(entry.recommendations.trim());
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
    const task = this.pendingReviews[0];
    if (!task) return;

    const lastAt = this.state.lastReviewAt[task.sessionId] || 0;
    const now = Date.now();
    const minGapMs = Math.floor(60 * 60 * 1000 / Math.max(1, this.config.selfReview.maxPerHour));
    if (now - lastAt < minGapMs) return;

    this.pendingReviews.shift();
    this.savePendingReviews();
    this.runningReview = true;
    try {
      const profile = this.getModeProfile();
      const systemPrompt = [
        'You are a quality reviewer.',
        'Identify improvements based only on the conversation.',
        'Do not invent facts.',
        profile.reviewGuidance,
        'Return JSON only.'
      ].join(' ');

      const prompt = [
        'Review the assistant response and extract improvements.',
        `Learning mode: ${profile.mode}.`,
        `Return at most ${profile.reviewMaxImprovements} improvements.`,
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

      const improvements = Array.isArray(payload.improvements)
        ? payload.improvements.filter(Boolean).slice(0, profile.reviewMaxImprovements)
        : [];
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
        await this.sendReport(task.sessionId, note, 'normal');
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
            await this.sendReport(sessionId, `Learning update saved: ${entry.title}`, 'normal');
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
    const profile = this.getModeProfile();
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
      `Extract up to ${profile.externalMaxTopics} research topics.`,
      `Learning mode: ${profile.mode}.`,
      profile.externalGuidance,
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
    return topics.slice(0, profile.externalMaxTopics);
  }

  private async learnFromTopic(sessionId: string, topic: AutoTopic): Promise<LearningEntry | null> {
    const profile = this.getModeProfile();
    const searchRes = await this.searchSkill.execute({
      query: topic.query,
      maxResults: profile.externalMaxSources
    });

    const results = Array.isArray(searchRes?.results) ? searchRes.results : [];
    if (results.length === 0) return null;

    const sources: Array<{ title: string; url: string; text?: string }> = [];
    for (const result of results.slice(0, profile.externalMaxSources)) {
      try {
        const fetched = await this.fetchSkill.execute({
          url: result.url,
          maxChars: profile.externalMaxCharsPerSource,
          timeoutMs: 12000
        });
        const text = typeof fetched?.text === 'string' ? fetched.text.slice(0, profile.externalMaxCharsPerSource) : '';
        sources.push({ title: result.title, url: result.url, text });
      } catch {
        sources.push({ title: result.title, url: result.url, text: '' });
      }
    }

    const sourcesBlock = sources
      .map((s, i) => {
        const idx = i + 1;
        const snippet = s.text ? s.text.slice(0, Math.min(3000, profile.externalMaxCharsPerSource)) : '';
        return `[${idx}] ${s.title}\nURL: ${s.url}\n${snippet}`;
      })
      .join('\n\n');

    const systemPrompt = [
      'You are a learning summarizer.',
      'Use only the provided sources.',
      profile.externalGuidance,
      'Return JSON only.'
    ].join(' ');

    const prompt = [
      `Create a short learning note for: ${topic.query}`,
      `Learning mode: ${profile.mode}.`,
      'Return JSON: {"title":"","summary":["- ..."],"improvements":["- ..."],"recommendations":["- ..."]}',
      'Recommendations should be actionable next steps.',
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
    const recommendationsLines = Array.isArray(payload.recommendations) ? payload.recommendations.filter(Boolean) : [];

    const summary = summaryLines.length ? summaryLines.join('\n') : '';
    const improvements = improvementsLines.length ? improvementsLines.join('\n') : '';
    const recommendations = recommendationsLines.length ? recommendationsLines.join('\n') : '';

    return {
      id: uuidv4(),
      type: 'external',
      sessionId,
      title: this.redactSecrets(title),
      summary: this.redactSecrets(summary),
      improvements: this.redactSecrets(improvements),
      recommendations: this.redactSecrets(recommendations),
      sources: sources.map(s => ({ title: s.title, url: s.url })),
      createdAt: Date.now()
    };
  }

  private extractActionLines(entry: LearningEntry): string[] {
    const raw = entry.recommendations || entry.improvements || '';
    if (!raw) return [];
    return raw
      .split('\n')
      .map(line => line.replace(/^[-*•\s]+/, '').trim())
      .filter(Boolean);
  }

  private handleAutoGoals(entry: LearningEntry) {
    if (!this.config.autoGoals?.enabled) return;
    if (this.state.autoGoalsForEntry[entry.id]) return;
    if (entry.type === 'self_review' && !this.config.autoGoals.includeSelfReview) return;
    if (entry.type === 'external' && !this.config.autoGoals.includeExternal) return;

    const lines = this.extractActionLines(entry);
    if (lines.length === 0) {
      this.state.autoGoalsForEntry[entry.id] = true;
      this.saveState();
      return;
    }

    const profile = this.getModeProfile();
    const maxPerEntry = profile.autoGoalMaxPerEntry;
    const goals = lines.slice(0, maxPerEntry);
    goals.forEach((line) => {
      const title = line.length > 80 ? `${line.slice(0, 77)}...` : line;
      const descriptionParts = [
        `From learning: ${entry.title}`,
        entry.summary ? `Summary:\n${entry.summary}` : '',
        `Action:\n${line}`
      ].filter(Boolean);
      const goal = {
        title,
        description: descriptionParts.join('\n\n'),
        priority: this.config.autoGoals.priority || 'normal',
        tags: ['learning', entry.type]
      };

      const pending = this.queuePendingAction({
        type: 'background_goal',
        sessionId: entry.sessionId,
        entryId: entry.id,
        entryTitle: entry.title,
        summary: entry.summary,
        action: line,
        goal
      });
      if (!this.approvalsEnabled()) this.approvePendingLearningAction(pending.id, entry.sessionId);
    });

    this.state.autoGoalsForEntry[entry.id] = true;
    this.saveState();
  }

  private handleSkillCreation(entry: LearningEntry) {
    const cfg = this.config.skillCreation;
    if (!cfg?.enabled) return;
    if (this.state.skillGoalsForEntry[entry.id]) return;
    if (entry.type === 'self_review' && !cfg.includeSelfReview) return;
    if (entry.type === 'external' && !cfg.includeExternal) return;

    const minChars = Math.max(12, Math.floor(Number(cfg.minActionChars) || 24));
    const maxPerEntry = Math.max(1, Math.min(3, Math.floor(Number(cfg.maxPerEntry) || 1)));
    const actions = this.extractActionLines(entry)
      .filter(line => line.length >= minChars)
      .slice(0, maxPerEntry);

    actions.forEach((action, index) => {
      const titleText = action.replace(/[^a-zA-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
      const title = `Create learned skill: ${(titleText || entry.title).slice(0, 56)}`;
      backgroundWorker.addGoal({
        title,
        description: [
          `Create a validated declarative skill from learning entry "${entry.title}".`,
          entry.summary ? `Context:\n${entry.summary}` : '',
          `Reusable lesson:\n${action}`,
          'The skill must contain instructions only; it must not generate or execute code during creation.'
        ].filter(Boolean).join('\n\n'),
        sessionId: entry.sessionId,
        priority: 'low',
        estimatedMinutes: 2,
        tags: ['learning', 'skill-creation', entry.type],
        metadata: {
          kind: 'learned-skill-creation',
          entryId: entry.id,
          entryTitle: entry.title,
          sourceType: entry.type,
          action,
          summary: entry.summary,
          ordinal: index
        }
      });
    });

    this.state.skillGoalsForEntry[entry.id] = true;
    this.saveState();
  }

  public async executeSkillCreationGoal(goal: BackgroundGoal): Promise<string> {
    const metadata = goal.metadata || {};
    if (metadata.kind !== 'learned-skill-creation') {
      throw new Error('This background goal is not a learned-skill creation goal.');
    }

    const action = this.redactSecrets(String(metadata.action || '').trim());
    const summary = this.redactSecrets(String(metadata.summary || '').trim());
    const sourceEntryId = String(metadata.entryId || '').trim();
    if (!action || !sourceEntryId) throw new Error('Learned-skill goal is missing its source evidence.');
    const executableConfig = this.config.skillCreation.executable;
    const executableAllowedTools = Array.from(new Set((executableConfig?.allowedTools || [])
      .map(tool => String(tool || '').trim())
      .filter(Boolean)))
      .slice(0, 20);
    const executableEnabled = executableConfig?.enabled === true && executableAllowedTools.length > 0;
    // Fix #1: give the model each allowed tool's argument schema (esp. required
    // args) so generated executable steps carry valid arguments instead of
    // guessing (it used to omit web_fetch's 'url' or notes/memory 'action').
    const toolSpecHints = executableAllowedTools
      .map(tool => {
        const skill = SkillRegistry.get(tool);
        if (!skill) return `- ${tool}: (unavailable)`;
        const schema: any = (skill as any).inputSchema || {};
        const required = Array.isArray(schema.required) ? schema.required : [];
        const props = schema.properties && typeof schema.properties === 'object'
          ? Object.keys(schema.properties)
          : [];
        return `- ${tool}: required args = ${required.length ? required.join(', ') : 'none'}; available props = ${props.join(', ') || 'none'}`;
      })
      .join('\n');


    const systemPrompt = [
      'You are a concise skill author.',
      'Convert one proven lesson into a reusable declarative workflow.',
      'Do not add permissions, shell commands, secrets, or claims not present in the lesson.',
      executableEnabled
        ? `An executable workflow may only use these tools: ${executableAllowedTools.join(', ')}.`
        : 'Do not create an executable workflow.',
      'Return JSON only.'
    ].join(' ');
    const prompt = [
      'Create one skill from the lesson below.',
      executableEnabled
        ? 'Return JSON: {"name":"lowercase-hyphen-name","description":"what it does and when to use it","instructions":["imperative step"],"keywords":["trigger"],"executable":{"steps":[{"tool":"allowed_tool","arguments":{"query":"{{task}}"},"onError":"stop"}]}}'
        : 'Return JSON: {"name":"lowercase-hyphen-name","description":"what it does and when to use it","instructions":["imperative step"],"keywords":["trigger"]}',
      'Use 2-8 concise imperative instructions. Keep the description under 300 characters.',
      executableEnabled
        ? `Only add executable.steps when the lesson maps safely to the allowlist. Use at most ${Math.max(1, Math.min(8, Number(executableConfig.maxSteps) || 6))} sequential steps. Arguments may use {{task}}, {{query}}, {{context}}, {{lastOutput}}, or {{steps.0.output}} templates. Every step must include all args marked required below. If the lesson is purely conversational/behavioral and cannot be expressed as tool calls, OMIT executable.steps entirely.`
        : '',
      executableEnabled ? `Allowed tool argument specs (fill all required args):\n${toolSpecHints}` : '',
      '',
      summary ? `Context:\n${summary}` : '',
      `Lesson:\n${action}`
    ].filter(Boolean).join('\n');

    let payload: any = null;
    try {
      const response = await this.getModel().generate(prompt, systemPrompt, []);
      payload = this.safeJsonParse(response?.content || '');
    } catch {
      payload = null;
    }

    const fallbackName = `learn-${action}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .split('-')
      .slice(0, 7)
      .join('-');
    const instructions = Array.isArray(payload?.instructions)
      ? payload.instructions.map((line: any) => String(line || '').trim()).filter(Boolean)
      : [action];
    const description = typeof payload?.description === 'string' && payload.description.trim().length >= 20
      ? payload.description.trim()
      : `Apply the learned workflow for ${action.slice(0, 180)}. Use when a similar task or failure pattern appears.`;
    const rawSteps = Array.isArray(payload?.executable?.steps) ? payload.executable.steps : [];
    // Fix #2: behavioral/conversational lessons often produce no (or non-tool)
    // executable steps. Only attempt an executable spec when the model actually
    // emitted usable steps; otherwise fall through to a clean instruction-only
    // skill (valid, not marked 'invalid') so the reusable guidance is still kept.
    const executableSpec = executableEnabled && rawSteps.length > 0
      ? {
          steps: rawSteps.slice(0, Math.max(1, Math.min(8, Number(executableConfig.maxSteps) || 6))),
          allowedTools: executableAllowedTools,
          maxOutputChars: 30_000
        }
      : undefined;

    const record = learnedSkillsManager.upsert({
      name: String(payload?.name || fallbackName || 'learned-workflow'),
      description,
      instructions,
      keywords: Array.isArray(payload?.keywords) ? payload.keywords : [],
      sessionId: goal.sessionId,
      sourceEntryId,
      executableSpec
    });
    return `Created learned skill ${record.name} version ${record.version}${record.executable && record.toolName ? ` and registered callable tool ${record.toolName}` : ''} from learning entry ${sourceEntryId}.`;
  }

  public getLearnedSkillsPrompt(sessionId: string, query = ''): string {
    return learnedSkillsManager.getPrompt(sessionId, query);
  }

  private handleAutoUpdate(entry: LearningEntry) {
    if (!this.config.autoUpdate?.enabled) return;
    if (this.state.autoUpdatesForEntry[entry.id]) return;

    const todayKey = this.getLocalDateKey();
    const countToday = this.state.autoUpdatesPerDay[todayKey] || 0;
    if (countToday >= this.config.autoUpdate.maxPerDay) return;

    const lines = this.extractActionLines(entry);
    if (lines.length === 0) {
      this.state.autoUpdatesForEntry[entry.id] = true;
      this.saveState();
      return;
    }

    const profile = this.getModeProfile();
    const maxPerEntry = profile.autoUpdateMaxPerEntry;
    const selected = lines.slice(0, maxPerEntry);
    const target = this.config.autoUpdate.target === 'AGENTS.md' ? 'AGENTS.md' : 'USER.md';
    const sectionTitle = target === 'AGENTS.md' ? 'Auto-Learned Behavior' : 'Auto-Learned Preferences';

    const pending = this.queuePendingAction({
      type: 'auto_update',
      sessionId: entry.sessionId,
      entryId: entry.id,
      entryTitle: entry.title,
      summary: entry.summary,
      action: selected.join('\n'),
      target,
      sectionTitle,
      lines: selected
    });
    if (!this.approvalsEnabled()) {
      const result = this.approvePendingLearningAction(pending.id, entry.sessionId);
      if (result.success) this.state.autoUpdatesPerDay[todayKey] = countToday + selected.length;
    }
    this.state.autoUpdatesForEntry[entry.id] = true;
    this.saveState();
  }

  private upsertSectionLines(fileName: string, sectionTitle: string, lines: string[]): number {
    const filePath = path.join(process.cwd(), fileName);
    if (!fs.existsSync(filePath)) return 0;
    const raw = fs.readFileSync(filePath, 'utf-8');
    const normalizedLines = lines.map(l => l.trim()).filter(Boolean);
    if (normalizedLines.length === 0) return 0;

    const sectionHeader = `## ${sectionTitle}`;
    const hasSection = raw.includes(sectionHeader);
    const lineSet = new Set<string>();
    let output = raw;

    if (hasSection) {
      const parts = raw.split(sectionHeader);
      const before = parts[0];
      const after = parts.slice(1).join(sectionHeader);
      const nextHeaderIndex = after.indexOf('\n## ');
      const sectionBody = nextHeaderIndex >= 0 ? after.slice(0, nextHeaderIndex) : after;
      sectionBody.split('\n').forEach((line) => {
        const cleaned = line.replace(/^[-*•\s]+/, '').trim().toLowerCase();
        if (cleaned) lineSet.add(cleaned);
      });

      const toInsert = normalizedLines.filter(l => !lineSet.has(l.toLowerCase()));
      if (toInsert.length === 0) return 0;

      const insertBlock = toInsert.map(l => `- ${l}`).join('\n');
      const newSectionBody = sectionBody.trimEnd() + '\n' + insertBlock + '\n';
      const rebuilt = before + sectionHeader + newSectionBody + (nextHeaderIndex >= 0 ? after.slice(nextHeaderIndex) : '');
      output = rebuilt;
    } else {
      const insertBlock = normalizedLines.map(l => `- ${l}`).join('\n');
      output = raw.trimEnd() + `\n\n${sectionHeader}\n${insertBlock}\n`;
    }

    fs.writeFileSync(filePath, output);
    return normalizedLines.length;
  }

  private async maybeSendDailySummary() {
    if (!this.config.dailySummary?.enabled || !this.report) return;
    const sessionId = this.getMostRecentSessionId();
    if (!sessionId) return;

    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();
    const targetHour = Math.min(23, Math.max(0, this.config.dailySummary.hourLocal));
    const targetMinute = Math.min(59, Math.max(0, this.config.dailySummary.minuteLocal));
    if (hour < targetHour || (hour === targetHour && minute < targetMinute)) return;

    const todayKey = this.getLocalDateKey();
    if (this.state.lastSummaryAt[sessionId] === todayKey) return;

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const entriesToday = this.entries.filter(e => e.createdAt >= startOfDay.getTime());
    if (entriesToday.length === 0) return;

    const lines: string[] = [];
    lines.push(`Daily learning summary (${todayKey}):`);
    entriesToday.slice(-5).forEach((entry, idx) => {
      const summaryLine = entry.summary ? entry.summary.split('\n')[0]?.trim() : '';
      lines.push(`${idx + 1}. ${entry.title}${summaryLine ? ` — ${summaryLine.replace(/^[-*•\s]+/, '')}` : ''}`);
    });

    if (this.config.dailySummary.includeRecommendations) {
      const recLines: string[] = [];
      entriesToday.forEach((entry) => {
        const actions = this.extractActionLines(entry);
        actions.slice(0, 2).forEach((action) => {
          recLines.push(action);
        });
      });
      if (recLines.length > 0) {
        lines.push('');
        lines.push('Recommended actions:');
        recLines.slice(0, 6).forEach((action) => lines.push(`- ${action}`));
      }
    }

    if (this.config.dailySummary.includeGoals) {
      const pending = backgroundWorker.getPendingGoals(sessionId).filter(g => g.tags?.includes('learning'));
      const active = backgroundWorker.getActiveGoals().filter(g => g.sessionId === sessionId && g.tags?.includes('learning'));
      const total = pending.length + active.length;
      if (total > 0) {
        lines.push('');
        lines.push(`Learning goals queued: ${total} (active ${active.length}, pending ${pending.length})`);
      }
    }

    await this.sendReport(sessionId, lines.join('\n'), 'normal');
    this.state.lastSummaryAt[sessionId] = todayKey;
    this.saveState();
  }

  private async sendReport(sessionId: string, message: string, priority: 'low' | 'normal' | 'high' | 'urgent') {
    if (!this.report) return;
    if (dndManager.shouldNotify(priority)) {
      await this.report(sessionId, message);
    } else {
      dndManager.queueNotification(sessionId, message, priority);
    }
  }

  private getLocalDateKey(): string {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
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
