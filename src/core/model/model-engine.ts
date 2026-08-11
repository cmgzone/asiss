/**
 * ModelEngine — Hermes Evolution Phase 6.
 *
 * Scores registered providers for the current Task instead of routing solely
 * from message complexity. The score is deliberately explainable:
 *
 * capability + reliability + tool-call success + context fit
 *   - latency penalty - cost penalty
 *
 * It wraps (rather than replaces) ModelRegistry, ModelRouter, CostTracker and
 * model resilience. Explicit ModelRouter rules remain hard overrides; the
 * scoring path is used for capability routing and records its own outcomes so
 * choices improve across restarts.
 */

import fs from 'fs';
import path from 'path';
import { ModelLevel, ModelProvider, LEVEL_RANK } from '../models';
import { providerLevel } from '../model-level';
import { modelResilienceManager } from '../resilient-model';
import { costTracker } from '../cost-tracker';
import {
  BuildModelTaskProfileInput,
  ModelCostSnapshot,
  ModelEngineOptions,
  ModelHealthSnapshot,
  ModelPerformance,
  ModelScore,
  ModelSelection,
  ModelTaskComplexity,
  ModelTaskProfile
} from './model-types';

interface StoredMetrics {
  version: 1;
  providers: Record<string, ModelPerformance>;
}

const DEFAULT_PERFORMANCE: ModelPerformance = {
  modelCalls: 0,
  successfulModelCalls: 0,
  failedModelCalls: 0,
  totalLatencyMs: 0,
  latencySamples: 0,
  toolCalls: 0,
  successfulToolCalls: 0,
  failedToolCalls: 0
};

const DEFAULT_LEVEL_BY_COMPLEXITY: Record<ModelTaskComplexity, ModelLevel> = {
  simple: 'low',
  medium: 'medium',
  complex: 'high'
};

const SIMPLE_PATTERNS = [
  /^(hi|hello|hey|thanks|thank you|ok|yes|no|bye|sure)\b/i,
  /^(what|who|when|where)\b/i,
  /^(define|explain briefly|summarize)\b/i
];

const COMPLEX_PATTERNS = [
  /\b(implement|build|create|develop|architect|design|refactor)\b/i,
  /\b(analyze|debug|investigate|diagnose|fix)\b/i,
  /\b(research|deep dive|comprehensive|migration|security|audit)\b/i,
  /```[\s\S]+```/
];

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

function clonePerformance(value: ModelPerformance): ModelPerformance {
  return { ...value };
}

function isRoutable(provider: ModelProvider): boolean {
  return Boolean(provider?.id)
    && provider.id !== 'mock'
    && provider.id !== 'error'
    && !provider.id.startsWith('resilient:')
    // Credential-pool entries are fallbacks, not deliberate primary choices.
    && !/_pool_\d+$/.test(provider.id);
}

/** Build a stable task profile with no provider or persistence dependencies. */
export function buildModelTaskProfile(input: BuildModelTaskProfileInput): ModelTaskProfile {
  const goal = String(input.goal || '').trim();
  const contextText = String(input.contextText || goal);
  const complexity = classifyTaskComplexity(goal, input.task);
  return {
    goal,
    taskId: input.task?.id,
    kind: input.task?.kind,
    priority: input.task?.priority,
    complexity,
    desiredLevel: input.desiredLevel || DEFAULT_LEVEL_BY_COMPLEXITY[complexity],
    contextTokens: Math.max(1, Math.ceil(contextText.length / 4)),
    requiresTools: input.requiresTools === true,
    attachmentCount: Math.max(0, Math.floor(Number(input.attachmentCount) || 0))
  };
}

export function classifyTaskComplexity(goal: string, task?: { priority?: string; kind?: string }): ModelTaskComplexity {
  const text = String(goal || '').trim();
  if (task?.priority === 'urgent' || task?.kind === 'workflow' || task?.kind === 'delegation') return 'complex';
  if (text.length < 40 && !COMPLEX_PATTERNS.some(pattern => pattern.test(text))) return 'simple';
  if (COMPLEX_PATTERNS.some(pattern => pattern.test(text))) return 'complex';
  if (SIMPLE_PATTERNS.some(pattern => pattern.test(text))) return 'simple';
  if (text.length > 500) return 'complex';
  return 'medium';
}

export class ModelEngine {
  private readonly filePath: string;
  private readonly getHealth: () => ModelHealthSnapshot[];
  private readonly getCosts: () => ModelCostSnapshot;
  private readonly now: () => number;
  private metrics: StoredMetrics = { version: 1, providers: {} };

  constructor(options: ModelEngineOptions = {}) {
    this.filePath = options.filePath === undefined
      ? path.join(process.cwd(), 'model_metrics.json')
      : options.filePath;
    this.getHealth = options.getHealth || (() => modelResilienceManager.list());
    this.getCosts = options.getCosts || (() => this.costSnapshot());
    this.now = options.now || (() => Date.now());
    this.load();
  }

