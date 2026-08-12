/**
 * Canonical AgentResult — Phase 13 Step 2.
 *
 * Agents return EVIDENCE, not "Done." The canonical shape maps to/from
 * the legacy `AgentTaskReport` shape so wrap-first users get the stable
 * surface. `confidence` is OPTIONAL and deliberately not produced by
 * delegations yet — the measurement infrastructure lands later; selection
 * must not rank on invented numbers.
 *
 * Audit 5 — the legacy `AgentTaskReport` / `AgentToolCallRecord` types and
 * the review-prompt renderer moved here from agent-run-manager.ts (deleted):
 * the report is now rendered from canonical Tasks' `outcome.result`, with
 * tool evidence read from `Task.toolExecutions`. One report shape, one
 * authority.
 */

import type { Task } from '../task/task-types';

export type AgentResultStatus = 'completed' | 'failed' | 'cancelled';

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

export interface AgentArtifactRef {
  name: string;
  path?: string;
  kind?: string;
  summary?: string;
}

export interface AgentResult {
  taskId?: string;
  agentId: string;
  agentName?: string;
  status: AgentResultStatus;
  summary: string;
  findings: string[];
  /** Commands, outputs, sources, files, or observations backing the result. */
  evidence: string[];
  artifacts: AgentArtifactRef[];
  recommendations: string[];
  confidence?: number;
  unresolvedQuestions: string[];
  errorSummary?: string;
  attempts?: number;
  startedAt?: string;
  completedAt?: string;
  /** The child agent's final answer / artifact summary (review-prompt feed). */
  finalOutput?: string;
}

/** Adapter: legacy AgentTaskReport -> canonical AgentResult. */
export function agentResultFromTaskReport(report: AgentTaskReport): AgentResult {
  return {
    taskId: report.taskId,
    agentId: report.agentId,
    agentName: report.agentId,
    status: report.status === 'completed' ? 'completed' : 'failed',
    summary: report.summary || report.finalOutput || report.errorSummary || '',
    findings: [...(report.workDone || [])],
    evidence: [...(report.evidence || [])],
    artifacts: (report.filesChanged || []).map((f) => ({ name: f })),
    recommendations: [...(report.nextSteps || [])],
    unresolvedQuestions: [...(report.risks || [])],
    errorSummary: report.errorSummary,
    attempts: report.attempts,
    startedAt: report.startedAt,
    completedAt: report.completedAt,
    finalOutput: report.finalOutput
  };
}

/** Adapter: canonical AgentResult -> legacy AgentTaskReport shape. */
export function taskReportFromAgentResult(result: AgentResult): AgentTaskReport {
  return {
    taskId: result.taskId || '',
    agentId: result.agentId,
    status: result.status === 'completed' ? 'completed' : 'failed',
    summary: result.summary,
    workDone: [...result.findings],
    filesChanged: result.artifacts.map((a) => a.path || a.name),
    toolCalls: [],
    evidence: [...result.evidence],
    risks: [...result.unresolvedQuestions],
    nextSteps: [...result.recommendations],
    finalOutput: result.finalOutput || result.summary,
    errorSummary: result.errorSummary || (result.status === 'failed' ? result.summary : undefined),
    attempts: result.attempts,
    startedAt: result.startedAt,
    completedAt: result.completedAt
  };
}

/**
 * Normalize a canonical Task's stored outcome.result into an AgentTaskReport.
 * The engine stores the legacy report shape on child Task outcomes (it is the
 * stable surface); when a Task carries a raw AgentResult instead (future
 * consumers), adapt it. Returns null when the outcome carries no report.
 */
export function taskReportFromOutcome(task: Task): AgentTaskReport | null {
  const result: any = task.outcome?.result;
  if (!result || typeof result !== 'object') return null;
  if (Array.isArray(result.workDone) && typeof result.status === 'string') {
    return result as AgentTaskReport;
  }
  if (typeof result.summary === 'string' && typeof result.agentId === 'string') {
    return taskReportFromAgentResult(result as AgentResult);
  }
  return null;
}

