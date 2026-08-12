# Audit: the two former engine-bypassing mission terminals (Move 4c)

> Focused behavioral audit of the two `AgentRunner.processMessage` loop exits
> that bypass `taskEngine.runTurn`: the suppressed-tool-budget stop
> (`runner.ts` ~2170-2196) and the repeated-tool-batch stop
> (`runner.ts` ~2239-2286). These are the "two classes of edge terminals"
> that `ROADMAP.md` Move 4c says must be routed through the engine's `blocked`
> verdict. This audit records what each terminal **actually does today**, what
> it records/emits, what it would do under the current `runMission` contract,
> and whether a single `blocked` verdict is semantically correct for both.
> Pairs with the regression smokes in `scripts/smoke-terminal-paths.ts`.

---

## 1. Suppressed-tool-budget stop (`runner.ts` ~2170-2196)

### 1.1 Condition
- The model returned at least one tool call on an iteration (`response.toolCalls.length > 0`), and
- either `forceFinalAnswer` is already set **or** the requested tool is in
  `missionDisabledTools` (`disabledRequests.length > 0`), and
- `suppressedToolRequests` (incremented inside this branch) reaches `>= 2`.

`forceFinalAnswer` is set elsewhere by the per-task tool cap (`~2210-2230`),
the successful-batch repetition branch (`~2257-2266`), the exploration budget
(`~2293+`), or the global tool budget `totalToolCalls >= maxToolCalls`
(`~2497-2505`).

### 1.2 Current behavior
```ts
forceFinalAnswer = true;
suppressedToolRequests += 1;
if (suppressedToolRequests >= 2) {
  const candidate = String(response.content || '').trim();
  const finalText = candidate && !this.looksLikeProgressOnly(candidate)
    ? candidate
    : 'I stopped additional tool calls because the task reached its safety budget. …';
  this.memory.add(sessionId, { role: 'assistant', content: finalText,
    metadata: { final: true, completed: Boolean(candidate), toolBudgetStopped: true } });
  await this.deliverFinalResponse(sessionId, finalText, turnRunId, turnMessageId, Boolean(candidate));
  missionCompleted = Boolean(candidate);
  missionSummary = finalText;
  if (!candidate) missionError = 'Tool budget reached before a reliable final answer.';
  stoppedByStepLimit = false;
  break;
}
// first suppression (< 2): add a system memory, then continue
this.memory.add(sessionId, { role: 'system',
  content: 'A tool call was suppressed because that tool has already completed its allowed work for this task. …',
  metadata: { type: 'mission_tool_budget' } });
continue;
```
- First suppression: **non-terminal**, records a `mission_tool_budget` system
  memory and `continue`s the loop.
- Second consecutive suppression: **terminal**, as above.

### 1.3 What it records
- Assistant-final memory entry `{ final: true, completed: Boolean(candidate), toolBudgetStopped: true }`.
- System `mission_tool_budget` memory entries (from the cap / budget pushes
  and the first suppression).
- On the canonical Task: only whatever the earlier executed batches recorded
  (ToolEngine tool records + progress). **No turn is recorded** — `runTurn` is
  never called on this path.
- `executionStateManager.markBlocked` is **not** called on this path.

### 1.4 What it emits
- Structured stream events through `deliverFinalResponse`:
  `assistant_start`, `assistant_delta`, `assistant_done` (with `ok` =
  `Boolean(candidate)`). Legacy fallback: `sendResponse`.
- **No** `TaskTurnStarted`, **no** `TaskTurnCompleted` — the engine's turn
  bookkeeping is bypassed entirely.
- **No** `markBlocked` state mutation.

### 1.5 User-visible output
- If the model produced a substantive final text (not progress-only), that
  text; otherwise the hard-coded safety-budget fallback sentence.

### 1.6 Final Task state
- `missionCompleted` is `Boolean(candidate)`, so `finalizeMissionTask` →
  `taskEngine.complete(SUCCESS)` (task `COMPLETED`, outcome `SUCCESS`) when a
  candidate existed, or `taskEngine.failTask('Tool budget reached…')` (task
  `FAILED`) when not. Note: `turns` stays `0`; no decision records are added.

