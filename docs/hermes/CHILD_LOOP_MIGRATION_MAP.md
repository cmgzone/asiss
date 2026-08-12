# Step 3 — `runChildLoop()` responsibility map (Phase 13)

> Pre-migration audit of the delegated-child execution path
> (`src/skills/delegate-agent.ts`). **No deletion until every
> responsibility has a new canonical owner.** The target is:
>
> ```
> Parent Task -> TaskEngine -> Child Task -> AgentEngine -> Agent
>              -> ModelEngine -> ToolEngine -> (VerificationEngine-later)
> ```
>
> `TaskEngine` owns the loop (what work happens); `AgentEngine` owns who
> performs it; `runChildLoop()` must NOT be replaced by an
> `AgentEngine.execute()` that secretly becomes runChildLoop v2.

---

## 0. The migration surface

| Surface | Location | Role |
| --- | --- | --- |
| `executeSingle` | delegate-agent.ts:84-182 | resolve agent, tool allowlist, run record, retry loop, result |
| `runChildLoop` | delegate-agent.ts:184-268 | the child model/tool turn loop |
| `executeAllowedTool` | delegate-agent.ts:270-334 | tool exec (bypasses ToolEngine/PolicyEngine) |
| `getAllowedToolSchemas` | delegate-agent.ts:404-433 | tool assignment (agent skills ∩ allowlist) |
| `buildChildSystemPrompt` / `buildInitialTaskPrompt` / `buildConversationPrompt` | :468-517 | context assembly |
| `formatSkillResult` / `recordProfilePerformance` | :519-537 | result + learning |

---

## 1. Responsibility-by-responsibility map

Each row: where the responsibility lives today, what it does, the
**canonical owner** it moves to, and what is needed at the target.

