# Hermes Architecture Audit 5 — `agentRunManager` dependency audit

> Pre-removal audit of the legacy delegation bookkeeping
> (`src/core/agent-run-manager.ts`, `agent_runs.json`). **Documentation
> first; the file is not touched until this audit concludes.** After Phase 13
> every work origin executes as a canonical Task through `AgentEngine` →
> `TaskEngine`, so the question is: does `agentRunManager` still own anything
> the canonical stack does not?

## 1. Dependency inventory

### Producers (write `agent_runs.json`)

| Site | Calls |
| --- | --- |
| `src/skills/delegate-agent.ts` | `createRun` (executeSingle), `startAttempt`, `completeRun`, `recordToolCall` + `appendMessage` (via `bookChildEvidence`) |

Only `delegate_agent` writes. The swarm/background/scheduled paths funnel
through `delegate_agent`, so they write too — but no other subsystem touches
the manager directly.

### Consumers (read)

| Site | Reads | Purpose |
| --- | --- | --- |
| `src/agents/runner.ts:1069` | `buildReviewPrompt(sessionId)` | injects an "Agent Delegation Reports" block into the workspace context so the main agent reviews child reports |
| `src/skills/delegate-agent.ts:140,291` | `buildReviewPrompt(sessionId)` | `reviewPrompt` field returned to the calling agent (batch + single paths) |
| `src/skills/project-manager.ts:209` | `listReports({ agentId, limit })` | `agent_run` / `agent_run_all` / `agent_status` return structured reports to the model |
| `src/core/agent/agent-result.ts` | `type AgentTaskReport` (import) | adapter source/target between canonical `AgentResult` and the legacy report shape |

### Tests

`scripts/smoke-agent-delegation.ts` asserts `agent_runs.json` is written,
`getRun(result.taskId)` resolves, and `buildReviewPrompt` includes the child
output.

### Not used

`task-memory` (the Step 3 sub-step 3 comment claims task_memory rendering —
it actually reads TaskEngine), the web channel, background worker, scheduler,
swarm store.

## 2. Classification — each responsibility vs the canonical stack

| # | Responsibility | Canonical equivalent | Verdict |
| --- | --- | --- | --- |
| 1 | Run bookkeeping (create/attempt/complete/fail) | child Task: `assignedAgent`, `outcome.result` (canonical AgentResult), `status`/`outcome`, `timing` | **fully covered** |
| 2 | Tool call records (`recordToolCall`, `appendMessage`) | `Task.toolExecutions` (STARTED/COMPLETED/FAILED with output/error) + task-hooks bridge forwards them to hookManager | **fully covered** |
| 3 | Review prompt (`buildReviewPrompt`) | render the same block from terminal child Tasks (session, assignedAgent, `outcome.result`) | **missing — small renderer to build** |
| 4 | project-manager reports (`listReports({ agentId })`) | TaskEngine query by `assignedAgent` (canonical id), return AgentResults | **missing — small query to build** |
| 5 | Report type + adapters | `AgentTaskReport` / `AgentToolCallRecord` types + the two adapters move into `agent-result.ts` (they already live next to `AgentResult` there) | **refactor** |

## 3. Verdict

**`agentRunManager` is purely compatibility bookkeeping.** Every
responsibility maps 1:1 onto canonical Task/TaskEvent functionality; nothing
it owns is genuinely missing from the canonical stack. Two small consumers
(review-prompt rendering, project-manager reports) need a canonical-backed
replacement before deletion — neither is new authority.

## 4. Minimal removal plan

1. **Types + adapters** — move `AgentTaskReport` / `AgentToolCallRecord`
   into `agent-result.ts` (with the existing adapters). Delete
   `src/core/agent-run-manager.ts`.
2. **Review prompt** — add `renderDelegationReports(tasks)` (agent module)
   producing the identical "Agent Delegation Reports" block from canonical
   Tasks (`sessionId` / `assignedAgent` / `outcome.result` AgentResult).
3. **Runner** — `buildWorkspacePrompt` queries terminal session Tasks
   (kinds delegation/swarm/background/scheduled) and renders via the new
   function instead of `agentRunManager.buildReviewPrompt`.
4. **delegate-agent** — drop every `agentRunManager` call. The report becomes
   `taskReportFromAgentResult(exec.result)` with `toolCalls` from the child
   Tasks' `toolExecutions`; `reviewPrompt` renders from the child Tasks;
   `result.taskId` becomes the canonical child Task id (real linkage instead
   of the manager's synthetic id).
5. **project-manager** — `getAgentRunReports(agentId, limit)` queries
   TaskEngine for terminal tasks whose `assignedAgent` matches the canonical
   agent and returns their AgentResults.
6. **Smoke** — `smoke-agent-delegation` drops the `agent_runs.json`/`getRun`
   assertions; the canonical-linkage and toolCall-from-canonical-task
   assertions stay (stronger: the report's toolCalls now come from
   `Task.toolExecutions`).
7. **Delete the file + stale comments**; keep `agent_runs.json` data on disk
   untouched (runtime state, no code reads it after this).

## 5. Acceptance gate

`tsc --noEmit` clean; `smoke:agent-engine`, `smoke:agent-execution`,
`smoke:delegation`, `smoke:scheduler`, `smoke:runtime` (e2e),
`smoke:baseline`, `smoke:terminal-paths` all green; no reference to
`agent-run-manager` / `agentRunManager` remains in `src/` or `scripts/`.

## 6. Resolution — executed (removed)

The audit concluded "purely compatibility bookkeeping", so the removal plan
was executed in full:

1. **Types + adapters** — `AgentTaskReport` / `AgentToolCallRecord` moved
   into `agent-result.ts`; `src/core/agent-run-manager.ts` deleted.
2. **Review prompt** — `renderDelegationReports(tasks)` + the
   `delegationTasksForSession` / `taskReportFromOutcome` helpers
   (agent module) render the identical "Agent Delegation Reports" block
   from canonical Tasks (kinds delegation/swarm/background/scheduled,
   terminal, newest first).
3. **Runner** — `buildWorkspacePrompt` renders via the new function over
   `taskEngine.list()` instead of `agentRunManager.buildReviewPrompt`.
4. **delegate-agent** — every `agentRunManager` call dropped. The report is
   `taskReportFromAgentResult(exec.result)` with `toolCalls` from the child
   Tasks' `toolExecutions`; the report's `taskId` is the canonical child
   Task id (real linkage); `reviewPrompt` renders from the child Tasks.
5. **project-manager** — `getAgentRunReports` queries TaskEngine for
   terminal tasks whose `assignedAgent` matches the agent (`swarm:<id>`
   etc.) and returns their reports.
6. **Smoke** — `smoke-agent-delegation` dropped the `agent_runs.json` /
   `getRun` assertions; it now asserts the report's taskId equals the
   canonical child id, `reviewPrompt` renders from the child Task and
   includes the final output, toolCalls come from `Task.toolExecutions`,
   and no `agent_runs.json` is written.
7. **Deleted** the file and stale comments; `agent_runs.json` data on disk
   untouched (runtime state, no code reads it).

Verified: `tsc --noEmit` clean; `smoke:delegation` green (new canonical
assertions); the full battery (`agent-engine`, `agent-execution`,
`agent-task-profile`, `scheduler`, `runtime`, `baseline`, `terminal-paths`)
unchanged. No reference to `agentRunManager` / `agent-run-manager` remains
in `src/` or `scripts/`. One execution authority, one report shape.