### 1.7 What `runMission()` would currently do
`runMission` calls its `iterate` closure per turn and then the engine's
`completionVerdictHook`. This terminal is not reachable: `runMission` has no
concept of "suppress the tool batch and force a final answer after N
consecutive refusals". The iterate closure would keep returning tool batches;
nothing in the current contract produces this stop. Move 4c must teach the
iterate to return the forced-final signal, or the driver must reproduce the
suppression counter.

### 1.8 Required engine-equivalent behavior
A way for the iterate to say "no more tools, deliver this final text now,
completed = <bool>" — i.e. a **forced-final terminal** whose summary/completed
flag the driver honors. `complete` verdict when `completed=true`; some failing
verdict when `false`.

---

## 2. Repeated-tool-batch stop (`runner.ts` ~2239-2286)

### 2.1 Condition
- The same tool-batch signature (name + stable-stringified args) was seen
  `>= maxRepeatedToolBatches` times, and
- we reach the terminal sub-branch: `lastBatchHadFailure` is `true` **and**
  `repeatedFailureRecoveries >= 1` (the one free recovery was already spent).
  (When `lastBatchHadFailure` is false — a *successful* batch repeated — it
  instead sets `forceFinalAnswer` and disables the tools, feeding path 1.)

### 2.2 Current behavior (terminal sub-branch only)
```ts
executionStateManager.markBlocked(sessionId, reason);   // reason = 'Repeated the same tool batch N times: …'
stoppedByStepLimit = false;
const blockedText = [`I stopped the task because the same failed tool action was repeated ${n} times.`,
  lastToolError ? `Last error: ${lastToolError}` : '',
  'The loop was stopped instead of showing or executing the same action again.'].filter(Boolean).join('\n\n');
this.memory.add(sessionId, { role: 'assistant', content: blockedText,
  metadata: { final: true, completed: false, blocked: true } });
await this.deliverFinalResponse(sessionId, blockedText, turnRunId, turnMessageId, false);
missionCompleted = false;
missionSummary = blockedText;
missionError = reason;
break;
```
The non-terminal sub-branches: a one-time `repetition_recovery` recovery
continue (`~2242-2255`), and the successful-repeat suppression continue
(`~2257-2266`).

### 2.3 What it records
- Assistant-final memory `{ final: true, completed: false, blocked: true }`.
- `executionStateManager.markBlocked` — sets `lastBlockingReason` (clipped to
  240 chars) and marks the `verify` checklist step failed.
- System `repetition_recovery` memories from the earlier recovery continue.
- On the canonical Task: tool records for the batches that actually executed
  before the terminal; **no turn recorded** (`turns` stays `0`).

### 2.4 What it emits
- Structured `assistant_start`/`assistant_delta`/`assistant_done` (with
  `ok: false`) through `deliverFinalResponse`; legacy `sendResponse`.
- **No** `TaskTurnStarted` / **no** `TaskTurnCompleted`.
- `markBlocked` state mutation (not a bus/gateway event).

### 2.5 User-visible output
- The `blockedText` block: a "I stopped the task because the same failed tool
  action was repeated N times." message plus the last tool error.

### 2.6 Final Task state
- `missionCompleted = false`, `missionError = reason` →
  `finalizeMissionTask` → `taskEngine.failTask(reason)` → task `FAILED`.

### 2.7 What `runMission()` would currently do
Not reachable as-is: `runMission`'s iterate would keep returning the same
batch; the completion hook (which sees `lastBatchHadFailure`) would answer
`continue` (recovery) until the forced-continuation budget, then `blocked`.
The immediate N-repetition blockage with a *specific* user text would not be
produced. The recovery/exploration counter behavior also lives in the runner
today.

### 2.8 Required engine-equivalent behavior
The iterate must return a **blocked terminal** with a synthetic assistant text
(the `blockedText`) and a failing outcome, and the driver must map it to the
engine's blocked/partial lifecycle without calling the completion hook again.

---

## 3. Determination: is the engine's `blocked` verdict semantically correct?

