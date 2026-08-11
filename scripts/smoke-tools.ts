/**
 * ToolEngine smoke test — Hermes Evolution Phase 4.
 *
 * Offline (no model API, fake skills/MCP): guards the canonical tool lifecycle
 * extracted from AgentRunner:
 *   normalize -> validate -> authorize -> execute -> normalize result -> record
 *
 * Covers:
 *   1. normalizeToolRequest: registered names pass through, MCP prefixes are
 *      stripped, playwright/browser aliases fold onto the native skill,
 *      hallucinated names are alias-resolved
 *   2. Native skill success + session-arg injection + output normalization
 *   3. Native skill failure + semantic fallback to a capability-alternative
 *   4. Workspace policy: DENY for shell/apply_patch/write_file without a
 *      workspace; ALLOW otherwise
 *   5. MCP tool execution with dynamic resolution for unknown names
 *   6. Task recording: STARTED -> COMPLETED / FAILED, checkpoints, telemetry
 *   7. ToolEngine never throws for tool failures
 *
 * Run with: npx ts-node scripts/smoke-tools.ts
 */

import assert from 'assert';
import { ToolEngine, normalizeToolRequest } from '../src/core/tools';
import { TaskEngine, TaskStore } from '../src/core/task';
import { SkillRegistryLike, McpGateway, DynamicToolGateway } from '../src/core/tools/tool-registry';

// ---- Fakes ----------------------------------------------------------------

function fakeSkill(name: string, opts: {
  execute?: (args: any) => any;
  capabilities?: string[];
} = {}): any {
  return {
    name,
    description: `fake ${name}`,
    capabilities: opts.capabilities,
    execute: opts.execute || (async () => ({ ok: true, name })),
    calls: [] as any[]
  };
}

const registry = {
  skills: new Map<string, any>(),
  get(name: string) { return this.skills.get(name); },
  getAll() { return Array.from(this.skills.values()); },
  skillsForCapability(cap: string) {
    return this.getAll()
      .filter((s) => (s.capabilities || []).includes(cap))
      .map((s) => s.name);
  }
};
function register(skill: any) {
  (registry.skills as Map<string, any>).set(skill.name, skill);
}

const mcp: McpGateway = {
  callTool(name: string, args: any) {
    if (name === 'filesystem__list') return Promise.resolve({ files: ['a.txt'] });
    return Promise.reject(new Error(`Tool '${name}' not found in any connected MCP server`));
  },
  getKnownToolNames() { return ['filesystem__list', 'db__query']; }
};

const dynamic: DynamicToolGateway = {
  async resolve(name: string, args: any, sessionId?: string) {
    if (name === 'mcp__filesystem__write') return { success: true, output: 'file contents', tool: 'write_file' };
    return { success: false, error: 'cannot create' };
  },
  normalizeName(name: string) {
    const m = String(name || '').match(/^(?:mcp[_-]+|.*__)([a-z0-9_]+)$/i);
    return m ? m[1].toLowerCase().replace(/_+/g, '_') : null;
  }
};

// ---- Track telemetry + task recording -------------------------------------

const analyticsCalls: Array<{ sessionId: string; tool: string; success: boolean }> = [];
const analytics = {
  recordToolCallResult(sessionId: string, tool: string, success: boolean) {
    analyticsCalls.push({ sessionId, tool, success });
  }
};

const taskEngine = new TaskEngine({ store: new TaskStore({ filePath: '' }) });

const engine = new ToolEngine({
  skills: registry as any,
  mcp: mcp as any,
  dynamicTools: dynamic as any,
  analytics,
  taskEngine,
  checkpoints: {
    create: () => ({ id: 'cp-1', reason: 'Before shell' }),
    shouldCheckpointShell: () => true
  }
});

// ---- 1. Name normalization -------------------------------------------------

