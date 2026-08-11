/**
 * Policy rules — Hermes Evolution Phase 5.
 *
 * Each rule classifies a tool request and returns a PolicyCheck. A rule
 * "fires" when it recognizes the situation it guards; the decision it returns
 * is driven by configuration (default 'allow', preserving current behavior):
 *
 *   workspace-guard    project missions need an attached workspace for
 *                      shell / apply_patch / write_file          (always DENY)
 *   allow-deny-lists   explicit tool allow/deny lists             (always DENY)
 *   agent-permissions  agent permission allow-list                (always DENY)
 *   destructive-command  rm -rf, git push --force, drop table, ...
 *   secret-scan          commands touching .env / keys / tokens
 *   network-tools        web_search, web_fetch, playwright, ...
 *   file-writes          apply_patch, write_file
 *   elevated-command     remote mutations: privilege escalation, curl|sh,
 *                        git push, npm publish
 */

import { ToolRequest, PolicyCheck, PolicyConfig, TaskRiskLevel } from './policy-types';

/** Native workspace-required tools (moved unchanged from the Phase 4 guard). */
export const WORKSPACE_REQUIRED_TOOLS = ['shell', 'apply_patch', 'write_file'];

/** Tools that reach the network. */
export const NETWORK_TOOLS = new Set([
  'web_search', 'web_fetch', 'brave_search', 'playwright', 'http_get', 'fetch'
]);

/** Workspace-mutating tools. */
export const FILE_WRITE_TOOLS = new Set(['apply_patch', 'write_file']);

/** Shell commands that destroy state. */
export const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\s+-rf?\b/i,
  /\brmdir\s+\/s\b/i,
  /\bformat\s+[a-z]:/i,
  /\bgit\s+push\s+--?force\b/i,
  /\bgit\s+reset\s+--?hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\bgit\s+checkout\s+--?\.\b/i,
  /\bdrop\s+(?:table|database)\b/i,
  /\bdelete\s+from\b/i,
  /\btruncate\s+(?:table\s+)?\S+/i,
  /\bmkfs(?:\.[a-z0-9]+)?\b/i,
  /\bdd\s+if=/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\btaskkill\s+\/f\b/i,
  /\bnet\s+user\b/i,
  /\bchmod\s+-?r?\s*777\b/i,
  /\brm\s+-r\b/i
];