The engine's `blocked` verdict (`task-engine.ts` `runTurn`, `case 'blocked'`):
`failTask` → task `FAILED`, then `setOutcome({ status: 'PARTIAL' })`, emits
`TaskTurnCompleted` with `verdict: 'blocked'`, and returns `action: 'blocked'`.
So **`blocked` always fails the task with a PARTIAL outcome and records a
turn.**

Against the two terminals:

| Terminal | Current end state | markBlocked? | Turn recorded? | `blocked` verdict result | Correct? |
| --- | --- | --- | --- | --- | --- |
| Suppressed-tool-budget, candidate present | `COMPLETED` / `SUCCESS` | no | no | `FAILED` + `PARTIAL` | **✗ wrong** — would turn a success into a failure |
| Suppressed-tool-budget, no candidate | `FAILED` | no | no | `FAILED` + `PARTIAL` (+turn) | ~ close (adds PARTIAL + turn it doesn't have today) |
| Repeated-tool-batch | `FAILED` (no outcome) | **yes** | no | `FAILED` + `PARTIAL` (+turn) | ~ close (adds PARTIAL + turn; matches the markBlocked intent) |

**Conclusion: a single `blocked` verdict is NOT semantically correct for all
three.** The suppressed-tool-budget stop is a *forced-final* stop that can
legitimately end **SUCCESS** when the model supplied a real final answer —
routing it through `blocked` would regress every suppressed-budget success
into a FAILED/PARTIAL task. The repeated-tool-batch stop is the closest match
for `blocked` (it already calls `markBlocked`), but `blocked` would add a turn
record and a PARTIAL outcome it does not produce today.

**Recommendation for Move 4c:** the iterate contract needs a terminal signal
that carries the host's decision *and* a summary, e.g.
`{ terminal: 'forcedFinal', summary, completed }` and
`{ terminal: 'blocked', summary, error }`. Map `forcedFinal.completed=true` →
engine `complete` (SUCCESS); `forcedFinal.completed=false` and
`blocked` → engine `blocked`/`failed`. Keep `markBlocked` where the runner
uses it today so the execution-state checklist survives. This preserves the
current end states instead of unconditionally failing them.

---

## 4. Move 4c implementation result

The audit's recommendation is implemented through
`TaskMissionIteration.verdict`. It is an explicit host safety signal, not a
host lifecycle transition: `TaskEngine.runMission()` passes it to `runTurn()`,
which records the canonical turn and applies the state-machine transition.

- A substantive suppressed-budget final returns `{ type: 'complete' }`, keeps
  `COMPLETED`/`SUCCESS`, and emits the final `TaskTurnCompleted` event.
- A suppressed-budget stop without a substantive candidate returns `{ type:
  'fail' }`.
- A repeated failed batch returns `{ type: 'blocked' }`, keeps the existing
  execution-state blocker, and now records `FAILED`/`PARTIAL` plus the terminal
  turn event.

## 5. Regression coverage

`scripts/smoke-terminal-paths.ts` (`npm run smoke:terminal-paths`) drives the
real `AgentRunner` with a stub model and a hermetic temp workspace, and asserts
the post-migration behavior of both terminals:

1. **Suppressed-tool-budget stop** — the model always returns `notes`
   tool-calls; the per-task cap disables `notes` and sets `forceFinalAnswer`,
   then two suppressed requests fire the terminal. Asserts: assistant-final
   memory `{ final, completed, toolBudgetStopped }`, delivered `assistant_done`
   with the candidate text, task `COMPLETED`/`SUCCESS`, one canonical turn per
   host iteration, and a final `complete` turn verdict.
2. **Repeated-tool-batch stop** — the model always returns the same failing
   `shell` batch; the batch-count guard spends its one recovery then fires the
   blocked terminal. Asserts: assistant-final memory `{ final, completed:
   false, blocked: true }`, `markBlocked` recorded a `lastBlockingReason`,
   delivered `assistant_done` with `ok: false` and the blocked text, task
   `FAILED`/`PARTIAL`, one canonical turn per host iteration, and a final
   `blocked` turn verdict.
