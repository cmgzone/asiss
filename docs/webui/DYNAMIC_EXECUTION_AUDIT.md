# Gitu WebUI — Dynamic Execution Audit

> Phase 1 deliverable of the Dynamic Tool Execution plan. **No behavior was changed**
> to produce this document — it is a read-only map of the current WebUI so the
> refactor can reuse what exists and only fill the gaps.
>
> Scope: `src/channels/web/public/index.html` (the entire frontend, one file,
> inline `<script>` + `<style>`), `src/channels/web/server.ts` (Web channel),
> `src/agents/runner.ts` (mission loop), `src/core/types.ts` (event contract),
> `src/skills/shell.ts` (streaming), `src/core/task/*` (goal/task state).

---

## 1. Current event flow (backend → frontend)

### Contract

The single contract is `StreamEventPayload` (`src/core/types.ts:25-51`):

```
StreamEventType =
  | 'assistant_start' | 'assistant_delta' | 'assistant_done' | 'assistant_error'
  | 'assistant_update' | 'assistant_stopped'
  | 'mission_start' | 'mission_end'
  | 'tool_start' | 'tool_delta' | 'tool_done'
  | 'approval_required' | 'approval_granted' | 'approval_denied'
  | 'repository_refreshed' | 'recovery'
```

Payload fields: `runId`, `messageId`, plus per-type extras (`text`, `finalText`,
`ok`, `progress`, `reasoning`, `toolCallId`, `name`, `output`, `status`, `error`,
`approvalId`, `tool`, `risk*`, `reasons`, `arguments`, `allowed`, repo stats,
`timestamp`).

### Producers → delivery

1. **`src/agents/runner.ts`** emits assistant_*, mission_start/end, tool_start,
   tool_done, assistant_update (progress narration), assistant_stopped.
2. **`src/gateway/server.ts:213`** emits `assistant_error` when the model layer
   fails.
3. **`src/core/task/task-event-projection.ts`** projects task-engine events into
   `approval_required` / `approval_granted` / `approval_denied` /
   `repository_refreshed` (the TaskEngine is the canonical tool-lifecycle bus;
   runner tool calls funnel through it).
4. **`src/channels/web/server.ts:1724-1739`** (`sendStreamEvent`) forwards every
   event to the authenticated user's socket room with a **scope payload**:
   `{ projectId, conversationId }` (via `extractChatScope`).
5. **Shell streaming** is a *separate channel*: `shell.ts` writes
   `__SHELL_STREAM__`-marked chunks through `streamFn` → `gateway.sendStream` →
   web `sendStream` → socket **`stream_chunk`** event (server.ts:1718).

### Socket → frontend handlers

All in `connectSocket()` (`index.html` line ~220):

| Socket event | Frontend handler | Effect |
|---|---|---|
| `assistant_start` | `clearPending(); setAssistant(runId,'',false)` | new assistant bubble |
| `assistant_delta` | `setAssistant(runId, prevText + text, false)` | **throttled** 60 ms re-render |
| `assistant_done` | `setAssistant(...,true)` or `convertToProgress` | finalize / fold into update |
| `assistant_error` | `setAssistant(...,true)` + `failed=true` | error text + Retry button |
| `assistant_stopped` | mark `stopped=true` + Retry button | Stopped state |
| `assistant_update` | `addProgressUpdate` | single replaceable update bubble |
| `mission_start` / `mission_end` | `missionActive` toggle | stop button visibility |
| `tool_start` | `activity()` (canvas) + `setToolSummary()` (chat) | two surfaces |
| `tool_done` | same two, `completed/failed` | in-place update |
| `stream_chunk` | append to `#terminal` div | terminal panel |
| `approval_*` | `showApprovalCard` / `resolveApprovalCard` | in-chat approval card |
| `repository_refreshed` | `showRepoWarmth` | sidebar dot |
| `media` | artifact link in canvas | artifact list |
| `error` | toast | generic error |

**Key structural finding:** `tool_delta` and `recovery` are declared in the type
union but **never emitted by any producer** — the contract has two dead surface
areas the plan depends on (live tool progress, recovery narration).

### Stop path

`socket 'stop'` (server.ts:1623) resolves the chat scope to the running session,
then invokes the message handler with `content: '__stop__'`,
`metadata.control: 'stop'`. The runner's `stopSession()` (a) aborts the per-mission
`AbortController` — which interrupts a running shell command mid-execution via
`ToolContext.signal` — and (b) sets the stopped flag so the mission halts at the
next turn boundary, recording `CANCELLED` on the task and `stoppedByUser` on its
metadata, then emits `assistant_stopped` + `mission_end`.

---

## 2. Current tool lifecycle

### Backend

```
per LLM batch:
  assistant_update (progress narration)          ← BEFORE tools run
  tool_start   { runId, messageId=batchId, name: "a, b, c" }   ← ONE per batch
  ...execute calls (TaskEngine records per-call start/complete/fail internally)...
  tool_done    { runId, messageId=batchId, toolCallId: call.name,
                 name, output, status: completed|failed, error }   ← ONE per call
```

Gaps vs the plan's lifecycle (`STARTED → RUNNING → COMPLETED/FAILED/CANCELLED`):

- **`tool_start` is per-batch, not per-call.** A batch of 5 tools shows as one
  "Executing a, b, c" card; individual "Reading repository" → "Running tests"
  steps are impossible today.
