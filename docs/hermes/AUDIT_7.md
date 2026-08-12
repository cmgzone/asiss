# Hermes Architecture Audit 7 — Agent Execution Authority (Phase 16, Move 1)

> Docs-first audit for Phase 16: **one AgentEngine using AgentProfiles and
> explicit policies.** Per the governing rule: *Task = what work happens,
> AgentProfile = how this kind of agent behaves, AgentEngine = who performs
> the work and how that execution is configured.* The goal is to identify
> **duplicate authority, not merely duplicate code** — then define the Agent
> contract and consolidate execution behind one engine.

## 1. Path inventory — every agent execution path

| Path | Who creates the run | Lifecycle owner | Model selection | Context build | Tool selection | Failure/retry | Persist | Events | Cancel |
|---|---|---|---|---|---|---|---|---|---|
| **Mission loop** (`processMessage`) | runner `beginMissionTask` (canonical `kind: 'mission'` Task) | `TaskEngine.runMission` | ModelRouter → ModelEngine task-shaped scoring, config fallback, `withModelRetry` | `ContextEngine.buildMissionPrompt` (repo/warmth) + runner sections (workspace, plan, unified memory, current task) | runner `buildToolList` (cap, dedup, MCP) | `TaskEngine.diagnose` (recovery) + engine verdicts + model-call retry | TaskEngine store | TaskEventBus + hook bridge | `taskEngine.cancel` + plan-mode UX |
| **Delegation** (`delegate_agent` skill) | AgentEngine `executeTask` (child Task) | `TaskEngine.runMission` (child) | `resolveMissionModel` — agent `modelPolicy` (pin + fallbacks + desiredLevel) | AgentEngine flat child prompt (system + task + conversation) — no ContextEngine, no memory | `advertisedToolSchemas` — `agent.tools` ∩ allowed, SkillRegistry + MCP | engine `maxAttempts` (new child Task per attempt, subtasks) | TaskEngine store | TaskEventBus | `taskEngine.cancel` |
| **Swarm task** (swarm executor) | delegate skill → AgentEngine (kind `'swarm'`) | TaskEngine (child) | agent modelPolicy | child prompt (flat) | advertisedToolSchemas | engine attempts | TaskEngine + swarm_data linkage | TaskEventBus | `taskEngine.cancel` |
| **Swarm non-delegate branch** | **bare `model.generate` — NO Task** | **none** | `getModelById` | `this.baseSystemPrompt` only | **none** | **none** | **none** | **none** | **none** |
| **Background goal** (`runBackgroundGoalViaEngine`) | AgentEngine (kind `'background'`) | TaskEngine (child) | agent modelPolicy | child prompt (flat) | advertisedToolSchemas | engine attempts → worker retry authority | TaskEngine + goal linkage | TaskEventBus | worker cancel + `taskEngine.cancel` |
| **Scheduled job** (`runScheduledJobViaEngine`) | AgentEngine (kind `'scheduled'`) | TaskEngine (child) | agent modelPolicy | child prompt (flat) | advertisedToolSchemas | engine attempts → job failure record | TaskEngine + scheduler linkage | TaskEventBus | scheduler cancel |
| **Skill creation / external research** | runner/learning wrap (kind `'background'`) | TaskEngine (deterministic workflow as execution) | internal model calls | workflow prompts | internal skills | `failTask` + store authority | TaskEngine | TaskEventBus | `taskEngine.cancel` |
| **Tool execution** | `ToolEngine.execute` (native/MCP/learned/dynamic) | ToolEngine (records `toolExecutions` on Task) | — | — | policy validation (PolicyEngine) | tool verdicts → TaskToolRecord | Task | TaskEventBus | abort via task |
| **Model invocation** | `ModelProvider.generate`/`generateStream` | provider | registry/router/engine/policies | — | — | `withModelRetry` (transient) + resilient-model cooldowns | model-engine metrics | — | — |

## 2. Already-unified (the wins to preserve)

