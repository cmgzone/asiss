import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

export type AgentRunStatus = 'queued' | 'running' | 'completed' | 'failed';
export type AgentTaskReportStatus = 'completed' | 'failed';

export interface AgentToolCallRecord {
  id: string;
  name: string;
  arguments: any;
  success: boolean;
  output?: string;
  error?: string;
  timestamp: string;
}

export interface AgentRunMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  timestamp: string;
  toolName?: string;
}

export interface AgentTaskReport {
  taskId: string;
  agentId: string;
  status: AgentTaskReportStatus;
  summary: string;
  workDone: string[];
  filesChanged: string[];
  toolCalls: AgentToolCallRecord[];
  evidence: string[];
  risks: string[];
  nextSteps: string[];
  finalOutput: string;
  errorSummary?: string;
  attempts?: number;
  startedAt?: string;
  completedAt?: string;
  expectedOutput?: string;
  reviewCriteria?: string[];
}

export interface AgentRun {
  taskId: string;
  sessionId?: string;
  agentId: string;
  agentName: string;
  agentKind: 'custom_agent' | 'agent_profile' | 'swarm_agent';
  status: AgentRunStatus;
  task: string;
  expectedOutput?: string;
  allowedTools: string[];
  reviewCriteria: string[];
  maxTurns: number;
  attempts: number;
  messages: AgentRunMessage[];
  toolCalls: AgentToolCallRecord[];
  report?: AgentTaskReport;
  errorSummary?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

interface AgentRunData {
  runs: AgentRun[];
}

export class AgentRunManager {
  private readonly dataPath: string;
  private data: AgentRunData;

  constructor(dataPath?: string) {
    this.dataPath = dataPath || path.join(process.cwd(), 'agent_runs.json');
    this.data = { runs: [] };
    this.load();
  }

  private load() {
    if (!fs.existsSync(this.dataPath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.dataPath, 'utf-8'));
      const runs = Array.isArray(raw?.runs) ? raw.runs : Array.isArray(raw) ? raw : [];
      this.data = { runs: runs.map((run: any) => this.normalizeRun(run)).filter(Boolean) as AgentRun[] };
    } catch {
      this.data = { runs: [] };
    }
  }

  private save() {
    fs.writeFileSync(this.dataPath, JSON.stringify(this.data, null, 2));
  }

  private now() {
    return new Date().toISOString();
  }

  private stringArray(value: any): string[] {
    if (!Array.isArray(value)) return [];
    return value.map(v => String(v)).filter(Boolean);
  }

  private normalizeToolCall(value: any): AgentToolCallRecord {
    return {
      id: String(value?.id || uuidv4().slice(0, 8)),
      name: String(value?.name || 'unknown_tool'),
      arguments: value?.arguments ?? {},
      success: Boolean(value?.success),
      output: value?.output === undefined ? undefined : String(value.output),
      error: value?.error === undefined ? undefined : String(value.error),
      timestamp: String(value?.timestamp || this.now())
    };
  }

  private normalizeMessage(value: any): AgentRunMessage {
    const role = ['system', 'user', 'assistant', 'tool'].includes(value?.role) ? value.role : 'system';
    return {
      role,
      content: String(value?.content || ''),
      timestamp: String(value?.timestamp || this.now()),
      toolName: value?.toolName === undefined ? undefined : String(value.toolName)
    };
  }

  private normalizeReport(value: any, fallback: Partial<AgentTaskReport>): AgentTaskReport {
    const toolCalls = Array.isArray(value?.toolCalls)
      ? value.toolCalls.map((call: any) => this.normalizeToolCall(call))
      : fallback.toolCalls || [];

    return {
      taskId: String(value?.taskId || fallback.taskId || ''),
      agentId: String(value?.agentId || fallback.agentId || ''),
      status: value?.status === 'failed' ? 'failed' : 'completed',
      summary: String(value?.summary || fallback.summary || ''),
      workDone: this.stringArray(value?.workDone).length ? this.stringArray(value.workDone) : (fallback.workDone || []),
      filesChanged: this.stringArray(value?.filesChanged).length ? this.stringArray(value.filesChanged) : (fallback.filesChanged || []),
      toolCalls,
      evidence: this.stringArray(value?.evidence).length ? this.stringArray(value.evidence) : (fallback.evidence || []),
      risks: this.stringArray(value?.risks).length ? this.stringArray(value.risks) : (fallback.risks || []),
      nextSteps: this.stringArray(value?.nextSteps).length ? this.stringArray(value.nextSteps) : (fallback.nextSteps || []),
      finalOutput: String(value?.finalOutput || fallback.finalOutput || value?.summary || fallback.summary || ''),
      errorSummary: value?.errorSummary === undefined ? fallback.errorSummary : String(value.errorSummary),
      attempts: Number.isFinite(Number(value?.attempts)) ? Number(value.attempts) : fallback.attempts,
      startedAt: value?.startedAt || fallback.startedAt,
      completedAt: value?.completedAt || fallback.completedAt,
      expectedOutput: value?.expectedOutput || fallback.expectedOutput,
      reviewCriteria: this.stringArray(value?.reviewCriteria).length ? this.stringArray(value.reviewCriteria) : (fallback.reviewCriteria || [])
    };
  }