- **`toolCallId` is the tool *name*, not a unique call id.** Two `read_file`
  calls in one batch produce two `tool_done` events with the same
  `toolCallId` — the frontend cannot distinguish them.
- **No progress events.** No `progress`/`message` mid-call updates; a long shell
  command only surfaces via the separate `stream_chunk` side channel.
- **No per-tool CANCELLED.** Interrupted tools never get a terminal `tool_done`;
  the card stays `running` until `assistant_stopped`/`mission_end` resets
  everything at mission level. There is no way to know *which* tool was cut off.
- **No execution identity.** Events are keyed by `runId` (an assistant turn) and
  `messageId` (a batch). Nothing ties `mission_start → turns → tools →
  mission_end` into one execution-scoped id; a long mission is a chain of runIds.

### Frontend (two parallel render surfaces, one event)

1. **Canvas** — `activity(id, name, status, output)` (`index.html` ~line 214):
   prepends a card to `#activityList`. Id = `messageId || runId` from the event.
   This is the *ephemeral* list — exactly the "temporary dynamic state" the plan
   wants, but it is DOM-only (no state array, no rehydration).
2. **Chat** — `setToolSummary(activityId, name, status, output)` (~line 211):
   creates/updates an `activity`-kind **message in `state.messages`**, rendered as
   a compact `tool-summary` button with an expandable `tool-detail` panel
   (`formatToolDetail` pretty-prints shell/edit/search output, redacts secrets
   via `safeToolOutput`).

**Coalescing:** `setToolSummary` merges a new tool event into the *previous*
activity message when the tool kinds match (kind-based for shell/edit/page/
search/agents/project/memory, exact-name for generic tools). The label becomes
"Edited files · 3 actions". So the UI already avoids one-message-per-tool — but
it collapses *tool identity*: individual tools are not distinguishable.

**The chat stream is not interrupted by tool events** — assistant text and tool
cards live in separate message kinds and update independently. The plan's Phase 7
requirement is already structurally true; the remaining issue is that tool cards
are chat *messages* (persisted, scrollable history) rather than an attached
dynamic execution region.

---

## 3. Current chat rendering flow

- `state.messages` holds kinds: `user`, `assistant`, `activity`, `update`.
- `renderMessages()` full re-render; `appendMessageNode(m)` incremental append.
- **Streaming throttle:** `assistant_delta` accumulates text on the message
  object immediately; the DOM re-render is deferred to one per 60 ms
  (`scheduleAssistantRender`), flushed synchronously on `assistant_done`.
  `renderAssistantBody` re-parses markdown + re-highlights code blocks only on
  flush. Verified by the streaming benchmark (parse cost drops ~6–12×; the DOM
  benchmark added the layout/paint proof).
- `nearBottom()` gates auto-scroll during streaming and non-user appends.
- `update` bubbles replace each other in place (`addProgressUpdate` finds the
  existing `kind==='update'` and swaps text) — one progress bubble at a time,
  transient.
- `convertToProgress` folds a final assistant message back into an update bubble
  when `assistant_done.progress` is set.
- Retry (`retryMessage`): client-side — drops everything after the last user
  message and re-emits the same text; `failed`/`stopped` messages show the
  button; `stopped` is persisted server-side through conversation normalization.

### Persistence

`completedMessages()` = messages with `complete !== false && kind !== 'update'`,
sliced to 120. **`activity` messages ARE persisted** (non-project chats via
`PUT /api/conversations/:id`, project chats via localStorage). On load,
`normalizeConversationMessages` re-coalesces them. So today execution activity is
**permanent chat history**, contrary to the plan's Phase 14 principle
(chat = user + final assistant only; execution = separately stored/reconstructable).

---

## 4. Duplicate state (same truth, N places)

| Truth | Held in | Notes |
|---|---|---|
| Tool lifecycle | `state.messages` (activity kind) **and** canvas DOM `#activityList` | same event rendered twice, two code paths |
| Active tool for stream routing | `state.activeActivityId` | single slot (see races) |
| Terminal output | `#terminal` div **and** `m.output` on the active tool card | the div is both display and transport |
| Mission running | `state.missionActive` + stop-button visibility + `#terminal` content | derived in several handlers |
| Goal/task state | `/api/loop` payload (`loopData`) — separate fetch, 3 s poll | third source of truth about the same mission |
| Conversation | server conversations **and** per-project localStorage (`gitu:v2:chat:*`) | two persistence mechanisms, same message list |
| Saves | `saveChat()` (immediate) + `persistConversation()` (180 ms debounce) | two writers for the same rows |
| Runs | `state.runs = new Map()` | **declared, never used — dead state** |
| Trajectories | `/api/trajectories` (redacted JSONL) | exists server-side, shown raw in Runtime, not linked to chat |

---

## 5. Existing reusable components (build on these)

1. **`tool-summary` / `tool-detail`** — compact-by-default, click-to-expand tool
   card with `aria-expanded`, status class, per-kind detail formatting. This is
   already the Phase 6 "compact card → expand" pattern; it just lives in chat.
2. **`refreshToolDetail`** — in-place update of a tool card (icon, label, status,
   detail) — the "same card, new state" primitive Phase 5 needs.
3. **`scheduleAssistantRender` + `nearBottom`** — the throttled streaming +
   scroll-guard machinery (with the benchmark + `/demo` harness proving it).
4. **`enhanceCodeBlocks`** — syntax highlighting + per-block copy.
5. **Canvas `activity()` card** — ephemeral running/failed/completed card with a
   prepend list; the seed of a real activity feed.