- **Task lifecycle**: `TaskEngine.runMission` is the ONE lifecycle driver — the
  mission loop AND every child mission (delegation/swarm/background/scheduled)
  go through it. Hosts only supply `iterate` callbacks.
- **Tool execution**: `ToolEngine.execute` is the single execution mechanism;
  native, MCP, learned, and dynamic tools all funnel through it and leave
  `toolExecutions` evidence on the canonical Task.
- **Events**: one `TaskEventBus`, auto-forwarded to hooks by
  `task-hooks-bridge`. Evidence lives on the Task.
- **Triggers**: scheduler/background worker/heartbeat are WHEN-only (Phase 15).
- **AgentRunManager**: deleted (Audit 5) — zero references remain, only
  comments. No second run bookkeeping.

## 3. Findings (duplicate / split authority), ranked

### D1 — swarm executor's non-delegate branch ran outside the lifecycle (REMOVED, Move 3)

When `delegate_agent` is not in the registry, the swarm executor did a bare
`model.generate(prompt, this.baseSystemPrompt, [])`: no Task, no ToolEngine,
no events, no evidence, no cancellation — the last fragment path where agent
work happens outside the canonical lifecycle. In practice the skill is always
registered (the runner constructs it unconditionally), so this was a defensive
branch, but it was exactly the "no competing agent execution path" rule Phase
16 exists to enforce. **Resolved (Move 3, part 1): the branch is deleted** —
the executor now logs loudly and throws `delegate_agent skill is unavailable…`
when the skill is missing; the swarm store's `runAgent` catch marks the task
`failed` with that message, keeping `swarm_data.json` authoritative for swarm
statuses (Audit 4 S2). No swarm work can ever run as an untracked model call.

### D2 — two context-construction authorities (PARTIALLY RESOLVED, Move 4)

The mission loop builds rich context (`ContextEngine.buildMissionPrompt`:
repository warmth, workspace) plus runner-injected sections (plan, unified
memory from Phase 14, current task). AgentEngine child missions build a FLAT
prompt (`buildChildSystemPrompt` + `buildChildTaskPrompt` + conversation).
**Resolved (Move 4): the child context now assembles from the agent's
`contextPolicy.sources`** — task/instructions/history are structural (the task
contract + loop contract, always rendered), 'memory' gates the unified-memory
section, 'attempts' gates prior failed-attempt outcome lines (fed from the
failed child Tasks across retries). **Deferred: 'repo'** — children still get
no ContextEngine repository warmth; wiring it needs ContextEngine access in
the child runtime (tracked for a later phase).

### D3 — two model-selection authorities (layer, don't duplicate)

Mission loop: ModelRouter → ModelEngine task-shaped scoring with a pinned
override (`modelRouter.explicitModelIdFor`) and config fallback. AgentEngine:
`resolveMissionModel` from the agent's `modelPolicy` (pin + ordered fallbacks +
desiredLevel). These are complementary (agent policy is the width, routing is
the default) and **Move 3b partially closes the gap**: when a designated
default agent exists, the mission loop layers `modelPolicy.modelId` UNDER the
router override (router wins; agent pin is the width) — same ModelPolicy
contract both paths consume. **Plan (Move 4): complete the contract** — task
requirements → selection → fallback → budget, used uniformly by both paths.

### D4 — two tool-selection authorities (RESOLVED, Move 4)

`buildToolList` (mission, capped/deduped/MCP) vs `advertisedToolSchemas`
(AgentEngine, `agent.tools` ∩ allowed). Both feed the SAME `ToolEngine`, so
execution is unified; selection policy was split. **Resolved (Move 4): one
ToolPolicy per Agent consumed by both paths** — the child side already
honored `agent.tools` ∩ request-allowed; the mission now applies the
designated default agent's `permissions` to its advertised surface (denied
list always removed, explicit allow list or declared tools intersect the
surface, `maxToolCalls` becomes the mission tool-call budget when the host
config doesn't set one). No declared restriction -> surface unchanged.

