# Audit: the agent architecture before AgentEngine (Phase 13 Step 1)

> Phase 13 makes agents first-class workers on top of the TaskEngine we
> finished in Phase 12. Foundational rule: **TaskEngine owns what work
> happens; AgentEngine owns who performs it** — Phase 13 must not create a
> second execution authority. This audit answers the Step 1 question:
>
> > **Where does Hermes currently decide what an agent is, what it can do,
> > and how it executes?**
>
> and then identifies the duplicated responsibilities AgentEngine must
> absorb (or deliberately leave alone). Pure reading exercise — no code
> changes, mirroring `AUDIT_2.md`'s "audit first, code second" rule.

---

## 1. What an agent IS today: five concepts, no registry

There is **no central agent registry** (`registerAgent`/`AgentRegistry`
match nothing). "Agent" is five overlapping concepts:

| Concept | Definition | Store | Identity fields |
| --- | --- | --- | --- |
| `SwarmAgent` | runtime task-executor | `swarm_data.json` (`src/core/agent-swarm.ts:5-18`, `:70`) | id, name, role (free string), specialization, status, parentId?, modelId?, profileId?, assignedTasks[] |
| `CustomAgentConfig` | persona-based chat agent | `custom_agents.json` + `agents/*.md` (`src/core/custom-agents.ts:12-27`, `:137`, `:157-233`) | id, name, displayName, description, persona, skills[], temperature?, model?, profileId?, triggers[], enabled |
| `AgentProfile` | learning/performance wrapper | `agent_profiles.json` (`src/core/agent-profiles.ts:26-37`, `:48`) | id, name, modelId?, allowedSkills?, learnedPreferences, performance |
| `ResolvedAgent` | runtime merged view (only unification point) | ephemeral (`src/skills/delegate-agent.ts:16-24`, `:336-358`) | id, name, kind ('custom_agent'\|'agent_profile'\|'swarm_agent'), persona, modelId?, profile?, allowedSkillNames[] |
| `A2AAgentCard` | external/remote agent | config + remote discovery (`src/core/a2a-protocol.ts:123-141`) | name, description, url, version, capabilities?, skills?, security |

Three independent singletons with three JSON files, each with its own
CRUD (`agentSwarm`, `customAgentManager`, `agentProfileManager`); identity
is unified **only** inside `DelegateAgentSkill.resolveAgent`
(delegate-agent.ts:336-358), which checks custom → profile → swarm by id,
then name, then falls back to an ephemeral `'auto'` specialist.

### 1.1 Consequences of the split

- Identity is cross-referenced by loose string: `profileId` matches id
  **or name** (`src/core/agent-profiles.ts:88-91`); no foreign keys.
- Two stores can hold the same name; priority by lookup order, not by
  definition (`delegate-agent.ts:337-344`) — the swarm collaborator
  resolves by name independently (`agent-swarm.ts:381`).
- Persona is defined in three places and synthesized differently:
  custom `persona` verbatim vs profile description+capability summary
  (`delegate-agent.ts:379-384`) vs swarm role+specialization prompt text
  (`agent-swarm.ts:228`, `:397`).
- Performance/learning attaches **only** to `AgentProfile`; custom and
  swarm agents without a `profileId` silently skip it
  (`delegate-agent.ts:531-537`).

## 2. What an agent CAN DO today: decided at execution time

"Capabilities" is not a first-class concept anywhere. What an agent can do
is computed per delegation in `DelegateAgentSkill.getAllowedToolSchemas`
(`delegate-agent.ts:404-433`):

```
agent.skills (custom) / profile.allowedSkills + preferredTools (profile)
        ∩  request-level allowedTools allowlist
        →  filtered against the GLOBAL SkillRegistry + MCP tools
```

- Swarm agents get **zero tools unless they carry a profileId** — `role`
  and `specialization` are never enforced; they exist only as prompt text.
- Model choice is a 3-way fallback: `custom.model` → `profile.modelId` →
  default (`delegate-agent.ts:367`, `:463-466`; `runner.ts:317-318`).
- The main mission loop **ignores all of this**: it advertises the global
  registry (with caps only — `runner.ts:925-989`) and selects a model
  from a *task-shaped* profile, never an agent-shaped one (see §5).

## 3. HOW an agent executes today: three worlds, one authority

### 3.1 Main agent (missions)
`AgentRunner.processMessage` turn loop (`src/agents/runner.ts:1622`+) with
the Phase 12 contract: a canonical Task is created (`beginMissionTask`,
runner.ts:1583-1614) and executed via `taskEngine.runMission(taskId,
{ iterate })` (runner.ts:1880). TaskEngine owns the lifecycle; the runner
owns model call, streaming, guardrails, tool budget, context, memory.