6. **`loopDialog`** — Goals ↔ Tasks trace with `Stopped`/`CANCELLED` badges,
   live 3 s refresh, click-to-jump. The seed of execution history (Phase 15).
7. **`showApprovalCard` / `resolveApprovalCard`** — dynamic in-chat card that
   resolves in place; the model for a live execution card.
8. **`stopMission()` + `missionActive` + per-session AbortController** — the
   Phase 12 stop story (mid-command interrupt + CANCELLED/stopped records) is
   done backend-side and mostly done in the UI.
9. **`safeToolOutput` / `formatToolDetail`** — redaction + per-kind rendering of
   tool output; reuse for terminal/diff/artifact cards.
10. **Artifacts** — `media` socket event → canvas `#artifactList` with blob URLs.
11. **Bench infrastructure** — `scripts/bench-streaming-render.mjs`,
    `scripts/bench-dom-render.mjs`, `/demo` page (real pipeline extraction,
    side-by-side replay). Reuse for Phase 10's terminal-output throttling and
    Phase 19's gates.

---

## 6. Missing states (the plan's gap list, mapped to reality)

| Plan state | Today | Backend signal needed? |
|---|---|---|
| `execution.started/completed/cancelled` | `mission_start`/`mission_end` exist but carry no execution id and no final summary | **Yes** — an `executionId` spanning the mission (or frontend synthesis from `missionMarker` runId) |
| `tool.started` per call | only per-batch `tool_start` | **Yes** — per-call events (or per-call entries in the batch event) |
| `tool.progress` (%, message) | `tool_delta` declared, never emitted; only `stream_chunk` | **Yes** — emit `tool_delta` |
| `tool.completed/failed` per call | `tool_done` per call but `toolCallId` = name (collides) | **Yes** — unique call ids |
| `tool.cancelled` | absent | **Yes** — terminal event for interrupted tools |
| `execution.summary` (collapsed card) | absent; `/api/loop` has goal/task evidence but no per-execution timeline | Optional (can derive from tool events + `/api/loop`) |
| Recovery narration | `assistant_update` text sometimes describes it; `recovery` event declared, never emitted | **Yes** — emit `recovery` (or `assistant_update` with a structured flag) |
| Execution history view | `/api/trajectories` (raw event JSONL) + Runtime page; not user-facing in chat | Mostly exists server-side; needs a projection + UI |
| Reconnect/resume | socket `disconnect` clears `missionActive`; in-flight canvas/tool state is lost on reload; nothing re-syncs | Server has trajectories; needs a `GET current-execution` endpoint or replay |
| Mobile execution sheet | canvas is a fixed/overlay panel; no compact sheet, no "View activity" affordance | Frontend only |

**Distinct terminal states** (completed / failed / cancelled / blocked): partially
present. `assistant_done` (`ok:false`) → web channel treats as error;
`assistant_stopped` → Stopped; step-limit → `PARTIAL`/blocked recorded in the
task layer and visible only in the Loop dialog. The chat surface does not
distinguish these four for a mission — a `mission_end` payload carrying
`status: completed|failed|cancelled|blocked` (derived from the task outcome the
runner already records) would close this.

---

## 7. Race conditions observed

1. **Stream double-append.** `stream_chunk` writes to `#terminal`; a
   MutationObserver diffs the div and mirrors the delta into the active tool
   card's `output`. When `tool_done` arrives, `setToolSummary` **appends**
   `output` to the already-mirrored text → the tail of a streamed command can
   appear twice in the card. (The observer is the only path to live tool output;
   `stream_chunk` itself never touches the card.)
2. **Single active-stream slot.** `state.activeActivityId` holds one id; two
   concurrent streams (parallel delegated agents, or a child mission) collide —
   `appendToolStream` writes the second stream into the first tool's card.
3. **Coalescing ambiguity.** `setToolSummary` walks backward to find a "same
   kind" activity message. A progress `update` bubble landing between batches
   doesn't break the search, but the *visual order* can interleave a tool card
   above/below the progress bubble arbitrarily.
4. **`assistant_delta` accumulation.** `(m?.text||'') + delta` assumes ordered,
   non-duplicated deltas; a retried run reusing a runId, or a replayed batch,
   duplicates text. (The `message`-dedupe guard only covers non-streamed final
   messages.)
5. **Reload mid-mission.** The server keeps running the mission, but the page
   resets `missionActive=false` and drops canvas state; `mission_start` will not
   re-fire, so the UI never learns the mission restarted — the running mission is
   invisible until its next event lands. There is no `GET`-style sync.
6. **Stop during approval / between batches.** `stop` aborts the shell signal and
   sets the flag, but in-flight approval cards are not cancelled, and a tool
   batch already past the abort check still finishes before the stop lands.
7. **Terminal reset diff.** The observer's `startsWith` diff assumes append-only
   growth; a full reset of `#terminal` (e.g., future re-render) silently
   produces an empty delta and drops output.

---

## 8. Mobile problems

- **Canvas is an overlay, not a sheet.** At ≤800 px the canvas becomes a fixed
  right-side panel (`min(88vw,360px)`); there is no compact "Gitu is working"
  card, no progress bar, no [View activity]/[Stop] affordance in a sheet. The
  plan's Phase 16 shape doesn't exist.
- **Hover-only affordances.** The conversation ⋯ menu (`.thread-row:hover
  .thread-menu-btn`) and code-copy buttons are opacity-0 until `:hover` — on
  touch devices these are effectively invisible/flaky (hover fires on first tap).
