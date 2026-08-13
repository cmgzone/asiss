import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

export type MainGoalStatus = 'active' | 'completed' | 'paused' | 'cleared';
export type MainGoalOrigin = 'auto' | 'manual';

/**
 * Phase 20 Move 2 — one terminal canonical Task outcome attached to a goal.
 * The autonomous loop's Complete stage records this so a goal can show WHICH
 * task completed/failed it and the evidence (verification + criteria) behind
 * the verdict — goal -> task -> agent -> verify -> complete is queryable from
 * the goal record itself.
 */
export interface GoalTaskEvidence {
  /** Canonical Task id that served this goal. */
  taskId: string;
  /** TaskOutcomeStatus: SUCCESS / FAILURE / PARTIAL / CANCELLED. */
  outcome: string;
  /** Short user-facing summary of the outcome. */
  summary?: string;
  attempts?: number;
  turns?: number;
  /** Rendered verification/criteria summary (e.g. "2 passed, 1 failed"). */
  verification?: string;
  toolCalls?: number;
  completedAt?: number;
}

export interface MainChatGoal {
    id: string;
    sessionId: string;
    title: string;
    objective: string;
    status: MainGoalStatus;
    origin: MainGoalOrigin;
    confidence: number;
    createdAt: number;
    updatedAt: number;
    lastUserInputAt: number;
    sourceMessageId?: string;
    latestUserRequest?: string;
    constraints: string[];
    acceptanceCriteria: string[];
    notes: string[];
    linkedProjectId?: string;
    linkedBackgroundGoalIds: string[];
    /** Phase 20 Move 2 — canonical Tasks created to serve this goal. */
    linkedTaskIds: string[];
    /** Phase 20 Move 2 — terminal outcomes of the linked canonical Tasks. */
    taskOutcomes: GoalTaskEvidence[];
    completedAt?: number;
    metadata?: Record<string, any>;
}

interface SessionGoalState {
    current: MainChatGoal | null;
    recent: MainChatGoal[];
}

interface MainGoalState {
    sessions: Record<string, SessionGoalState>;
}

export class MainGoalManager {
    private filePath: string;
    private state: MainGoalState = { sessions: {} };

    constructor(filename: string = 'main_goals.json') {
        this.filePath = path.join(process.cwd(), filename);
        this.load();
    }

    private load() {
        if (!fs.existsSync(this.filePath)) return;
        try {
            const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
            this.state = this.normalizeState(parsed);
        } catch (err) {
            console.error('[MainGoal] Failed to load:', err);
            this.state = { sessions: {} };
        }
    }

    private save() {
        try {
            fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
        } catch (err) {
            console.error('[MainGoal] Failed to save:', err);
        }
    }

    private normalizeState(raw: any): MainGoalState {
        const sessions: Record<string, SessionGoalState> = {};
        const rawSessions = raw?.sessions && typeof raw.sessions === 'object' ? raw.sessions : {};
        for (const [sessionId, value] of Object.entries(rawSessions)) {
            const state = value as any;
            sessions[sessionId] = {
                current: state?.current ? this.normalizeGoal(state.current, sessionId) : null,
                recent: Array.isArray(state?.recent)
                    ? state.recent.map((goal: any) => this.normalizeGoal(goal, sessionId)).slice(0, 20)
                    : []
            };
        }
        return { sessions };
    }