### 3.2 Delegated children (subagents)
A **bespoke self-contained loop inside the `delegate_agent` skill** —
`DelegateAgentSkill.executeSingle` / `runChildLoop`
(`src/skills/delegate-agent.ts:84-268`):

- Calls `params.model.generate(...)` directly (`:207`) — bypassing the
  runner's streaming, guardrails, verification, and memory pipeline.
- Keeps its own conversation record in `AgentRunManager`, not shared
  memory (`:202-241`, `:509-517`).
- Executes tools via `executeAllowedTool` (`:270-334`) → `skill.execute`
  or `deps.callMcpTool` directly — **bypassing ToolEngine and PolicyEngine**
  entirely (only the parent's `delegate_agent` call is policy-checked,
  `src/core/policy/policy-rules.ts:253-257`).
- Terminates when the model returns JSON without tool calls; else a
  `maxTurns` cap throws (`:267`).
- Never creates a canonical Task: `kind: 'delegation'` exists in the enum
  (`src/core/task/task-types.ts:43`, referenced at `model-engine.ts:106`)
  but nothing ever creates one. Delegation has its own lifecycle in
  `agent-run-manager.ts` (queued/running/completed/failed, retries,
  attempts, its own JSON report format).

### 3.3 Background agents & swarm
- Background goals **do** run through the real AgentRunner/TaskEngine loop:
  `backgroundWorker.setExecutor` builds a `Message` (channel 'background')
  and calls `processMessage` (runner.ts:1338-1403) — but background's own
  goal lifecycle (statuses, milestones, retries, successScore) lives in
  `src/core/background-worker.ts` (`kind: 'background'` unused).
- Swarm owns an `AgentTask` queue, messages, and collaboration records
  (`src/core/agent-swarm.ts:31-57`, `:205-291`, `:360-443`) — its own
  task lifecycle, re-entering through the delegate skill via the executor
  hook (runner.ts:312-333).
- A2A is external interop: `A2AClientSkill` (`src/skills/a2a.ts`) + an
  Express JSON-RPC server (`src/channels/a2a/server.ts`) whose incoming
  messages join the main handler; its task records are in-memory only.

**Duplication in one line:** three parallel status machines (agent run,
background goal, swarm agent-task) plus the canonical Task, three separate
report/evidence formats, three separate "agent communication" concepts
(`AgentMessage`, A2A, TaskEventBus) with no shared bridge.

## 4. Cross-cutting chains

### 4.1 Model assignment
Per-turn selection is **task-shaped, not agent-shaped**: `ModelEngine.select`
scores providers on a `ModelTaskProfile` built from goal text + task
kind/priority + tool needs (`src/core/model/model-engine.ts:87-166`,
`scoreAll` :200-248), possibly pinned by `model-router` rules
(`src/core/model-router.ts:139-186`). **No `modelPolicy` concept exists**
(repo-wide: 0 matches). The only per-agent model input lives in the
delegate path (agent.model / profile.modelId). The main loop never reads
a per-agent model — decisive point for Phase 13: selection must accept an
agent dimension without re-introducing naive routing.

### 4.2 Tool assignment
Tools are advertised from the global `SkillRegistry` + MCP with
**per-session caps only** (maxNativeTools 60 / maxMcpToolsPerServer 40,
`runner.ts:148-154`, `:925-989`); per-turn filtering is mission-level
(disabled sets, budget), never agent-level. Per-agent filtering exists
only through delegation's `getAllowedToolSchemas`. The
normalize→validate→authorize→execute→record chain is ToolEngine's single
canonical lifecycle (`src/core/tools/tool-engine.ts`), but delegated
children bypass it.

### 4.3 Permissions
The PolicyEngine is **user/session-agnostic**: config allow/deny lists,
workspace guard, tool modes, destructive/secret/network/write rules
(`src/core/policy/policy-rules.ts:266-275`). There IS an agent-permissions
rule (`policy-rules.ts:152-165`) with `agentPermissions` plumbed through
`ToolContext` (`src/core/tools/tool-result.ts:27`) — but **nothing ever
populates it**; zero producers repo-wide. Delegated child tools bypass
PolicyEngine anyway. So "agent permissions" is declared, wired, and dead.

### 4.4 Memory scoping
No `memoryScope`/task-memory agent dimension (0 matches). `MemoryManager`
is keyed by `sessionId` only (`src/core/memory.ts:203-287`; sqlite
`messages.session_id`). Agent-specific state exists as side channels:
custom-agent conversations keyed `sessionId+agentId` (`custom-agents.ts:29-35`,
`:420-459`, used only by the `@Agent` chat path), delegated children as
`${sessionId}:child:${taskId}` pseudo-sessions, background as
`${sessionId}:background:${goal.id}` (runner.ts:1348). Learned-skill
advertisement is per-session (`runner.ts:934-937`).