- **Unbounded output.** `#terminal` and tool-detail `<pre>` grow without a cap on
  mobile; long streams cost memory and scroll churn.
- **Wide output not scrollable in cards.** Tool-detail `pre` lacks horizontal
  overflow handling; a long shell line blows the card width.
- **Topbar collapse** hides the title and squeezes selects; the Loop dialog
  already collapses to one column (good) but the goals/tasks lists are dense.

---

## 9. What the refactor should reuse vs build (per plan phase)

| Plan phase | Reuse | Build |
|---|---|---|
| 2 contract | `StreamEventPayload` + scoped routing + `missionMarker` as the execution anchor | `executionId` (or frontend `executionStore` keyed off `mission_start.runId`); per-call tool ids; emit `tool_delta` + `recovery`; `mission_end.status` |
| 3 store | `state.messages` activity kind, `missionActive`, `activeActivityId` | `executionStore` (ephemeral, not persisted) fed by a single reducer over socket events |
| 4–6 ExecutionCard | `tool-summary`/`tool-detail`, `refreshToolDetail`, canvas `activity()` | one `<ExecutionCard>` per execution replacing the dual canvas+chat-summary split; status: running/completed/failed/cancelled |
| 7 streaming | `scheduleAssistantRender`, `nearBottom`, `/demo` harness | none — verify tool events never touch the assistant render path |
| 8 summary | Loop dialog evidence | collapse-to-summary state in the card + "View execution" |
| 9 artifacts | `media` handler, `artifactUrl` | Open/Preview/View-diff affordances |
| 10 terminal | `stream_chunk` + observer diff, `safeToolOutput` | feed stream directly into the terminal card (kill the DOM side-channel); throttle via the existing benchmark's rAF/60 ms pattern |
| 11 agents | tool grouping for `delegate_agent` | per-agent rows when `tool_delta`/child events arrive |
| 12 stop | `stopMission`, abort signal, CANCELLED records | per-card cancel; distinct cancelled card state |
| 13 recovery | `assistant_update` narration | `recovery` event → diagnosing/fixing/verified card states |
| 14 persistence | `normalizeConversationMessages` coalescing | stop persisting `activity` kind; store execution refs instead |
| 15 history | `/api/trajectories`, `/api/loop` | execution timeline projection + "View execution" modal |
| 16 mobile | existing ≤800 px breakpoints | compact bottom sheet with progress + [View activity][Stop] |
| 17 modules | — | incremental extraction (state → socket → chat → execution → components) |

---

## 10. Phase 2 status — the execution event contract is implemented

Implemented on the backend (runner emissions + contract fields; additive, no
frontend contract break):

- **`executionId`** on `StreamEventPayload` (`src/core/types.ts`). `mission_start`
  anchors the mission (reusing the `missionMarker` uuid); **every** mission event
  now carries it: per-turn assistant_*, assistant_update, tool_start/tool_delta/
  tool_done, recovery, assistant_stopped, mission_end. One executionId -> many
  dynamic events.
- **Per-call tool ids**: `tool_start` is now emitted **per call** (was per batch)
  with a unique `toolCallId` + human `label`; `tool_done` uses the same id
  (was the tool *name*, which collided). The frontend resolves activity ids via
  `d.toolCallId || d.messageId || d.runId` (one-line change, keeps the current
  canvas/chat working until Phase 4 rebuilds the cards).
- **`tool_delta`** is now actually emitted (was declared-only): shell stream
  chunks flow into per-tool `tool_delta` events, throttled to one flush per
  150 ms per tool via a mission-scoped buffer (`toolDeltaBuffer`), flushed
  before `tool_done`, shell-stream markers stripped.
- **`recovery`** is now emitted (was declared-only): `phase: 'diagnosing'` at the
  start of a turn after a failed batch, `phase: 'fixing'` before the repair
  batch, `phase: 'verified'` on completion when the task carries verification
  evidence.
- **`mission_end.status`**: `completed | failed | cancelled | blocked` derived
  from the terminal turn action / user stop / driver failure. The `finally`
  block also cleans up the delta timer.

Verified deterministically (no tokens) via `logs/verify-ph2-contract.ts` — a
real `AgentRunner` mission with a stub model + stub gateway (same pattern as
`scripts/smoke-repetition-guard.ts`):

- Scenario A (fail -> repair -> complete): every event carries the same
  executionId; 2 per-call `tool_start` with unique ids matching `tool_done`;
  statuses `failed` -> `completed`; recovery `diagnosing` + `fixing`;
  `mission_end.status: 'completed'`.
- Scenario B (real shell tool): `tool_delta` events carry the streamed output
  (markers stripped) with the same `toolCallId` as `tool_done`.

Not yet done (later phases): the frontend execution store + card rendering
(Phase 3-6), frontend consumption of `mission_end.status`/`recovery`/tool_delta.

---

## 11. Phase 3 status — ephemeral executionStore (frontend)

Implemented in `index.html` (additive; existing canvas/chat rendering untouched
until Phase 4 re-renders from the store):

- **`executionStore`** — `{ executions: Map<executionId, record>, currentId }`,
  bounded to the latest 20 missions. One record per `mission_start.executionId`.
