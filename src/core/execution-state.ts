import { v4 as uuidv4 } from 'uuid';

export type MissionChecklistStatus = 'completed' | 'in_progress' | 'pending' | 'failed';
export type MissionEventStatus = 'completed' | 'in_progress' | 'failed';

export interface MissionChecklistItem {
  key: string;
  label: string;
  status: MissionChecklistStatus;
  note?: string;
  updatedAt: number;
}

export interface MissionEvent {
  id: string;
  kind: 'tool' | 'background' | 'agent';
  label: string;
  summary: string;
  status: MissionEventStatus;
  timestamp: number;
  reportedAt?: number;
  consumedAt?: number;
}

export interface MissionState {
  sessionId: string;
  missionId: string;
  mission: string;
  createdAt: number;
  updatedAt: number;
  checklist: MissionChecklistItem[];
  completedSteps: string[];
  pendingSteps: string[];
  failedSteps: string[];
  lastFinalAnswer?: string;
  lastAssistantResponse?: string;
  reportedHistory: string[];
  events: MissionEvent[];
  lastBlockingReason?: string;
}

interface BeginMissionOptions {
  continuation?: boolean;
}

interface RecordEventInput {
  kind: MissionEvent['kind'];
  label: string;
  summary: string;
  status: MissionEventStatus;
}

interface PrepareResponseOptions {
  final?: boolean;
  fallbackNow?: string;
  fallbackNext?: string;
}

export class ExecutionStateManager {
  private states = new Map<string, MissionState>();

  beginMission(sessionId: string, mission: string, options: BeginMissionOptions = {}): MissionState {
    const trimmedMission = String(mission || '').trim() || 'Continue current mission';
    const current = this.states.get(sessionId);
    if (!current || !options.continuation) {
      const normalizedCurrent = current ? this.normalize(trimmedMission) : '';
      const normalizedExisting = current ? this.normalize(current.mission) : '';
      if (!current || (normalizedCurrent && normalizedCurrent !== normalizedExisting)) {
        const created = this.createState(sessionId, trimmedMission);
        this.states.set(sessionId, created);
        return created;
      }
    }

    const state = current || this.createState(sessionId, trimmedMission);
    state.updatedAt = Date.now();
    if (!current) {
      this.states.set(sessionId, state);
    }
    return state;
  }

  getState(sessionId: string): MissionState | undefined {
    return this.states.get(sessionId);
  }

  ensureState(sessionId: string, mission: string): MissionState {
    return this.beginMission(sessionId, mission, { continuation: true });
  }

  markToolExecutionStarted(sessionId: string, note?: string) {
    const state = this.getState(sessionId);
    if (!state) return;
    this.setChecklist(state, 'execute', 'in_progress', note || 'Running the latest tool batch.');
    this.setChecklist(state, 'review', 'pending', 'Waiting for new tool results.');
    this.recomputeStepBuckets(state);
  }

  recordEvents(sessionId: string, items: RecordEventInput[], blockingReason?: string) {
    const state = this.getState(sessionId);
    if (!state) return;
    for (const item of items) {
      const summary = this.clip(String(item.summary || '').trim(), 240);
      if (!summary) continue;
      const normalized = this.normalize(summary);
      const existing = [...state.events].reverse().find(event =>
        this.normalize(event.summary) === normalized && event.status === item.status
      );
      if (existing) {
        existing.timestamp = Date.now();
        continue;
      }
      state.events.push({
        id: uuidv4().slice(0, 8),
        kind: item.kind,
        label: item.label,
        summary,
        status: item.status,
        timestamp: Date.now()
      });
    }

    if (blockingReason) {
      state.lastBlockingReason = this.clip(blockingReason, 240);
      this.setChecklist(state, 'verify', 'failed', state.lastBlockingReason);
    } else if (items.some(item => item.status === 'failed')) {
      const failed = items.filter(item => item.status === 'failed').map(item => item.summary);
      state.lastBlockingReason = this.clip(failed.join(' | '), 240);
      this.setChecklist(state, 'verify', 'failed', state.lastBlockingReason);
    } else {
      state.lastBlockingReason = undefined;
      this.setChecklist(state, 'review', 'completed', 'Latest tool results summarized.');
      this.setChecklist(state, 'verify', 'in_progress', 'Checking whether all requested objectives are done.');
    }

    if (items.length > 0) {
      this.setChecklist(state, 'understand', 'completed', 'Mission and latest progress are tracked.');
      this.setChecklist(state, 'execute', 'completed', 'Latest tool batch finished.');
      this.setChecklist(state, 'finalize', 'pending', 'Waiting for the final synthesis.');
    }

    state.updatedAt = Date.now();
    this.recomputeStepBuckets(state);
  }

  recordBackgroundUpdate(sessionId: string, summary: string, status: MissionEventStatus) {
    this.recordEvents(sessionId, [{
      kind: 'background',
      label: 'Background update',
      summary,
      status
    }], status === 'failed' ? summary : undefined);
  }

