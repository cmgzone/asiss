# AgentRunner — Execution Flow (Phase 0 documentation)

> Target: `src/agents/runner.ts` (~3,900 lines). This document records the
> current execution flow so future phases can move responsibilities out of
> `AgentRunner` (into `TaskEngine`, `ToolEngine`, etc.) without losing behavior.

## Role

`AgentRunner` is the single agent loop. It owns: model selection, memory,
prompt/context construction, tool discovery + execution (native skills, MCP,
dynamic tools), fallback/recovery, repetition guards, checkpoints, analytics,
learning hooks, and final response delivery. It also wires up every subsystem
in its constructor (skill registry, model registry, MCP, scheduler, swarm,
background worker).

## Entry points

| Entry | Signature | Purpose |
| --- | --- | --- |
| `constructor(gateway: IGateway)` | sync | Bootstraps all subsystems (see below) |
| `processMessage(sessionId, msg)` | async | Main handler for every inbound message (chat, background, scheduler, delegation) |
| `getModel()` / `getModelById(id)` | async | Model resolution (registry → config → fallback → mock) |
| `registerCredentialPoolProviders(config)` | sync | Registers resilient model pools from env key lists |

The `IGateway` interface (defined in-file to avoid circular imports) is how the
runner talks to channels: `sendResponse`, `sendStreamChunk`, `sendStreamEvent`,
`sendMedia`, `listSessionIds`, `supportsStructuredStreaming`.

## Constructor wiring (subsystem bootstrap)

1. Creates `MemoryManager`, `LearningManager` (model + memory + notify),
   `SkillMarketplaceManager`, `McpManager`, `DynamicToolManager`,
   `SchedulerManager` (whose callback calls `processMessage`).
2. Registers ~40 native skills into `SkillRegistry` (system, files, shell, web,
   scheduler, checkpoints, business, project-manager, delegation, workflows,
   MCP admin, portable skills, hooks, marketplace, trusted actions, A2A,
   learned skills, ...).
3. Loads marketplace-installed skills and executable learned skills.
4. Rehydrates dynamic tools; registers custom models from `model-manager`.
5. Wires the agent-swarm executor onto `delegate_agent` / direct model calls.
6. Loads `config.json`, registers configured provider (openrouter/nvidia/
   opencode) + credential-pool providers.
7. Connects MCP servers (parallel, non-blocking, per-server error surfacing).
8. Loads `SOUL.md` (or `src/soul.md`) as `baseSystemPrompt`; starts scheduler.

## `processMessage` flow (line refs approx. at baseline commit)

1. **Pre-handling** (~1512-1560): background/goal activity tracking, DND
   notification flush, and command handlers (`handleMainGoalCommand`,
   `handleScheduleCommand`, `handleBackgroundGoalCommand`,
   `handleCustomAgentCommand`, `handleModelCommand`, `handleLearningCommand`,
   `handleDeepResearchCommand`).
2. **Guardrails** (~1561): `guardrailManager.validateInput` - blocks disallowed
   input.
3. **Casual conversation** (~1565): `tryHandleCasualConversation` short-circuits
   when no tools are needed.
4. **Memory + mission state** (~1570-1595): user message added to memory with a
   `__missionMarker` (uuid); `analyticsTracker.recordMessage`;
   `executionStateManager.beginMission` (anti-repetition).
5. **Tool inventory** (~1596-1610): `mcpManager.listTools()` +
   `buildAdvertisedTools` - capped (native <= 60 by default, MCP <= 40/server),
   deduplicated, native skills win name conflicts.
6. **Turn budget config** (~1611-1680): maxTurns, autoContinue, repetition
   guard, maxToolCalls, mission tool budget, `verificationRequired` heuristic.
7. **Auto-compact** (~1685): `autoCompactSessionIfNeeded` summarizes old
   history into a system `compaction` memory.
8. **Multi-turn loop** (`for(;;)` x `maxTurns`):
   - **Context construction**: compaction filter -> mission memories (capped at
     24 + summary) -> relevant prior memories (token-overlap scoring, limit 4)
     -> current history text -> workspace context (`buildWorkspacePrompt`:
     AGENTS.md/USER.md/MEMORY.md/LEARNING.md/daily memory, main goal, learned
     lessons/skills, portable skills, project summary, strategy scores,
     delegation reports, task-context resume).
   - **Model call** -> response with optional `toolCalls`.
   - **Completion detection** (~1901-2040): premature-completion heuristics
     (`looksLikeProgressOnly`, tool budget, repetition guard) force further
     turns; hard-blocked turns deliver a final response with `ok: false`.
   - **Tool execution** (~2076-2318): `executeToolCall` per call -
     native skill (with automatic checkpoint before destructive
     shell/patches, project workspace guard,
     `__sessionId`/`__projectId`/`__workspacePath` injection) -> semantic-error
     fallback to capability-alternative skills -> MCP `callTool` -> unknown-tool
     dynamic resolution (`dynamicTools.resolve`) -> closest-name suggestion +
     analytics. The tool lifecycle itself is bus-only (Phase 12 D3):
     ToolEngine records through TaskEngine, whose ToolStarted/Completed/Failed
     events reach hookManager via the task-hooks bridge (canonical names +
     `before_tool`/`after_tool`/`tool_error` legacy aliases). The runner emits
     nothing for tools. Parallel only for independent delegate calls;
     otherwise in model-declared order. Tracks mutation/verification
     sequences and tool budgets.
   - **Result processing**: results appended to memory; failure recovery
     counters; `verificationRequired && lastMutation > lastVerification` forces
     a verification turn.
9. **Finalization** (~2600-2700): `executionStateManager.prepareAssistantResponse`
   then `deliverFinalResponse` (structured streaming events
   `assistant_start`/`assistant_delta`/`assistant_done`, or plain
   `sendResponse`).

## Public APIs other files depend on

- `AgentRunner` class: `processMessage(sessionId, msg)`, `getModel()`,
  `getModelById(id)`.
- The `IGateway` contract is implemented by `Gateway`
  (`src/gateway/server.ts`) and consumed by the runner.
- Subsystems the runner depends on (all in `src/core/`): `SkillRegistry`,
  `ModelRegistry`, `MemoryManager`, `McpManager`, `SchedulerManager`,
  `DynamicToolManager`, `LearningManager`, `agentSwarm`, `backgroundWorker`,
  `checkpointManager`, `hookManager`, `analyticsTracker`, `costTracker`,
  `guardrailManager`, `executionStateManager`, `taskContext`, `dndManager`,
  `mainGoalManager`, `modelManager`, `planModeManager`, `agentProfileManager`,
  `agentRunManager`, `portableSkillsManager`, `learnedSkillsManager`,
  `marketplace`, `chainOfThought`, `proactiveEngine`, `modelRouter`.

## What Phase 1 must preserve

- `processMessage` is the only real agent-loop entry; the canonical Task system
  is added as a **new, un-coupled module** (`src/core/task/`) - no changes to
  `runner.ts`. Subsequent phases wrap each responsibility above (tool dispatch,
  context building, model routing) behind engines and only then rewire
  `AgentRunner` to use them.