  /** Score all candidates and return the most suitable provider for this Task. */
  select(
    input: BuildModelTaskProfileInput,
    providers: ModelProvider[],
    options: { pinnedProviderId?: string } = {}
  ): ModelSelection | null {
    const profile = buildModelTaskProfile(input);
    const candidates = providers.filter(isRoutable);
    if (candidates.length === 0) return null;

    const pinned = options.pinnedProviderId
      ? candidates.find(candidate => candidate.id === options.pinnedProviderId)
      : undefined;
    const scores = this.scoreAll(profile, candidates);
    if (pinned) {
      const score = scores.find(item => item.providerId === pinned.id)!;
      return {
        provider: pinned,
        profile,
        score: { ...score, reasons: ['Selected by an explicit model-router rule.', ...score.reasons] },
        candidates: scores,
        pinned: true
      };
    }

    const ranked = candidates
      .map(provider => ({ provider, score: scores.find(item => item.providerId === provider.id)! }))
      .sort((a, b) => b.score.score - a.score.score || a.provider.id.localeCompare(b.provider.id));
    return {
      provider: ranked[0].provider,
      profile,
      score: ranked[0].score,
      candidates: scores,
      pinned: false
    };
  }

  /** Record the result and latency of one model request. */
  recordModelOutcome(providerId: string, result: { success: boolean; latencyMs?: number }): void {
    const metrics = this.ensure(providerId);
    metrics.modelCalls += 1;
    if (result.success) metrics.successfulModelCalls += 1;
    else metrics.failedModelCalls += 1;
    if (Number.isFinite(result.latencyMs) && Number(result.latencyMs) >= 0) {
      metrics.totalLatencyMs += Math.round(Number(result.latencyMs));
      metrics.latencySamples += 1;
    }
    metrics.lastUsedAt = this.now();
    this.save();
  }

  /** Record whether a tool call proposed by a model actually succeeded. */
  recordToolOutcome(providerId: string, success: boolean): void {
    const metrics = this.ensure(providerId);
    metrics.toolCalls += 1;
    if (success) metrics.successfulToolCalls += 1;
    else metrics.failedToolCalls += 1;
    metrics.lastUsedAt = this.now();
    this.save();
  }

  getPerformance(providerId: string): ModelPerformance {
    return clonePerformance(this.metrics.providers[providerId] || DEFAULT_PERFORMANCE);
  }

  listPerformance(): Record<string, ModelPerformance> {
    return Object.fromEntries(Object.entries(this.metrics.providers).map(([id, value]) => [id, clonePerformance(value)]));
  }

  private scoreAll(profile: ModelTaskProfile, providers: ModelProvider[]): ModelScore[] {
    const health = new Map(this.getHealth().map(item => [item.id, item]));
    const costs = this.getCosts().averageCostByModel || {};
    const costsByProvider = new Map(providers.map(provider => [provider.id, this.costFor(provider, costs)]));
    const knownCosts = Array.from(costsByProvider.values()).filter((cost): cost is number => cost !== undefined);
    const minCost = knownCosts.length ? Math.min(...knownCosts) : undefined;
    const maxCost = knownCosts.length ? Math.max(...knownCosts) : undefined;

    return providers.map(provider => {
      const metrics = this.getPerformance(provider.id);
      const level = providerLevel(provider);
      const capability = this.capabilityScore(level, profile.desiredLevel);
      const reliability = this.reliabilityScore(metrics, health.get(provider.id));
      const toolCallSuccess = this.toolSuccessScore(metrics, profile.requiresTools);
      const contextFit = this.contextFitScore(provider, profile.contextTokens);
      const latencyPenalty = this.latencyPenalty(metrics);
      const costPenalty = this.costPenalty(level, costsByProvider.get(provider.id), minCost, maxCost);
      const score = clamp(
        capability * 0.40
        + reliability * 0.22
        + toolCallSuccess * 0.16
        + contextFit * 0.12
        - latencyPenalty * 0.06
        - costPenalty * 0.08
      );
      const reasons = [
        `${level} capability is matched to ${profile.desiredLevel} work (${Math.round(capability)}/100).`,
        `observed reliability ${Math.round(reliability)}/100${metrics.modelCalls ? ` from ${metrics.modelCalls} model calls` : ' (no local history yet)'}.`,
        profile.requiresTools
          ? `tool-use success ${Math.round(toolCallSuccess)}/100.`
          : 'tool-use score is neutral because this task does not require tools.',
        `context fit ${Math.round(contextFit)}/100 for ~${profile.contextTokens} tokens.`,
        `latency penalty ${Math.round(latencyPenalty)}/100; cost penalty ${Math.round(costPenalty)}/100.`
      ];
      return {
        providerId: provider.id,
        providerName: provider.name,
        level,
        score: Math.round(score * 100) / 100,
        capability: Math.round(capability * 100) / 100,
        reliability: Math.round(reliability * 100) / 100,
        toolCallSuccess: Math.round(toolCallSuccess * 100) / 100,
        contextFit: Math.round(contextFit * 100) / 100,
        latencyPenalty: Math.round(latencyPenalty * 100) / 100,
        costPenalty: Math.round(costPenalty * 100) / 100,
        reasons
      };
    }).sort((a, b) => b.score - a.score || a.providerId.localeCompare(b.providerId));
  }

