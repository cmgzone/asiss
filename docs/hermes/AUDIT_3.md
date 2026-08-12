# Hermes Architecture Audit 3 — Execution Authority

> Phase 12 closeout audit after Move 4c/4d. Question: can `AgentRunner`
> independently execute a mission if `TaskEngine` is removed?

## Verdict

**No.** `AgentRunner.processMessage()` cannot run an autonomous mission without
creating a canonical Task. If task initialization fails, it returns an explicit
failure response without invoking a model or tool. Normal mission work enters
only through `taskEngine.runMission()`.

## Authority map

| Concern | Authority | Runner role |
| --- | --- | --- |
| Mission loop and sequential turns | `TaskEngine.runMission()` | Supplies one host iteration |
| Task lifecycle and terminal state | `TaskEngine.runTurn()` | Supplies evidence or an explicit safety verdict |
| Completion and verification decision | TaskEngine completion hook + `verificationPending()` | Implements the host-domain judgment hook |
| Diagnosis and recovery transition | `TaskEngine.diagnose()` | Supplies the repository-aware diagnoser |
| Turn and continuation budgets | `TaskEngine.runMission()` | Translates configured auto-continue capacity into one budget |
| Tool execution records | `ToolEngine` through `TaskEngine` | Invokes the host tool capability and annotates tool kind |
| Tool repetition/suppression policy | Runner host policy | Returns engine-owned `continue`/`complete`/`blocked` verdicts; no direct Task transition |
| Model call, session memory, streaming/UI | `AgentRunner` | Host capability; not task lifecycle authority |
| Driver exception | `TaskEngine.runTurn({ type: 'fail' })` | Reports the exception to the engine |

## Terminal-path decision

The suppressed-tool-budget and repeated-tool-batch paths no longer call
`deliverFinalResponse` and break the mission loop. They return a mission
iteration verdict; `runMission()` calls `runTurn()` before the runner renders
the associated final UI/memory entry. A successful forced final uses `complete`,
not `blocked`, preserving `SUCCESS`. A repeated failed batch uses `blocked`,
preserving its checklist blocker and producing the canonical `PARTIAL` outcome.

## Evidence

- `npm run smoke:terminal-paths` verifies both terminal paths, their user
  response, final task states, and `TaskTurnStarted`/`TaskTurnCompleted` events.
- `npm run smoke:turn-contract` verifies the explicit safety verdict contract
  and the mission-driver lifecycle.
- `npm run smoke:runtime` verifies the six-turn real mission including tool
  failure, recovery, verification, and completion.
- `npm run smoke:baseline` passes with an isolated `GITU_DATA_ROOT`; its
  default OneDrive data path is not writable in this sandbox.

## Remaining boundaries

The runner deliberately still owns model/tool invocation, streaming, and
session memory. These are host capabilities, not mission lifecycle authority.
Phase 13 may introduce a unified `AgentEngine`, but only after this Phase 12
boundary remains stable under future regression coverage.