    private normalizeGoal(raw: any, fallbackSessionId: string): MainChatGoal {
        const now = Date.now();
        const status: MainGoalStatus = ['active', 'completed', 'paused', 'cleared'].includes(raw?.status)
            ? raw.status
            : 'active';
        const origin: MainGoalOrigin = raw?.origin === 'manual' ? 'manual' : 'auto';
        return {
            id: String(raw?.id || uuidv4()),
            sessionId: String(raw?.sessionId || fallbackSessionId || 'default'),
            title: String(raw?.title || 'Main chat goal'),
            objective: String(raw?.objective || raw?.title || 'Help the user with the current conversation.'),
            status,
            origin,
            confidence: Number.isFinite(Number(raw?.confidence)) ? Math.max(0, Math.min(1, Number(raw.confidence))) : 0.6,
            createdAt: Number(raw?.createdAt) || now,
            updatedAt: Number(raw?.updatedAt) || now,
            lastUserInputAt: Number(raw?.lastUserInputAt) || now,
            sourceMessageId: raw?.sourceMessageId ? String(raw.sourceMessageId) : undefined,
            latestUserRequest: raw?.latestUserRequest ? String(raw.latestUserRequest) : undefined,
            constraints: Array.isArray(raw?.constraints) ? raw.constraints.map((v: any) => String(v)).filter(Boolean).slice(-30) : [],
            acceptanceCriteria: Array.isArray(raw?.acceptanceCriteria) ? raw.acceptanceCriteria.map((v: any) => String(v)).filter(Boolean).slice(-30) : [],
            notes: Array.isArray(raw?.notes) ? raw.notes.map((v: any) => String(v)).filter(Boolean).slice(-50) : [],
            linkedProjectId: raw?.linkedProjectId ? String(raw.linkedProjectId) : undefined,
            linkedBackgroundGoalIds: Array.isArray(raw?.linkedBackgroundGoalIds)
                ? raw.linkedBackgroundGoalIds.map((v: any) => String(v)).filter(Boolean).slice(-50)
                : [],
            linkedTaskIds: Array.isArray(raw?.linkedTaskIds)
                ? raw.linkedTaskIds.map((v: any) => String(v)).filter(Boolean).slice(-50)
                : [],
            taskOutcomes: Array.isArray(raw?.taskOutcomes)
                ? raw.taskOutcomes.map((v: any) => this.normalizeTaskEvidence(v)).filter(Boolean).slice(-20)
                : [],
            completedAt: Number(raw?.completedAt) || undefined,
            metadata: raw?.metadata && typeof raw.metadata === 'object' ? raw.metadata : undefined
        };
    }

    private getSession(sessionId: string): SessionGoalState {
        if (!this.state.sessions[sessionId]) {
            this.state.sessions[sessionId] = { current: null, recent: [] };
        }
        return this.state.sessions[sessionId];
    }

    public getCurrent(sessionId: string): MainChatGoal | null {
        const current = this.getSession(sessionId).current;
        return current && current.status === 'active' ? current : current;
    }

    public getRecent(sessionId: string): MainChatGoal[] {
        return this.getSession(sessionId).recent;
    }

    /**
     * Phase 20 web UI — every session's goal state (current + recent, with
     * the goal <-> task linkage) for the /api/loop trace panel.
     */
    public snapshot(limit: number = 20): Array<{ sessionId: string; current: MainChatGoal | null; recent: MainChatGoal[] }> {
        return Object.entries(this.state.sessions)
            .map(([sessionId, state]) => ({
                sessionId,
                current: state.current,
                recent: state.recent.slice(0, 5)
            }))
            .sort((a, b) => {
                const aTime = a.current?.updatedAt || a.recent[0]?.updatedAt || 0;
                const bTime = b.current?.updatedAt || b.recent[0]?.updatedAt || 0;
                return bTime - aTime;
            })
            .slice(0, limit);
    }

    public observeUserMessage(sessionId: string, message: { id?: string; content: string; timestamp?: number; metadata?: any }): MainChatGoal | null {
        const content = this.clean(message.content);
        if (!content || this.isSlashCommand(content)) return this.getSession(sessionId).current;

        const session = this.getSession(sessionId);
        const now = message.timestamp || Date.now();
        const current = session.current;

        if (!current || current.status !== 'active' || this.shouldReplaceGoal(current, content)) {
            return this.setGoal(sessionId, {
                title: this.deriveTitle(content),
                objective: this.deriveObjective(content, current),
                origin: 'auto',
                confidence: this.isGenericConversation(content) ? 0.35 : 0.72,
                sourceMessageId: message.id,
                latestUserRequest: content,
                metadata: {
                    generic: this.isGenericConversation(content),
                    createdFrom: 'user_message'
                }
            });
        }

        current.latestUserRequest = this.clip(content, 600);
        current.lastUserInputAt = now;
        current.updatedAt = now;

        const constraint = this.extractConstraint(content);
        if (constraint) current.constraints = this.unique([...current.constraints, constraint]).slice(-30);

        const acceptance = this.extractAcceptance(content);
        if (acceptance) current.acceptanceCriteria = this.unique([...current.acceptanceCriteria, acceptance]).slice(-30);

        const note = this.extractNote(content);
        if (note) current.notes = [...current.notes, note].slice(-50);

        this.save();
        return current;
    }