### D5 — memory injection split (RESOLVED, Move 4)

Mission prompt carries the Phase 14 unified memory section; AgentEngine
children got none. **Resolved (Move 4): children now receive unified memory
per `memoryPolicy`.** The `AgentEngineRuntime` gains a `retrieveMemory` hook
(the runner wires the Phase 14 consolidation layer); `runChildMission` maps
the agent's `memoryPolicy` (injectLimit / minScore / minImportance / types /
sources) to a retrieval and renders a `Memory context (unified)` section into
the child system prompt — gated on the 'memory' contextPolicy source.
Policy decides, the memory system executes; AgentEngine has no knowledge of
how memory is stored. The mission side applies the default agent's
memoryPolicy as a filter on its existing unified-memory section (types /
sources / minImportance).

### D6 — retry authority (layered, complementary — by design)

Transport-level (`withModelRetry` transient model-call retry), engine-level
(`executeTask` maxAttempts → new child Task per attempt), recovery-level
(`TaskEngine.diagnose` in-mission), and store-level (goal/job retry policies).
Layers are distinct concerns; document, do not merge. The one gap: the mission
loop's attempts live on the mission Task (`timing.attempts`) while agent
attempts are child Tasks — consistent with "attempts visible as subtasks".

### D7 — streaming (defer)

Only the mission loop streams (`generateStream` for web channels); child
missions buffer. Not an authority conflict; defer until the child context
policy lands.

## 4. Agent contract gap (Move 2 input)

The canonical `Agent` (agent-types.ts) already has: role, capabilities, tools,
`modelPolicy`, `permissions` (allowed/denied/approval/workspace/tool-call
cap), `memoryScope`, `taskScope`, persona, status. **Missing vs the Phase 16
spec**: `contextPolicy` (D2), `memoryPolicy` (D5 — only a scope today),
`handoffPolicy` (Move 5), `executionLimits` (only maxToolCalls inside
permissions; no token/time budget), and an explicit `instructions` field
(persona is the closest). The Task / AgentProfile / AgentRun separation: today
the run IS the child Task (evidence lives there, `Task = run` — consistent
with Phase 13), and agent status is a registry projection. **Decision for Move
3: keep Task-as-run** (a distinct AgentRun record would re-introduce the
duplicated run bookkeeping Audit 5 removed) and express "run" as the Task +
assignedAgent + registry status projection.

## 5. Consolidation plan (Moves 2-7)

1. **Move 2 — Agent contract — DONE (below).** Extended `Agent` with
   `instructions`, `contextPolicy`, `memoryPolicy`, `executionLimits`,
   `handoffPolicy`; `AgentProfile ≠ AgentRun ≠ Task` documented and
   Task-as-run kept.
2. **Move 3 — canonical execution — DONE.** D1 (swarm non-delegate
   fragment) removed; the mission loop resolves the designated default
   AgentProfile through the same contract (assignedAgent on the mission
   Task, modelPolicy pin under the router override, persona + instructions
   in the system prompt).
3. **Move 4 — policies — DONE.** ModelPolicy (D3) both paths; ToolPolicy
   (D4) both paths; MemoryPolicy (D5) both paths; ContextPolicy (D2)
   children (repo deferred).
4. **Move 5 — handoffs — DONE.** `handoffPolicy` enforced in
   AgentEngine.executeTask (the single delegation entry point): the
   delegating agent is the parent Task's assignedAgent; allowDelegation gates
   delegation at all, allowedRoles restricts the target's role, and every
   ancestor delegator's maxDepth bounds the chain originating from it.
   Refusals fail clearly with the policy reason and never create a child
   Task.
5. **Move 6 — AgentRunManager retirement check — DONE (below).** No run
   bookkeeping re-materialized; two remnants consolidated.
6. **Move 7 — verification**: every path (mission/delegation/swarm/background/
   scheduled/skill creation/external research/retry/cancel/tool/memory/model/
   handoff) through the same contract; tsc + the full smoke battery.

## 6. Move 2 — Agent contract (done)

