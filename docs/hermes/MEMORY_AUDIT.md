# Hermes Architecture Audit 6 — Memory & Learning Foundation (Phase 14)

> Docs-first audit for Phase 14 of the roadmap: one coherent memory subsystem.
> The rule that governed Phases 12–13 applies unchanged: **do not create a
> second memory authority**. Every existing memory surface stays authoritative
> for its own data; the unified layer adapts them, projects a canonical record
> shape, and provides one retrieval interface with relevance scoring. Nothing
> is deleted until its responsibility has a canonical owner.

## 1. Inventory — what already exists

| Surface | File | Owns | Closest 14.x type |
| --- | --- | --- | --- |
| Conversation store | `src/core/memory.ts` (`MemoryManager`) | Per-session message history (SQLite `messages` + `message_embeddings`, JSON fallback), keyword `search` + opt-in `semanticSearch` (embeddings, cosine) | 14.3 episodic + 14.2 working |
| Learning entries + actions | `src/core/learning-manager.ts` (`LearningManager`) | Self-review/external learning entries, pending actions with confidence/feedback (procedural rules: `applied` actions with `successCount`/`failureCount`), auto-goals, USER.md/AGENTS.md auto-updates, self-training export, LEARNING.md rendering | 14.4 semantic + 14.5 procedural |
| Task memory | `src/core/task/task-memory.ts` (`TaskMemory`) | Kind-`resume` tracking tasks over TaskEngine (current task, context points, statuses), summary prompt | 14.7 task memory |
| Learned skills | `src/core/learned-skills.ts` | Declarative reusable skills (with optional executable steps) | 14.5 procedural |
| Checkpoints | `src/core/checkpoint-manager.ts` | Workspace snapshots per task/decision | 14.7 evidence |
| File surfaces | `MEMORY.md`, `memory/*.md` daily notes, `LEARNING.md` | Rendered human/model-facing summaries | 14.4/14.6 surface |
| Skill surface | `src/skills/memory.ts` (`MemorySkill`) | `search` / `semantic_search` / `get_recent` over MemoryManager | 14.6 retrieval |

### Authority map

- **Write authority** today is per-store: only MemoryManager writes
  `memory.sqlite`/`memory.json`; only LearningManager writes
  `learning/*.json` + LEARNING.md; only TaskEngine writes Task records;
  only checkpoint-manager writes snapshots. No cross-store writer exists.
- **Read consumers** are scattered: the runner builds context by calling
  `memory.get` (conversation), `learning.getPromptLessons` (proven rules),
  `mainGoalManager`, `backgroundWorker` summaries, `taskMemory`, and the new
  `renderDelegationReports`. Retrieval is duplicated in shape but never in
  authority — there is **no second execution or storage authority** to remove
  yet; the gap is a *unified read model + retrieval scoring*.

## 2. Gap analysis vs the Phase 14 spec (14.1–14.9)

| Spec item | Status | Note |
| --- | --- | --- |
| 14.1 MemoryRecord model (type/source/scope/importance/confidence/lifecycle/timestamps/access/relations/metadata) | **missing** | No canonical record shape; each store has its own |
| 14.2 Working memory | partial | Conversation tail + TaskMemory current task; no explicit lifecycle/eviction |
| 14.3 Episodic memory | partial | Conversation store is session chat, not experience events (task outcomes, failures, corrections) |
| 14.4 Semantic memory | partial | Learning entries are knowledge, but untyped and session-scoped |
| 14.5 Procedural memory | strong | LearningManager confidence-scored actions + learned skills are exactly this |
| 14.6 Retrieval (semantic/keyword/metadata/recency/importance/relevance/budget) | partial | Per-store search; no unified scorer, no cross-store budget control |
| 14.7 Task memory | strong | TaskMemory on TaskEngine |
| 14.8 Consolidation (raw → candidate → dedupe → evaluate → persist) | missing | LearningManager has approval/feedback; no dedupe/merge pipeline |
| 14.9 Lifecycle (expiration/dedupe/promotion/demotion/archive) | missing | No canonical lifecycle states |

**Verdict: no architectural blocker.** The building blocks (conversation,
learning rules, task memory) all exist and are each single-authority. The work
is (a) a canonical `MemoryRecord` model, (b) a unified retrieval catalog that
adapts the existing stores wrap-first, and (c) a consolidation/lifecycle layer
on top — none of which creates a new storage authority.

