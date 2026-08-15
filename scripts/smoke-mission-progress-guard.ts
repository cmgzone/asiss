/**
 * Mission Progress Guard — regression smoke.
 *
 * Locks the required behavior: read-only inspection loops on implementation
 * tasks must never convert into task completion or a "could not be completed"
 * final. The guard must redirect READ loops toward MUTATION, keep the mission
 * alive, and only complete after actual work + verification:
 *
 *   READ -> READ -> READ -> progress guard -> mutation -> verify -> final
 *
 * Scenarios (per spec):
 *   A. repeated read_file -> apply_patch -> verify -> complete
 *   B. read_file cap -> apply_patch still allowed
 *   C. repeated successful read batch -> continue, NOT fail
 *   D. implementation task with empty admin/api dirs -> still edits frontend
 *   E. model cannot broaden "make landing page professional" into backend work
 *   F. prose-only "I'll implement it now" turns are never progress; repeated
 *      prose-only turns end in a controlled failure, not completion
 *   6. genuinely terminal (research) mission still finalizes on exploration cap
 *   7. failed-tool repetition protection remains intact
 *
 * Mechanics notes (verified against runner.ts):
 *   - the progress guard fires at the 3rd CONSECUTIVE read-only batch request,
 *     BEFORE that batch executes (2 read calls actually run);
 *   - IDENTICAL batches trip the repetition guard first; repeated read-only
 *     batches disable exactly the read tools and continue (never fail);
 *   - per-tool caps only apply when config.agent.unlimitedTools is false, so
 *     scenario B overrides the instance loadConfig with a capped test config;
 *   - fake skills MUST be registered AFTER `new AgentRunner(...)` (the
 *     constructor re-loads learned skills into the shared SkillRegistry);
 *   - `main().then(() => process.exit(0))` required or the MCP child keeps the
 *     process alive (EPIPE noise after exit is harmless).
 *
 * Run with: npm run smoke:mission-progress-guard
 */
import assert from 'assert';
import { AgentRunner } from '../src/agents/runner';
import { ModelProvider, Tool } from '../src/core/models';
import { SkillRegistry } from '../src/core/skills';
import { StreamEventPayload } from '../src/core/types';

const finalReport = [
  '# Executive summary',
  'The landing page has been updated to look professional.',
  '',
  '## Findings',
  '- The hero section now uses the approved brand palette.',
  '- Typography and spacing follow the design system.',
  '- All changes are applied and verified.',
  '',
  '## Details',
  'The implementation is complete and the workspace reflects the requested change. '.repeat(5),
  '',
  '## Sources',
  '- file:///index.html'
].join('\n');

let readFileCalls = 0;
let applyPatchCalls = 0;
let shellCalls = 0;
let codeSearchCalls = 0;
let patchTargets: string[] = [];

function buildGateway(events: StreamEventPayload[], legacyMessages: string[]) {
  return {
    async sendResponse(_sessionId: string, text: string) { legacyMessages.push(text); },
    async sendStreamChunk() {},
    async sendStreamEvent(_sessionId: string, event: StreamEventPayload) { events.push(event); },
    async sendMedia() {},
    listSessionIds() { return []; },
    supportsStructuredStreaming() { return true; }
  };
}

/**
 * Register deterministic fake skills. MUST be called AFTER constructing the
 * AgentRunner: the runner constructor re-loads learned skills into the shared
 * SkillRegistry, which would otherwise shadow these fakes with real tools.
 */
