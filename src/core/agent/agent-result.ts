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
    completedAt: report.completedAt
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
    finalOutput: result.summary,
    errorSummary: result.errorSummary || (result.status === 'failed' ? result.summary : undefined),
    attempts: result.attempts,
    startedAt: result.startedAt,
    completedAt: result.completedAt
  };
}