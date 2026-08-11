/**
 * Canonical Task system — Hermes Evolution Phase 1.
 *
 * Public surface:
 *   task-types.ts    — Task model, statuses, constraints, records
 *   task-state.ts    — state machine (legal transitions)
 *   task-events.ts   — event bus + lifecycle events
 *   task-store.ts    — persistence (memory + JSON)
 *   task.ts          — entity model (createTask / Task facade)
 *   task-engine.ts   — lifecycle ownership (create/analyze/plan/execute/...)
 *
 * Deliberately decoupled from AgentRunner: Phase 2 wires the runner to the
 * engine without touching the engine's dependencies.
 */

export * from './task-types';
export * from './task-state';
export * from './task-events';
export * from './task-store';
export * from './task';
export * from './task-engine';
export * from './task-hooks-bridge';
export * from './task-event-projection';
export * from './task-memory';