/** Shell commands that look like they handle secrets. */
export const SECRET_PATTERNS: RegExp[] = [
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAWS[A-Z0-9]{16,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bghp_[A-Za-z0-9]{36,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i,
  /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/,
  /\b(?:password|passwd|pwd|token|api[_-]?key|secret)\s*[=:]\s*\S+/i,
  /\b(?:cat|type|get-content|more|less)\s+(?:\S*[\/])?\.env\b/i,
  /\b(?:cat|type|get-content)\s+(?:\S*[\/])?(?:\.env|\.npmrc|\.pypirc|id_rsa|\.netrc)\b/i
];

/** Remote-mutating / elevated commands. */
export const ELEVATED_PATTERNS: RegExp[] = [
  /\bsu(?:do)?\b/i,
  /\bdoas\b/i,
  /\bcurl\s+[^\n|]*\s*\|\s*(?:ba)?sh\b/i,
  /\bwget\s+[^\n|]*\s*-o\s*-\s*\|\s*(?:ba)?sh\b/i,
  /\bgit\s+push\b/i,
  /\bnpm\s+(?:publish|unpublish)\b/i,
  /\bpowershell\s+-command\s+(?:\(|'|")/i
];

export interface RuleInput {
  request: ToolRequest;
  config: PolicyConfig;
  native: boolean;
  projectId?: string;
  workspacePath?: string;
  agentPermissions?: string[];
  taskRisk: TaskRiskLevel;
}

export type RuleResult = PolicyCheck | undefined;

/** command argument string for shell-based rules. */
function shellCommand(request: ToolRequest): string {
  return String((request.arguments as any)?.command || '');
}

function matchAny(patterns: RegExp[], text: string): RegExp | undefined {
  for (const re of patterns) {
    re.lastIndex = 0;
    if (re.test(text)) return re;
  }
  return undefined;
}

/** Native tools need an attached workspace in project-scoped missions. */
export function workspaceGuardRule(input: RuleInput): RuleResult {
  if (input.config.workspaceGuard === false) return undefined;
  if (!input.native) return undefined;
  const { request, projectId, workspacePath } = input;
  if (projectId && !workspacePath && WORKSPACE_REQUIRED_TOOLS.includes(request.name)) {
    return {
      rule: 'workspace-guard',
      decision: 'DENY',
      reason: 'This project has no attached local workspace. Create or select a workspace from the Projects page before running commands or editing files.',
      risk: 95
    };
  }
  return undefined;
}

/** Explicit allow/deny lists (native tools only, matching Phase 4 scope). */
export function allowDenyListsRule(input: RuleInput): RuleResult {
  if (!input.native) return undefined;
  const config = input.config;
  const enforce = config.enforceAllowDeny === true
    || (Array.isArray(config.deniedTools) && config.deniedTools.length > 0)
    || (Array.isArray(config.allowedTools) && config.allowedTools.length > 0);
  if (!enforce) return undefined;
  const denied = new Set(config.deniedTools || []);
  if (denied.has(input.request.name)) {
    return {
      rule: 'allow-deny-lists',
      decision: 'DENY',
      reason: `Tool '${input.request.name}' is denied by policy.`,
      risk: 90,
      config: 'policy.deniedTools'
    };
  }
  const allowed = config.allowedTools;
  if (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes(input.request.name)) {
    return {
      rule: 'allow-deny-lists',
      decision: 'DENY',
      reason: `Tool '${input.request.name}' is not in the allowed tool list.`,
      risk: 90,
      config: 'policy.allowedTools'
    };
  }
  return undefined;
}

/** Agent permission allow-list: tools outside the granted set are DENIED. */
export function agentPermissionsRule(input: RuleInput): RuleResult {
  const granted = input.agentPermissions;
  if (!Array.isArray(granted) || granted.length === 0) return undefined;
  if (!granted.includes(input.request.name)) {
    return {
      rule: 'agent-permissions',
      decision: 'DENY',
      reason: `Tool '${input.request.name}' is not in the agent's granted permissions (${granted.join(', ')}).`,
      risk: 90,
      config: 'agent.permissions'
    };
  }
  return undefined;
}

function configRule(
  rule: string,
  mode: 'allow' | 'ask' | 'deny',
  reason: string,
  risk: number,
  configKey: string
): RuleResult {
  // Always record the check (decision ALLOW in allow mode) so the verdict
  // carries the full risk picture even for calls that ran — observability.
  return { rule, decision: mode.toUpperCase() as 'ALLOW' | 'ASK' | 'DENY', reason, risk, config: configKey };
}

/** Destructive shell commands. */
export function destructiveCommandRule(input: RuleInput): RuleResult {
  const mode = input.config.destructiveCommands || 'allow';
  const command = shellCommand(input.request);
  if (!command) return undefined;
  const match = matchAny(DESTRUCTIVE_PATTERNS, command);
  if (!match) return undefined;
  return configRule(
    'destructive-command',
    mode,
    `Shell command matches destructive pattern /${match.source}/.`,
    90,
    'policy.destructiveCommands'
  );
}

/** Shell commands that look like they handle secrets. */
export function secretScanRule(input: RuleInput): RuleResult {
  const mode = input.config.secretScan || 'allow';
  const command = shellCommand(input.request);
  if (!command) return undefined;
  const match = matchAny(SECRET_PATTERNS, command);
  if (!match) return undefined;
  return configRule(
    'secret-scan',
    mode,
    `Shell command matches secret-handling pattern /${match.source}/.`,
    95,
    'policy.secretScan'
  );
}

/** Tools that reach the network. */
export function networkToolsRule(input: RuleInput): RuleResult {
  const mode = input.config.networkTools || 'allow';
  if (!NETWORK_TOOLS.has(input.request.name)) return undefined;
  return configRule(
    'network-tools',
    mode,
    `Tool '${input.request.name}' accesses the network.`,
    40,
    'policy.networkTools'
  );
}

/** Workspace-mutating tools. */
export function fileWritesRule(input: RuleInput): RuleResult {
  const mode = input.config.fileWrites || 'allow';
  if (!FILE_WRITE_TOOLS.has(input.request.name)) return undefined;
  return configRule(
    'file-writes',
    mode,
    `Tool '${input.request.name}' mutates workspace files.`,
    30,
    'policy.fileWrites'
  );
}

/** Elevated / remote-mutating commands. */
export function elevatedCommandRule(input: RuleInput): RuleResult {
  const mode = input.config.elevatedCommands || 'allow';
  const command = shellCommand(input.request);
  if (command) {
    const match = matchAny(ELEVATED_PATTERNS, command);
    if (match) {
      return configRule(
        'elevated-command',
        mode,
        `Shell command matches elevated/remote-mutation pattern /${match.source}/.`,
        80,
        'policy.elevatedCommands'
      );
    }
  }
  if (input.request.name === 'delegate_agent') {
    return configRule(
      'elevated-command',
      mode,
      "Tool 'delegate_agent' spawns a sub-agent that can perform arbitrary actions.",
      60,
      'policy.elevatedCommands'
    );
  }
  return undefined;
}

/** All built-in rules, in evaluation order. */
export const BUILT_IN_RULES: Array<(input: RuleInput) => RuleResult> = [
  workspaceGuardRule,
  allowDenyListsRule,
  agentPermissionsRule,
  destructiveCommandRule,
  secretScanRule,
  networkToolsRule,
  fileWritesRule,
  elevatedCommandRule
];
