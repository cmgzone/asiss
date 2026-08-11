/**
 * Internal task event bus — Hermes Evolution Phase 1 (foundation for Phase 3).
 *
 * Systems subscribe to events instead of calling each other directly. The
 * TaskEngine emits lifecycle events; telemetry, recovery, learning and the UI
 * can attach later without the engine knowing about them.
 */

/**
 * Event names. Covers the Phase 3 set (TaskCreated ... LearningCreated) plus
 * the finer-grained lifecycle events the TaskEngine emits today.
 */
export type TaskEventName =
  // Lifecycle
  | 'TaskCreated'
  | 'TaskAnalyzed'
  | 'TaskPlanned'
  | 'TaskReady'
  | 'TaskStarted'
  | 'TaskProgress'
  // Multi-turn execution contract (Phase 12 Move 1)
  | 'TaskTurnStarted'
  | 'TaskTurnCompleted'
  | 'TaskPaused'
  | 'TaskResumed'
  | 'TaskBlocked'
  | 'TaskRecovered'
  | 'TaskRetrying'
  | 'TaskFailed'
  | 'TaskVerifying'
  | 'TaskVerified'
  | 'TaskVerificationFailed'
  | 'TaskCompleted'
  | 'TaskCancelled'
  // Tool execution
  | 'ToolStarted'
  | 'ToolCompleted'
  | 'ToolFailed'
  // User approval (Phase 5 ASK path)
  | 'ApprovalRequired'
  | 'ApprovalGranted'
  | 'ApprovalDenied'
  // Agents / delegation
  | 'AgentSpawned'
  | 'AgentCompleted'
  // Workspace snapshots
  | 'CheckpointCreated'
  // Verification / tests
  | 'TestStarted'
  | 'TestFailed'
  | 'TestPassed'
  // Learning (Phase 14 integration point)
  | 'LearningCreated'
  // Repository intelligence (Phase 9 telemetry)
  | 'RepositoryIndexRefreshed';

export interface TaskEvent {
  name: TaskEventName;
  taskId: string;
  timestamp: number;
  /** Optional event-specific payload (result, error, tool name, ...). */
  data?: Record<string, unknown>;
}

export type TaskEventHandler = (event: TaskEvent) => void | Promise<void>;

const WILDCARD = '*';

export class TaskEventBus {
  private handlers = new Map<TaskEventName | typeof WILDCARD, Set<TaskEventHandler>>();

  /** Subscribe. Returns an unsubscribe function. */
  on(name: TaskEventName | typeof WILDCARD, handler: TaskEventHandler): () => void {
    const handlers = this.handlers.get(name) || new Set<TaskEventHandler>();
    handlers.add(handler);
    this.handlers.set(name, handlers);
    return () => {
      handlers.delete(handler);
    };
  }

  /** Emit to subscribers of `name` and wildcard subscribers. Errors are caught and logged per handler. */
  async emit(event: TaskEvent): Promise<void> {
    const targets = [this.handlers.get(event.name), this.handlers.get(WILDCARD)];
    for (const set of targets) {
      if (!set) continue;
      for (const handler of Array.from(set)) {
        try {
          await handler(event);
        } catch (error) {
          console.warn(`[TaskEventBus] ${event.name} handler failed:`, error);
        }
      }
    }
  }

  /** Number of subscriptions, for diagnostics. */
  status(): { [name: string]: number } {
    const out: { [name: string]: number } = {};
    for (const [name, handlers] of this.handlers) {
      if (handlers.size > 0) out[name] = handlers.size;
    }
    return out;
  }
}

/** Default process-wide bus. Tests and multi-engine setups can create their own. */
export const taskEventBus = new TaskEventBus();
