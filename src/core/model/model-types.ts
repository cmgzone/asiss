/**
 * ModelEngine types — Hermes Evolution Phase 6.
 *
 * A ModelTaskProfile describes the work rather than just the raw user
 * message. ModelEngine turns the profile and observed provider performance
 * into an explainable selection.
 */

import { ModelLevel, ModelProvider } from '../models';
import { Task, TaskKind, TaskPriority } from '../task';

export type ModelTaskComplexity = 'simple' | 'medium' | 'complex';

export interface ModelTaskProfile {
  goal: string;
  taskId?: string;
  kind?: TaskKind;
  priority?: TaskPriority;
  complexity: ModelTaskComplexity;
  desiredLevel: ModelLevel;
  /** Approximate prompt + system context size, in tokens. */
  contextTokens: number;
  requiresTools: boolean;
  attachmentCount: number;
}

export interface BuildModelTaskProfileInput {
  goal: string;
  task?: Task;
  contextText?: string;
  requiresTools?: boolean;
  attachmentCount?: number;
  desiredLevel?: ModelLevel;
}

export interface ModelPerformance {
  modelCalls: number;
  successfulModelCalls: number;
  failedModelCalls: number;
  totalLatencyMs: number;
  latencySamples: number;
  toolCalls: number;
  successfulToolCalls: number;
  failedToolCalls: number;
  lastUsedAt?: number;
}

export interface ModelHealthSnapshot {
  id: string;
  successes: number;
  failures: number;
  consecutiveFailures?: number;
  cooldownUntil?: number;
}

export interface ModelCostSnapshot {
  /** Average USD per completed model call, keyed by provider id or model name. */
  averageCostByModel: Record<string, number>;
}

export interface ModelScore {
  providerId: string;
  providerName: string;
  level: ModelLevel;
  score: number;
  capability: number;
  reliability: number;
  toolCallSuccess: number;
  contextFit: number;
  latencyPenalty: number;
  costPenalty: number;
  reasons: string[];
}

export interface ModelSelection {
  provider: ModelProvider;
  profile: ModelTaskProfile;
  score: ModelScore;
  candidates: ModelScore[];
  /** True when an explicit model-router rule selected this provider. */
  pinned: boolean;
}

export interface ModelEngineOptions {
  /** Runtime metrics path. Use an empty string for an in-memory engine. */
  filePath?: string;
  getHealth?: () => ModelHealthSnapshot[];
  getCosts?: () => ModelCostSnapshot;
  now?: () => number;
}
