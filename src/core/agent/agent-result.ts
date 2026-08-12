/**
 * Canonical AgentResult — Phase 13 Step 2.
 *
 * Agents return EVIDENCE, not "Done." The canonical shape maps to/from
 * the legacy `AgentTaskReport` (agent-run-manager) so wrap-first users
 * get the stable surface. `confidence` is OPTIONAL and deliberately not
 * produced by delegations yet — the measurement infrastructure lands
 * later; selection must not rank on invented numbers.
 */

import type { AgentTaskReport } from '../agent-run-manager';

export type AgentResultStatus = 'completed' | 'failed' | 'cancelled';

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