  markFinalAnswer(sessionId: string, answer: string) {
    const state = this.getState(sessionId);
    if (!state) return;
    state.lastFinalAnswer = this.clip(answer.trim(), 1200);
    state.lastBlockingReason = undefined;
    this.setChecklist(state, 'review', 'completed', 'Reviewed all latest progress.');
    this.setChecklist(state, 'verify', 'completed', 'Verified the final response against tracked work.');
    this.setChecklist(state, 'finalize', 'completed', 'Final answer delivered.');
    state.updatedAt = Date.now();
    this.recomputeStepBuckets(state);
  }

  markBlocked(sessionId: string, reason: string) {
    const state = this.getState(sessionId);
    if (!state) return;
    state.lastBlockingReason = this.clip(reason.trim(), 240);
    this.setChecklist(state, 'verify', 'failed', state.lastBlockingReason);
    this.setChecklist(state, 'finalize', 'pending', 'Waiting for the blocker to clear.');
    state.updatedAt = Date.now();
    this.recomputeStepBuckets(state);
  }

  buildContinuationPrompt(sessionId: string, options: { continuation: boolean; finalTurn: boolean }): string {
    const state = this.getState(sessionId);
    if (!state) return '';
    const unreported = state.events
      .filter(event => !event.reportedAt)
      .slice(-8)
      .map(event => `- ${this.statusIcon(event.status)} ${event.summary}`);
    const reported = state.reportedHistory.slice(-4).map(line => `- ${line}`);
    const checklist = state.checklist.map(item => `${this.statusIcon(item.status)} ${item.label}${item.note ? `: ${item.note}` : ''}`);

    const lines = [
      'Mission execution state:',
      `Current mission: ${state.mission}`,
      checklist.length > 0 ? `Checklist:\n${checklist.join('\n')}` : '',
      state.completedSteps.length > 0 ? `Completed steps: ${state.completedSteps.join(' | ')}` : '',
      state.pendingSteps.length > 0 ? `Pending steps: ${state.pendingSteps.join(' | ')}` : '',
      state.failedSteps.length > 0 ? `Failed steps: ${state.failedSteps.join(' | ')}` : '',
      reported.length > 0 ? `Already reported to the user:\n${reported.join('\n')}` : '',
      unreported.length > 0 ? `New progress not yet reported:\n${unreported.join('\n')}` : '',
      state.lastFinalAnswer ? `Last final answer: ${this.clip(state.lastFinalAnswer, 500)}` : '',
      state.lastBlockingReason ? `Current blocker: ${state.lastBlockingReason}` : 'Current blocker: none.',
      options.continuation
        ? 'Continue from the latest completed work. Do not repeat previous explanations, plans, or summaries. Only report new progress, new findings, new errors, or completed work. If nothing changed, state what is blocking progress.'
        : 'Do not restart your reasoning. Report only information that moves the mission forward.',
      'For every non-final update, answer these questions in substance: What just finished? What is happening now? What is next?',
      'Tool outputs are tracked outside the chat history. Summarize only the new information from tool execution instead of repeating raw output.',
      options.finalTurn
        ? 'Before the final answer, verify every requested objective has been completed. The final answer must synthesize all completed work without repeating intermediate updates.'
        : ''
    ].filter(Boolean);

    return lines.join('\n\n');
  }

  consumeNewFindings(sessionId: string, limit: number = 5): string[] {
    const state = this.getState(sessionId);
    if (!state) return [];
    const now = Date.now();
    const items = state.events.filter(event => !event.reportedAt).slice(-limit);
    for (const event of items) {
      event.reportedAt = now;
    }
    state.updatedAt = now;
    return items.map(event => event.summary);
  }

  prepareAssistantResponse(sessionId: string, draft: string, options: PrepareResponseOptions = {}): string {
    const state = this.getState(sessionId);
    const trimmed = String(draft || '').trim();
    if (!state) {
      return trimmed;
    }

    let finalText = trimmed;
    if (trimmed && this.isSubstantiallySimilar(trimmed, state.lastAssistantResponse || '')) {
      finalText = this.buildConciseContinuation(sessionId, {
        fallbackNow: options.fallbackNow,
        fallbackNext: options.fallbackNext,
        final: options.final
      });
    }

    if (options.final && finalText) {
      this.markFinalAnswer(sessionId, finalText);
    }

    if (finalText) {
      state.lastAssistantResponse = finalText;
      state.reportedHistory.push(this.clip(finalText.replace(/\s+/g, ' ').trim(), 220));
      state.reportedHistory = state.reportedHistory.slice(-12);
      state.updatedAt = Date.now();
      this.consumeReferencedEvents(state, finalText);
    }

    return finalText;
  }

