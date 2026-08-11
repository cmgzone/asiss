import assert from 'assert';
import { AgentRunner } from '../src/agents/runner';
import { ModelProvider, Tool } from '../src/core/models';
import { SkillRegistry } from '../src/core/skills';
import { StreamEventPayload } from '../src/core/types';

async function main() {
  const events: StreamEventPayload[] = [];
  const legacyMessages: string[] = [];
  let notesCalls = 0;
  const toolLists: string[][] = [];
  let modelTurn = 0;
  const finalReport = [
    '# Executive summary',
    'The collected sources support three relevant developments. This report uses only the evidence supplied by the tools.',
    '',
    '## Findings',
    '- Finding one is supported by source A.',
    '- Finding two is supported by source B.',
    '- Finding three remains uncertain and is identified as such.',
    '',
    '## Analysis',
    'The evidence is sufficient for a concise comparison, but not for unsupported metrics or invented release names. '.repeat(5),
    '',
    '## Sources',
    '- https://example.com/a',
    '- https://example.com/b'
  ].join('\n');

  const fakeModel: ModelProvider = {
    id: 'smoke-repetition-model',
    name: 'Smoke repetition model',
    async generate(_prompt: string, _systemPrompt?: string, tools: Tool[] = []) {
      toolLists.push(tools.map(tool => tool.name));
      modelTurn += 1;
      if (modelTurn === 1) {
        return {
          content: "I've gathered the sources. Let me synthesize this into a comprehensive report.",
          toolCalls: [{ id: 'note-1', name: 'notes', arguments: { action: 'add_note', content: 'source summary' } }]
        };
      }
      return { content: finalReport };
    }
  };

  const gateway = {
    async sendResponse(_sessionId: string, text: string) { legacyMessages.push(text); },
    async sendStreamChunk() {},
    async sendStreamEvent(_sessionId: string, event: StreamEventPayload) { events.push(event); },
    async sendMedia() {},
    listSessionIds() { return []; },
    supportsStructuredStreaming() { return true; }
  };

  const runner = new AgentRunner(gateway);
  (runner as any).getModel = () => fakeModel;
  (runner as any).getModelById = () => fakeModel;
  SkillRegistry.register({
    name: 'notes', description: 'Test notes',
    inputSchema: { type: 'object', properties: { action: { type: 'string' }, content: { type: 'string' } } },
    async execute() { notesCalls += 1; return { success: true, message: 'Note added successfully' }; }
  });

  await runner.processMessage(`smoke-repetition-${Date.now()}`, {
    id: 'research', channel: 'background', senderId: 'smoke',
    content: 'Research the latest AI news and produce a sourced report.',
    timestamp: Date.now(), metadata: { backgroundGoalId: 'smoke' }
  });

  assert.equal(notesCalls, 1, 'The notes side effect must run at most once per task.');
  assert.ok(toolLists[0].includes('notes'), 'Notes should be available initially.');
  assert.equal(toolLists[1].includes('notes'), false, 'Notes must be removed after the first write.');
  const updates = events.filter(event => event.type === 'assistant_update');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].text?.includes('Let me synthesize'), false, 'Raw model preambles must not become progress updates.');
  assert.equal(events.find(event => event.type === 'assistant_done')?.finalText, finalReport);
  assert.equal(legacyMessages.length, 1, 'Only the hidden debug event may use the legacy response channel.');

  let shellCalls = 0;
  let shellModelTurns = 0;
  const shellEvents: StreamEventPayload[] = [];
  const shellModel: ModelProvider = {
    id: 'smoke-shell-cap', name: 'Smoke shell cap',
    async generate(_prompt: string, _systemPrompt?: string, tools: Tool[] = []) {
      shellModelTurns += 1;
      if (tools.some(tool => tool.name === 'shell')) {
        return {
          content: 'I am still inspecting the workspace.',
          toolCalls: [{ id: `shell-${shellModelTurns}`, name: 'shell', arguments: { command: `inspection-${shellModelTurns}` } }]
        };
      }
      return { content: finalReport };
    }
  };
  const shellGateway = {
    async sendResponse() {}, async sendStreamChunk() {}, async sendMedia() {},
    async sendStreamEvent(_sessionId: string, event: StreamEventPayload) { shellEvents.push(event); },
    listSessionIds() { return []; }, supportsStructuredStreaming() { return true; }
  };
  const shellRunner = new AgentRunner(shellGateway);
  (shellRunner as any).getModel = () => shellModel;
  (shellRunner as any).getModelById = () => shellModel;
  SkillRegistry.register({
    name: 'shell', description: 'Test shell', inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
    async execute() { shellCalls += 1; return { stdout: '', stderr: '', exitCode: 0 }; }
  });
  await shellRunner.processMessage(`smoke-shell-cap-${Date.now()}`, {
    id: 'shell-cap', channel: 'background', senderId: 'smoke', content: 'Inspect and build the requested output.',
    timestamp: Date.now(), metadata: { backgroundGoalId: 'smoke-shell' }
  });
  assert.equal(shellCalls, 8, 'Shell execution must stop at its per-task cap.');
  assert.equal(shellEvents.find(event => event.type === 'assistant_done')?.finalText, finalReport);

  console.log(JSON.stringify({ oneNotesWrite: true, toolDisabled: true, canonicalProgress: true, fullFinalReport: true, shellCap: true }));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