    public setGoal(sessionId: string, params: {
        title: string;
        objective?: string;
        origin?: MainGoalOrigin;
        confidence?: number;
        sourceMessageId?: string;
        latestUserRequest?: string;
        constraints?: string[];
        acceptanceCriteria?: string[];
        notes?: string[];
        metadata?: Record<string, any>;
    }): MainChatGoal {
        const session = this.getSession(sessionId);
        if (session.current && session.current.status === 'active') {
            session.current.status = 'paused';
            session.current.updatedAt = Date.now();
            session.recent.unshift(session.current);
            session.recent = session.recent.slice(0, 20);
        }

        const now = Date.now();
        const goal: MainChatGoal = {
            id: uuidv4(),
            sessionId,
            title: this.clip(this.clean(params.title) || 'Main chat goal', 120),
            objective: this.clip(this.clean(params.objective || params.title) || 'Help the user with the current conversation.', 1000),
            status: 'active',
            origin: params.origin || 'manual',
            confidence: Math.max(0, Math.min(1, Number(params.confidence ?? 0.9))),
            createdAt: now,
            updatedAt: now,
            lastUserInputAt: now,
            sourceMessageId: params.sourceMessageId,
            latestUserRequest: params.latestUserRequest ? this.clip(params.latestUserRequest, 600) : undefined,
            constraints: this.unique(params.constraints || []),
            acceptanceCriteria: this.unique(params.acceptanceCriteria || []),
            notes: (params.notes || []).filter(Boolean).slice(-50),
            linkedBackgroundGoalIds: [],
            linkedTaskIds: [],
            taskOutcomes: [],
            metadata: params.metadata
        };

        session.current = goal;
        this.save();
        console.log(`[MainGoal] Set main goal for ${sessionId}: "${goal.title}"`);
        return goal;
    }

    public addNote(sessionId: string, note: string): boolean {
        const current = this.getSession(sessionId).current;
        if (!current) return false;
        const clean = this.clean(note);
        if (!clean) return false;
        current.notes = [...current.notes, clean].slice(-50);
        current.updatedAt = Date.now();
        this.save();
        return true;
    }

    public addConstraint(sessionId: string, constraint: string): boolean {
        const current = this.getSession(sessionId).current;
        if (!current) return false;
        const clean = this.clean(constraint);
        if (!clean) return false;
        current.constraints = this.unique([...current.constraints, clean]).slice(-30);
        current.updatedAt = Date.now();
        this.save();
        return true;
    }

    public addAcceptanceCriterion(sessionId: string, criterion: string): boolean {
        const current = this.getSession(sessionId).current;
        if (!current) return false;
        const clean = this.clean(criterion);
        if (!clean) return false;
        current.acceptanceCriteria = this.unique([...current.acceptanceCriteria, clean]).slice(-30);
        current.updatedAt = Date.now();
        this.save();
        return true;
    }

    public completeGoal(sessionId: string, note?: string, evidence?: GoalTaskEvidence): boolean {
        const session = this.getSession(sessionId);
        if (!session.current) return false;
        if (note) session.current.notes = [...session.current.notes, this.clean(note)].filter(Boolean).slice(-50);
        if (evidence) session.current.taskOutcomes = this.pushTaskEvidence(session.current.taskOutcomes, evidence);
        session.current.status = 'completed';
        session.current.completedAt = Date.now();
        session.current.updatedAt = Date.now();
        session.recent.unshift(session.current);
        session.recent = session.recent.slice(0, 20);
        session.current = null;
        this.save();
        return true;
    }