- **Pure reducer** (`createExecution` / `reduceExecution` / `applyExecutionEvent`,
  delimited `// ===== Phase 3 ... =====` block, no DOM) tracks the plan's
  fields: `status` (running | completed | failed | cancelled | blocked),
  `currentTask` (latest narration wins), `activeToolId`, `tools[]`
  (id/name/label/status/output/error with delta accumulation and bounds),
  `agents[]` (delegate_agent calls), `progress` (from `tool_delta.progressPct`),
  `artifacts[]`, `terminal` (bounded 20k), `latestError`, `recoveryPhase`.
- **Wiring** — every execution-relevant socket handler feeds the store
  (mission_start/end, assistant_update/error/stopped, tool_start/delta/done,
  recovery, stream_chunk, media) plus the two NEW listeners `tool_delta` and
  `recovery`. Events without `executionId` are ignored (chat-only events).
- **Store-driven render** — a compact **Execution panel** at the top of the
  canvas shows status badge (reusing the loop badge colors), current task,
  active tool, tool/agent counts, progress bar, recovery chip, and latest
  error. Renders via `renderExecution()`, throttled to one rAF
  (`scheduleExecutionRender`).
- **Ephemeral by design** — nothing in the store is persisted or written to
  `state.messages`; permanent chat history is untouched.

Verified:
- Inline script + served page parse clean; the panel markup + new listeners are
  in the served bundle.
- `logs/test-execution-store.cjs` extracts the pure block verbatim and drives a
  synthetic event stream: happy path (mission -> 2 tools incl. delegate ->
  recovery diagnosing -> completed, 13 assertions), failed mission (status
  failed + latestError 'exit 1' + tool status failed), cancelled mission
  (assistant_stopped -> cancelled), and the no-executionId ignore rule.

Not yet done: the chat ExecutionCard (Phase 4) and switching the canvas/chat
rendering to read from the store instead of `state.messages`.

**Biggest risk to manage:** `setToolSummary`'s coalescing and the canvas/chat
duplication are load-bearing today (they keep the chat clean). Moving execution
out of `state.messages` must preserve (a) the activity-message rendering in
`renderMessages`/`appendMessageNode`, (b) persistence normalization on load, and
(c) the retry/export code that walks `state.messages`. The execution store should
be introduced alongside, with the chat tool-summary becoming a *view* over it
rather than a separate message kind.

## 12. Phase 4 status — the chat ExecutionCard (transient, store-driven)

The card is rendered from `executionStore` into `#messages` as a dedicated
`article#executionCard` node — **never** pushed to `state.messages`, never
persisted. Scope-aware via `currentScopeExecution()` (project + conversation);
leaving the scope removes the card.

States:
- **running** — expanded: status badge (reusing the Loop dialog colors), current
  task, active tool line, progress bar, recovery-phase chip, latest error, and
  compact per-tool rows (`✓/✕/●` icon, name, label, duration). Rows expand on
  click to show bounded output (Phase 6 compact-by-default behavior).