| # | Responsibility | Today (file:line) | Canonical owner | Needed at target |
| --- | --- | --- | --- | --- |
| 1 | **Task creation** | none — runs recorded in `agent_runs.json` via `agentRunManager.createRun` (:112); `kind: 'delegation'` never used | `TaskEngine.create()` with `kind: 'delegation'`, `parentId`, `constraints.allowedTools`, `context.sessionId/workspacePath` | wire child Task id into everything below; `Task.subtasks` linkage from parent |
| 2 | **Context** | prompts rebuilt from `AgentRunManager` messages (`buildConversationPrompt` :509) — own memory side-channel | `ContextEngine` (assembly/history) over the child Task + session memory, mirroring the mission iterate pattern (runner.ts:1974) | child context builder taking persona + tools + task + prior messages |
| 3 | **Model selection** | `selectModel` :463 — `getModelById(agent.modelId)` else default | `ModelEngine.select()` with a task-shaped profile + `Agent.modelPolicy` pin | modelPolicy already on canonical Agent (Step 2); child TaskProfile |
| 4 | **Model calls** | `model.generate(prompt, systemPrompt, tools)` :207 — direct, no fallback wrapper | host-driven model call inside a `TaskEngine.runMission` iterate hook (same shape as runner's mission loop) | iterate hook; resilient-model wrapper if desired |
| 5 | **Tool execution** | `executeAllowedTool` :270-334 — `SkillRegistry.get` / `callMcpTool` directly; **bypasses ToolEngine and PolicyEngine** | `ToolEngine.execute(name, args, ctx)` with `taskId` (records `ToolExecution` on the child Task) — tool-engine.ts:101 | pass `sessionId/taskId/workspacePath/agentPermissions` ctx |
| 6 | **Policy** | none — only the parent's `delegate_agent` call is checked (policy-rules.ts:253-257) | `PolicyEngine` via ToolEngine ctx; feed `Agent.permissions` into the **dead `agentPermissions` input** (tool-result.ts:27, policy-rules.ts:152-165) | populate `agentPermissions` from `Agent.tools`/`permissions` — this is the Phase 13 Step 6 wiring, done early because the plumbing exists |
| 7 | **Memory** | pseudo-session `${sessionId}:child:${taskId}` for checkpoints (:297); conversation in `AgentRunManager.messages` | child Task artifacts/records + MemoryEngine-later; keep pseudo-session for checkpoints | none new — pseudo-session pattern already canonical |
| 8 | **Retries** | manual attempt loop :129-171 (`maxAttempts = retries + 1`), run statuses queued/running/completed/failed | `TaskEngine.retry()` (task-engine.ts:967) + `recordFailure` (:1139); `timing.attempts` is engine-owned | drive `runMission` once per attempt OR let engine retry; reviewPrompt must survive retries |
| 9 | **Verification** | none — child returns a self-declared JSON report (`parseReportFromText` :247); review is the parent's job | `TaskEngine` verification records + `completionVerdict` hook; VerificationEngine-later | map `reviewCriteria`/`expectedOutput` into the verdict hook so the engine owns PASS/FAIL-of-report |
| 10 | **Streaming** | none — child uses `generate` (non-streaming) | keep non-streaming (children are background work) | none |
| 11 | **Cancellation** | none — a stuck child runs to maxTurns then throws (:267) | `TaskEngine.cancel()` — child Tasks become cancellable | engine surface already exists; parent/UI can cancel by task id |
| 12 | **Result formatting** | `parseReportFromText` + `AgentTaskReport` JSON schema (delegate-agent.ts:468-497) | canonical `AgentResult` (agent-result.ts, Step 2) mapped to/from the legacy report | report parse stays, but output through `agentResultFromTaskReport` |
| 13 | **Parent/child communication** | `formatSkillResult` :519 returns report + `reviewPrompt` from `agentRunManager.buildReviewPrompt` | child Task outcome + artifacts read by the parent iterate/skill; reviewPrompt built from Task records | parent reads `task.outcome.result` (AgentResult) instead of `agent_runs.json` |
| 14 | **Parallel batch** | `Promise.all` over `tasks[]` :65-79, per-child max 8 | keep `Promise.all` (host-level fan-out, NOT a loop authority) — each child is an independent child Task | none — this is orchestration, allowed at host level |
| 15 | **Tool allowlist** | `getAllowedToolSchemas` :404-433 — skills ∩ request allowlist | `Agent.tools` + `TaskConstraints.allowedTools` (enforced by ToolEngine/PolicyEngine) | adapter `getAllowedToolSchemas` → `Agent.tools` |
| 16 | **Performance/learning** | `recordProfilePerformance` :531-537 (profiles only) | keep as-is post-completion (it consumes AgentResult status) | call after engine turn, from `task.outcome.status` |

---

## 2. What runChildLoop does NOT do (gaps the migration FIXES)

- **No policy enforcement** on child tools — PolicyEngine only checked the
  parent call. Migration fixes via ToolEngine ctx `agentPermissions`.
- **No canonical Task record** — `kind: 'delegation'` exists unused; work
  invisible to TaskEngine/events/UI.
- **No cancellation** — stuck children burn maxTurns.
- **No verification records** — self-declared reports only.
- **No resilience wrapper** on the model call.

---

## 3. The forbidden shape (runChildLoop v2)

`AgentEngine.executeTask` must be a **thin orchestration adapter**, NOT a
new loop. It owns:

- ✅ child Task creation via `taskEngine.create`
- ✅ agent selection (Step 2) + policy/tool injection
- ✅ calling `taskEngine.runMission(childTaskId, { iterate, budget, completionVerdict })`
- ✅ mapping `TaskMissionIteration` ↔ child turn (context → model → tools)
- ✅ result via `task.outcome` → `AgentResult` → legacy report adapter

It must NOT own:

- ❌ its own for-loop over turns (engine owns via runMission)
- ❌ its own retry bookkeeping (engine owns `attempts`/`recordFailure`/`retry`)
- ❌ its own tool dispatch (ToolEngine)
- ❌ its own policy decisions (PolicyEngine)
- ❌ its own task state machine (TaskEngine)

## 4. The big test (acceptance gate)

> **Can a delegated agent complete a real child task without
> `runChildLoop()` being involved?**

Concretely: `scripts/smoke-agent-engine.ts` (or a new delegation smoke)
drives `AgentEngine.executeTask` through a stub model + real ToolEngine
against a hermetic workspace, and asserts: child Task COMPLETED,
`timing.turns > 0`, ToolExecution records exist, PolicyEngine ran
(agentPermissions enforced), result is a canonical AgentResult, parent
subtask link set — with `runChildLoop` never invoked (guard/probe).

Until that smoke is green, `runChildLoop` stays in place (dual-path,
Phase 12 discipline).
