/**
 * ToolEngine — Hermes Evolution Phase 4.
 *
 * One consistent tool execution mechanism for native skills, MCP tools,
 * dynamic tools and (later) learned skills:
 *
 *   tool-engine.ts    — lifecycle orchestrator (resolve/validate/authorize/execute/record)
 *   tool-registry.ts  — unified tool catalog (native + MCP descriptors)
 *   tool-selector.ts  — name resolution, aliases, fallback selection, suggestions
 *   tool-validator.ts — argument validation
 *   tool-policy.ts    — ALLOW/DENY authorization (Phase 5 PolicyEngine foundation)
 *   tool-executor.ts  — native/MCP/dynamic dispatch with semantic fallback
 *   tool-result.ts    — request/context/result types + output normalization
 */

export * from './tool-result';
export * from './tool-registry';
export * from './tool-selector';
export * from './tool-validator';
export * from './tool-policy';
export * from './tool-executor';
export * from './tool-engine';