Extends the canonical `Agent` (`src/core/agent/agent-types.ts`) with the five
fields the §4 gap listed, without creating any new record:

- **`instructions?: string`** — explicit imperative operating rules, rendered
  into the child system prompt AFTER persona (so they win conflicts).
  Distinct from persona (identity/tone) and from learned skills.
- **`contextPolicy`** — `sources: AgentContextSource[]`
  (task | instructions | repo | memory | history | attempts) in assembly
  order + `maxContextChars` budget. Defaults to `['task', 'instructions']`;
  the repo/memory/history/attempts sources are consumed by the Move 3/4
  context builder.
- **`memoryPolicy`** — unified-memory retrieval/injection policy
  (`injectLimit` / `minScore` / `minImportance` / `types` / `sources`).
  Children default to `injectLimit: 0` (finding D5 — no memory injection
  today; Move 4 wires the Phase 14 catalog retrieval through it).
- **`executionLimits`** — `maxTurns` / `maxAttempts` / `maxOutputTokens` /
  `timeoutMs` / `maxContextChars`, complementing `permissions.maxToolCalls`.
  Consumed by `AgentEngine.executeTask` as fallback mission budgets.
- **`handoffPolicy`** — `allowDelegation` / `allowedRoles` / `maxDepth`.
  Declared now, enforced in Move 5; A2A (external) cards default to
  `allowDelegation: false`.

All four adapters (custom / profile / swarm / A2A) fill contract defaults, and
`AgentRegistry.register()` / `AgentEngine.registerAgent()` accept the full
`AgentInput`. **Task-as-run is documented in the contract header**: the run is
`Task + assignedAgent + registry status projection` — an AgentRun record
would re-introduce the duplicated run bookkeeping Audit 5 removed.

## 7. Move 6 — AgentRunManager retirement check (done)

Audit 5 deleted `agentRunManager` and its `agent_runs.json` store. Move 6
re-verifies nothing re-materialized and consolidates remnants:

- **No AgentRun record / store**: `AgentRun` exists only as the Task-as-run
  comment in agent-types.ts; no `agent_runs.json` writes anywhere; no
  `agentRunManager` reference in src/ or scripts/ (grep, zero hits). Run
  state lives in Task + toolExecutions + TaskEvents, with agent status a
  registry projection (`assignAgent`/`releaseAgent` mutate the in-memory
  registry only).
- **Consolidated: dead analytics API removed.** `AnalyticsTracker.recordAgentRun`
  had zero call sites (the runner's delegation path stopped calling it when
  agentRunManager was removed) and the `'agent_run'` AnalyticsEvent type was
  never emitted or consumed. Both removed from `analytics-tracker.ts` —
  agent-run telemetry now comes from TaskEvents via the hooks bridge, not a
  parallel analytics hook.
- **Consolidated: stale skill docs fixed.** project-manager's `agent_run` /
  `agent_run_all` descriptions still said they returned "AgentRunManager
  reports"; the implementation already queries canonical delegated child
  Tasks (`getAgentRunReports` → TaskEngine, Audit 5). The descriptions now
  name the canonical source.
- **Guard in place**: smoke:delegation still asserts `agent_runs.json` is
  never written.

## 8. Move 7 — end-to-end verification (done)

**Question:** can every autonomous work origin execute through the same Agent
contract from beginning to end — and which implementation actually executed
for each?