## 3. Canonical model (14.1)

```text
MemoryRecord
├── id            '<source>:<nativeId>'   (stable across restarts)
├── type          working | episodic | semantic | procedural | project | task
├── content
├── source        conversation | learning | task | user | agent | checkpoint
├── scope         global | project | session | task | agent
├── importance    0-5 (low -> critical)
├── confidence    0..1
├── lifecycle     candidate | active | archived | expired
├── createdAt / updatedAt
├── accessCount / lastAccessedAt
├── relations     [{ type, targetId }]
└── metadata      (sessionId, projectId, taskId, native fields, ...)
```

Source → type mapping for the adapters (wrap-first, no migration):

| Source store | Canonical type | Scope |
| --- | --- | --- |
| MemoryManager messages | episodic | session |
| MemoryManager recent tail | working | session |
| LearningManager applied actions | procedural | session |
| LearningManager entries | semantic | session |
| TaskEngine current tracking task | working/task | session |
| TaskEngine terminal tasks (outcome.result) | episodic | session |

## 4. Retrieval scoring (14.6)

`retrieve(query, opts)` returns the **smallest useful context** (default
`limit: 5`), never the whole store:

```text
score = wR·relevance + wA·recency + wI·importance + wC·confidence + wU·access
```

- `relevance` = token-overlap of query vs content, or the stored
  `semanticScore` when the source store already computed one (max of both).
- `recency` = exponential decay (`2^(-ageDays/halfLifeDays)`, default 30d).
- `importance` = importance/5 · `confidence` = confidence (raw).
- `access` = min(accessCount, 5)/5 (frequently-retrieved memories stay warm).
- Defaults `wR .5 wA .2 wI .15 wC .1 wU .05`, all overridable per call; filters
  for `sessionId`, `type`, `minImportance`, `minConfidence`; dedupe by id
  across providers; each hit carries a `scoreBreakdown` for observability.

## 5. Build plan (moves, each with a smoke gate)

1. **Move 1 — model + catalog (done).** `src/core/memory-unified/`:
   `MemoryRecord` model + `UnifiedMemoryCatalog` (register providers, `records`
   projection, `retrieve` with scoring, `recordAccess`). Adapters over
   MemoryManager / LearningManager / TaskEngine. Read-only over the stores —
   no new persistence. Gate: `npm run smoke:memory-unified`.
2. **Move 2 — experience capture + one context section (done).**
   `EpisodicCapture` (`memory-unified/episodic-capture.ts`) subscribes to the
   TaskEventBus terminal events (TaskCompleted / TaskFailed / TaskCancelled)
   and projects each terminal task's outcome into a bounded (default 50)
   in-memory episode feed, deduped by task id; failures rank importance 4
   (the most valuable experience) and the summary falls back to the recorded
   failure when there is no outcome.result. Restart resilience: the feed is
   seeded from the durable TaskEngine on construction, so a fresh process
   recalls recent episodes. The runner now builds the catalog over
   conversation + learning + task (+ capture) and renders one budgeted
   `Memory context (unified)` section in the mission prompt (working task,
   recent episodes, proven rules — 1/3/3, advisory-only). The pre-existing
   per-store context blocks stay until each is proven covered; the review
   prompt already moved to the canonical Tasks in Audit 5.
3. **Move 3 — consolidation + lifecycle (done).**
   `MemoryConsolidation` (`memory-unified/memory-consolidation.ts`) is the
   consolidation/lifecycle layer over the catalog. It owns ONLY the state no
   source store has — dedupe/merge results, record lifecycle, feedback-driven
   promotion, durable access stats — persisted as a per-record overlay
   (`memory/memory_lifecycle.json` under the data root; atomic tmp+rename).
   Content stays in the source stores, so there is still exactly one content
   authority per source and one lifecycle authority here.
   - **Dedupe**: by canonical id (exact duplicates collapse).
   - **Merge**: near-duplicates (same source + type + normalized content) in
     knowledge sources (learning/task; conversation is excluded — each message
     is a distinct experience) keep the stronger record (importance ×
     confidence strength) and archive the weaker with `supersededBy`; the
     survivor carries `mergedFrom`.
   - **Lifecycle**: fresh low-importance records start `candidate`;
     `recordAccess` (≥3) or success feedback promotes `candidate → active`;
     `archive()` / `expire()` move to terminal states; `consolidate()` expires
     records whose last activity exceeds the TTL (default 180 days, clock
     injectable for deterministic tests).
   - **Importance promotion**: success feedback raises importance (+1) and
     confidence (+0.1) and promotes candidates — the LearningManager feedback
     loop generalized to canonical records. `retrieve()` ranks only
     active/candidate records (archived/expired excluded).
   The runner now reads the mission-prompt memory section THROUGH the
   consolidation layer (`buildUnifiedMemoryContext` → `consolidate()`,
   archived/expired filtered), so dedupe/merge + lifecycle apply to what the
   model sees. A source-record cache (populated during `consolidate()`)
   seeds overlay importance/confidence for session-scoped records that
   `catalog.get` cannot resolve without a session id.