- **completed / failed / cancelled / blocked** — collapsed to a one-line
  summary (`✓ Completed · 2/2 tools · 3.2s`); click to expand. A manual
  expand/collapse is preserved across re-renders via `data-manual` (the
  renderer used to force-collapse terminal cards on every re-render, which
  silently undid a user's expand — fixed while testing).

Wiring: `mission_start` -> `assistant_update/error/stopped`, per-call
`tool_start/tool_delta/tool_done`, `recovery`, `stream_chunk`, `media` all feed
`applyExecutionEvent`. The card is created on the **first tool_start** (not
mission_start) so no-tool Q&A missions show no card. The old per-tool chat
summaries (`tool-summary` cards in `state.messages`) are dropped for current
missions — the card replaces them; `renderMessages` re-attaches the card after
re-renders.

Verified (headless Chromium, real functions extracted verbatim + real CSS from
`index.html`):
- Running: 2 rows, both running, detail hidden by default, active line shows
  the label, expanded.
- Tool row click expands detail showing accumulated `tool_delta` output.
- Completion: auto-collapses (`data-collapsed=1`), failed row styled, expand
  click re-opens and stays open (the `data-manual` fix), error line visible.
- Scope switch: card removed for another conversation.
- The DOM test caught two real bugs: (1) terminal cards force-collapsed on
  every re-render, undoing user expansion; (2) the harness had to include the
  real CSS block — without it `.exec-card-body{display:none}` is missing and a
  center-click lands on a tool row instead of the card summary (test-side
  finding; the served page was never affected).
- Phase 3 reducer suite still green; inline script + served bundle parse clean
  and carry all three fixes (`data-manual`, scope removal, create-if-absent).

Next: Phase 5/6 — polish tool lifecycle detail rows and the compact/failed/
cancelled card visuals in the live app.

## 13. Smoke promotion — the executionStore reducer contract is in the battery

`logs/test-execution-store.cjs` was promoted to `scripts/smoke-execution-store.ts`
and registered in the canonical battery (`npm test`):

- `package.json`: `smoke:execution-store` script added.
- `scripts/run-battery.ts`: `execution-store` entry in `CANONICAL_BATTERY`
  (after turn-contract) + doc-comment battery list updated; smoke-phase19
  Gate A (every battery entry must be a registered script) stays green.
- The smoke extracts the delimited PURE store block verbatim from
  `index.html`, asserts the inline script parses, and drives six sections:
  happy path (13 assertions), failed mission, cancelled mission, and the
  no-executionId ignore rule — same contract the chat ExecutionCard and
  canvas Execution panel render from.
- Verified: `npx tsc --noEmit` clean, `npm run smoke:execution-store` passes,
  `npm test -- --only=execution-store` passes through the real battery
  runner, `npm run smoke:phase19` and `npm run lint:src` green.

## 14. Mission-level progress — the ExecutionCard's real progress bar

The backend now emits `progressPct` (0-100) on **every mission-scoped event**,
and the store reduces it from any event, so the ExecutionCard and canvas
Execution panel show a real, moving progress bar.

Backend (`src/agents/runner.ts`):
- `missionProgressPct()` reads the mission Task's recorded progress — the
  canonical estimate the task engine advances after each tool batch
  (`recordProgress(batchPct)`, capped at 90 so the bar has room to fill) and
  pins to 100 on completion. Falls back to a tool-budget estimate
  (`10 + totalToolCalls/maxToolCalls*80`, capped 90) when no Task was created.
- Threaded onto `mission_start` (0), `assistant_update`, `recovery`
  (diagnosing/fixing = current, verified = 100), `tool_start`, `tool_delta`
  (both the throttled flush and the flush-before-`tool_done`), `tool_done`,
  and `mission_end` (100 when completed, else last known).

Frontend (`src/channels/web/public/index.html`):
- The reducer previously read `progressPct` only from `tool_delta`; a generic
  line at the top of `reduceExecution` now applies it to every event, so the
  bar tracks the mission lifecycle (assistant narration, tool events, recovery
  phases) rather than just per-tool output.

Verified:
- Deterministic harness (real AgentRunner + stub model, `logs/verify-ph2-contract.ts`):
  progress is monotonic across a fail -> repair -> complete mission
  (`0 -> 17 -> 23 -> 100`) and a real shell mission (`0 -> 17 -> 100`);
  assistant stream events carry no progressPct (store keeps the last value).
- `scripts/smoke-execution-store.ts` gained §3b: progress rides every mission
  event (`0 -> 15 -> 25 -> 40 -> 60 -> 75 -> 100`), asserting the reducer
  contract end-to-end. All gates green: tsc, smoke, phase19, lint, diff.

## 15. Execution resync — reconnect/reload rebuilds the store from server state

The audit's #5 gap (reload mid-mission loses all execution state) is closed:
a reconnecting or reloading WebUI rebuilds its ephemeral executionStore from
server-side trajectory data, keyed by executionId.

Backend (`src/channels/web/server.ts`):
- `missionEventBuffers` — a per-scope map (keyed by the same scoped user id the
  socket rooms use) retaining every mission-scoped event. `mission_start`
  resets the buffer; other events append (bounded to 2000).
- `execution_resync` socket event — resolves the requesting scope exactly like
  a message/stop would (project id or owned conversation), looks up the
  buffer, and replies with `execution_snapshot`: `{ events, active, scope }`.
  Each event gets the scope spread on, so the client's contextMatches gate
  accepts the replay; `active` = mission_start seen without mission_end yet.
- The snapshot is still served after mission_end (terminal card restores too).

Frontend (`src/channels/web/public/index.html`):
- `requestExecutionResync()` emits the request with the current scope; called
  after `enterApp` (login/reload) and after conversation/project switches.
- `execution_snapshot` handler replays each buffered event through
  `applyExecutionEvent` (respecting contextMatches), restores
  `state.missionActive` + the Stop button from `active`, and re-creates the
  ExecutionCard + panel via `ensureExecutionCard()` / `scheduleExecutionRender()`.

Verified end-to-end (real WebChannel on a test port + real socket.io client in
Playwright, driving the real sendStreamEvent buffering path):
- No mission -> empty snapshot, active false.
- Mid-mission -> 3 buffered events replayed with executionId, tool ids,
  delta output, progressPct, and per-event scope; active true.
- Another conversation -> no events (buffer is per scoped user).
- After mission_end -> 5 events still replayable, active false.
- Frontend DOM harness (real handler + real store/card code): replay rebuilds
  the store (status/progress/tool output), restores missionActive + Stop
  button, and renders the card. All gates green (tsc, store smoke, exec-card
  DOM test, phase19, lint, diff); assets synced; backend restarted.

## 16. Phase 15 status — "View execution" history modal

Completed missions now have a **View execution** chip on the collapsed
ExecutionCard summary that opens a modal replaying the mission's tool timeline
from the store (reusing the Loop dialog shell + row styling).

Store: the pure reducer now accumulates `recoveryPhases[]` (phase, timestamp,
narration) alongside `recoveryPhase`, so the modal can render a real timeline
of diagnose/fix/verify stages, not just the latest one.

Modal contents (`renderExecutionHistory`):
- Stats grid — tools done/total, agents, progress %, artifacts, recoveries.
- Recovery chips (diagnosing/fixing/verified with narration, verified green).
- **Timeline** — every tool call in order (icon, name, label, duration),
  expandable to bounded output/error, failed rows styled, up to the last 40.
- Artifacts, Terminal (last 8k chars), and Error sections.

Wiring: `openExecutionHistory()` renders from `currentScopeExecution()` and
shows the dialog; the delegated `#messages` click handler catches the chip
before the card-collapse branch; a dialog-level listener expands tool rows;
the × button closes. The chip renders only for terminal statuses (running
cards never show it).

Verified (headless Chromium, real functions + real CSS):
- Completed card shows the chip, collapsed; running card shows none.
- Clicking it opens the dialog with meta `ex1 · Completed · duration`; stats
  grid, both tool rows in order (failed styled), diagnosing chip, terminal
  section, artifact row, and Timeline section header all present.
- Modal tool rows expand to detail on click; close button works.
- Store smoke gained recoveryPhases assertions; all gates green (tsc, store
  smoke, exec-card + history DOM tests, phase19, lint, diff); assets synced.

## 17. Phase 10 status — terminal DOM side-channel killed

**Finding (audit §4):** the old chat UI diffed the canvas `#terminal` element with a
`MutationObserver` (`terminalSnapshot`/`appendToolStream`) to mirror command output into
per-tool chat summaries. Fragile: it rode a DOM side-channel, had no tool identity, and
raced the throttled renderer.

**Fix:** removed the observer and its dead consumer island.
- Tool output now flows **only** through `tool_delta` (per `toolCallId`, server-throttled to
  one flush per 150 ms) into the store's per-tool `output`, which the ExecutionCard tool
  detail renders on rAF via `scheduleExecutionRender`. `stream_chunk` still feeds the
  canvas `#terminal` panel and `execution.terminal` (the store accumulation), but nothing
  diffs the DOM to mirror output into chat anymore.
- Deleted the orphaned `refreshToolDetail` / `setToolSummary` / `appendToolStream`
  functions (zero callers after the observer went) and the `activeActivityId` /
  `streamFlushTimer` state fields that only they touched. The tool-summary label/format
  helpers (`toolSummaryText`, `toolSummaryKind`, `safeToolOutput`, `formatToolDetail`)
  stay — `normalizeConversationMessages` and `appendMessageNode` still use them for
  persisted activity messages.

**Verified:** inline script parses; zero references to the dead island remain; Phase 4
exec-card DOM test and Phase 15 history modal test both green; store smoke green; `tsc`
clean; assets synced to `dist/` (observer gone from the served bundle too).

## 18. Phase 17 status — incremental module split (executionStore + socket wiring)

**Goal:** break the monolithic inline `<script>` in `index.html` into separate
`js/` modules incrementally, keeping the page fully functional at each step.

**Step 1 (this phase) — two modules extracted verbatim, zero behavior change:**
- `public/js/execution-store.js` — the delimited PURE store block
  (`executionStore`, `createExecution`, `findTool`, `reduceExecution`,
  `applyExecutionEvent`), byte-identical to the pre-split source, markers kept.
- `public/js/socket.js` — `requestExecutionResync()` + `connectSocket()` as
  globals, with a header noting the load-order contract (after the store,
  before the inline script; the inline script still owns `state`,
  `contextMatches`, and every UI helper they call).
- `index.html` now loads them as classic scripts (`<script src="/js/...">`)
  before the inline script. Classic scripts share the global lexical scope, so
  the inline script's `requestExecutionResync()` call sites (enterApp +
  conversation/project switches) and the socket handlers' references to
  `applyExecutionEvent(executionStore, ...)` resolve unchanged. The inline
  script shrank by ~9.9 KB.

