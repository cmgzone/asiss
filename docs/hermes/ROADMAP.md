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
| 5 | PolicyEngine | ALLOW / ASK / DENY before tool execution | [x] |
| 6 | ModelEngine | Capability/reliability/cost scoring instead of naive routing | [x] |
| 7 | ContextEngine | Budgeted relevance-based context construction | [x] |
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

Phases 0-7 are complete. `AgentRunner.processMessage` now creates a canonical
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
Phase 5 is also done: `src/core/policy/` now owns authorization. The
PolicyEngine evaluates every tool request through composable rules
(workspace-guard, allow/deny lists, agent permissions, destructive-command,
secret-scan, network-tools, file-writes, elevated-command) and returns an
ALLOW / ASK / DENY verdict with per-rule checks and a risk score for
observability. ASK verdicts resolve through an approval handler (engine-level
or per-call) with a configurable default outcome. The DEFAULT configuration is
pure allow mode — every rule defaults to 'allow' and unresolved ASKs default
to allow — so adopting the engine changed nothing in production; the Phase 4
workspace guard and allow/deny lists moved into the engine with identical
scope (native tools). ToolEngine now runs the PolicyEngine for every tool
before execution and attaches the full verdict to denied results. The ASK path
is finished too: `ApprovalCoordinator` (`src/core/policy/policy-approval.ts`)
turns an ASK verdict into a real user decision — it emits `ApprovalRequired`
on the TaskEventBus (forwarded to hookManager audit and, via AgentRunner, to
the session's gateway as `approval_required` stream events), waits for the
user, and on Allow/Deny emits `ApprovalGranted`/`ApprovalDenied` plus a
decision record on the canonical Task. The web channel routes
`approval_response` payloads back into the coordinator, and the UI renders an
approval card with Allow/Deny buttons; unresolved requests fail closed after
10 minutes. Verified by `scripts/smoke-policy.ts` (15 sections) and by all
prior smokes unchanged.
Phase 6 is also done: `src/core/model/` provides a task-aware `ModelEngine`.
It profiles the active canonical Task and scores routable providers by
capability fit, observed model reliability, observed tool-call success, context
fit, latency, and actual CostTracker history. Its lightweight durable metrics
are stored locally in ignored `model_metrics.json`. Explicit ModelRouter rules
remain hard user overrides, but empty level rules now use ModelEngine rather
than a first-match provider. AgentRunner records the selected provider and the
explainable score on the Task, and feeds model/tool outcomes back into the
engine; resilient providers expose which provider actually fulfilled the call
so performance is attributed accurately. Verified by
`scripts/smoke-model-engine.ts` and the end-to-end runtime smoke.

Phase 7 is also done: `src/core/context/` owns budgeted, relevance-based
context construction (relevance scoring, token budgeting with priority
trimming, injectable summarizer with cache, on-demand repository indexing that
surfaces goal-matched files, and a builder that assembles history / decisions /
project / repository / tools / notes into one observable ContextPackage).
AgentRunner's history renderer now delegates to the engine's `renderHistory`
(byte-identical output — the e2e runtime smoke passes unchanged), and an
opt-in repository section (`agent.context.repository.enabled`) surfaces the
files most relevant to the goal. Verified by `scripts/smoke-context.ts`
(7 sections) and all prior smokes.
Phase 8 is done: `src/core/context/repo-index.ts` builds a persistent,
symbol-aware repository index on top of Phase 7's on-demand index. For each
source file it extracts symbols (functions/classes/interfaces/types by
language family), imports (a module graph), and test/config classification,
then persists the index under the standard data root (`repo-index/<hash>.json`)
and refreshes it incrementally — only files whose mtime/size changed are
re-parsed, and vanished/new files are dropped/added. ContextEngine now prefers
the persistent index by default (load -> refresh -> save, corrupt files
rebuild; `repository.persistent: false` restores the lightweight walk), and
`matchBySymbols` resolves goals to files via path + symbol + import signals
with test/config bonuses ("fix authentication" -> src/auth/auth.ts and
tests/auth/*; "add tests" surfaces test files; "docker deploy" surfaces
Dockerfile). The repository section now also renders a per-goal
"Files relevant to the current goal" hint each turn, driven by the same
`agent.context.repository` config (`goalHints.enabled: false` opts back into
the plain path list): symbol/test/config reasons per file, powered by a
stem-aware matcher ("authentication" hits `authenticate`/`auth`) and gated so
unrelated goals inject no noise. Verified by `scripts/smoke-repo-index.ts`
(9 sections: extraction, imports, classification, full index, symbol
matching, disk round-trip, incremental refresh, engine integration, goal
hints) and all prior smokes. Symbol references now also resolve
directly through the index's exportedSymbols map ("fix authenticate()" ->
src/auth/auth.ts, exact + case-insensitive) via `ContextEngine.resolveSymbols`,
and a `symbol` skill answers "where does this symbol live?" with the defining
files, kinds, and lines.
Phase 9 is done: the index stays warm on demand. `ContextEngine.refreshRepository`
re-runs the Phase 8 incremental refresh (only changed files re-parsed, then
re-saved) or rebuilds the lightweight index, throttled per root (default 5s,
`repository.warm.throttleMs`, fully off via `repository.warm.enabled: false`,
bypassed with `{ force: true }`). AgentRunner warms the workspace before
rendering the repository section each turn, and the symbol skill force-warms
before every explicit query, so /symbol never answers from a stale index.
Verified by `scripts/smoke-repo-index.ts` (11 sections: + warm refresh,
throttle, force, opt-out, lightweight rebuild, skill self-refresh).
Phase 10 next: keep the execution loop honest — step/session limits already
exist; add a repository-aware retry policy that suggests the files matched by
the goal when a coding step fails.