  private normalizeRun(value: any): AgentRun | null {
    if (!value) return null;
    const taskId = String(value.taskId || uuidv4().slice(0, 8));
    const agentId = String(value.agentId || '');
    const status = ['queued', 'running', 'completed', 'failed'].includes(value.status) ? value.status : 'queued';
    const run: AgentRun = {
      taskId,
      sessionId: value.sessionId ? String(value.sessionId) : undefined,
      agentId,
      agentName: String(value.agentName || agentId || 'agent'),
      agentKind: ['custom_agent', 'agent_profile', 'swarm_agent'].includes(value.agentKind) ? value.agentKind : 'custom_agent',
      status,
      task: String(value.task || ''),
      expectedOutput: value.expectedOutput ? String(value.expectedOutput) : undefined,
      allowedTools: this.stringArray(value.allowedTools),
      reviewCriteria: this.stringArray(value.reviewCriteria),
      maxTurns: Number.isFinite(Number(value.maxTurns)) ? Number(value.maxTurns) : 6,
      attempts: Number.isFinite(Number(value.attempts)) ? Number(value.attempts) : 0,
      messages: Array.isArray(value.messages) ? value.messages.map((msg: any) => this.normalizeMessage(msg)) : [],
      toolCalls: Array.isArray(value.toolCalls) ? value.toolCalls.map((call: any) => this.normalizeToolCall(call)) : [],
      errorSummary: value.errorSummary ? String(value.errorSummary) : undefined,
      createdAt: String(value.createdAt || this.now()),
      startedAt: value.startedAt ? String(value.startedAt) : undefined,
      completedAt: value.completedAt ? String(value.completedAt) : undefined
    };
    if (value.report) {
      run.report = this.normalizeReport(value.report, {
        taskId,
        agentId,
        toolCalls: run.toolCalls,
        expectedOutput: run.expectedOutput,
        reviewCriteria: run.reviewCriteria
      });
    }
    return run;
  }

  createRun(params: {
    sessionId?: string;
    agentId: string;
    agentName: string;
    agentKind: AgentRun['agentKind'];
    task: string;
    expectedOutput?: string;
    allowedTools?: string[];
    reviewCriteria?: string[];
    maxTurns?: number;
  }): AgentRun {
    const now = this.now();
    const run: AgentRun = {
      taskId: uuidv4().slice(0, 8),
      sessionId: params.sessionId,
      agentId: params.agentId,
      agentName: params.agentName,
      agentKind: params.agentKind,
      status: 'queued',
      task: params.task,
      expectedOutput: params.expectedOutput,
      allowedTools: params.allowedTools || [],
      reviewCriteria: params.reviewCriteria || [],
      maxTurns: params.maxTurns || 6,
      attempts: 0,
      messages: [],
      toolCalls: [],
      createdAt: now
    };
    this.data.runs.push(run);
    this.save();
    return run;
  }

  startAttempt(taskId: string): AgentRun | undefined {
    const run = this.getRun(taskId);
    if (!run) return undefined;
    run.status = 'running';
    run.attempts += 1;
    run.startedAt = run.startedAt || this.now();
    this.save();
    return run;
  }

  appendMessage(taskId: string, message: Omit<AgentRunMessage, 'timestamp'> & { timestamp?: string }) {
    const run = this.getRun(taskId);
    if (!run) return;
    run.messages.push({
      role: message.role,
      content: message.content,
      toolName: message.toolName,
      timestamp: message.timestamp || this.now()
    });
    this.save();
  }

  recordToolCall(taskId: string, call: Omit<AgentToolCallRecord, 'timestamp'> & { timestamp?: string }): AgentToolCallRecord | undefined {
    const run = this.getRun(taskId);
    if (!run) return undefined;
    const record: AgentToolCallRecord = {
      ...call,
      id: call.id || uuidv4().slice(0, 8),
      timestamp: call.timestamp || this.now()
    };
    run.toolCalls.push(record);
    this.save();
    return record;
  }

  completeRun(taskId: string, report: AgentTaskReport): AgentRun | undefined {
    const run = this.getRun(taskId);
    if (!run) return undefined;
    const completedAt = this.now();
    const normalized = this.normalizeReport(report, {
      taskId,
      agentId: run.agentId,
      toolCalls: run.toolCalls,
      attempts: run.attempts,
      startedAt: run.startedAt,
      completedAt,
      expectedOutput: run.expectedOutput,
      reviewCriteria: run.reviewCriteria
    });
    normalized.taskId = taskId;
    normalized.agentId = run.agentId;
    normalized.toolCalls = run.toolCalls;
    normalized.attempts = run.attempts;
    normalized.startedAt = run.startedAt;
    normalized.completedAt = completedAt;
    normalized.expectedOutput = run.expectedOutput;
    normalized.reviewCriteria = run.reviewCriteria;

    run.report = normalized;
    run.status = normalized.status;
    run.errorSummary = normalized.errorSummary;
    run.completedAt = completedAt;
    this.save();
    return run;
  }