### 4.5 Results
Delegated children DO return evidence: `AgentTaskReport` (agent-run-manager.ts:25-43)
carries `evidence[]`, `workDone[]`, `filesChanged[]`, `toolCalls[]`,
`risks[]`, `nextSteps[]`, `finalOutput` — and the parent review prompt
explicitly says "Treat them as evidence to verify, not as unquestioned
truth" (`agent-run-manager.ts:362-380`). Gaps vs the Phase 13 target:
**no confidence score** (delegations never produce one, though
`TaskOutcome.confidence` exists at task-types.ts:210), no artifact-store
linkage (`filesChanged` + `finalOutput` strings only), and reports are
JSON-or-text parsed from model output (`parseReportFromText`, :344-360).

## 5. Duplicated responsibilities — mapping to engines

| Responsibility | TaskEngine (owns) | AgentRunner (owns today) | Delegation/Swarm/Background (duplicate) |
| --- | --- | --- | --- |
| Work lifecycle | canonical Task lifecycle, runMission/runTurn, verdicts | task creation + iterate callback | agent-run status machine, background goal lifecycle, swarm AgentTask queue |
| Recording | progress/tools/checkpoints/artifacts/decisions/cost/model | tool executes recorded via ToolEngine | `AgentRun` JSON report format (#2) |
| Evidence/verification | `verify`/`diagnose`, verification-pending | completion heuristic, verify-then-retry | review prompt synthesis, no verification step |
| Execution loop | iterate contract (Phase 12) | full loop body | `runChildLoop` (bespoke, bypasses engines) |
| Turn/multi-turn | `TaskTurnStarted/Completed`, `timing.turns` | — | child turns untracked |

Net: **the engine is the mission-lifecycle authority, the runner is the
mission executor, and delegation/background/swarm/A2A are parallel
subsystems with duplicated lifecycle, report, and communication concepts.**
Delegated children are the biggest offender: they are a second execution
loop that bypasses ToolEngine, PolicyEngine, memory, guardrails, and the
canonical Task — exactly the "second execution authority" Phase 13 forbids.

## 6. Verdicts for the design

1. **One canonical `Agent`** replacing the four def concepts (or a unified
   registry over the existing stores + `ResolvedAgent` as the canonical
   runtime shape). Capabilities and tools are first-class fields; role is
   an enum or map, not free text.
2. **AgentEngine = selection + assignment + lifecycle of who works**, with
   `registerAgent/getAgent/selectAgent/assignTask/executeTask/releaseAgent`
   — but execution delegates to TaskEngine, never a second loop. Kill
   `runChildLoop`'s bespoke loop; route child tasks through canonical
   Tasks (`kind: 'delegation'`) with agent policy injected via
   runner-like iterate handlers.
3. **Selection is capability matching + task profile**, optionally
   performance-ranked later; `AgentProfile.performance` and
   `learnedPreferences` are the seed data.
4. **Permissions become agent-aware** by feeding `agentPermissions` into
   the existing dead rule (`policy-rules.ts:152-165`) — PolicyEngine stays
   the single ALLOW/ASK/DENY authority, now populated per agent.
5. **ModelPolicy added as an agent-width** on top of ModelEngine's
   task-shaped scoring — pin per agent, keep scoring.
6. **Results standardize on a canonical `AgentResult`** (status, findings,
   evidence, artifacts, recommendations, confidence, unresolvedQuestions)
   mapped to/from `AgentTaskReport`, registered as task artifacts.
7. **Memory stays engine-owned** (`MemoryEngine`-later); AgentEngine adds
   an agent scope, not a new store. `TaskMemory` remains per-task.
8. **Swarm rebuilds on AgentEngine** (assigned child Tasks, selected
   workers) without spawning a second lifecycle.

## 7. Open questions for Step 2

- Do custom agents / profiles / swarm agents stay as-is behind the
  registry, or migrate to one schema (migration cost vs pragmatic wrap)?
- Where does `AgentEngine.executeTask` live: adapter over
  `taskEngine.runMission` with an agent-flavored iterate, for a
  delegation-sized Task?
- Does agent selection consult `performance` now, or is capability-only
  matching the first cut (ROADMAP-friendlier)?
- A2A: adopt `A2AAgentCard.capabilities/skills` as the external face of
  the canonical Agent, or keep A2A separate?