4. **Move 4 — skill integration (done).** `MemorySkill` gains the canonical
   `retrieve` action — one retrieval entry point over the unified layer
   (consolidation when wired, else the catalog). It understands query,
   sessionId, source (conversation | learning | task), types, limit,
   minScore, minImportance, minConfidence, and taskId filters, and returns
   unified records (id/type/source/scope/importance/confidence/lifecycle/
   content/metadata/timestamps) with a `scoreBreakdown`. The breakdown now
   surfaces BOTH relevance sources — `semantic` (source-store embedding
   similarity when present) and `lexical` (token overlap) — alongside
   recency / importance / confidence / access, so retrieval behavior is
   auditable. `search` and `semantic_search` are thin delegates over the
   same `retrieve` path (legacy row shape preserved; `unified: true`
   marker; mode keyword / semantic|lexical with a reason) — no second
   retrieval architecture — and fall back to the legacy MemoryManager
   paths when no unified layer is wired. `get_recent` stays a raw
   session-history read. The runner passes its catalog + consolidation
   into the skill at construction; the runner's own prompt-memory section
   already reads through the canonical consolidation layer (Move 3), so
   there is one retrieval path everywhere.
5. **Move 5 — learning loop (done).** The learning half of the acceptance
   loop: `TaskLessonBridge` (`memory-unified/lesson-capture.ts`) subscribes
   to the TaskEventBus terminal events (TaskCompleted / TaskFailed) and
   queues a self-review for each task outcome via the new
   `LearningManager.queueTaskReview()` — so engine-driven work (delegation,
   swarm, background, scheduled, mission) enters the SAME approval pipeline
   as interactive lessons (it is a WHEN-trigger, not a second authority).
   `processNextReview` prompts over the canonical Task (goal / status /
   outcome) and titles the entry `Task self-review: <kind> <status>`; the
   extracted improvement becomes a pending lesson → approval (existing
   queue, `approvePendingLearningAction`) → applied → a retrievable
   unified-memory record (procedural rule via the learning provider; the
   `taskOutcomeSummary` helper is shared with the episodic capture so both
   views read the same evidence). The runner wires the bridge next to the
   episodic capture.

   **Phase 14 acceptance — verified end to end.** The smoke completes a
   task, runs the full loop (bridge → self-review → lesson → approval →
   applied rule), then simulates a restart with FRESH instances over the
   same data root (new TaskEngine over the durable task store, new
   LearningManager over `pending_lessons.json`, new MemoryManager over
   `memory.sqlite`, new catalog + consolidation reloading the overlay) and
   retrieves BOTH the terminal episode (seeded from the durable Task store)
   and the approved lesson — the knowledge from the previous run is
   recalled without the old process alive.

## 6. Acceptance gate (Moves 1-5)

`tsc --noEmit` clean; `smoke:memory-unified` green (model shape, adapter
coverage across the three stores, retrieval ranking, budget cap, dedupe,
access tracking, event capture for completed + failed tasks, restart-safe
seeding, catalog exposure of captured episodes, dedupe-by-id, near-duplicate
merge with archived `supersededBy`, candidate→active promotion by access and
by success feedback, importance promotion, TTL expiry with an injected clock,
overlay persistence across save/load, retrieval excluding archived/expired,
MemorySkill `retrieve` with scoreBreakdown + source/types/minScore/taskId
filters, search/semantic_search delegates over the unified path, bare-skill
legacy fallback, task→self-review→approval→applied loop with the restart-
recall acceptance gate); `smoke:runtime` (mission prompt with the unified
memory section), `baseline`, `delegation`, `agent-execution`, `scheduler`
all unchanged.