  failRun(taskId: string, errorSummary: string): AgentRun | undefined {
    const run = this.getRun(taskId);
    if (!run) return undefined;
    const completedAt = this.now();
    const report: AgentTaskReport = {
      taskId,
      agentId: run.agentId,
      status: 'failed',
      summary: 'Delegated agent task failed.',
      workDone: [],
      filesChanged: [],
      toolCalls: run.toolCalls,
      evidence: [],
      risks: [errorSummary],
      nextSteps: ['Review the error summary and retry with a smaller or clearer task.'],
      finalOutput: '',
      errorSummary,
      attempts: run.attempts,
      startedAt: run.startedAt,
      completedAt,
      expectedOutput: run.expectedOutput,
      reviewCriteria: run.reviewCriteria
    };
    run.status = 'failed';
    run.report = report;
    run.errorSummary = errorSummary;
    run.completedAt = completedAt;
    this.save();
    return run;
  }

  getRun(taskId: string): AgentRun | undefined {
    return this.data.runs.find(run => run.taskId === taskId);
  }

  listRuns(params?: { sessionId?: string; agentId?: string; status?: AgentRunStatus; limit?: number }): AgentRun[] {
    let runs = [...this.data.runs];
    if (params?.sessionId) runs = runs.filter(run => run.sessionId === params.sessionId);
    if (params?.agentId) runs = runs.filter(run => run.agentId === params.agentId);
    if (params?.status) runs = runs.filter(run => run.status === params.status);
    runs.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    if (params?.limit && params.limit > 0) runs = runs.slice(0, params.limit);
    return runs;
  }

  listReports(params?: { sessionId?: string; agentId?: string; status?: AgentTaskReportStatus; limit?: number }): AgentTaskReport[] {
    let reports = this.listRuns({ sessionId: params?.sessionId, agentId: params?.agentId, limit: params?.limit ? params.limit * 2 : undefined })
      .map(run => run.report)
      .filter(Boolean) as AgentTaskReport[];
    if (params?.status) reports = reports.filter(report => report.status === params.status);
    if (params?.limit && params.limit > 0) reports = reports.slice(0, params.limit);
    return reports;
  }

  parseReportFromText(text: string, fallback: Partial<AgentTaskReport>): AgentTaskReport {
    const parsed = this.parseJsonObject(text);
    if (parsed) {
      return this.normalizeReport(parsed, fallback);
    }
    const finalOutput = text.trim();
    return this.normalizeReport({
      status: 'completed',
      summary: finalOutput.split(/\r?\n/).find(Boolean) || fallback.summary || 'Delegated agent completed the task.',
      workDone: finalOutput ? [finalOutput] : [],
      filesChanged: [],
      evidence: [],
      risks: [],
      nextSteps: [],
      finalOutput
    }, fallback);
  }

  buildReviewPrompt(sessionId?: string, limit?: number): string {
    const reports = this.listReports({ sessionId, limit });
    if (reports.length === 0) return '';
    const lines: string[] = [
      'Agent Delegation Reports:',
      'Review these child-agent reports before producing the final user response. Treat them as evidence to verify, not as unquestioned truth. Mention unresolved risks or failed delegated work when relevant.'
    ];
    for (const report of reports) {
      lines.push(`- Task ${report.taskId} by ${report.agentId}: ${report.status}`);
      if (report.summary) lines.push(`  Summary: ${report.summary}`);
      if (report.workDone.length) lines.push(`  Work done: ${report.workDone.join('; ')}`);
      if (report.filesChanged.length) lines.push(`  Files changed: ${report.filesChanged.join(', ')}`);
      if (report.evidence.length) lines.push(`  Evidence: ${report.evidence.join('; ')}`);
      if (report.risks.length) lines.push(`  Risks: ${report.risks.join('; ')}`);
      if (report.nextSteps.length) lines.push(`  Next steps: ${report.nextSteps.join('; ')}`);
      if (report.finalOutput) lines.push(`  Final output: ${report.finalOutput}`);
    }
    return lines.join('\n');
  }

  private parseJsonObject(text: string): any | null {
    const trimmed = text.trim();
    if (!trimmed) return null;
    const candidates = [
      trimmed,
      this.extractCodeFence(trimmed),
      this.extractBalancedJson(trimmed)
    ].filter(Boolean) as string[];

    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      } catch {
        // Try next candidate.
      }
    }
    return null;
  }

  private extractCodeFence(text: string): string | null {
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    return match ? match[1].trim() : null;
  }

  private extractBalancedJson(text: string): string | null {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    return text.slice(start, end + 1).trim();
  }
}

export const agentRunManager = new AgentRunManager();
