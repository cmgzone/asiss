# WebUI — Message-Scoped Executions & Thinking (Phase 21)

## 1. The architecture in one diagram

```
Backend event (socket)
        │
        ▼
execution-store.js  ── PURE reducer, one record per executionId
        │                 (mission_start → tool_* → recovery → mission_end)
        │  version++ on every applied event
        ▼
index.html Phase 21 card layer
        │  mountExecutionCard(executionId)
        │    → <article id="execution-card-<executionId>">
        │  renderExecutionCardById(executionId) — only when ITS version changed
        ▼
assistant message (data-run=<runId>)
        │  owned by the turn that produced the activity
        ▼
tool timeline / artifacts / status (children of that turn's card)
```

**The rule:** every execution gets ONE unique card element
(`execution-card-${executionId}`). There is no global `#executionCard`, no
`currentScopeExecution()`-driven single surface, and a new mission never
overwrites a previous mission's card. Cards are mounted at the end of
`#messages` in event order and updated independently.

## 2. The message → execution relationship

- `runId` identifies an **assistant turn** (message). All tool/assistant
  events carry the same `runId` as the assistant message they belong to.
- `executionId` identifies a **mission** (one user request). The backend
  emits it on every mission/tool/recovery/stream event.
- `toolCallId` is a unique id per tool invocation — repeated `read_file`
  calls are tracked independently because the row identity is the call id,
  never the tool name.

The frontend binds a mission's card to the assistant turn that produced it:
`tool_start` mounts `execution-card-<executionId>` after the turn's message
in DOM order, so the conversation reads:

```
User:  Fix the authentication bug.
Gitu:  ◉ Analyzing the auth flow …        ← thinking / progress narration
       [execution card]                   ← tools, status, artifacts
       I found the issue. …               ← final response
       ✓ Completed · 3 tools · 18s        ← persisted summary footer
```

When `assistant_start` fires, the pending thinking message is **adopted in
place** (`adoptPendingMessage`) — the same DOM node becomes the streaming
response, so Thinking → response never removes/re-adds a node (no layout
jump, no flicker, no duplicate indicators).

## 3. How thinking/work state is represented

Thinking is **message-scoped and derived from real events only** — there is
no global `#thinking` element and no invented chain-of-thought.

| User-facing state | Driven by | Icon |
| --- | --- | --- |
| `thinking` / "Planning approach" | `mission_start` before any activity | ○ |
| `working` / narration text | `assistant_update.text` (folded into the owning message, not a separate bubble) | ◉ |
| `tool` / "Running tests" | `tool_start` label or tool-name → action map (`executionWork`) | ◉ |
| `completed` / "Completed · N tools" | `mission_end status=completed` | ✓ |
| `failed` | `tool_done failed` / `assistant_error` | ⚠ |
| `stopped` | `assistant_stopped` / `mission_end cancelled` | ■ |

Transitions are subtle CSS state changes (`st-*` classes): the running dot
pulses gently, completed rows recede, the card settles once on mount. No
fake percentage dominates the card — the backend `progressPct` renders only
as a thin 3px secondary line; the primary signal is always **what Gitu is
doing right now**.

## 4. How thinking clears

- **Response begins:** `adoptPendingMessage` removes the work-status
  placeholder and streams the answer into the same node.
- **Stop:** `assistant_stopped` → store status `cancelled`, card shows
  `Stopped`, `clearPending` removes any leftover thinking node.
- **Error:** `assistant_error` → store status `failed`, card shows the
  error, thinking node removed.
- **Completion:** `mission_end` → card settles as `✓ Completed`, and a
  compact summary is persisted onto the last assistant message so restored
  conversations show the footer (live tool timelines stay ephemeral by
  design — only the summary is persisted).

## 5. Private reasoning

`assistant_done.reasoning` is never rendered (no 💭 block) and is stripped
in `completedMessages()` before persistence — it cannot reach the UI or the
saved conversation. Work labels come only from `tool_start` names/labels,
`assistant_update` narration, and mission statuses.

## 6. Views of ONE execution model

One store, multiple views: the per-turn chat card, the desktop canvas
panel (`renderExecution`), the mobile bottom sheet (`renderExecSheet`), and
the "View execution" modal — all read the same records. Rendering is
rAF-throttled and per-card (version-based dirty tracking), so a busy
execution never re-renders its neighbors, and assistant streaming keeps its
60 ms markdown throttle untouched.
