/**
 * Tool validator — Hermes Evolution Phase 4.
 *
 * Argument validation before execution. Currently enforces only that arguments
 * are a plain object; schema-driven validation (inputSchema / zod) is the
 * extension point Phase 5+ wires in once policy lives in the engine.
 */

import { ToolRequest } from './tool-result';
import { ToolDescriptor } from './tool-registry';

export interface ToolValidation {
  valid: boolean;
  reason?: string;
}

export function validateToolArguments(request: ToolRequest, descriptor?: ToolDescriptor): ToolValidation {
  if (request.arguments === undefined || request.arguments === null) {
    return { valid: true };
  }
  if (typeof request.arguments !== 'object' || Array.isArray(request.arguments)) {
    return { valid: false, reason: `Tool '${request.name}' arguments must be a JSON object.` };
  }
  // Schema-aware validation is deferred: skills currently own their own
  // argument handling, and enforcing schemas here could reject calls that
  // previously succeeded through defaults. Wired in a later phase.
  return { valid: true };
}
