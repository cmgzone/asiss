# Hermes Evolution — Phase Roadmap

> Controlled architectural evolution of the gitu/ASISS codebase into the Hermes
> architecture. Rule: introduce a new abstraction -> wrap the existing subsystem
> -> move one responsibility -> test -> move the next -> remove the old path.
> The system stays usable at every step; `src/agents/runner.ts` is not rewritten
> wholesale.

## Status legend

- [x] done · [~] in progress · [ ] not started

## Phases

| # | Phase | Deliverable | Status |
| --- | --- | --- | --- |
| 0 | Freeze baseline | `docs/hermes/BASELINE.md`, `AGENT_RUNNER_FLOW.md`, `SUBSYSTEM_INVENTORY.md`, `scripts/smoke-baseline.ts` | [x] |
| 1 | Canonical Task system | `src/core/task/` (types, state, events, store, engine) | [x] |
| 2 | TaskEngine ownership | AgentRunner creates a Task per mission, records tools/checkpoints/cost/progress, finalizes on every exit | [x] |
| 3 | Event system | TaskEventBus bridged to hookManager (audit + subscribers); events carry taskId/sessionId | [x] |
| 4 | ToolEngine | Extract tool dispatch from AgentRunner (`src/core/tools/`) | [x] |
| 5 | PolicyEngine | ALLOW / ASK / DENY before tool execution | [ ] |
| 6 | ModelEngine | Capability/reliability/cost scoring instead of naive routing | [ ] |
| 7 | ContextEngine | Budgeted relevance-based context construction | [ ] |
| 8 | Repository intelligence | Symbol/file/test index for coding tasks | [ ] |
| 9 | ExecutionScheduler | Real parallelism: deps, priorities, timeouts, retries | [ ] |
| 10 | Swarm on TaskEngine | AgentSwarm -> child Tasks -> AgentEngine | [ ] |
| 11 | VerificationEngine | Typecheck/lint/test/build gates; never trust "the model said it's fixed" | [ ] |
| 12 | Checkpoint integration | Task-aware checkpoints; mutations attributable to tasks | [ ] |
| 13 | Unified memory | Episodic/Semantic/Procedural/Project/Working memory | [ ] |
| 14 | LearningEngine | Observation -> evaluation -> validation -> promotion | [ ] |
| 15 | Background worker migration | Background goals/projects become Tasks | [ ] |
| 16 | AgentEngine | Unified Agent abstraction (Architect/Researcher/Coder/...) | [ ] |
| 17 | Self-repair loop | UNDERSTAND -> ... -> LEARN autonomous coding loop | [ ] |
| 18 | TelemetryEngine | Why-is-Hermes-slow observability | [ ] |
| 19 | Automated evals | `evals/` suite + regression gates | [ ] |
| 20 | Advanced autonomy | Persistent projects, learned routing, A2A federation | [ ] |

## Current milestone

Phases 0-4 are complete. `AgentRunner.processMessage` now creates a canonical
Task per mission (`kind: 'mission'`), advances it through the lifecycle
(CREATED -> ANALYZING -> PLANNING -> EXECUTING), records tool executions
(ToolStarted/ToolCompleted/ToolFailed), automatic workspace checkpoints, token
cost and progress, and finalizes it on every exit path (success -> COMPLETED;
blocked / step-limit / thrown errors -> FAILED) via try/finally. Existing
behavior is unchanged: the engine only records, it does not execute. Verified
end-to-end by `scripts/smoke-agent-runtime.ts`. Phase 3 is also done: the
task-hooks bridge (`src/core/task/task-hooks-bridge.ts`) auto-subscribes the
process-wide TaskEventBus and forwards every task/tool lifecycle event onto
hookManager (extended HookEventName union), so telemetry/recovery/audit observe
the canonical Task system without AgentRunner wiring anything. Phase 4 is
also done: `src/core/tools/` now owns the whole tool lifecycle (result types,
registry catalog, name normalization + alias resolution + fallback chains,
argument validation, authorize/policy, execution with automatic checkpoints and
semantic fallback, and telemetry/task recording). AgentRunner's
`executeToolCall` and `normalizeToolCall` are thin delegations into
`ToolEngine.execute`; the old static helpers (resolveToolAlias,
resolveFallbackSkills, adaptFallbackArgs, closestToolNames) are deleted.
Verified by `scripts/smoke-tools.ts` (7 lifecycle sections) and by the
end-to-end `smoke-agent-runtime` mission running through the new pipeline.
Phase 5 next: a real PolicyEngine (ALLOW / ASK / DENY) in front of execution.