  buildConciseContinuation(
    sessionId: string,
    options: { fallbackNow?: string; fallbackNext?: string; final?: boolean } = {}
  ): string {
    const state = this.getState(sessionId);
    if (!state) return '';
    const findings = this.consumeNewFindings(sessionId, 4);
    const justFinished = findings.length > 0
      ? findings.join(' | ')
      : 'No new completed work since the last update.';
    const now = state.lastBlockingReason
      ? `Blocked by ${state.lastBlockingReason}.`
      : (options.fallbackNow || this.describeCurrentWork(state));
    const next = options.fallbackNext
      || (state.lastBlockingReason
        ? 'Resolve the blocker or adjust the plan before continuing.'
        : this.describeNextWork(state));
    const checklist = state.checklist
      .map(item => `${this.statusIcon(item.status)} ${item.label}`)
      .join('\n');

    const lines = [
      options.final ? 'Final status update:' : 'Progress update:',
      `What just finished: ${justFinished}`,
      `What is happening now: ${now}`,
      `What is next: ${next}`,
      checklist ? `Checklist:\n${checklist}` : ''
    ].filter(Boolean);

    return lines.join('\n\n');
  }

  private createState(sessionId: string, mission: string): MissionState {
    const now = Date.now();
    const checklist: MissionChecklistItem[] = [
      { key: 'understand', label: 'Mission captured', status: 'completed', note: 'Tracking the current request.', updatedAt: now },
      { key: 'execute', label: 'Latest tool work', status: 'pending', note: 'Waiting for tool execution.', updatedAt: now },
      { key: 'review', label: 'Latest results review', status: 'pending', note: 'Waiting for new findings.', updatedAt: now },
      { key: 'verify', label: 'Objective verification', status: 'pending', note: 'Waiting for enough evidence to verify completion.', updatedAt: now },
      { key: 'finalize', label: 'Final synthesis', status: 'pending', note: 'Waiting for the final answer.', updatedAt: now }
    ];
    const state: MissionState = {
      sessionId,
      missionId: uuidv4(),
      mission,
      createdAt: now,
      updatedAt: now,
      checklist,
      completedSteps: [],
      pendingSteps: [],
      failedSteps: [],
      reportedHistory: [],
      events: []
    };
    this.recomputeStepBuckets(state);
    return state;
  }

  private setChecklist(
    state: MissionState,
    key: string,
    status: MissionChecklistStatus,
    note?: string
  ) {
    const item = state.checklist.find(entry => entry.key === key);
    if (!item) return;
    item.status = status;
    item.note = note;
    item.updatedAt = Date.now();
  }

  private recomputeStepBuckets(state: MissionState) {
    state.completedSteps = state.checklist
      .filter(item => item.status === 'completed')
      .map(item => item.label);
    state.pendingSteps = state.checklist
      .filter(item => item.status === 'pending' || item.status === 'in_progress')
      .map(item => item.label);
    state.failedSteps = state.checklist
      .filter(item => item.status === 'failed')
      .map(item => item.label + (item.note ? ` (${item.note})` : ''));
  }

  private describeCurrentWork(state: MissionState): string {
    const inProgress = state.checklist.find(item => item.status === 'in_progress');
    if (inProgress) {
      return inProgress.note || inProgress.label;
    }
    if (state.pendingSteps.length > 0) {
      return `Working toward ${state.pendingSteps[0]}.`;
    }
    return 'Waiting for new work.';
  }

  private describeNextWork(state: MissionState): string {
    const next = state.checklist.find(item => item.status === 'pending' || item.status === 'in_progress');
    if (next) {
      return next.note || next.label;
    }
    return 'No further work is queued.';
  }

  private consumeReferencedEvents(state: MissionState, text: string) {
    const normalizedText = this.normalize(text);
    const now = Date.now();
    for (const event of state.events) {
      if (event.reportedAt) continue;
      if (!event.summary) continue;
      const summaryKey = this.normalize(event.summary);
      if (summaryKey && normalizedText.includes(summaryKey)) {
        event.reportedAt = now;
      }
    }
  }

  private isSubstantiallySimilar(a: string, b: string): boolean {
    const left = this.normalize(a);
    const right = this.normalize(b);
    if (!left || !right) return false;
    if (left === right) return true;
    if (left.length > 80 && (left.includes(right) || right.includes(left))) return true;

    const leftTokens = new Set(left.split(' ').filter(Boolean));
    const rightTokens = new Set(right.split(' ').filter(Boolean));
    if (leftTokens.size === 0 || rightTokens.size === 0) return false;
    let shared = 0;
    for (const token of leftTokens) {
      if (rightTokens.has(token)) shared += 1;
    }
    const ratio = shared / Math.max(leftTokens.size, rightTokens.size);
    return ratio >= 0.82;
  }

  private normalize(value: string): string {
    return String(value || '')
      .toLowerCase()
      .replace(/[`*_>#-]/g, ' ')
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private clip(value: string, max: number): string {
    if (value.length <= max) return value;
    return value.slice(0, Math.max(0, max - 3)).trimEnd() + '...';
  }

  private statusIcon(status: MissionChecklistStatus | MissionEventStatus): string {
    if (status === 'completed') return '✅';
    if (status === 'failed') return '❌';
    if (status === 'in_progress') return '🔄';
    return '⏳';
  }
}

export const executionStateManager = new ExecutionStateManager();
