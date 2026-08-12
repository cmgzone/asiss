# Step 9.3 — Scheduler responsibility map (Phase 13)

> Pre-migration audit of the scheduled-job execution path
> (`src/core/scheduler.ts` + the runner's `SchedulerManager` wiring).
> **No code changes until this audit lands.** The target shape:
>
> ```
> Scheduler (WHEN: timers, persistence, cancellation)
>    |
>    v
> AgentEngine (WHO: select/assign the worker)
>    |
>    v
> TaskEngine (HOW: turns, tools, verification, completion, failure)
> ```
>
> The scheduler must NOT become a second execution engine. It stays the
> trigger; the engines own the work. `kind: 'scheduled'` already exists in
> the canonical Task model (`task-types.ts:45`) and is currently unused.

---

## 0. The migration surface

| Surface | Location | Role |
| --- | --- | --- |
| `SchedulerManager` | src/core/scheduler.ts (whole file) | job store (`scheduler.json`), `setTimeout` timers, `runJob` |
| `SchedulerSkill` | src/skills/scheduler.ts | `create` / `list` / `cancel` tool actions (UI + model) |
| Runner's `onRun` | runner.ts:216-224 (`new SchedulerManager(async (job) => …)`) | builds a `channel: 'scheduler'` Message and calls `processMessage(job.sessionId, …)` |
| `beginMissionTask` | runner.ts:1687-1716 | creates the canonical Task for a message — **always `kind: 'mission'`** |
| `kind: 'scheduled'` | task-types.ts:45 | declared, never created |

---

## 1. Responsibility-by-responsibility map

| # | Responsibility | Today (file:line) | Canonical owner | Needed at target |
| --- | --- | --- | --- | --- |
| 1 | **Timing / due-ness** | `scheduleTimer` scheduler.ts:100-112 — one `setTimeout` per job, clamped to `MAX_TIMEOUT_MS` | stays in `SchedulerManager` (WHEN authority) | none |
| 2 | **Recurrence** | `runJob` scheduler.ts:119-140 — `runAt = now + intervalMs`, re-arm | stays in `SchedulerManager` | none |
| 3 | **Persistence** | `load`/`save` scheduler.ts:22-47 — `scheduler.json`, atomic tmp+rename | stays in `SchedulerManager` | none |
| 4 | **Cancellation** | `cancel` scheduler.ts:91-99 — `enabled = false`, clear timer | stays in `SchedulerManager` | note: in-flight runs are not aborted (same today) |
| 5 | **Task creation** | `beginMissionTask` runner.ts:1700 — **`kind: 'mission'`** | `TaskEngine.create()` with `kind: 'scheduled'` | kind + `metadata.schedulerJobId` linkage |
| 6 | **Worker selection (WHO)** | none — jobs run in their session as missions | `AgentEngine.selectForProfile({ kind: 'scheduled' })` + ephemeral fallback | profile from the job prompt |
| 7 | **Execution loop (HOW)** | `processMessage` → `taskEngine.runMission` (Phase 12 Move 4c — the runner's loop body is the iterate hook) | `AgentEngine.executeTask` → `TaskEngine.runMission` | already canonical; no new authority |
| 8 | **Tools / policy** | mission loop → ToolEngine + PolicyEngine | unchanged (child mission path) | pass `agentPermissions` from the worker |
| 9 | **Retries** | none — `runJob` swallows `onRun` errors, one-shot disables / recurring reschedules | preserve: pass `retries: 0` to executeTask | none |
| 10 | **Failure handling** | swallowed at scheduler level; mission failure recorded on the Task | Task outcome recorded; job failure traceable via `metadata.canonicalTaskId` | link job → Task |
| 11 | **Result delivery** | mission streams the response into the session | deliver the child `AgentResult` output to the session after completion | `gateway.sendResponse(sessionId, output)` |
| 12 | **Overlap** | serial by construction — the recurring timer is re-armed only after `onRun` completes, but re-entry edge paths (start() re-entry, future re-arms) had no guard | `SchedulerManager` in-flight guard: a `running` Set skips + re-arms a tick whose previous run is still executing | landed after the audit (smoke:scheduler) |

---

## 2. What the current path does NOT do (gaps the migration FIXES)

- **Wrong task kind** — scheduled work is recorded as `kind: 'mission'`, so
  telemetry/events/UI cannot distinguish scheduled runs; `kind: 'scheduled'`
  exists unused.
- **No WHO** — jobs always run in their session as missions; no worker
  selection via the canonical AgentEngine.
- **No job linkage** — the canonical Task carries no `schedulerJobId`, so
  consumers cannot trace a run back to `scheduler.json`.
- **No failure evidence on the job** — the scheduler swallows `onRun` errors;
  only the Task (kind 'mission') records the outcome.

## 3. Preserve-with-care (scheduler special concerns)

- **Missed schedules**: one-shots with a past `runAt` fire once on restart
  (`delay` clamps to 0); recurring jobs fire once, no catch-up. The migration
  does not touch timing, so this behavior is unchanged.
- **Overlap**: the recurring path is serial by construction (the timer is
  re-armed only after the run completes), and an explicit in-flight guard
  now hardens re-entry edge paths (`start()` re-entry, any future re-arm): a
  tick whose previous run is still executing is skipped and re-armed for the
  next interval, bumping `skippedRuns` instead of overlapping.
- **Cancellation**: `cancel()` prevents rescheduling; in-flight runs finish.
  Same semantics after migration.
- **Retries**: none today — preserved with `retries: 0`.
- **Session context**: the mission path runs with the session's memory and
  workspace/project context; the canonical child mission is isolated. This is
  the one real behavioral tradeoff — mitigated by delivering the final result
  to the session and by keeping the legacy mission path as the failure
  fallback (system stays usable at every step).

## 4. The migration (smallest)

1. Keep `SchedulerManager` and `SchedulerSkill` byte-for-byte (WHEN, store,
   state, cancellation).
2. Runner's `onRun`:
   - **Primary**: `agentEngine.executeTask({ agentId: selected.id, task:
     job.prompt, kind: 'scheduled', sessionId: job.sessionId, maxTurns: 6,
     retries: 0, metadata: { schedulerJobId, schedulerJobType, source:
     'scheduler' } })` — worker via `selectForProfile` (capability hints from
     the prompt + task-scope `'scheduled'`), falling back to an ephemeral
     "Scheduled Worker" agent with the full native tool surface.
   - On success: deliver `finalOutput || summary` to the session.
   - On failure/throw: fall back to the existing `processMessage` mission path.
3. No other files change.

## 5. Acceptance gate

> **Does a scheduled job complete as a canonical kind-'scheduled' Task with
> the job linked, and does the scheduler keep owning WHEN?**

Concretely: `smoke:agent-execution` gains a section asserting `executeTask`
with `kind: 'scheduled'` + `metadata.schedulerJobId` produces a COMPLETED
child Task of kind `'scheduled'` with the linkage intact; `smoke:agent-task-profile`
gains a task-scope `'scheduled'` selection check; `smoke:scheduler` proves the
overlap guard (in-flight re-entry is skipped, `skippedRuns` bumps, the job
reschedules and runs again after completion). Verified by `tsc --noEmit` + the
existing smoke battery.
