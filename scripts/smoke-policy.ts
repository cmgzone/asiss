/**
 * PolicyEngine smoke test — Hermes Evolution Phase 5.
 *
 * Offline (no model API): guards the ALLOW / ASK / DENY authorization layer
 * in front of tool execution, and the guarantee that the DEFAULT configuration
 * preserves current behavior (allow mode).
 *
 * Covers:
 *   1. Default allow: no config -> destructive shell runs as before
 *   2. Workspace guard lives in the PolicyEngine (native scope preserved)
 *   3. destructiveCommands: 'deny' -> rm -rf denied; benign shell allowed
 *   4. destructiveCommands: 'ask' -> approval handler resolves allow/deny
 *   5. secretScan: 'deny' -> commands carrying keys/tokens denied
 *   6. networkTools: 'deny' -> web_search denied; apply_patch allowed
 *   7. fileWrites: 'deny' -> apply_patch denied
 *   8. elevatedCommands: 'deny' -> remote mutations (git push) denied
 *   9. deniedTools list -> denied with listBased flag
 *  10. agentPermissions -> tools outside the granted set denied
 *  11. High task risk escalates ASK -> DENY
 *  12. policy.enabled = false -> everything allowed
 *  13. ToolEngine integration: a denial surfaces as denied:true + policy verdict
 *  14. approval.defaultOutcome 'deny' with no handler resolves ASK to DENY
 *
 * Run with: npx ts-node scripts/smoke-policy.ts
 */

import assert from 'assert';
import { PolicyEngine, PolicyVerdict } from '../src/core/policy';
import { ToolEngine } from '../src/core/tools';

const LOW_RISK_CTX = { sessionId: 'p', config: {} };