function registerSkills() {
  SkillRegistry.register({
    name: 'read_file', description: 'Read a file',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    async execute() { readFileCalls += 1; return { success: true, message: 'file contents' }; }
  });
  SkillRegistry.register({
    name: 'apply_patch', description: 'Apply an edit',
    inputSchema: { type: 'object', properties: { patch: { type: 'string' }, path: { type: 'string' } } },
    async execute(args: { path?: string }) {
      applyPatchCalls += 1;
      patchTargets.push(String(args?.path || ''));
      return { success: true, message: 'patch applied' };
    }
  });
  SkillRegistry.register({
    name: 'shell', description: 'Run a shell command',
    inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
    async execute(args: { command?: string }) {
      shellCalls += 1;
      if (String(args?.command || '').includes('fail-me')) {
        return { success: false, error: 'boom' };
      }
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    }
  });
  SkillRegistry.register({
    name: 'code_search', description: 'Search code',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    async execute() { codeSearchCalls += 1; return { success: true, message: 'matches' }; }
  });
}

function guardMemories(runner: AgentRunner, sessionId: string): any[] {
  const all = (runner as any).memory.getAll(sessionId);
  return all.filter((m: any) => String(m?.metadata?.type || '').startsWith('mission_'));
}

function finalDoneText(events: StreamEventPayload[]): string | undefined {
  return events.find(e => e.type === 'assistant_done')?.finalText;
}

function allDoneEvents(events: StreamEventPayload[]): any[] {
  return events.filter(e => e.type === 'assistant_done');
}

function finalMemories(runner: AgentRunner, sessionId: string): any[] {
  return (runner as any).memory.getAll(sessionId)
    .filter((m: any) => m.role === 'assistant' && m.metadata?.final);
}

const LANDING_GOAL = 'fix the landing page, it is so ugly';

