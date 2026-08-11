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
import { PolicyEngine, PolicyVerdict, ApprovalCoordinator } from '../src/core/policy';
import { ToolEngine } from '../src/core/tools';
import { TaskEngine, TaskStore, TaskEventBus, TaskEvent } from '../src/core/task';

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

  // ---- 15. ApprovalCoordinator: the finished ASK path ----
  {
    const bus = new TaskEventBus();
    const taskEngine = new TaskEngine({ store: new TaskStore({ filePath: '' }) });
    const coordinator = new ApprovalCoordinator({ bus, taskEngine, timeoutMs: 50 });
    const events: TaskEvent[] = [];
    bus.on('*', (e) => { events.push(e); });

    const task = await taskEngine.create({ goal: 'needs approval', kind: 'mission' });
    await taskEngine.analyze(task.id);
    await taskEngine.plan(task.id);
    await taskEngine.start(task.id);

    // PolicyEngine ASK -> coordinator.requestApproval, then user allows.
    const policyWithApproval = new PolicyEngine({
      approvalHandler: (v, ctx) => coordinator.requestApproval(v, ctx)
    });
    const ctx = { sessionId: 's-approval', taskId: task.id, native: true, workspacePath: '/tmp/w', config: { policy: { destructiveCommands: 'ask' } } };
    const pendingVerdict = policyWithApproval.evaluate(
      { name: 'shell', arguments: { command: 'rm -rf /tmp/scratch' } },
      ctx
    );
    assert.strictEqual(coordinator.pendingCount(), 1, 'approval registered as pending');
    const req = coordinator.listPending()[0];
    assert.strictEqual(req.tool, 'shell', 'approval carries the tool name');
    assert.strictEqual(req.riskLabel, 'high', 'risk label derived from verdict risk');
    assert.ok(req.id, 'approval has an id');

    const required = events.find((e) => e.name === 'ApprovalRequired');
    assert.ok(required, 'ApprovalRequired emitted on the bus');
    assert.strictEqual(required!.data?.approvalId, req.id, 'event carries the approval id');
    assert.strictEqual(required!.data?.sessionId, 's-approval', 'event carries the session');
    assert.strictEqual(required!.taskId, task.id, 'event is attributed to the task');

    // User allows: the waiting evaluate() resolves to ALLOW.
    const [allowedResult, grantedPromise] = await Promise.all([
      pendingVerdict,
      coordinator.resolveApproval(req.id, true, { userId: 'u-1' })
    ]);
    const allowedVerdict = await allowedResult;
    assert.strictEqual(allowedVerdict.decision, 'ALLOW', 'allowed approval executes the tool');
    assert.strictEqual(allowedVerdict.approved, true, 'approved flag on the verdict');
    assert.strictEqual(coordinator.pendingCount(), 0, 'approval consumed');
    assert.ok(events.some((e) => e.name === 'ApprovalGranted'), 'ApprovalGranted emitted');
    assert.ok(events.some((e) => e.name === 'ApprovalGranted' && e.data?.userId === 'u-1'), 'decision carries the user');
    const stored = taskEngine.get(task.id)!;
    assert.ok(stored.decisions.some((d) => d.summary.includes("User approved tool 'shell'")), 'decision recorded on the canonical Task');
    assert.ok(grantedPromise && grantedPromise.status === 'allowed', 'approval request status updated');

    // User denies a second request.
    const deniedVerdict = policyWithApproval.evaluate(
      { name: 'shell', arguments: { command: 'rm -rf /tmp/scratch' } },
      ctx
    );
    const req2 = coordinator.listPending()[0];
    await coordinator.resolveApproval(req2.id, false, { userId: 'u-2' });
    assert.strictEqual((await deniedVerdict).decision, 'DENY', 'denied approval blocks the tool');
    assert.ok(events.some((e) => e.name === 'ApprovalDenied' && e.data?.allowed === false), 'ApprovalDenied emitted');

    // Unknown id is a no-op.
    assert.strictEqual(await coordinator.resolveApproval('missing-id', true), undefined, 'unknown approval resolves to nothing');

    // Timeout (50ms) fails closed by default and emits ApprovalDenied.
    const timedOut = policyWithApproval.evaluate(
      { name: 'shell', arguments: { command: 'rm -rf /tmp/scratch' } },
      ctx
    );
    assert.strictEqual(coordinator.pendingCount(), 1, 'third approval pending');
    const timedOutVerdict = await timedOut;
    assert.strictEqual(timedOutVerdict.decision, 'DENY', 'unanswered approval fails closed');
    assert.ok(events.some((e) => e.name === 'ApprovalDenied' && /timed out/.test(String(e.data?.note || ''))), 'timeout recorded in the decision event');
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
    askDefaultOutcome: true,
    approvalCoordinator: true
  }));
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