**Contracts preserved:**
- `scripts/smoke-execution-store.ts` now extracts the store block from
  `js/execution-store.js` (same delimiters) instead of `index.html`.
- The Phase 4/15 DOM harnesses read the store from the new file and splice the
  still-inline renderer (`executionRenderTimer` anchor) — all scenarios green.
- `copy-runtime-assets.js` copies `public/` recursively, so `js/` syncs to
  `dist/` automatically; `/js/*.js` serve 200 from the live server.

**Verified end-to-end (live page, headless Chromium against the running
server):** the page boots with all three scripts and zero console/page errors;
`executionStore`, `createExecution`, `reduceExecution`, `applyExecutionEvent`,
`requestExecutionResync`, `connectSocket`, and the inline renderer all resolve
as globals; a synthetic mission driven through the page globals completes
(status=completed, 1 tool, progress=100, accumulated output). Smoke, battery
(`--only=execution-store`), both DOM harnesses, `tsc`, `lint:src`,
`diff:gate`, and `phase19` all pass.

**Next incremental steps:** extract the markdown/highlighting helpers, then the
message renderer + delegated handlers, then the canvas panel — one module per
phase, re-verifying the live page each time.

## 19. Phase 16 status — mobile bottom-sheet execution panel

**Audit gap (§8):** mobile had no touch-friendly execution surface; the canvas
was a right-side slide-over with hover-only affordances.

**Built:** a dedicated `#execSheet` bottom sheet, mobile-only (`display:none`
on desktop, fixed bottom sheet above the composer at ≤800px), rendered from the
executionStore on the same rAF as the card (`scheduleExecutionRender` now calls
`renderExecSheet()`):
- **Progress** — the same `.progress` bar fed by `progressPct` (width %, 0→100).
- **Activity** — compact per-tool rows (icon · name · label · duration, last 6),
  the current task line, and the latest error line.
- **Stop** — a full-width Stop button wired to the real `stopMission()` (socket
  `stop` emit + composer-stop behavior), visible only while running.
- **Lifecycle** — auto-opens on mission start; a manual dismiss sticks for that
  executionId only (`state.sheetDismissedFor`, cleared on the next mission);
  closes on completion/failure/cancel; state badge mirrors the card
  (Running/Completed/Failed/Stopped).

**Verified:**
- DOM test (real store + renderer + real extracted click wiring + real CSS,
  mobile viewport): opens while running with state/progress/task/tool rows;
  Stop triggers `stopMission`; dismiss sticks for the mission; completion
  closes it; a new mission re-opens; desktop `display:none`.