async function main() {
  // ---- A. repeated read_file -> apply_patch -> verify -> complete ---------
  {
    readFileCalls = 0; applyPatchCalls = 0; shellCalls = 0; codeSearchCalls = 0; patchTargets = [];
    let turn = 0;
    let patched = false;
    let verified = false;
    const toolLists: string[][] = [];
    const events: StreamEventPayload[] = [];
    const legacy: string[] = [];
    const model: ModelProvider = {
      id: 'guard-A-model', name: 'Guard A model',
      async generate(_p, _s, tools: Tool[] = []) {
        turn += 1;
        toolLists.push(tools.map(t => t.name));
        // Identical read_file batch every time — the repetition guard fires
        // at the 3rd identical batch and must disable the read tool, not fail.
        if (tools.some(t => t.name === 'read_file')) {
          return { content: 'Inspecting the workspace.', toolCalls: [{ id: `read-${turn}`, name: 'read_file', arguments: { path: 'index.html' } }] };
        }
        if (tools.some(t => t.name === 'apply_patch') && !patched) {
          patched = true;
          return { content: 'Applying the professional redesign.', toolCalls: [{ id: 'patch-1', name: 'apply_patch', arguments: { path: 'index.html', patch: 'redesign' } }] };
        }
        if (tools.some(t => t.name === 'shell') && !verified) {
          verified = true;
          return { content: 'Verifying the change.', toolCalls: [{ id: 'test-1', name: 'shell', arguments: { command: 'npm test' } }] };
        }
        return { content: finalReport };
      }
    };
    const runner = new AgentRunner(buildGateway(events, legacy));
    (runner as any).getModel = () => model;
    (runner as any).getModelById = () => model;
    registerSkills();
    const sessionId = `guard-A-${Date.now()}`;
    await runner.processMessage(sessionId, {
      id: 'guard-A', channel: 'background', senderId: 'smoke',
      content: LANDING_GOAL,
      timestamp: Date.now(), metadata: { backgroundGoalId: `smoke-guard-A-${Date.now()}` }
    });
    assert.equal(readFileCalls, 2, 'the repetition guard pre-empts the 3rd identical read batch');
    assert.equal(applyPatchCalls, 1, 'the mutation must actually run after inspection stalls');
    assert.equal(shellCalls, 1, 'verification must run after the mutation');
    assert.deepEqual(patchTargets, ['index.html'], 'the mutation targets the landing page');
    const guards = guardMemories(runner, sessionId);
    const allMemories = (runner as any).memory.getAll(sessionId);
    assert.ok(allMemories.some((m: any) => m.metadata?.phase === 'repeated_inspection_disabled'), 'repeated read batch disabled the read tool, did not fail');
    const removed = toolLists.some(list => !list.includes('read_file'));
    assert.ok(removed, 'read_file removed from the tool surface after repetition');
    const dones = allDoneEvents(events);
    assert.equal(dones.length, 1, 'exactly one final response');
    assert.equal(dones[0].ok, true, 'the final response completes the mission');
    assert.equal(finalDoneText(events), finalReport, 'mission completes with the final report');
    const finals = finalMemories(runner, sessionId);
    assert.ok(finals.some((m: any) => m.metadata.completed === true), 'completion requires actual mutation + verification');
    assert.ok(!String(finalDoneText(events) || '').includes('could not be completed'), 'no "could not be completed" final');
    console.log('A. repeated read_file -> apply_patch -> verify -> complete ok');
  }

  // ---- B. read_file cap -> apply_patch still allowed ----------------------
  {
    readFileCalls = 0; applyPatchCalls = 0; shellCalls = 0; codeSearchCalls = 0; patchTargets = [];
    let patched = false;
    const events: StreamEventPayload[] = [];
    const legacy: string[] = [];
    const model: ModelProvider = {
      id: 'guard-B-model', name: 'Guard B model',
      async generate(_p, _s, tools: Tool[] = []) {
        if (tools.some(t => t.name === 'read_file')) {
          return { content: 'Inspecting.', toolCalls: [{ id: `read-${readFileCalls + 1}`, name: 'read_file', arguments: { path: 'index.html' } }] };
        }
        if (tools.some(t => t.name === 'apply_patch') && !patched) {
          patched = true;
          return { content: 'Applying the edit.', toolCalls: [{ id: 'patch-1', name: 'apply_patch', arguments: { path: 'index.html', patch: 'x' } }] };
        }
        return { content: finalReport };
      }
    };
    const runner = new AgentRunner(buildGateway(events, legacy));
    (runner as any).getModel = () => model;
    (runner as any).getModelById = () => model;
    // Per-tool caps only apply when unlimitedTools is false: inject a test
    // config with a 2-call read_file cap (cap fires before the stall guard).
    (runner as any).loadConfig = () => ({
      model: 'mock',
      agent: {
        unlimitedTools: false,
        repetitionGuard: {
          maxRepeatedToolBatches: 3,
          maxExplorationBatches: 6,
          toolCaps: { read_file: 2 }
        }
      }
    });
    registerSkills();
    const sessionId = `guard-B-${Date.now()}`;
    await runner.processMessage(sessionId, {
      id: 'guard-B', channel: 'background', senderId: 'smoke',
      content: LANDING_GOAL,
      timestamp: Date.now(), metadata: { backgroundGoalId: `smoke-guard-B-${Date.now()}` }
    });
    assert.equal(readFileCalls, 2, 'read_file stops at its per-task cap');
    assert.equal(applyPatchCalls, 1, 'implementation continues through apply_patch after the cap');
    const guards = guardMemories(runner, sessionId);
    const recover = guards.find(g => g.metadata.type === 'mission_tool_budget' && g.metadata.phase === 'recover_to_mutation');
    assert.ok(recover, 'capped tool redirects to mutation, never finalizes');
    assert.ok(String(recover.content).includes(LANDING_GOAL), 'cap recovery is anchored to the original goal');
    assert.ok(String(recover.content).includes('Do not broaden scope'), 'cap recovery forbids scope broadening');
    assert.equal(finalDoneText(events), finalReport, 'mission completes after the redirected mutation');
    console.log('B. read_file cap -> apply_patch still allowed          ok');
  }

  // ---- C. repeated successful read batch -> continue, NOT fail -----------
  {
    readFileCalls = 0; applyPatchCalls = 0; shellCalls = 0; codeSearchCalls = 0; patchTargets = [];
    let turn = 0;
    let patched = false;
    const events: StreamEventPayload[] = [];
    const legacy: string[] = [];
    const model: ModelProvider = {
      id: 'guard-C-model', name: 'Guard C model',
      async generate(_p, _s, tools: Tool[] = []) {
        turn += 1;
        if (tools.some(t => t.name === 'read_file')) {
          return { content: 'Still inspecting.', toolCalls: [{ id: `read-${turn}`, name: 'read_file', arguments: { path: 'index.html' } }] };
        }
        if (tools.some(t => t.name === 'apply_patch') && !patched) {
          patched = true;
          return { content: 'Applying the edit.', toolCalls: [{ id: 'patch-1', name: 'apply_patch', arguments: { path: 'index.html', patch: 'x' } }] };
        }
        return { content: finalReport };
      }
    };
    const runner = new AgentRunner(buildGateway(events, legacy));
    (runner as any).getModel = () => model;
    (runner as any).getModelById = () => model;
    registerSkills();
    const sessionId = `guard-C-${Date.now()}`;
    await runner.processMessage(sessionId, {
      id: 'guard-C', channel: 'background', senderId: 'smoke',
      content: LANDING_GOAL,
      timestamp: Date.now(), metadata: { backgroundGoalId: `smoke-guard-C-${Date.now()}` }
    });
    assert.equal(readFileCalls, 2, 'reads stop executing once the guard takes over');
    const dones = allDoneEvents(events);
    assert.equal(dones.length, 1, 'a repeated read batch never produces a terminal response');
    assert.equal(dones[0].ok, true, 'the only terminal is the successful final');
    const guards = guardMemories(runner, sessionId);
    const allMemories = (runner as any).memory.getAll(sessionId);
    const repeat = allMemories.find((m: any) => m.metadata?.phase === 'repeated_inspection_disabled');
    assert.ok(repeat, 'repeated inspection disables the read tool and continues');
    assert.ok(String(repeat.content).includes('Repeated inspection detected'), 'repeated-inspection recovery message injected');
    assert.ok(String(repeat.content).includes(LANDING_GOAL), 'recovery anchored to the original goal');
    assert.equal(applyPatchCalls, 1, 'mission continues to the mutation instead of failing');
    const finals = finalMemories(runner, sessionId);
    assert.ok(finals.some((m: any) => m.metadata.completed === true), 'mission completes only after mutation');
    assert.ok(!finals.some((m: any) => m.metadata.completed === false && m.metadata.toolBudgetStopped), 'no tool-budget stop verdict');
    console.log('C. repeated successful read batch continues, not fails ok');
  }

  // ---- D. empty admin/api dirs -> still edits frontend --------------------
  {
    readFileCalls = 0; applyPatchCalls = 0; shellCalls = 0; codeSearchCalls = 0; patchTargets = [];
    let turn = 0;
    let patched = false;
    const events: StreamEventPayload[] = [];
    const legacy: string[] = [];
    const model: ModelProvider = {
      id: 'guard-D-model', name: 'Guard D model',
      async generate(_p, _s, tools: Tool[] = []) {
        turn += 1;
        if (turn === 1) {
          return { content: 'Reading the landing page.', toolCalls: [{ id: 'read-1', name: 'read_file', arguments: { path: 'index.html' } }] };
        }
        if (turn === 2) {
          return { content: 'Checking the admin directory.', toolCalls: [{ id: 'read-2', name: 'read_file', arguments: { path: 'admin/' } }] };
        }
        if (turn === 3) {
          return { content: 'Checking the api directory.', toolCalls: [{ id: 'read-3', name: 'read_file', arguments: { path: 'api/' } }] };
        }
        if (tools.some(t => t.name === 'apply_patch') && !patched) {
          patched = true;
          return { content: 'Applying the frontend edit.', toolCalls: [{ id: 'patch-1', name: 'apply_patch', arguments: { path: 'index.html', patch: 'design' } }] };
        }
        return { content: finalReport };
      }
    };
    const runner = new AgentRunner(buildGateway(events, legacy));
    (runner as any).getModel = () => model;
    (runner as any).getModelById = () => model;
    registerSkills();
    const sessionId = `guard-D-${Date.now()}`;
    await runner.processMessage(sessionId, {
      id: 'guard-D', channel: 'background', senderId: 'smoke',
      content: LANDING_GOAL,
      timestamp: Date.now(), metadata: { backgroundGoalId: `smoke-guard-D-${Date.now()}` }
    });
    assert.equal(applyPatchCalls, 1, 'the frontend edit still runs');
    assert.deepEqual(patchTargets, ['index.html'], 'empty admin/api dirs do not redirect the mutation to backend work');
    assert.ok(!patchTargets.some(t => /(admin|api)\//.test(t)), 'no mutation targets admin/ or api/');
    assert.equal(finalDoneText(events), finalReport, 'mission completes with the frontend change');
    const guards = guardMemories(runner, sessionId);
    assert.ok(guards.some(g => g.metadata.phase === 'inspect_to_mutate'), 'stall guard fired during the dir exploration');
    console.log('D. empty admin/api dirs do not block frontend edit  ok');
  }

  // ---- E. cannot broaden into backend implementation ----------------------
  {
    readFileCalls = 0; applyPatchCalls = 0; shellCalls = 0; codeSearchCalls = 0; patchTargets = [];
    let turn = 0;
    let patched = false;
    const events: StreamEventPayload[] = [];
    const legacy: string[] = [];
    const model: ModelProvider = {
      id: 'guard-E-model', name: 'Guard E model',
      async generate(_p, _s, tools: Tool[] = []) {
        turn += 1;
        if (turn <= 3) {
          // Varied reads: the stall guard fires at the 3rd read-only batch.
          return { content: 'Inspecting the workspace.', toolCalls: [{ id: `read-${turn}`, name: 'read_file', arguments: { path: `page-${turn}.html` } }] };
        }
        if (turn === 4) {
          // The model tries to finish with an explanation that invents backend
          // work — this must be refused and redirected, not delivered.
          return { content: 'I implemented a full backend admin panel and API server, plus authentication.' };
        }
        if (tools.some(t => t.name === 'apply_patch') && !patched) {
          patched = true;
          return { content: 'Applying the frontend redesign.', toolCalls: [{ id: 'patch-1', name: 'apply_patch', arguments: { path: 'index.html', patch: 'design' } }] };
        }
        return { content: finalReport };
      }
    };
    const runner = new AgentRunner(buildGateway(events, legacy));
    (runner as any).getModel = () => model;
    (runner as any).getModelById = () => model;
    registerSkills();
    const sessionId = `guard-E-${Date.now()}`;
    await runner.processMessage(sessionId, {
      id: 'guard-E', channel: 'background', senderId: 'smoke',
      content: LANDING_GOAL,
      timestamp: Date.now(), metadata: { backgroundGoalId: `smoke-guard-E-${Date.now()}` }
    });
    assert.equal(readFileCalls, 2, 'reads stop at the stall guard');
    const guards = guardMemories(runner, sessionId);
    assert.ok(guards.some(g => g.metadata.phase === 'inspect_to_mutate'), 'stall guard fired before the prose turn');
    const retry = guards.find(g => g.metadata.phase === 'mutation_retry');
    assert.ok(retry, 'the prose-only final is refused with a mutation retry instruction');
    assert.ok(String(retry.content).includes('You have not performed the requested implementation.'), 'retry states the implementation was not performed');
    assert.ok(String(retry.content).includes('no mutation tool call'), 'retry states the previous response was prose-only');
    assert.ok(String(retry.content).includes('- call a mutation tool'), 'retry requires a mutation tool call');
    assert.ok(String(retry.content).includes(LANDING_GOAL), 'retry anchors the ORIGINAL user request verbatim');
    assert.ok(String(retry.content).includes('Do not broaden scope'), 'retry forbids broadening the scope');
    const dones = allDoneEvents(events);
    assert.equal(dones.length, 1, 'the explanation final was refused — only one terminal response');
    assert.ok(!String(dones[0].finalText || '').includes('admin panel'), 'the invented backend explanation was never delivered');
    assert.equal(applyPatchCalls, 1, 'the mission continued to the frontend mutation');
    assert.deepEqual(patchTargets, ['index.html'], 'only the frontend file was mutated');
    assert.equal(finalDoneText(events), finalReport, 'mission completes with the frontend work');
    const finals = finalMemories(runner, sessionId);
    assert.ok(finals.some((m: any) => m.metadata.completed === true), 'completion only after the actual mutation');
    console.log('E. backend broadening refused, frontend edit done  ok');
  }

  // ---- F. prose-only turns never count as progress; repeated -> fail ------
  {
    readFileCalls = 0; applyPatchCalls = 0; shellCalls = 0; codeSearchCalls = 0; patchTargets = [];
    let turn = 0;
    const events: StreamEventPayload[] = [];
    const legacy: string[] = [];
    const model: ModelProvider = {
      id: 'guard-F-model', name: 'Guard F model',
      async generate(_p, _s, tools: Tool[] = []) {
        turn += 1;
        if (turn <= 3) {
          // Varied reads: the stall guard fires at the 3rd read-only batch and
          // FORCE_MUTATION activates.
          return { content: 'Inspecting the workspace.', toolCalls: [{ id: `read-${turn}`, name: 'read_file', arguments: { path: `page-${turn}.html` } }] };
        }
        // The model keeps SAYING it will implement without ever calling a
        // mutation tool — exactly the reported Problem #2 behavior.
        if (turn === 4) {
          return { content: 'Let me proceed with implementation directly.' };
        }
        if (turn === 5) {
          return { content: 'Let me fix the landing page now using a mutation tool.' };
        }
        return { content: finalReport };
      }
    };
    const runner = new AgentRunner(buildGateway(events, legacy));
    (runner as any).getModel = () => model;
    (runner as any).getModelById = () => model;
    registerSkills();
    const sessionId = `guard-F-${Date.now()}`;
    await runner.processMessage(sessionId, {
      id: 'guard-F', channel: 'background', senderId: 'smoke',
      content: LANDING_GOAL,
      timestamp: Date.now(), metadata: { backgroundGoalId: `smoke-guard-F-${Date.now()}` }
    });
    assert.equal(readFileCalls, 2, 'reads stop at the stall guard');
    const guards = guardMemories(runner, sessionId);
    const retries = guards.filter(g => g.metadata.phase === 'mutation_retry');
    assert.equal(retries.length, 1, 'the first prose-only turn gets one mutation retry instruction');
    assert.ok(String(retries[0].content).includes('Your previous response contained only planning/prose and no mutation tool call.'), 'retry names the prose-only turn');
    assert.ok(String(retries[0].content).includes('- modify the relevant workspace files'), 'retry requires the workspace mutation');
    assert.ok(String(retries[0].content).includes('- do not broaden the task'), 'retry forbids broadening');
    assert.equal(applyPatchCalls, 0, 'no mutation tool was ever called');
    const dones = allDoneEvents(events);
    assert.equal(dones.length, 1, 'exactly one terminal response');
    assert.equal(dones[0].ok, false, 'the repeated prose-only mission ends in a controlled failure, not completion');
    assert.ok(String(dones[0].finalText || '').includes('The requested implementation was not performed.'), 'failure final is honest about the missing work');
    assert.ok(!String(dones[0].finalText || '').includes('could not be completed'), 'no generic safety-stop text');
    const finals = finalMemories(runner, sessionId);
    assert.ok(finals.some((m: any) => m.metadata.completed === false), 'mission is NOT marked completed');
    assert.ok(!finals.some((m: any) => m.metadata.completed === true), 'prose-only turns never produce a completed=true final');
    console.log('F. prose-only turns cannot count as progress      ok');
  }

  // ---- 6. genuinely terminal (research) still finalizes -------------------
  {
    readFileCalls = 0; applyPatchCalls = 0; shellCalls = 0; codeSearchCalls = 0; patchTargets = [];
    const events: StreamEventPayload[] = [];
    const legacy: string[] = [];
    const model: ModelProvider = {
      id: 'guard-terminal-model', name: 'Guard terminal model',
      async generate(_p, _s, tools: Tool[] = []) {
        if (tools.some(t => t.name === 'code_search')) {
          return { content: 'Searching.', toolCalls: [{ id: `search-${codeSearchCalls + 1}`, name: 'code_search', arguments: { query: `q${codeSearchCalls + 1}` } }] };
        }
        return { content: finalReport };
      }
    };
    const runner = new AgentRunner(buildGateway(events, legacy));
    (runner as any).getModel = () => model;
    (runner as any).getModelById = () => model;
    registerSkills();
    const sessionId = `guard-terminal-${Date.now()}`;
    await runner.processMessage(sessionId, {
      id: 'guard-terminal', channel: 'background', senderId: 'smoke',
      content: 'Research the latest AI news and produce a sourced report.',
      timestamp: Date.now(), metadata: { backgroundGoalId: `smoke-guard-terminal-${Date.now()}` }
    });
    assert.equal(codeSearchCalls, 5, 'research exploration executes 5 batches and stops at the 6-batch limit');
    assert.equal(finalDoneText(events), finalReport, 'research mission finalizes with the collected evidence');
    const guards = guardMemories(runner, sessionId);
    assert.equal(guards.length, 0, 'progress guard must not apply to non-implementation missions');
    console.log('6. genuinely terminal mission finalizes              ok');
  }

  // ---- 7. failed-tool repetition protection remains -----------------------
  {
    readFileCalls = 0; applyPatchCalls = 0; shellCalls = 0; codeSearchCalls = 0; patchTargets = [];
    const events: StreamEventPayload[] = [];
    const legacy: string[] = [];
    const model: ModelProvider = {
      id: 'guard-rep-model', name: 'Guard repetition model',
      async generate(_p, _s, tools: Tool[] = []) {
        if (tools.some(t => t.name === 'shell')) {
          return { content: 'Retrying.', toolCalls: [{ id: `fail-${shellCalls + 1}`, name: 'shell', arguments: { command: 'fail-me' } }] };
        }
        return { content: finalReport };
      }
    };
    const runner = new AgentRunner(buildGateway(events, legacy));
    (runner as any).getModel = () => model;
    (runner as any).getModelById = () => model;
    registerSkills();
    const sessionId = `guard-rep-${Date.now()}`;
    await runner.processMessage(sessionId, {
      id: 'guard-rep', channel: 'background', senderId: 'smoke',
      content: LANDING_GOAL,
      timestamp: Date.now(), metadata: { backgroundGoalId: `smoke-guard-rep-${Date.now()}` }
    });
    assert.equal(shellCalls, 2, 'only the first two failed batches execute; recovery and blocked returns pre-empt execution');
    assert.ok(String(finalDoneText(events) || '').includes('repeated'), 'blocked final reports the repeated failure');
    const finals = finalMemories(runner, sessionId);
    assert.ok(finals.some((m: any) => m.metadata.blocked === true), 'mission ends blocked, not silently completed');
    console.log('7. failed-tool repetition protection intact          ok');
  }

  console.log(JSON.stringify({
    repeatedReadToMutation: true,
    cappedReadContinues: true,
    repeatedReadContinues: true,
    emptyDirsDoNotBlockFrontend: true,
    noScopeBroadening: true,
    proseOnlyNeverCompletes: true,
    terminalStillFinalizes: true,
    repetitionGuardIntact: true
  }));
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });