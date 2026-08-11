/**
 * Task state machine — Hermes Evolution Phase 1.
 *
 * Owns the legal transitions between TaskStatus values and the classification
 * helpers (terminal / active / recoverable). The TaskEngine calls
 * `assertTransition` before every status change so the lifecycle can never
 * silently drift from the canonical model.
 */

import { TaskStatus } from './task-types';

/**
 * Allowed transitions.
 *
 * Canonical path:    CREATED -> ANALYZING -> PLANNING -> READY -> EXECUTING
 *                    -> VERIFYING -> COMPLETED
 * Failure path:      EXECUTING/VERIFYING -> FAILED -> DIAGNOSING -> REPAIRING
 *                    -> EXECUTING
 * Dependency path:   READY -> BLOCKED -> READY
 * User path:         active states -> PAUSED -> READY
 * Abort path:        any non-terminal state -> CANCELLED
 */
const TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  CREATED: new Set(['ANALYZING', 'CANCELLED']),
  ANALYZING: new Set(['PLANNING', 'READY', 'FAILED', 'PAUSED', 'CANCELLED']),
  PLANNING: new Set(['READY', 'FAILED', 'PAUSED', 'CANCELLED']),
  READY: new Set(['EXECUTING', 'BLOCKED', 'PAUSED', 'COMPLETED', 'CANCELLED']),
  EXECUTING: new Set(['VERIFYING', 'COMPLETED', 'FAILED', 'PAUSED', 'CANCELLED']),
  VERIFYING: new Set(['COMPLETED', 'FAILED', 'EXECUTING', 'PAUSED', 'CANCELLED']),
  FAILED: new Set(['DIAGNOSING', 'REPAIRING', 'EXECUTING', 'CANCELLED']),
  DIAGNOSING: new Set(['REPAIRING', 'EXECUTING', 'FAILED', 'CANCELLED']),
  REPAIRING: new Set(['EXECUTING', 'VERIFYING', 'FAILED', 'CANCELLED']),
  PAUSED: new Set(['READY', 'CANCELLED']),
  BLOCKED: new Set(['READY', 'CANCELLED']),
  COMPLETED: new Set([]),
  CANCELLED: new Set([]),
};

export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set(['COMPLETED', 'CANCELLED']);

export const ACTIVE_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'CREATED',
  'ANALYZING',
  'PLANNING',
  'READY',
  'EXECUTING',
  'VERIFYING',
  'DIAGNOSING',
  'REPAIRING',
  'PAUSED',
  'BLOCKED',
]);

/** Statuses that can be retried (the FAILED -> DIAGNOSING -> REPAIRING path). */
export const RECOVERABLE_STATUSES: ReadonlySet<TaskStatus> = new Set(['FAILED']);

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function isActive(status: TaskStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}

export function isRecoverable(status: TaskStatus): boolean {
  return RECOVERABLE_STATUSES.has(status);
}

/** True when `to` is a legal next state from `from`. */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from]?.has(to) ?? false;
}

/** Throws unless `from -> to` is legal. */
export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal task state transition: ${from} -> ${to}`);
  }
}

/** Human-readable explanation of why a transition is illegal. */
export function transitionError(from: TaskStatus, to: TaskStatus): string {
  const allowed = Array.from(TRANSITIONS[from] || []).join(', ');
  return `Cannot move task from ${from} to ${to}. Legal transitions from ${from}: ${allowed || '(none — terminal state)'}`;
}

/** The canonical full lifecycle, useful for diagnostics and the ROADMAP docs. */
export const CANONICAL_LIFECYCLE: TaskStatus[] = [
  'CREATED',
  'ANALYZING',
  'PLANNING',
  'READY',
  'EXECUTING',
  'VERIFYING',
  'COMPLETED',
];

export const FAILURE_LIFECYCLE: TaskStatus[] = [
  'EXECUTING',
  'FAILED',
  'DIAGNOSING',
  'REPAIRING',
  'EXECUTING',
];