    public clearGoal(sessionId: string, note?: string): boolean {
        const session = this.getSession(sessionId);
        if (!session.current) return false;
        if (note) session.current.notes = [...session.current.notes, this.clean(note)].filter(Boolean).slice(-50);
        session.current.status = 'cleared';
        session.current.updatedAt = Date.now();
        session.recent.unshift(session.current);
        session.recent = session.recent.slice(0, 20);
        session.current = null;
        this.save();
        return true;
    }

    public linkProject(sessionId: string, projectId: string): boolean {
        const current = this.getSession(sessionId).current;
        if (!current) return false;
        current.linkedProjectId = projectId;
        current.updatedAt = Date.now();
        this.save();
        return true;
    }

    /**
     * Phase 20 Move 2 — record that a canonical Task was created to serve the
     * current goal (the Task carries the goal id via metadata.goalId). Both
     * ends of goal <-> task are now traceable.
     */
    public linkTask(sessionId: string, taskId: string): boolean {
        const current = this.getSession(sessionId).current;
        if (!current) return false;
        if (!current.linkedTaskIds.includes(taskId)) {
            current.linkedTaskIds = [...current.linkedTaskIds, taskId].slice(-50);
            current.updatedAt = Date.now();
            this.save();
        }
        return true;
    }

    /**
     * Phase 20 Move 2 — attach a terminal canonical Task outcome to the
     * current goal WITHOUT completing it. Used for failed/blocked missions so
     * the failure is traceable on the goal while the goal stays active.
     */
    public recordTaskOutcome(sessionId: string, evidence: GoalTaskEvidence): boolean {
        const current = this.getSession(sessionId).current;
        if (!current) return false;
        current.taskOutcomes = this.pushTaskEvidence(current.taskOutcomes, evidence);
        current.updatedAt = Date.now();
        this.save();
        return true;
    }

    public linkBackgroundGoal(sessionId: string, goalId: string): boolean {
        const current = this.getSession(sessionId).current;
        if (!current) return false;
        current.linkedBackgroundGoalIds = this.unique([...current.linkedBackgroundGoalIds, goalId]).slice(-50);
        current.updatedAt = Date.now();
        this.save();
        return true;
    }

    public getPrompt(sessionId?: string): string {
        if (!sessionId) return '';
        const current = this.getSession(sessionId).current;
        if (!current || current.status !== 'active') return '';

        const minutesAgo = Math.max(0, Math.round((Date.now() - current.lastUserInputAt) / 60000));
        const lines: string[] = [
            'Main Chat Goal:',
            `- Title: ${current.title}`,
            `- Objective: ${current.objective}`,
            `- Status: ${current.status}; origin=${current.origin}; confidence=${current.confidence.toFixed(2)}; last user input ${minutesAgo}m ago`
        ];

        if (current.latestUserRequest) lines.push(`- Latest user request: ${current.latestUserRequest}`);
        if (current.linkedProjectId) lines.push(`- Linked project: ${current.linkedProjectId}`);
        if (current.linkedBackgroundGoalIds.length > 0) {
            lines.push(`- Linked background goals: ${current.linkedBackgroundGoalIds.slice(-5).join(', ')}`);
        }
        if (current.linkedTaskIds.length > 0) {
            lines.push(`- Linked tasks: ${current.linkedTaskIds.slice(-5).join(', ')}`);
        }
        if (current.taskOutcomes.length > 0) {
            const last = current.taskOutcomes[current.taskOutcomes.length - 1];
            const verification = last.verification ? `; verification: ${last.verification}` : '';
            lines.push(`- Latest task outcome: ${last.outcome}${last.turns !== undefined ? ` in ${last.turns} turns` : ''}${verification}`);
        }
        if (current.constraints.length > 0) {
            lines.push(`- Constraints: ${current.constraints.slice(-8).join(' | ')}`);
        }
        if (current.acceptanceCriteria.length > 0) {
            lines.push(`- Done means: ${current.acceptanceCriteria.slice(-8).join(' | ')}`);
        }
        if (current.notes.length > 0) {
            lines.push(`- Notes: ${current.notes.slice(-6).join(' | ')}`);
        }

        lines.push('Focus rule: preserve this main goal across normal turns; let the newest user message steer immediate details; replace the main goal only when the user explicitly changes focus.');
        return lines.join('\n');
    }