| Origin | Canonical Task | AgentProfile resolved | AgentEngine path | Model Policy | Tool Policy | Memory/Context | Evidence | Proving smoke |
|---|---|---|---|---|---|---|---|---|
| Mission | ✓ kind 'mission' | ✓ designated default (`resolveDefaultAgent`) | ✓ runMission iterate | ✓ modelPolicy pin under router | ✓ permissions shape the surface | ✓ unified-memory section (memoryPolicy filter) | ✓ Task + toolExecutions + decisions | smoke:runtime |
| Delegation | ✓ kind 'delegation' | ✓ registry agent | ✓ executeTask | ✓ modelPolicy + fallbacks | ✓ agent.tools ∩ allowed | ✓ child memory section (Move 4) | ✓ AgentResult artifact | smoke:delegation, smoke:agent-execution §1-4, §13 |
| Swarm | ✓ kind 'swarm' | ✓ store agent | ✓ executeTask | ✓ modelPolicy | ✓ agent.tools ∩ allowed | ✓ child memory section | ✓ canonicalTaskIds linkage | smoke:agent-execution §5, §12, §14 |
| Background | ✓ kind 'background' | ✓ selectForProfile | ✓ executeTask | ✓ modelPolicy | ✓ | ✓ | ✓ canonicalTaskId linkage | smoke:agent-execution §6 |
| Scheduled | ✓ kind 'scheduled' | ✓ selectForProfile | ✓ executeTask | ✓ modelPolicy | ✓ | ✓ | ✓ schedulerJobId linkage | smoke:agent-execution §7 |
| Skill creation | ✓ kind 'background' | ✓ ephemeral worker | ✓ engine workflow-as-execution | ✓ internal calls | ✓ internal skills | — | ✓ result evidence | smoke:learning (canonicalSkillCreation) |
| External research | ✓ kind 'background' | ✓ engine wrap | ✓ engine | ✓ | ✓ | — | ✓ title/summary evidence | smoke:learning (canonicalExternalResearch) |

**Gates:**

- **Gate 1 — no direct model execution for agent work**: the swarm
  non-delegate fragment (D1) is removed; the swarm executor block contains no
  `model.generate` and fails loudly when `delegate_agent` is unavailable.
  Remaining `model.generate` sites are non-agent-work by construction
  (mission loop iterate, summarization, dynamic-tool interpreter, proactive
  check-in, @-mention).
- **Gate 2 — one Agent contract**: every origin resolves an Agent with the
  full Move 2 surface (instructions, modelPolicy, permissions/ToolPolicy,
  memoryPolicy, contextPolicy, handoffPolicy, executionLimits).
- **Gate 3 — one Task identity**: Task-as-run; no AgentRun record anywhere.
- **Gate 4 — one failure authority**: TaskEngine owns diagnose/retry/resume;
  model-call retry stays below as documented (D6).
- **Gate 5 — one tool authority**: ToolEngine executes; agents only request
  per ToolPolicy (D4).
- **Gate 6 — memory reaches agents**: host missions AND AgentEngine children
  receive unified memory through the consolidation layer (D5 closed).
- **Gate 7 — no AgentRun remnants**: permanent, comment-aware source sweep
  (`scripts/smoke-phase16.ts`, `npm run smoke:phase16`) keeps
  `agentRunManager` / `recordAgentRun` / `agent_runs.json` writes /
  `AgentRun` at zero in src/ + scripts/, plus the Gate 1 block check and
  the Gate 2 field declaration check.

## 9. Acceptance gate (Moves 1-7)

Move 1 was documentation only. Move 2 verified by `tsc --noEmit` clean +
`smoke:agent-engine` section 7: contract defaults on wrapped agents
(contextPolicy.sources = task,instructions; memoryPolicy.injectLimit = 0;
empty executionLimits; delegation allowed), full-contract register() storage
(instructions / contextPolicy incl. budget / memoryPolicy incl. sources /
executionLimits / handoffPolicy.allowedRoles), and the two live wirings:
`executionLimits.maxTurns: 2` lands on the child Task's `constraints.maxTurns`
when the caller omits the budget, and the agent's `instructions` appear in the
child system prompt. Task-as-run asserted: one child Task per run, child
assigned to `reg:contractbot`.