/** The canonical Task kinds that represent delegated child work. */
const DELEGATION_TASK_KINDS: Task['kind'][] = ['delegation', 'swarm', 'background', 'scheduled'];

/**
 * The terminal delegated child Tasks of a session, newest first. This is the
 * canonical replacement for the legacy manager's listReports({ sessionId })
 * used by the review-prompt consumers.
 */
export function delegationTasksForSession(tasks: Task[], sessionId?: string): Task[] {
  return tasks
    .filter(t => (sessionId ? t.sessionId === sessionId : true))
    .filter(t => DELEGATION_TASK_KINDS.includes(t.kind))
    .filter(t => t.status === 'COMPLETED' || t.status === 'FAILED' || t.status === 'CANCELLED')
    .filter(t => taskReportFromOutcome(t) !== null)
    .sort((a, b) =>
      (b.timing?.completedAt ?? b.timing?.createdAt ?? 0) - (a.timing?.completedAt ?? a.timing?.createdAt ?? 0)
    );
}

/**
 * Render the "Agent Delegation Reports" review block from canonical Tasks.
 * Produces the identical block the legacy AgentRunManager.buildReviewPrompt
 * did, so the main agent's context and the delegate result's reviewPrompt
 * change shape only in source, not in content.
 */
export function renderDelegationReports(tasks: Task[]): string {
  const reports = tasks.map(t => taskReportFromOutcome(t)).filter((r): r is AgentTaskReport => r !== null);
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

/**
 * Parse a child agent's final answer into a canonical AgentResult.
 * The model is instructed to reply with one JSON object shaped like
 * AgentResult's report fields; when it cannot (JSON parse failure) the
 * whole text becomes the summary with status 'failed' so the engine owns
 * the terminal decision instead of the model declaring victory.
 */
export function parseAgentResultFromText(
  content: string,
  meta: { taskId?: string; agentId: string; agentName?: string }
): AgentResult {
  const text = String(content || '').trim();
  if (!text) {
    return {
      taskId: meta.taskId,
      agentId: meta.agentId,
      agentName: meta.agentName,
      status: 'failed',
      summary: 'Child agent returned no final report.',
      findings: [],
      evidence: [],
      artifacts: [],
      recommendations: [],
      unresolvedQuestions: []
    };
  }

  // Strip code fences if the model wrapped the JSON.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced ? fenced[1] : text;

  let parsed: any = null;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    parsed = null;
  }

  if (!parsed || typeof parsed !== 'object') {
    return {
      taskId: meta.taskId,
      agentId: meta.agentId,
      agentName: meta.agentName,
      status: 'failed',
      summary: 'Child agent did not return a structured report.',
      findings: [],
      evidence: [],
      artifacts: [],
      recommendations: [],
      unresolvedQuestions: [],
      errorSummary: 'Unparseable final report; the engine did not accept a self-declared completion.'
    };
  }

  const status: AgentResultStatus =
    parsed.status === 'completed' || parsed.status === 'success' ? 'completed' : 'failed';

  return {
    taskId: meta.taskId || parsed.taskId,
    agentId: meta.agentId || parsed.agentId,
    agentName: meta.agentName,
    status,
    summary: String(parsed.summary || parsed.finalOutput || '').trim() || 'No summary.',
    findings: [...(Array.isArray(parsed.workDone) ? parsed.workDone : [])],
    evidence: [...(Array.isArray(parsed.evidence) ? parsed.evidence : [])],
    artifacts: Array.isArray(parsed.filesChanged)
      ? (parsed.filesChanged as unknown[]).filter((f): f is string => typeof f === 'string')
          .map((f: string) => ({ name: f }))
      : [],
    recommendations: [...(Array.isArray(parsed.nextSteps) ? parsed.nextSteps : [])],
    unresolvedQuestions: [...(Array.isArray(parsed.risks) ? parsed.risks : [])],
    errorSummary: parsed.errorSummary,
    attempts: parsed.attempts,
    finalOutput: String(parsed.finalOutput || parsed.summary || '')
  };
}