    private shouldReplaceGoal(current: MainChatGoal, text: string): boolean {
        if (current.metadata?.generic && this.isActionable(text)) return true;
        return /^(new goal|new main goal|change main goal|switch(?: the)? goal|switch focus|now focus on|focus on|instead[, ]|scratch that|forget that|main goal is|our goal is|let'?s work on)\b/i.test(text);
    }

    private isSlashCommand(text: string): boolean {
        return text.trim().startsWith('/');
    }

    private isGenericConversation(text: string): boolean {
        const normalized = text.toLowerCase().replace(/[.!?]+$/g, '').trim();
        if (/^(hi|hello|hey|yo|thanks|thank you|ok|okay|yes|no|continue|go on|tell me more)$/.test(normalized)) return true;
        return text.length < 12 && !this.isActionable(text);
    }

    private isActionable(text: string): boolean {
        return /\b(fix|create|build|make|add|remove|update|change|implement|debug|review|explain|tell me|check|test|run|import|clone|deploy|write|research|find|summarize|plan)\b/i.test(text);
    }

    private deriveTitle(text: string): string {
        if (this.isGenericConversation(text)) return 'General conversation';
        const firstLine = text.split(/\r?\n/).find(line => line.trim()) || text;
        return this.clip(
            firstLine
                .replace(/^\s*(please|can you|could you|would you|i want you to|i need you to|let'?s)\s+/i, '')
                .replace(/\s+/g, ' ')
                .trim(),
            90
        );
    }

    private deriveObjective(text: string, current?: MainChatGoal | null): string {
        if (this.isGenericConversation(text)) {
            return current?.objective || 'Continue the conversation and help the user with the next concrete request.';
        }
        return this.clip(text, 1000);
    }

    private extractConstraint(text: string): string | null {
        if (/\b(make sure|also|must|should|need to|do not|don't|never|only|without|avoid|require|requirement)\b/i.test(text)) {
            return this.clip(text, 300);
        }
        return null;
    }

    private extractAcceptance(text: string): string | null {
        if (/\b(done means|finished when|success means|verify|test|smoke test|build passes|marked done|no duplicate|no duplicates)\b/i.test(text)) {
            return this.clip(text, 300);
        }
        return null;
    }

    private extractNote(text: string): string | null {
        if (/\b(remember|note|for context|important|still not done|weak spot|problem)\b/i.test(text)) {
            return this.clip(text, 300);
        }
        return null;
    }

    private clean(value: string): string {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    private clip(value: string, max: number): string {
        const clean = this.clean(value);
        return clean.length > max ? clean.slice(0, max).trim() : clean;
    }

    private unique(values: string[]): string[] {
        return Array.from(new Set(values.map(value => this.clean(value)).filter(Boolean)));
    }

    private normalizeTaskEvidence(raw: any): GoalTaskEvidence | null {
        if (!raw || typeof raw !== 'object' || !raw.taskId) return null;
        return {
            taskId: String(raw.taskId),
            outcome: ['SUCCESS', 'FAILURE', 'PARTIAL', 'CANCELLED'].includes(String(raw.outcome))
                ? String(raw.outcome)
                : 'FAILURE',
            summary: raw.summary ? this.clip(String(raw.summary), 600) : undefined,
            attempts: Number.isFinite(Number(raw.attempts)) ? Number(raw.attempts) : undefined,
            turns: Number.isFinite(Number(raw.turns)) ? Number(raw.turns) : undefined,
            verification: raw.verification ? this.clip(String(raw.verification), 400) : undefined,
            toolCalls: Number.isFinite(Number(raw.toolCalls)) ? Number(raw.toolCalls) : undefined,
            completedAt: Number(raw.completedAt) || undefined
        };
    }

    private pushTaskEvidence(list: GoalTaskEvidence[], evidence: GoalTaskEvidence): GoalTaskEvidence[] {
        const existing = list.findIndex((item) => item.taskId === evidence.taskId);
        if (existing >= 0) {
            const next = [...list];
            next[existing] = { ...next[existing], ...evidence };
            return next.slice(-20);
        }
        return [...list, evidence].slice(-20);
    }
}

export const mainGoalManager = new MainGoalManager();
