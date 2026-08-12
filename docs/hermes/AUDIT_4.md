# Hermes Architecture Audit 4 — Phase 13 authority & single source of truth

> Closeout audit after Phase 13 completed the work-origin migration chain
> (delegation → swarm → background → scheduled all run as canonical Tasks
> through `AgentEngine.executeTask`). Verifies one authority per concern
> across the migrated subsystems and consolidates the remaining duplicate
> (swarm → canonical-Task linkage, S1).

## 1. Authority map

| Trigger | WHEN | WHO | HOW | Store (authoritative) |
| --- | --- | --- | --- | --- |
| Mission (`processMessage`) | user/client message | session mission (no worker) | `TaskEngine.runMission` (host iterate) | task store |
| Delegation (`delegate_agent`) | parent-mission tool call | explicit agent id → `AgentEngine.executeTask` | `TaskEngine.runMission` (AgentEngine iterate) | custom/profile/swarm stores + `agent_runs.json` shim |
| Swarm (`agentSwarm.runAgent`) | user/UI via project-manager skill | explicit swarm agent → delegate → `executeTask` (`kind: 'swarm'`) | same | `swarm_data.json` |
| Background (`backgroundWorker`) | worker tick (idle / DND / capacity) | `AgentEngine.selectForProfile` (`kind: 'background'`) + ephemeral fallback | same | `background_goals.json` |
| Scheduled (`SchedulerManager`) | timer (`runAt` / `intervalMs`) | `AgentEngine.selectForProfile` (`kind: 'scheduled'`) + ephemeral fallback | same | `scheduler.json` |

Every work origin now funnels into the same HOW: `AgentEngine.executeTask` →
`TaskEngine.runMission`. `runChildLoop` is deleted; the scheduler and worker
are WHEN-only triggers; the runner's legacy mission loop survives only as the
failure fallback for the three migrated paths.

## 2. Single source of truth per concern

| Concern | Single source | Competing implementation remaining? | Verdict |
| --- | --- | --- | --- |
| Execution (turns, verdicts, recovery, terminal state) | `TaskEngine` via `AgentEngine.executeTask` | none — all four work origins route here | ✓ single |
| Worker selection (WHO) | `AgentEngine.selectForProfile` (background, scheduled) | swarm passes an explicit agent id resolved through the stores (`delegate_agent` wrap) | ✓ single by design (explicit assignment); no competing selector |
| Timing / due-ness (WHEN) | `SchedulerManager` timers; `BackgroundWorker` tick | none | ✓ single |
| Trigger-state persistence | `scheduler.json` / `background_goals.json` / `swarm_data.json` | none — each store stays authoritative for its own trigger metadata | ✓ single |
| Execution evidence | canonical Task (toolExecutions, verification, outcome, artifacts) | worker/swarm stores keep their own statuses/progress | ✓ single for *execution*; store statuses are trigger state by design |
| Task linkage (store ↔ canonical) | background: `goal.metadata.canonicalTaskId`; scheduled: `task.metadata.schedulerJobId`; delegation: child under parent | **swarm: none** — the swarm agent record could not be traced to its canonical child Tasks | **~ consolidate (S1)** |
| Tools / policy | `ToolEngine` + `PolicyEngine` (agentPermissions live) | none | ✓ single |
| Legacy run bookkeeping | `agent_runs.json` via `agentRunManager` | canonical Task outcome/artifacts | deferred compatibility shim (documented Step 3 sub-step 3) |

## 3. Findings, ranked

**S1 — Swarm → canonical Task linkage missing (consolidated in this audit).**
Background links `goal.metadata.canonicalTaskId` and scheduled links
`task.metadata.schedulerJobId`, but the swarm store recorded only its own
`AgentTask` ids — a duplicate execution record with no way to connect it to
the engine-owned run. Fix: `delegate_agent` now surfaces `canonicalTaskIds`
(exec.taskIds) on its result, and the runner's swarm executor records them on
the swarm agent (`SwarmAgent.canonicalTaskIds`, deduped, persisted to
`swarm_data.json`). Verified by smoke:delegation (result carries the canonical
child id; the task exists with `kind: 'delegation'`).

**S2 — Store statuses vs canonical Task status (by design, not consolidated).**
`goal.status`, `SwarmAgent.status`, and `job.enabled` are trigger/store state;
the canonical Task owns execution evidence. These are deliberately separate
authorities (the stores stay authoritative per the wrap-first rule). The
linkages (S1, `canonicalTaskId`, `schedulerJobId`) make the relationship
explicit rather than a hidden duplicate.

**S3 — Canonical Agent status is a projection of the swarm store (by design).**
`fromSwarmAgent` maps store status → canonical status; `agentRegistry.refresh()`
re-reads the stores before every delegation, so the projection is refreshed per
use. A transient divergence (canonical ASSIGNED/AVAILABLE vs store 'working')
can exist mid-run and self-heals on the next refresh — acceptable for a
selection-time projection.

**S4 — `agentRunManager` shim (deferred).** `agent_runs.json` still books
delegations for `reviewPrompt` / task_memory / `agent_runs.json` consumers. It
is a documented compatibility surface, not a competing execution authority.
Consolidation = migrate its consumers to canonical Task records; deferred until
the consumers move.

**S5 — Persistent-state sprawl (pre-existing, deferred).** `swarm_data.json`,
`background_goals.json`, `scheduler.json` key to `process.cwd()` while the task
store honors `GITU_DATA_ROOT` (D5 from Audit 2). Not touched by Phase 13.

## 4. Next phase decision

Phase 13 is complete: every work origin executes as a canonical Task, worker
selection is engine-owned where selection applies, and store↔canonical linkage
is explicit for all four paths. Recommended next move, smallest first:

1. **Finish S4** — move `agentRunManager` consumers (`buildReviewPrompt`,
   task_memory rendering) onto canonical Task records, then delete the shim.
2. **Phase 17 — Self-repair loop** (the roadmap's next feature phase): the
   UNDERSTAND → … → LEARN autonomous loop now has all the machinery (Task
   lifecycle, diagnose/recovery, AgentEngine selection, warm repository
   index) to build on.
