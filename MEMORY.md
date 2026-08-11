# MEMORY.md

## Project Notes
- Repo: myassis (local personal assistant with channels + skills).
- System prompt: loaded from SOUL.md (fallback to src/soul.md).

## Hermes Evolution (architecture project)
- Controlled architectural evolution of the runner into engine-owned subsystems. Plan: `docs/hermes/ROADMAP.md`; audit of all 22 mission-loop ops: `docs/hermes/EXECUTION_MAP.md`.
- Phases 0-11 done (baseline, canonical Task system, TaskEngine ownership, event bus + hooks bridge, ToolEngine, PolicyEngine, ModelEngine, ContextEngine, repo index, warm telemetry, goal-aware retries, verify-then-retry). Moves 1-3 of architecture review done (typed config, one recovery authority = TaskEngine.diagnose, typed event-to-channel projection).
- Phase 12 (Execution authority) in progress. D1/D2/D3 done (prompt assembly into ContextEngine, task-context folded into TaskEngine, tool lifecycle bus-only). **Move 1 done: `TaskEngine.runTurn()` turn contract** — per-turn primitive owning EXECUTING -> (VERIFYING) -> EXECUTING/COMPLETED; host supplies verdict (continue/verify/complete/fail/blocked); sequential turns; verify reuses diagnose. Verified by `npm run smoke:turn-contract` (8 sections).
- Next: Phase 12 Move 2 = completion-verdict hook (move completionBlocked into the turn contract), then verify/diagnose in-loop, then delegate the loop body as the executor hook. Runner loop must stay untouched until then.
- Remember: rebuild after src edits (`npm run build`); dist holds stale duplicates until then.

## Recent Fixes
- Agent automation: configurable max tool turns via config.agent.maxTurns; clearer pause messaging.
- Telegram: streaming responses supported so OpenRouter streamed output reaches Telegram.
- Project manager: action enum + action normalization + idempotent project_create; duplicates removed from projects_data.json.
- MCP filesystem: stdio args now resolve ./ to an absolute path to avoid allowed-dir confusion.
- Agent runtime: stable cross-restart session IDs, mission-scoped context, relevant-history recall, one final streaming path, autonomous recovery from premature prose/tool failures, required post-change verification, and auto-completed goals.
- Delegation: independent child tasks can run concurrently through delegate_agent batches; dependent edit/build tools stay ordered.
- Coding: semantic tool failures now trigger recovery; apply_patch supports context-aware hunks, reports missing context, and blocks workspace escapes.
- Web: the legacy dashboard was replaced by a chat-first interface with a collapsible live canvas, projects, agents, analytics, models, settings, voice, media, and structured streaming.