async function main() {
  {
    const norm = normalizeToolRequest({ name: 'apply_patch', arguments: { patch: 'x' } }, registry as any, (n) => dynamic.normalizeName(n));
    assert.strictEqual(norm.name, 'apply_patch', 'registered name passes through');
    assert.deepStrictEqual(norm.arguments, { patch: 'x' }, 'args preserved');

    const stripped = normalizeToolRequest({ name: 'mcp__filesystem__read_file', arguments: { path: '/' } }, registry as any, (n) => dynamic.normalizeName(n));
    assert.strictEqual(stripped.name, 'read_file', 'mcp prefix strips to registered skill');

    const pw = normalizeToolRequest({ name: 'playwright_screenshot', arguments: { url: 'https://x.dev' } }, registry as any, (n) => dynamic.normalizeName(n));
    assert.strictEqual(pw.name, 'playwright', 'playwright alias folds onto native skill');
    assert.strictEqual(pw.arguments!.action, 'screenshot', 'action adapted from suffix');

    const alias = normalizeToolRequest({ name: 'spawn_subagent', arguments: {} }, registry as any, (n) => dynamic.normalizeName(n));
    assert.strictEqual(alias.name, 'delegate_agent', 'hallucinated alias resolved');
  }

  // ---- 2. Native success + session args ------------------------------------
  {
    const shellSkill = fakeSkill('shell', {
      execute: (args: any) => {
        shellSkill.calls.push(args);
        return { stdout: 'ok', exitCode: 0 };
      }
    });
    register(shellSkill);
    const task = await taskEngine.create({ goal: 'run a tool', kind: 'mission' });
    await taskEngine.analyze(task.id);
    await taskEngine.plan(task.id);
    await taskEngine.start(task.id);

    const result = await engine.execute(
      { name: 'shell', arguments: { command: 'echo hi' } },
      { sessionId: 's1', taskId: task.id, workspacePath: '/tmp/w', config: { checkpoints: {} } }
    );
    assert.strictEqual(result.success, true, 'native tool succeeds');
    assert.strictEqual(result.source, 'native');
    const args = shellSkill.calls[0];
    assert.strictEqual(args.__sessionId, 's1', 'session id injected');
    assert.strictEqual(args.__workspacePath, '/tmp/w', 'workspace injected');
    assert.strictEqual(typeof result.output, 'string', 'output normalized to string');
    assert.deepStrictEqual(JSON.parse(result.output!).result.stdout, 'ok', 'output JSON-round-trips');
    assert.strictEqual(analyticsCalls.some(c => c.tool === 'shell' && c.success), true, 'telemetry records success');

    const stored = taskEngine.get(task.id)!;
    const exec = stored.toolExecutions.find(e => e.name === 'shell')!;
    assert.ok(exec, 'tool execution recorded on task');
    assert.strictEqual(exec.status, 'COMPLETED', 'task record resolves to COMPLETED');
    assert.strictEqual(typeof exec.durationMs, 'number', 'duration stamped');
  }

  // ---- 3. Native failure + semantic fallback --------------------------------
  {
    const flakySearch = fakeSkill('web_search', {
      capabilities: ['web_search'],
      execute: async () => ({ error: 'rate limited' })
    });
    const pwSkill = fakeSkill('playwright', {
      capabilities: ['web_search'],
      execute: async () => ({ title: 'fallback worked' })
    });
    register(flakySearch);
    register(pwSkill);
    const task = await taskEngine.create({ goal: 'fallback', kind: 'mission' });
    await taskEngine.analyze(task.id);
    await taskEngine.plan(task.id);
    await taskEngine.start(task.id);

    const result = await engine.execute(
      { name: 'web_search', arguments: { query: 'hermes' } },
      { sessionId: 's2', taskId: task.id, config: {} }
    );
    assert.strictEqual(result.success, true, 'semantic fallback succeeds');
    assert.ok(result.fallback, 'fallback reported');
    assert.strictEqual(result.fallback!.requested, 'web_search');
    assert.strictEqual(result.fallback!.resolved, 'playwright');
    assert.strictEqual(JSON.parse(result.output!).title, 'fallback worked', 'fallback output returned');
  }

  // ---- 4. Workspace policy --------------------------------------------------
  {
    const result = await engine.execute(
      { name: 'shell', arguments: { command: 'rm -rf /' } },
      { sessionId: 's3', projectId: 'proj-1', config: {} }
    );
    assert.strictEqual(result.success, false, 'workspace-required tool denied without workspace');
    assert.strictEqual(result.denied, true, 'denial flagged');
    assert.match(String(result.error || ''), /no attached local workspace/, 'denial reason surfaces');

    register(fakeSkill('notes', {
      execute: async () => ({ notes: [] })
    }));
    const allowed = await engine.execute(
      { name: 'notes', arguments: { action: 'read_notes' } },
      { sessionId: 's3', projectId: 'proj-1', config: {} }
    );
    assert.strictEqual(allowed.success, true, 'non-workspace tool allowed');
  }

  // ---- 5. MCP execution + dynamic resolution --------------------------------
  {
    const task = await taskEngine.create({ goal: 'mcp', kind: 'mission' });
    await taskEngine.analyze(task.id);
    await taskEngine.plan(task.id);
    await taskEngine.start(task.id);

    const mcpOk = await engine.execute(
      { name: 'filesystem__list', arguments: { path: '/' } },
      { sessionId: 's4', taskId: task.id, config: {} }
    );
    assert.strictEqual(mcpOk.success, true, 'known MCP tool succeeds');
    assert.strictEqual(mcpOk.source, 'mcp');
    assert.strictEqual(JSON.parse(mcpOk.output!).files[0], 'a.txt');

    const dynOk = await engine.execute(
      { name: 'mcp__filesystem__write', arguments: { path: '/a' } },
      { sessionId: 's4', taskId: task.id, config: {} }
    );
    assert.strictEqual(dynOk.success, true, 'unknown MCP name resolved dynamically');
    assert.ok(dynOk.dynamic, 'dynamic resolution reported');
    assert.strictEqual(dynOk.dynamic!.resolved, 'write_file');
    assert.strictEqual(dynOk.output, 'file contents', 'dynamic output returned');

    const dynFail = await engine.execute(
      { name: 'totally_unknown_xyz', arguments: {} },
      { sessionId: 's4', taskId: task.id, config: {} }
    );
    assert.strictEqual(dynFail.success, false, 'unresolvable name fails cleanly');
    assert.match(String(dynFail.error || ''), /not available/, 'helpful error message');
  }

  // ---- 6. Checkpoint + failure recording on task ----------------------------
  {
    const task = await taskEngine.create({ goal: 'checkpoint', kind: 'mission' });
    await taskEngine.analyze(task.id);
    await taskEngine.plan(task.id);
    await taskEngine.start(task.id);

    const shellSkill = registry.get('shell')!;
    const orig = shellSkill.execute;
    shellSkill.execute = async () => ({ error: 'boom' });
    const failed = await engine.execute(
      { name: 'shell', arguments: { command: 'npm run build' } },
      { sessionId: 's5', taskId: task.id, workspacePath: '/tmp/w', config: { checkpoints: { automaticBeforeDestructiveShell: true } } }
    );
    shellSkill.execute = orig;
    assert.strictEqual(failed.success, false, 'failing tool reported');
    assert.strictEqual(analyticsCalls.some(c => c.tool === 'shell' && !c.success), true, 'telemetry records failure');

    const stored = taskEngine.get(task.id)!;
    const exec = stored.toolExecutions.find(e => e.name === 'shell')!;
    assert.strictEqual(exec.status, 'FAILED', 'task record resolves to FAILED');
    assert.match(String(exec.error || ''), /boom/, 'failure error recorded');
    assert.strictEqual(stored.checkpoints.length, 1, 'automatic checkpoint recorded on task');
    assert.strictEqual(stored.checkpoints[0].id, 'cp-1', 'checkpoint id preserved');
  }

  // ---- 7. Never throws ------------------------------------------------------
  {
    const badMcp: McpGateway = {
      callTool: () => { throw new Error('mcp down'); },
      getKnownToolNames: () => []
    };
    const tempEngine = new ToolEngine({
      skills: registry as any,
      mcp: badMcp as any,
      dynamicTools: dynamic as any,
      analytics
    });
    const result = await tempEngine.execute({ name: 'some_mcp_tool', arguments: {} }, { sessionId: 's6' });
    assert.strictEqual(result.success, false, 'MCP crash surfaces as failure, not throw');
    assert.match(String(result.error || ''), /mcp down/, 'error message preserved');
  }

  console.log(JSON.stringify({
    normalization: true,
    nativeSuccess: true,
    semanticFallback: true,
    workspacePolicy: true,
    mcpAndDynamic: true,
    taskRecording: true,
    neverThrows: true
  }));
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
