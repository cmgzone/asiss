/**
 * Phase 23 — Project Context & Workspace Isolation gates.
 *
 * The fundamental invariant: every piece of context an agent receives and
 * every operation an agent performs must belong to the same active
 * ProjectContext, unless the user explicitly authorizes cross-project access.
 *
 *   1  ASISS project -> read ASISS file                    PASS
 *   2  PikiPOS project -> read PikiPOS file                PASS
 *   3  PikiPOS project -> read ASISS file                  BLOCK
 *   4  PikiPOS -> child Explorer inherits PikiPOS context  PASS
 *   5  PikiPOS memory -> PikiPOS query                     PASS
 *   6  PikiPOS memory -> ASISS-only query                  NO LEAK
 *   7  PikiPOS repo index -> PikiPOS context               PASS
 *   8  PikiPOS context -> ASISS repo index                 BLOCK
 *   9  shell: cd outside workspace                         BLOCK
 *   10 5 parallel sub-agents stay inside the same workspace
 *   11 switch project — old context disappears
 *   12 reload conversation — correct project context restored
 *
 * Run: npm run smoke:phase23 (also part of the battery).
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  GENERAL_PROJECT_ID,
  ProjectContext,
  ProjectContextRegistry,
  WorkspaceBoundaryViolationError,
  assertWorkspacePath,
  inspectShellCommand,
  projectContextFromParts,
  validateProjectContext,
  validateToolContext
} from '../src/core/project-context';
import { assertChildProjectConsistency } from '../src/core/agent/agent-engine';
import {
  ProjectMemoryStore,
  ProjectMemoryBridge
} from '../src/core/memory-unified/project-memory';
import { UnifiedMemoryCatalog } from '../src/core/memory-unified/memory-catalog';
import { buildPersistentIndex, repositoryIndexBelongsTo } from '../src/core/context/repo-index';
import { ContextEngine } from '../src/core/context/context-engine';
import { ExecutionBackendManager } from '../src/core/execution-backend';
import { ReadFileSkill, WriteFileSkill } from '../src/skills/filesystem';
import { projectContextFromParams } from '../src/skills/workspace-guard';

function tmpWorkspace(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `phase23-${label}-`));
}

function project(label: string, root: string): ProjectContext {
  return validateProjectContext({
    projectId: label.toLowerCase(),
    projectName: label,
    workspaceRoot: root
  });
}

async function main() {
  const asissRoot = tmpWorkspace('asiss');
  const pikiposRoot = tmpWorkspace('pikipos');
  const asissCtx = project('ASISS', asissRoot);
  const pikiposCtx = project('PikiPOS', pikiposRoot);

  // ------------------------------------------------------------------ 1/2/3
  // Filesystem boundary through the real skills.
  fs.writeFileSync(path.join(asissRoot, 'server.ts'), 'export const server = 1;\n');
  fs.writeFileSync(path.join(pikiposRoot, 'checkout.ts'), 'export const checkout = 2;\n');

  const read = new ReadFileSkill();
  const write = new WriteFileSkill();

  const asissRead = await read.execute({ path: 'server.ts', __projectContext: asissCtx });
  assert.strictEqual(asissRead.success, true, 'ASISS project can read its own file');
  assert.ok(String(asissRead.content).includes('server'), 'ASISS file content returned');
  console.log('1.  ASISS project -> read ASISS file                PASS');

  const pikiRead = await read.execute({ path: 'checkout.ts', __projectContext: pikiposCtx });
  assert.strictEqual(pikiRead.success, true, 'PikiPOS project can read its own file');
  assert.ok(String(pikiRead.content).includes('checkout'), 'PikiPOS file content returned');
  console.log('2.  PikiPOS project -> read PikiPOS file            PASS');

  // Absolute path into the OTHER workspace must be blocked.
  const crossRead = await read.execute({ path: path.join(asissRoot, 'server.ts'), __projectContext: pikiposCtx });
  assert.strictEqual(crossRead.success, false, 'cross-project read must fail');
  assert.strictEqual(crossRead.code, 'WORKSPACE_BOUNDARY_VIOLATION', 'structured violation code');
  assert.ok(String(crossRead.error).includes('WORKSPACE_BOUNDARY_VIOLATION'), 'structured violation message');
  assert.strictEqual(crossRead.activeProject, 'PikiPOS', 'violation reports the active project');
  assert.strictEqual(crossRead.requestedPath, path.resolve(path.join(asissRoot, 'server.ts')), 'violation reports the requested path');
  console.log('3.  PikiPOS project -> read ASISS file              BLOCK');

  // Relative escape (../../) must be blocked too.
  const escapeRead = await read.execute({ path: '../ASISS/server.ts', __projectContext: pikiposCtx });
  assert.strictEqual(escapeRead.success, false, 'relative escape must fail');
  assert.strictEqual(escapeRead.code, 'WORKSPACE_BOUNDARY_VIOLATION', 'escape produces the same code');
  console.log('    (relative ../ escape into ASISS also blocked)');

  // Writes outside the workspace are blocked as well.
  const crossWrite = await write.execute({ path: path.join(asissRoot, 'hacked.ts'), content: 'x', __projectContext: pikiposCtx });
  assert.strictEqual(crossWrite.success, false, 'cross-project write must fail');
  assert.strictEqual(crossWrite.code, 'WORKSPACE_BOUNDARY_VIOLATION', 'write violation code');
  console.log('    (write_file across projects also blocked)');

  // ---------------------------------------------------------------------- 4
  // Sub-agents inherit the parent ProjectContext; a mismatch is a hard block.
  assert.strictEqual(
    assertChildProjectConsistency({ projectId: 'pikipos', workspacePath: pikiposRoot }, pikiposCtx, "parent task 'mission'"),
    null,
    'PikiPOS parent -> PikiPOS child allowed'
  );
  const mismatch = assertChildProjectConsistency({ projectId: 'pikipos', workspacePath: pikiposRoot }, asissCtx, "parent task 'mission'");
  assert.ok(mismatch && mismatch.includes('pikipos'), 'PikiPOS parent -> ASISS child blocked');
  assert.ok(mismatch && mismatch.includes('cross-project authorization'), 'block names the authorization requirement');
  console.log('4.  PikiPOS -> child Explorer inherits PikiPOS ctx  PASS');

  // ------------------------------------------------------------------ 5/6
  // Memory is project-scoped by construction.
  const dataPath = path.join(tmpWorkspace('mem'), 'project-memory.json');
  const store = new ProjectMemoryStore({ dataPath });
  store.upsert({
    id: 'pikipos:practice:pos-flow',
    workspaceRoot: pikiposRoot,
    kind: 'practice',
    title: 'POS flow',
    content: 'PikiPOS checkout flow uses stripe-pay and local tax tables.',
    origin: 'manual',
    importance: 3,
    confidence: 0.9,
    createdAt: Date.now(),
    updatedAt: Date.now()
  });
  store.upsert({
    id: 'asiss:practice:engine-loop',
    workspaceRoot: asissRoot,
    kind: 'practice',
    title: 'Engine loop',
    content: 'ASISS mission loop runs runMission with a turn budget.',
    origin: 'manual',
    importance: 3,
    confidence: 0.9,
    createdAt: Date.now(),
    updatedAt: Date.now()
  });
  const catalog = new UnifiedMemoryCatalog();
  const bridge = new ProjectMemoryBridge({ store, catalog });
  const hits = bridge.retrieve(pikiposCtx, 'stripe-pay checkout tax', { limit: 5 });
  assert.ok(hits.some(h => String(h.content).includes('stripe-pay')), 'PikiPOS query finds PikiPOS memory');
  console.log('5.  PikiPOS memory -> PikiPOS query                 PASS');

  // A query that ONLY matches ASISS content must never surface ASISS memory
  // for the PikiPOS project — even though the semantic query matches ASISS
  // perfectly and PikiPOS has no matching content.
  const leakHits = bridge.retrieve(pikiposCtx, 'ASISS mission loop runMission turn budget', { limit: 5 });
  assert.ok(
    !leakHits.some(h => String(h.content).includes('mission loop') || String(h.metadata?.workspaceRoot) === asissRoot),
    'ASISS-only query must not leak ASISS memory into PikiPOS'
  );
  const catalogLeak = catalog.retrieve('ASISS mission loop runMission turn budget', {
    projectContext: pikiposCtx,
    limit: 5
  });
  assert.ok(
    !catalogLeak.some(h => String(h.content).includes('mission loop') || String(h.metadata?.workspaceRoot) === asissRoot),
    'catalog-level filter prevents the leak'
  );
  // The inverse also holds: the ASISS project never sees PikiPOS memory.
  const asissLeak = catalog.retrieve('stripe-pay checkout tax', {
    projectContext: asissCtx,
    limit: 5
  });
  assert.ok(
    !asissLeak.some(h => String(h.metadata?.workspaceRoot) === pikiposRoot),
    'PikiPOS memory never leaks into ASISS retrieval'
  );
  console.log('6.  PikiPOS memory -> ASISS-only query              NO LEAK');

  // ------------------------------------------------------------------ 7/8
  // Repository indexes are project-owned.
  const repoDataRoot = tmpWorkspace('repo');
  const pikiIndex = buildPersistentIndex(pikiposRoot, {}, 'pikipos');
  const asissIndex = buildPersistentIndex(asissRoot, {}, 'asiss');
  assert.ok(repositoryIndexBelongsTo(pikiIndex, pikiposCtx), 'PikiPOS index belongs to PikiPOS context');
  assert.ok(repositoryIndexBelongsTo(asissIndex, asissCtx), 'ASISS index belongs to ASISS context');
  console.log('7.  PikiPOS repo index -> PikiPOS context           PASS');

  assert.ok(!repositoryIndexBelongsTo(pikiIndex, asissCtx), 'PikiPOS index must NOT belong to ASISS context');
  assert.ok(!repositoryIndexBelongsTo(asissIndex, pikiposCtx), 'ASISS index must NOT belong to PikiPOS context');

  // Same workspace root but a DIFFERENT projectId: the index ownership check
  // must refuse to serve it (requested projectId -> index.projectId MATCH).
  const engine = new ContextEngine({ config: { repository: { persistent: true, dataRoot: repoDataRoot } } });
  engine.refreshRepository(pikiposCtx, { force: true });
  const pikiposSection = engine.repositorySection(pikiposCtx, 'checkout');
  assert.ok(pikiposSection.includes('checkout.ts') || pikiposSection.length > 0, 'PikiPOS context gets PikiPOS repository context');
  const impostor = validateProjectContext({
    projectId: 'asiss',
    projectName: 'ASISS',
    workspaceRoot: pikiposRoot // same folder, different project identity
  });
  const impostorSection = engine.repositorySection(impostor, 'checkout');
  assert.strictEqual(impostorSection, '', 'impostor project must NOT receive the PikiPOS index');
  console.log('8.  PikiPOS context -> ASISS repo index             BLOCK');

  // ---------------------------------------------------------------------- 9
  // Shell: `cd` outside the workspace is rejected; plan cwd defaults to the
  // workspace root and is asserted inside it.
  const cdViolation = inspectShellCommand(`cd ${JSON.stringify(asissRoot)}`, pikiposCtx);
  assert.ok(cdViolation && cdViolation.includes('WORKSPACE_BOUNDARY_VIOLATION'), 'cd into another workspace rejected');
  assert.ok(cdViolation.includes(asissRoot), 'violation names the requested directory');
  const cdDotDot = inspectShellCommand('cd .. && ls', pikiposCtx);
  assert.ok(cdDotDot && cdDotDot.includes('WORKSPACE_BOUNDARY_VIOLATION'), 'cd .. escaping the workspace rejected');
  assert.strictEqual(inspectShellCommand('cd src && ls', pikiposCtx), null, 'cd inside the workspace allowed');
  assert.strictEqual(inspectShellCommand('npm test', pikiposCtx), null, 'plain commands allowed');

  const cfgDir = tmpWorkspace('cfg');
  const backend = new ExecutionBackendManager(path.join(cfgDir, 'config.json'));
  const plan = backend.createPlan('ls', pikiposRoot, pikiposCtx);
  assert.strictEqual(plan.cwd, pikiposRoot, 'shell cwd defaults to the workspace root');
  assert.throws(
    () => backend.createPlan('ls', asissRoot, pikiposCtx),
    (err: any) => err?.code === 'WORKSPACE_BOUNDARY_VIOLATION',
    'execution backend rejects a cwd outside the workspace'
  );
  console.log('9.  shell: cd outside workspace                     BLOCK');

  // --------------------------------------------------------------------- 10
  // Five parallel sub-agents all inherit + stay inside the same workspace.
  const parallelChildren = Array.from({ length: 5 }, (_, i) => ({
    name: `Explorer ${i + 1}`,
    parent: { projectId: 'pikipos', workspacePath: pikiposRoot },
    child: pikiposCtx
  }));
  for (const child of parallelChildren) {
    assert.strictEqual(assertChildProjectConsistency(child.parent, child.child), null, `${child.name} inherits PikiPOS`);
  }
  const allInside = parallelChildren.every(c => c.child.workspaceRoot === pikiposRoot);
  assert.ok(allInside, 'all 5 parallel children share pikiposRoot');
  console.log('10. 5 parallel sub-agents stay in the same workspace PASS');

  // --------------------------------------------------------------------- 11
  // switchProject: the old context disappears from the active execution.
  const reg = new ProjectContextRegistry({ bindingsPath: path.join(tmpWorkspace('reg'), 'bindings.json') });
  const userId = 'user-alice';
  reg.setActiveProject(userId, pikiposCtx);
  assert.strictEqual(reg.activeProjectFor(userId)?.projectId, 'pikipos', 'active project is PikiPOS');
  reg.switchProject(userId, asissCtx);
  const active = reg.activeProjectFor(userId);
  assert.strictEqual(active?.projectId, 'asiss', 'after switch, active project is ASISS');
  assert.notStrictEqual(active?.workspaceRoot, pikiposRoot, 'old workspace is gone from the active execution');
  // validateToolContext catches a stale tool attribution after the switch.
  assert.throws(
    () => validateToolContext({ projectId: 'pikipos', workspaceRoot: pikiposRoot }, asissCtx, 'read_file'),
    (err: any) => err?.code === 'WORKSPACE_BOUNDARY_VIOLATION',
    'stale PikiPOS tool attribution blocked after switch'
  );
  // Explicit cross-project authorization is the sanctioned escape.
  reg.authorizeCrossProjectAccess(userId, 'pikipos');
  assert.ok(reg.isCrossProjectAuthorized(userId, 'pikipos'), 'authorization recorded');
  console.log('11. switch project — old context disappears          PASS');

  // --------------------------------------------------------------------- 12
  // Reload: a conversation binding survives a registry re-instantiation.
  const bindingsPath = path.join(tmpWorkspace('bind'), 'bindings.json');
  const regA = new ProjectContextRegistry({ bindingsPath });
  const convId = 'conv-pikipos-42';
  regA.bindConversation(convId, pikiposCtx);
  const regB = new ProjectContextRegistry({ bindingsPath });
  const restored = regB.projectForConversation(convId);
  assert.ok(restored, 'conversation binding restored after reload');
  assert.strictEqual(restored?.projectId, 'pikipos', 'restored project id');
  assert.strictEqual(restored?.workspaceRoot, pikiposRoot, 'restored workspace root');
  assert.strictEqual(restored?.conversationId, convId, 'restored conversation id');
  console.log('12. reload conversation — project context restored   PASS');

  // ------------------------------------------------------------------ extra
  // Validation contract.
  assert.throws(() => validateProjectContext({ projectId: '', workspaceRoot: pikiposRoot }), /projectId is required/);
  assert.throws(() => validateProjectContext({ projectId: 'x', workspaceRoot: 'relative/path' }), /must be absolute/);
  assert.throws(
    () => validateProjectContext({ projectId: 'x', workspaceRoot: pikiposRoot, repositoryRoot: asissRoot }),
    /inside workspaceRoot/,
    'repositoryRoot outside workspaceRoot rejected'
  );
  const fromParts = projectContextFromParts({ projectId: 'pikipos', projectName: 'PikiPOS', workspacePath: pikiposRoot, conversationId: 'c1' });
  assert.strictEqual(fromParts?.projectId, 'pikipos', 'legacy parts migrate into the canonical context');
  assert.strictEqual(projectContextFromParams({ __projectContext: pikiposCtx })?.projectId, 'pikipos', 'skills read the canonical context');
  assert.ok(assertWorkspacePath(path.join(pikiposRoot, 'src', 'App.tsx'), pikiposCtx).startsWith(pikiposRoot), 'in-workspace path allowed');
  assert.throws(() => assertWorkspacePath(path.join(asissRoot, 'src', 'server.ts'), pikiposCtx), WorkspaceBoundaryViolationError);
  assert.strictEqual(GENERAL_PROJECT_ID, 'general', 'general identifier constant');
  console.log('    validation + migration contract also holds');

  console.log('phase23: Project Context & Workspace Isolation contract holds (12 gates + extras)');
}

try {
  void main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
} catch (error) {
  console.error(error);
  process.exit(1);
}
