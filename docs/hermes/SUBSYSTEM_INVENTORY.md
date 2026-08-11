# Subsystem Inventory & Public APIs (Phase 0)

> Inventory of every subsystem under `src/`, its entry points, and who depends
> on it. Recorded at baseline commit `6bb7672` so the evolution can wrap each
> subsystem behind an engine (Phase 3+) without losing consumers.

## Application entry points

| Entry point | File | Purpose |
| --- | --- | --- |
| `main()` | `src/index.ts` | Loads config, registers channels, starts `Gateway` |
| `Gateway` | `src/gateway/server.ts` | Web/A2A HTTP server; owns the `IGateway` contract the runner consumes |
| CLI | `src/cli/` | wizard and related commands |
| `bin/gitu.js` | `bin/gitu.js` | npm bin shim -> dist |

## src/core (all singletons exported as `xxxManager`/`xxxEngine` unless noted)

| Module | Key exports | Entry points | Notes |
| --- | --- | --- | --- |
| `runner.ts` (src/agents) | `AgentRunner` | `constructor(gateway)`, `processMessage`, `getModel`, `getModelById` | The agent loop; owns everything below at runtime |
| `skills.ts` | `SkillRegistry`, `Skill` | `register/get/getAll/skillsForCapability/execute` | Skill abstraction; ~40 native skills + marketplace + learned |
| `models.ts` | `ModelRegistry`, `ModelProvider`, `ModelAttachment` | `register/get/setCurrentModel` | Provider registry; mock/openrouter/nvidia/opencode/generic-openai |
| `model-manager.ts` | `modelManager`, `resolveModelApiKey`, `isProviderKeyValid` | `listModels/addModel/...` | Persistent custom model config (`models.json`) |
| `model-router.ts` | `modelRouter` | `route/...` | Simple task-complexity -> model selection |
| `model-level.ts` | model capability levels | - | Capability scoring (latest feature, baseline commit) |
| `resilient-model.ts` | `ResilientModelProvider` | - | Fallback chains across providers |
| `retry-handler.ts` | `withModelRetry` | - | Retry helper for model calls |
| `memory.ts` | `MemoryManager`, `Memory` | `add/getAll/...` | Session memory + `memory.sqlite` persistence |
| `learning-manager.ts` | `LearningManager` | `recordActivity/getPromptLessons/getLearnedSkillsPrompt/...` | Lessons + learned skills + approval flow (`LEARNING.md`) |
| `learned-skills.ts` | `learnedSkillsManager` | `registerExecutableSkills/...` | Executable learned skills |
| `mcp.ts` | `McpManager` | `connect/listTools/callTool/getKnownToolNames` | MCP server + tool bridging |
| `dynamic-tools.ts` | `DynamicToolManager` | `resolve/normalizeName/rehydrate` | Creates tools on the fly for unknown calls |
| `scheduler.ts` | `SchedulerManager` | `start/schedule/...` | Cron-like scheduled prompts (`scheduler.json`) |
| `background-worker.ts` | `backgroundWorker` | goals/projects/milestones CRUD + `runPendingGoals` | Autonomous goal queue (`background_goals.json`, `projects_data.json`) |
| `main-goal.ts` | `mainGoalManager` | `observeUserMessage/getPrompt/...` | Persistent main goal (`main_goals.json`) |
| `task-context.ts` | `taskContext` | `setTask/addContext/updateTask/completeTask/getSummaryPrompt` | Simple current-task resume (`current_task.json`) |
| `agent-swarm.ts` | `agentSwarm` | `setExecutor/spawn/...` | Multi-agent collaboration (`swarm_data.json`) |
| `agent-run-manager.ts` | `agentRunManager` | `startRun/.../buildReviewPrompt` | Delegation runs + review reports (`agent_runs.json`) |
| `agent-profiles.ts` | `agentProfileManager` | CRUD profiles | Named agent profiles |
| `custom-agents.ts` | `customAgentManager` | CRUD + dispatch | User-defined custom agents (`CUSTOM_AGENTS.md`) |
| `checkpoint-manager.ts` | `checkpointManager` | `create/list/rollback/shouldCheckpointShell` | Git-backed workspace snapshots |
| `hooks.ts` | `hookManager` | `on/emit` | Internal event hooks (`before_tool`, `after_tool`, `tool_error`, `model_fallback`, `checkpoint_created`, `agent_complete`, `mcp_status`) + JSONL audit |
| `guardrails.ts` | `guardrailManager` | `validateInput/...` | Input/output policy |
| `execution-state.ts` | `executionStateManager` | `beginMission/prepareAssistantResponse/...` | Anti-repetition + durable run state |
| `analytics-tracker.ts` | `analyticsTracker` | `recordMessage/recordToolCallResult/getToolUsageStats` | Per-session analytics (`analytics_data.json`) |
| `cost-tracker.ts` | `costTracker` | `record/...` | Token cost accounting (`cost_data.json`) |
| `chain-of-thought.ts` | `chainOfThought` | reasoning capture | CoT persistence |
| `thinking.ts` | `thinkingManager` | - | Thinking-block parsing |
| `scratchpad.ts` | `scratchpad` | - | Working notes |
| `plan-mode.ts` | `planModeManager` | - | Plan-then-execute mode |
| `proactive-engine.ts` | `proactiveEngine` | - | Idle-time proactive actions |
| `conversation-manager.ts` | `ConversationManager` | - | Conversation state for web UI |
| `execution-backend.ts` / `execution-state.ts` | backend abstraction | - | Durable execution backends |
| `prompt-cache.ts` | `PromptCache` | - | Prompt caching |
| `portable-skills.ts` | `portableSkillsManager` | - | Portable skill bundles |
| `skill-marketplace.ts` | `SkillMarketplaceManager` | - | Marketplace install/load |
| `workspace-manager.ts` | `workspaceManager` | `assertAllowed` | Workspace path policy |
| `trusted-actions.ts` | `trustedActions` | - | User-approved action allowlist |
| `elevated.ts` | elevated helpers | - | Escalation helpers |
| `trajectory-store.ts` | trajectory store | - | Execution trajectory persistence |
| `a2a-protocol.ts` | A2A protocol types | - | Agent-to-agent protocol |
| `dnd.ts` | `dndManager` | `flushQueue` | Do-not-disturb queue |
| `attachment-store.ts`, `stt.ts`, `tts.ts`, `whatsapp-events.ts`, `stream-markers.ts`, `auth.ts`, `models.ts` | misc | - | Media/voice/streaming/UI support |