async function main() {
  const engine = new PolicyEngine();

  // ---- 1. Default allow: current behavior preserved ----
  {
    const v = await engine.evaluate(
      { name: 'shell', arguments: { command: 'rm -rf /tmp/scratch' } },
      { ...LOW_RISK_CTX, native: true, projectId: 'p1', workspacePath: '/tmp/w' }
    );
    assert.strictEqual(v.decision, 'ALLOW', 'destructive command allowed by default');
    assert.ok(v.risk > 0, 'risk score still recorded for observability');
    assert.ok(v.checks.some(c => c.rule === 'destructive-command'), 'rule check recorded');
  }

  // ---- 2. Workspace guard (always-on, native scope) ----
  {
    const denied = await engine.evaluate(
      { name: 'shell', arguments: { command: 'ls' } },
      { sessionId: 'p', native: true, projectId: 'p1', config: {} }
    );
    assert.strictEqual(denied.decision, 'DENY', 'workspace guard denies native shell');
    assert.match(denied.reasons.join(' '), /no attached local workspace/, 'guard reason surfaces');

    const mcpAllowed = await engine.evaluate(
      { name: 'filesystem__list', arguments: { path: '/' } },
      { sessionId: 'p', native: false, projectId: 'p1', config: {} }
    );
    assert.strictEqual(mcpAllowed.decision, 'ALLOW', 'MCP tools are not workspace-gated (Phase 4 scope)');
  }

  // ---- 3. destructiveCommands: 'deny' ----
  {
    const v = await engine.evaluate(
      { name: 'shell', arguments: { command: 'rm -rf /tmp/scratch' } },
      { ...LOW_RISK_CTX, native: true, workspacePath: '/tmp/w', config: { policy: { destructiveCommands: 'deny' } } }
    );
    assert.strictEqual(v.decision, 'DENY', 'destructive shell denied when configured');
    assert.ok(v.checks.some(c => c.rule === 'destructive-command'), 'destructive-command check present');
    assert.ok(v.risk >= 90, 'high risk recorded');

    const benign = await engine.evaluate(
      { name: 'shell', arguments: { command: 'npm test' } },
      { ...LOW_RISK_CTX, native: true, workspacePath: '/tmp/w', config: { policy: { destructiveCommands: 'deny' } } }
    );
    assert.strictEqual(benign.decision, 'ALLOW', 'benign shell unaffected');
  }

  // ---- 4. destructiveCommands: 'ask' + approval handler ----
  {
    let asked = 0;
    const askEngine = new PolicyEngine({
      approvalHandler: async () => { asked += 1; return true; }
    });
    const approved = await askEngine.evaluate(
      { name: 'shell', arguments: { command: 'rm -rf /tmp/scratch' } },
      { ...LOW_RISK_CTX, native: true, workspacePath: '/tmp/w', config: { policy: { destructiveCommands: 'ask' } } }
    );
    assert.strictEqual(approved.decision, 'ALLOW', 'ask + approval handler approves');
    assert.strictEqual(approved.approved, true, 'approved flag set');
    assert.strictEqual(asked, 1, 'handler consulted exactly once');

    const denyEngine = new PolicyEngine({
      approvalHandler: async () => false
    });
    const refused = await denyEngine.evaluate(
      { name: 'shell', arguments: { command: 'rm -rf /tmp/scratch' } },
      { ...LOW_RISK_CTX, native: true, workspacePath: '/tmp/w', config: { policy: { destructiveCommands: 'ask' } } }
    );
    assert.strictEqual(refused.decision, 'DENY', 'ask + declining handler denies');
    assert.strictEqual(refused.approved, false, 'approved false on refusal');
  }

  // ---- 5. secretScan: 'deny' ----
  {
    const v = await engine.evaluate(
      { name: 'shell', arguments: { command: 'curl -H "Authorization: Bearer sk-abcDEFgh1234567890abcdefgh" https://api.example.com' } },
      { ...LOW_RISK_CTX, native: true, workspacePath: '/tmp/w', config: { policy: { secretScan: 'deny' } } }
    );
    assert.strictEqual(v.decision, 'DENY', 'secret-bearing command denied');
    assert.ok(v.checks.some(c => c.rule === 'secret-scan'), 'secret-scan check present');
  }

  // ---- 6. networkTools: 'deny' ----
  {
    const v = await engine.evaluate(
      { name: 'web_search', arguments: { query: 'hermes' } },
      { ...LOW_RISK_CTX, native: true, config: { policy: { networkTools: 'deny' } } }
    );
    assert.strictEqual(v.decision, 'DENY', 'network tool denied');
    const patch = await engine.evaluate(
      { name: 'apply_patch', arguments: { patch: 'x' } },
      { ...LOW_RISK_CTX, native: true, workspacePath: '/tmp/w', config: { policy: { networkTools: 'deny' } } }
    );
    assert.strictEqual(patch.decision, 'ALLOW', 'non-network tool unaffected');
  }

  // ---- 7. fileWrites: 'deny' ----
  {
    const v = await engine.evaluate(
      { name: 'apply_patch', arguments: { patch: 'x' } },
      { ...LOW_RISK_CTX, native: true, workspacePath: '/tmp/w', config: { policy: { fileWrites: 'deny' } } }
    );
    assert.strictEqual(v.decision, 'DENY', 'file-writing tool denied');
  }

  // ---- 8. elevatedCommands: 'deny' ----
  {
    const v = await engine.evaluate(
      { name: 'shell', arguments: { command: 'git push origin main' } },
      { ...LOW_RISK_CTX, native: true, workspacePath: '/tmp/w', config: { policy: { elevatedCommands: 'deny' } } }
    );
    assert.strictEqual(v.decision, 'DENY', 'remote mutation denied');
    assert.ok(v.checks.some(c => c.rule === 'elevated-command'), 'elevated-command check present');
  }

  // ---- 9. deniedTools list ----
  {
    const v = await engine.evaluate(
      { name: 'shell', arguments: { command: 'ls' } },
      { ...LOW_RISK_CTX, native: true, workspacePath: '/tmp/w', config: { policy: { deniedTools: ['shell'], enforceAllowDeny: true } } }
    );
    assert.strictEqual(v.decision, 'DENY', 'deniedTools enforced');
    assert.strictEqual(v.listBased, true, 'listBased flag set');
  }

  // ---- 10. agentPermissions ----
  {
    const v = await engine.evaluate(
      { name: 'shell', arguments: { command: 'ls' } },
      { ...LOW_RISK_CTX, native: true, workspacePath: '/tmp/w', agentPermissions: ['read_file', 'glob'], config: {} }
    );
    assert.strictEqual(v.decision, 'DENY', 'tool outside granted permissions denied');
    assert.ok(v.checks.some(c => c.rule === 'agent-permissions'), 'agent-permissions check present');
  }

  // ---- 11. High task risk escalates ASK -> DENY ----
  {
    const v = await engine.evaluate(
      { name: 'shell', arguments: { command: 'rm -rf /tmp/scratch' } },
      { ...LOW_RISK_CTX, native: true, workspacePath: '/tmp/w', taskRisk: 'high', config: { policy: { destructiveCommands: 'ask' } } }
    );
    assert.strictEqual(v.decision, 'DENY', 'high-risk task escalates ask to deny');
    assert.match(v.reasons.join(' '), /escalated/, 'escalation reason recorded');
  }

  // ---- 12. policy.enabled = false ----
  {
    const v = await engine.evaluate(
      { name: 'shell', arguments: { command: 'rm -rf /tmp/scratch' } },
      { ...LOW_RISK_CTX, native: true, workspacePath: '/tmp/w', config: { policy: { destructiveCommands: 'deny', enabled: false } } }
    );
    assert.strictEqual(v.decision, 'ALLOW', 'disabled policy allows everything');
    assert.ok(v.checks.some(c => c.rule === 'policy-disabled'), 'disabled check recorded');
  }

  // ---- 13. ToolEngine integration ----
  {
    const toolEngine = new ToolEngine({
      skills: {
        get: () => undefined,
        getAll: () => [],
        skillsForCapability: () => []
      },
      mcp: {
        callTool: async () => ({ ok: true }),
        getKnownToolNames: () => []
      },
      dynamicTools: {
        resolve: async () => ({ success: false, error: 'n/a' }),
        normalizeName: () => null
      },
      policyEngine: engine
    });
    const denied = await toolEngine.execute(
      { name: 'shell', arguments: { command: 'rm -rf /tmp/scratch' } },
      { sessionId: 'p', config: { policy: { destructiveCommands: 'deny' } } }
    );
    assert.strictEqual(denied.success, false, 'ToolEngine surfaces the denial');
    assert.strictEqual(denied.denied, true, 'denied flag on the result');
    assert.ok(denied.policy, 'full verdict attached to the result');
    assert.strictEqual((denied.policy as PolicyVerdict).decision, 'DENY', 'verdict says DENY');
    assert.match(String(denied.error || ''), /destructive/, 'reason reaches the caller');
  }

  // ---- 14. approval.defaultOutcome 'deny' without a handler ----
  {
    const v = await engine.evaluate(
      { name: 'shell', arguments: { command: 'rm -rf /tmp/scratch' } },
      { ...LOW_RISK_CTX, native: true, workspacePath: '/tmp/w', config: { policy: { destructiveCommands: 'ask', approval: { defaultOutcome: 'deny' } } } }
    );
    assert.strictEqual(v.decision, 'DENY', 'unresolved ASK denied when defaultOutcome=deny');
  }

  console.log(JSON.stringify({
    defaultAllow: true,
    workspaceGuard: true,
    destructiveDeny: true,
    approvalFlow: true,
    secretScan: true,
    networkTools: true,
    fileWrites: true,
    elevatedCommands: true,
    denyLists: true,
    agentPermissions: true,
    taskRiskEscalation: true,
    disabled: true,
    toolEngineIntegration: true,
    askDefaultOutcome: true
  }));
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