  private capabilityScore(actual: ModelLevel, desired: ModelLevel): number {
    const delta = LEVEL_RANK[actual] - LEVEL_RANK[desired];
    return delta >= 0 ? 100 - delta * 8 : 100 + delta * 45;
  }

  private reliabilityScore(metrics: ModelPerformance, health?: ModelHealthSnapshot): number {
    // Priors keep a single successful/failed call from dramatically changing
    // routing, while still letting real usage dominate after a few calls.
    const local = (metrics.successfulModelCalls + 3) / (metrics.modelCalls + 4);
    const hSuccesses = health?.successes || 0;
    const hFailures = health?.failures || 0;
    const resilience = (hSuccesses + 2) / (hSuccesses + hFailures + 3);
    let score = (local * 0.75 + resilience * 0.25) * 100;
    if ((health?.cooldownUntil || 0) > this.now()) score -= 35;
    if ((health?.consecutiveFailures || 0) >= 3) score -= 15;
    return clamp(score);
  }

  private toolSuccessScore(metrics: ModelPerformance, requiresTools: boolean): number {
    if (!requiresTools) return 75;
    return clamp(((metrics.successfulToolCalls + 2) / (metrics.toolCalls + 3)) * 100);
  }

  private contextFitScore(provider: ModelProvider, contextTokens: number): number {
    const raw = Number((provider as any).contextWindow || (provider as any).contextLength || 0);
    // Unknown context windows should not be treated as either unsafe or ideal.
    if (!Number.isFinite(raw) || raw <= 0) return 75;
    if (contextTokens <= raw * 0.70) return 100;
    if (contextTokens <= raw) return 70;
    return clamp(70 - ((contextTokens - raw) / raw) * 140);
  }

  private latencyPenalty(metrics: ModelPerformance): number {
    if (metrics.latencySamples === 0) return 20;
    const averageMs = metrics.totalLatencyMs / metrics.latencySamples;
    return clamp(averageMs / 120);
  }

  private costPenalty(level: ModelLevel, cost: number | undefined, minCost?: number, maxCost?: number): number {
    if (cost !== undefined && minCost !== undefined && maxCost !== undefined && maxCost > minCost) {
      return clamp(((cost - minCost) / (maxCost - minCost)) * 100);
    }
    // Until pricing data exists, capability is a conservative cost proxy.
    return LEVEL_RANK[level] * 22;
  }

  private costFor(provider: ModelProvider, costs: Record<string, number>): number | undefined {
    const names = [
      provider.id,
      provider.name,
      String((provider as any).modelName || ''),
      typeof (provider as any).getModelName === 'function' ? String((provider as any).getModelName()) : ''
    ].filter(Boolean).map(value => value.toLowerCase());
    for (const [key, value] of Object.entries(costs)) {
      const normalized = key.toLowerCase();
      if (names.some(name => normalized === name || normalized.includes(name) || name.includes(normalized))) return value;
    }
    return undefined;
  }

  private costSnapshot(): ModelCostSnapshot {
    const summary = costTracker.getSummary();
    const averageCostByModel: Record<string, number> = {};
    for (const [model, value] of Object.entries(summary.byModel)) {
      if (value.calls > 0) averageCostByModel[model] = value.cost / value.calls;
    }
    return { averageCostByModel };
  }

  private ensure(providerId: string): ModelPerformance {
    if (!this.metrics.providers[providerId]) {
      this.metrics.providers[providerId] = clonePerformance(DEFAULT_PERFORMANCE);
    }
    return this.metrics.providers[providerId];
  }

  private load(): void {
    if (!this.filePath || !fs.existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      if (!raw || typeof raw !== 'object' || !raw.providers || typeof raw.providers !== 'object') return;
      this.metrics = {
        version: 1,
        providers: Object.fromEntries(Object.entries(raw.providers).map(([id, value]) => [
          id,
          { ...DEFAULT_PERFORMANCE, ...(value as Partial<ModelPerformance>) }
        ]))
      };
    } catch (error: any) {
      console.warn('[ModelEngine] Could not load model metrics:', error?.message || error);
    }
  }

  private save(): void {
    if (!this.filePath) return;
    try {
      const directory = path.dirname(this.filePath);
      if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
      const temporary = `${this.filePath}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(this.metrics, null, 2));
      fs.renameSync(temporary, this.filePath);
    } catch (error: any) {
      console.warn('[ModelEngine] Could not save model metrics:', error?.message || error);
    }
  }
}

/** Process-wide model scorer used by AgentRunner. */
export const modelEngine = new ModelEngine();