## src/skills (native skill implementations)

`system`, `notes`, `shell`, `web` (search/fetch), `scheduler`, `playwright`,
`brave`, `patch` (apply_patch), `checkpoints`, `business`, `project-manager`,
`agents-md`, `task-memory`, `background` (goals + dnd), `main-goal`,
`custom-agents`, `models`, `serper`, `memory`, `code-search`, `git`,
`code-review`, `plan-mode`, `deep-research`, `send-telegram`, `send-email`,
`webhook`, `agent-profiles`, `delegate-agent`, `execute-workflow`, `mcp-admin`,
`portable-skills`, `hooks`, `marketplace`, `trusted-actions`, `a2a`,
`learned-skills`, `filesystem` (read/write/list/glob), `tools-diag`.

## src/channels

| Channel | File | Notes |
| --- | --- | --- |
| Console | `src/channels/console.ts` | CLI chat |
| Web | `src/channels/web/server.ts` | Port 3000 + socket.io |
| A2A | `src/channels/a2a/server.ts` | Agent-to-agent HTTP |
| Telegram / Discord / Slack / WhatsApp | `src/channels/*` | Bot adapters |

## Overlapping "task-like" concepts (Phase 1 consolidation targets)

| Concept | Module | Status set |
| --- | --- | --- |
| Missions | `execution-state.ts` | per-message execution markers |
| Background goals | `background-worker.ts` | pending/in-progress/completed/failed/paused/cancelled |
| Projects / milestones | `background-worker.ts` | active/completed/paused/cancelled/blocked |
| Agent runs / delegations | `agent-run-manager.ts` | queued/running/completed/failed |
| Swarm agent tasks | `agent-swarm.ts` | `AgentTask` |
| Workflow steps | `skills/execute-workflow.ts` | scripted step execution |
| Current task (resume) | `task-context.ts` | in-progress/paused/completed |
| Main goal | `main-goal.ts` | persistent top-level goal |

These are the concepts the canonical `Task` (Phase 1, `src/core/task/`) will
unify behind a single lifecycle while the originals keep working.