- Live probe (served page, 390×844): boot with zero errors, `renderExecSheet`
  defined, sheet `flex` on mobile and `none` at 1280×800; a synthetic mission
  opens the sheet with `progress=63%`, 1 tool row, state Running.
- Regressions: Phase 4 card + Phase 15 history DOM tests, store smoke, `tsc`,
  `lint:src`, `diff:gate` all green; assets synced to `dist/`.

## 19b. Swipe-to-dismiss — the bottom sheet is now draggable

`wireExecSheetDrag()` (called once at init) attaches pointer handlers to
`#execSheet`:
- **Drag start** — `pointerdown` on the handle/head (or anywhere when the tool
  list is scrolled to top, so the list itself still scrolls); skips non-primary
  mouse buttons; `transition:none` + `setPointerCapture` so the drag is smooth.
- **Live drag** — `pointermove` translates the sheet in real time
  (`style.transform=translateY(dy)`, clamped to downward).
- **Commit** — on `pointerup`/`pointercancel`, clears the inline transform and
  restores the CSS transition; releasing past `max(90px, 30% of height)`
  dismisses for this mission (`sheetDismissedFor`), otherwise it springs back.
  A post-drag click on the handle is swallowed via `dataset.dragged` so the
  spring-back can't be immediately dismissed by a stray click.
- `touch-action:none` on the handle/head so touch drags aren't hijacked by page
  scrolling.

**Verified:** the Phase 16 DOM test gained drag scenarios (live `translateY`
mid-drag, threshold dismiss + `sheetDismissedFor`, small-drag spring-back with
cleared transform, post-drag click swallowed, clean tap still dismisses) — all
green; card/history DOM tests, store smoke, `tsc`, `lint:src`, `diff:gate`
unchanged. Live probe on the served mobile page (app revealed, as the login
view hides the layout when logged out) confirms the same drag→dismiss flow with
zero console errors; assets synced to `dist/`.

## 19c. Expandable tool rows in the mobile sheet

`renderExecSheet` now renders each tool row with `data-tool`, `role="button"`,
and an inline `.exec-tool-detail` (bounded to 2000 chars, error-or-output like
the card). A delegated `#execSheetTools` click handler toggles `.open` +
`.exec-tool-detail.hidden` — the exact card-detail gesture. Sheet-specific CSS
makes the detail full-width inside the flex row (`.exec-sheet-tools
.exec-tool-detail{width:100%}` + `flex-wrap:wrap` on open rows). Taps coexist
with swipe-to-dismiss: a tap fires pointerdown→up with zero movement, so the
drag commit no-ops and the click toggles the row.

**Verified:** the Phase 16 DOM test asserts the row carries a collapsed detail
with the tool output, tap expands it (`.open` + detail visible), and a second
tap collapses it — green, alongside all prior sheet/drag scenarios. Live probe
on the served mobile page expands a row to reveal live `tool_delta` output with
zero console errors; card/history DOM tests, store smoke, `tsc`, `lint:src`,
`diff:gate` all green; assets synced to `dist/`.

## 20. Phase 20 — final end-to-end UX walkthrough (desktop + mobile)

The last planned phase: drive the REAL full stack — a `WebChannel` on a test
port wired to a real `AgentRunner` with a scripted stub model (fail → repair →
succeed, 500 ms/turn), real socket.io, the real page logged in through the real
login form, a message sent through the real composer — and walk every UX
surface on desktop (1280×800) and mobile (390×844). Harness:
`logs/walkthrough-ux.ts` (run with `TS_NODE_TRANSPILE_ONLY=1`).

**Final state — all 16 checks green** (login/send, running card with
progress+rows, composer Stop + Enter-to-stop hint, card row expand, completed
collapse + View-execution modal, no desktop overflow, no console errors;
mobile sheet with progress+activity+Stop, inline row expand, swipe dismiss,
close-on-completion, no overflow, no console errors).

**Bugs the walkthrough surfaced and fixed:**

1. **Vendor asset 404 when launched from another cwd** (real finding): the web
   channel served `/vendor/marked.js` from `process.cwd()/node_modules`, so a
   desktop shell chdir-ing before launch broke syntax highlighting (page fell
   back to plain text). Now resolves module-relative first
   (`__dirname/../../..`) with a cwd fallback. Verified: `marked: 200` from
   the restarted production server.
2. **In-flight tool-row expansions wiped by the next `tool_delta` render** (real
   finding): both the ExecutionCard and the mobile sheet rebuild tool rows from
   scratch on every store event, so a row a user just expanded collapsed again
   on the next delta. Both renderers now snapshot which tool ids are `.open`
   and re-apply expansion (including un-hiding the detail) across re-renders —
   mirroring the card's existing manual-collapse preservation.
3. Walkthrough-side sampling bugs (too-fast stub mission, wrong progress
   selector, sampling before the first tool) were fixed in the harness — not
   the app.

**Regression round after fixes:** Phase 4 card + Phase 15 history + Phase 16
sheet DOM tests green, store smoke + battery pass, `tsc`, `lint:src`,
`diff:gate` clean; assets synced; backend rebuilt + restarted (root 200,
marked 200).

**Remaining known gaps (unchanged, documented):** per-agent expandable rows in
the card (Phase 11 partial), hover-only conversation menu on touch (§8), and
the desktop canvas still mirrors the card (harmless duplicate). Phase 17's
module split continues with the markdown/highlighting helpers next.
