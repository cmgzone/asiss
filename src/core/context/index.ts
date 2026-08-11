/**
 * ContextEngine — Hermes Evolution Phase 7.
 *
 * Budgeted, relevance-based context construction: instead of dumping the
 * entire conversation + repository + tools, build
 *   goal -> relevant memory/decisions/files/tools -> budget -> model.
 */

export * from './relevance';
export * from './context-budget';
export * from './summarizer';
export * from './repository-context';
export * from './repo-index';
export * from './repo-watcher';
export * from './verify-then-retry';
export * from './context-builder';
export * from './context-engine';