Move 3a (D1 removal) verified by `tsc --noEmit` clean + `smoke:agent-execution`
section 12: the swarm executor's fail-loudly contract — a throwing executor
(what the runner now does when `delegate_agent` is unavailable) yields an
`AgentResult` with `success: false`, the loud `delegate_agent skill is
unavailable…` message on the task result, and the swarm agent released from
`working` — no silent bare `model.generate` anywhere in the swarm path. The
remaining `model.generate` sites in the runner are non-swarm by construction:
the canonical mission loop's iterate (kind-'mission' Task), session
summarization, the dynamic-tool name interpreter, the proactive check-in
(advisory WHEN-only), and the host-driven @-mention fallback. Full battery
green in one pass: runtime, baseline, delegation,
agent-execution, agent-engine, agent-task-profile, scheduler, memory-unified,
learning.

Move 3b (mission loop default profile) verified by `tsc --noEmit` clean +
`smoke:agent-engine` section 8 (designation-only semantics: no default before
designation, wrapped AVAILABLE agents never implicit, released designated
agent skipped, the designated agent returns with its contract) +
`smoke:runtime` e2e (a designated default registered before the mission → the
mission Task carries `assignedAgent`, its instructions render in the mission
system prompt, and its `modelPolicy.modelId` pin is honored while the router
still wins explicit overrides). Zero behavior change without a designation:
`resolveDefaultAgent()` returns undefined and the mission loop is
byte-identical. Full battery green in one pass.

Move 4 (policies) verified by `tsc --noEmit` clean +
`smoke:agent-execution` section 13 (a PolicyBot with
contextPolicy `['task','instructions','history','memory','attempts']` +
memoryPolicy `{injectLimit:3, minScore:0.5, types:['procedural'],
sources:['learning']}` + `executionLimits.maxAttempts:2`: child system prompt
carries `Memory context (unified):` with the canned record and its 87%
confidence, `executionLimits` produced two attempts, and the second attempt's
prompt carries `Previous attempts: - Attempt 1: …` from the failed first
attempt — through the runtime `retrieveMemory` hook, no new engine) +
`smoke:agent-engine` section 7a (default context sources now
task/instructions/history = today's structural child context) +
`smoke:runtime` e2e (the designated default's `permissions.deniedTools:
['web_search']` removed web_search from every advertised mission surface
while apply_patch + shell stayed — the mission still completed). Full battery
green in one pass.

Move 5 (handoffPolicy) verified by `tsc --noEmit` clean +
`smoke:agent-execution` section 14: a RootBot with
`handoffPolicy {allowDelegation: true, allowedRoles: ['analyst'], maxDepth: 1}`
under a mission Task assigned to it — a coder-role target refused ('may
only hand off to roles'), an analyst target allowed at depth 1, a second hop
under it refused ('maxDepth … depth 2'), and an agent with
`allowDelegation: false` refuses any delegation ('does not allow
delegation'). Refusals never create child Tasks and name the policy. Full
battery green in one pass.

Move 6 (retirement check) verified by grep sweeps (`agentRunManager` zero
hits; no `agent_runs.json` writes; no `AgentRun` record type — only the
Task-as-run doc comment), the dead-API removal (`recordAgentRun` + the
`'agent_run'` analytics type, both with zero producers/consumers) and the
stale-doc fix (project-manager `agent_run`/`agent_run_all` descriptions now
name the canonical TaskEngine reports). `tsc --noEmit` clean, full battery
green in one pass.

Move 7 (verification) adds the permanent gate: `npm run smoke:phase16`
(`scripts/smoke-phase16.ts`, comment-aware source sweeps over 191 TS files)
keeps Gate 1 (swarm executor block contains no `model.generate` + fail-loudly
marker), Gate 2 (all five contract fields declared), Gate 3 (no
`\bAgentRun\b`), and Gate 7 (`agentRunManager` / `recordAgentRun` /
`agent_runs.json` writes at zero in src/ + scripts/, comments excluded, guard
file excluded) green forever. The behavioral matrix above maps every origin to
the battery smoke that proves its contract cells. **Phase 16 is complete:**
one Agent contract (Move 2), one canonical execution (Move 3), policies
consumed by both paths (Move 4), handoff enforcement (Move 5), retirement
verified (Move 6), verification gated (Move 7).
