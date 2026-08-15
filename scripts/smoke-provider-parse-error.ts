/**
 * Regression smoke: provider response parsing with unterminated tool-call
 * arguments ("Unterminated string in JSON at position N").
 *
 * Locks the required behavior:
 *   1. The provider adapter surfaces a typed parse error — it never silently
 *      repairs malformed JSON.
 *   2. The raw payload is logged before the error propagates, secrets
 *      redacted.
 *   3. The existing retry mechanism (withModelRetry) retries the same model
 *      turn AT MOST ONCE for parse errors.
 *   4. SSE lines fragmented across network chunks are buffered and reassembled
 *      — streamed tool-call arguments are parsed only after full assembly.
 *   5. At runner level, a provider parse error yields a controlled fail state:
 *      the mission does NOT restart from inspection, no tools run, and the
 *      delivered message is redacted.
 */
import assert from 'assert';
import http from 'http';
import { AddressInfo } from 'net';
import { GenericOpenAIProvider } from '../src/agents/openai-provider';
import { isProviderParseError, withModelRetry } from '../src/core/retry-handler';
import { redactSecrets } from '../src/core/redact';
import { AgentRunner } from '../src/agents/runner';
import { ModelProvider } from '../src/core/models';
import { StreamEventPayload } from '../src/core/types';

const PLANTED_SECRET = 'sk-plantedsecret123';

function buildGateway(events: StreamEventPayload[]) {
  return {
    async sendResponse() {},
    async sendStreamChunk() {},
    async sendStreamEvent(_sessionId: string, event: StreamEventPayload) { events.push(event); },
    async sendMedia() {},
    listSessionIds() { return []; },
    supportsStructuredStreaming() { return true; }
  };
}

function startServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

async function main() {
  // ---- A. non-streaming generate(): unterminated tool-call arguments ----
  {
    let hits = 0;
    const { server, port } = await startServer((_req, res) => {
      hits += 1;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: {
                name: 'apply_patch',
                arguments: `{"path":"README.md","content":"${PLANTED_SECRET} unterminated`
              }
            }]
          }
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1 }
      }));
    });

    const capturedWarns: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: any) => { capturedWarns.push(String(msg)); originalWarn(msg); };

    const provider = new GenericOpenAIProvider(
      'test-openai', 'Test OpenAI', `http://127.0.0.1:${port}`, 'sk-testkey123', 'test-model'
    );

    let thrown: any;
    try {
      await provider.generate('hi', undefined, undefined);
    } catch (e) {
      thrown = e;
    }
    console.warn = originalWarn;

    assert.ok(thrown, 'A. unterminated arguments must throw, never be repaired');
    assert.equal(thrown.code, 'TOOL_ARGUMENTS_JSON_PARSE', 'A. typed parse error code');
    assert.ok(/Unterminated string in JSON/.test(thrown.message), 'A. V8 parse position surfaced');
    assert.equal(thrown.provider, 'Test OpenAI', 'A. provider identified on the error');
    assert.equal(thrown.toolName, 'apply_patch', 'A. tool identified on the error');
    const warned = capturedWarns.join('\n');
    assert.ok(warned.includes('[ProviderParse]'), 'A. raw payload logged before propagation');
    assert.ok(warned.includes('sk-[REDACTED]'), 'A. secret redacted in the log');
    assert.ok(!warned.includes(PLANTED_SECRET), 'A. planted secret must not reach the log');
    assert.ok(!warned.includes('sk-testkey123'), 'A. provider api key must not reach the log');

    assert.ok(isProviderParseError(thrown), 'A. retry layer recognizes the parse error');

    hits = 0;
    let retried: any;
    try {
      await withModelRetry(() => provider.generate('hi'), 'TestGenerate');
    } catch (e) {
      retried = e;
    }
    assert.ok(retried, 'A. parse error still thrown after retry');
    assert.equal(hits, 2, 'A. same turn retried exactly once, not more');
    server.close();
    console.log('A. unterminated tool-call arguments: typed error + redacted logging + one retry ok');
  }

  // ---- B. streaming generateStream(): SSE line fragmented across chunks ----
  {
    const { server, port } = await startServer((_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      const eventA = 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"apply_patch","arguments":"{\\"path\\":\\"README.md\\""}}]}}]}\n\n';
      const eventB = 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":",\\"content\\":\\"hi\\"}"}}]}}]}\n\n';
      const cut = Math.floor(eventA.length / 2);
      res.write(eventA.slice(0, cut));
      setTimeout(() => {
        res.write(eventA.slice(cut) + eventB + 'data: [DONE]\n\n');
        res.end();
      }, 30);
    });

    const provider = new GenericOpenAIProvider(
      'test-openai-stream', 'Test OpenAI Stream', `http://127.0.0.1:${port}`, 'sk-testkey123', 'test-model'
    );
    const result = await provider.generateStream('hi');
    assert.ok(result.toolCalls && result.toolCalls.length === 1, 'B. tool call assembled across chunks');
    assert.deepEqual(result.toolCalls[0].arguments, { path: 'README.md', content: 'hi' }, 'B. fragmented SSE line reassembled, no corruption');
    server.close();
    console.log('B. SSE fragmentation across chunks reassembled ok');
  }

  // ---- C. runner level: parse error -> controlled fail, no restart ----
  {
    const events: StreamEventPayload[] = [];
    let generateCalls = 0;
    const broken: ModelProvider = {
      id: 'broken-parse', name: 'Broken Parse',
      async generate() {
        generateCalls += 1;
        throw new Error(`Unterminated string in JSON at position 3277: ${PLANTED_SECRET}`);
      }
    };
    const runner = new AgentRunner(buildGateway(events));
    (runner as any).getModel = () => broken;
    (runner as any).getModelById = () => broken;

    await runner.processMessage(`provider-err-${Date.now()}`, {
      id: 'provider-err', channel: 'background', senderId: 'smoke',
      content: 'Implement the hello world route',
      timestamp: Date.now(), metadata: { backgroundGoalId: `smoke-provider-err-${Date.now()}` }
    });

    assert.equal(generateCalls, 2, 'C. same model turn retried exactly once');
    const toolEvents = events.filter(e => e.type === 'tool_start' || e.type === 'tool_done');
    assert.equal(toolEvents.length, 0, 'C. no tools ran — the mission did NOT restart from inspection');
    const dones = events.filter(e => e.type === 'assistant_done') as any[];
    assert.equal(dones.length, 1, 'C. exactly one final response');
    assert.equal(dones[0].ok, false, 'C. final response not ok');
    assert.ok(String(dones[0].finalText || '').includes('Model provider error'), 'C. provider error surfaced');
    assert.ok(String(dones[0].finalText || '').includes('sk-[REDACTED]'), 'C. secret redacted in delivered text');
    assert.ok(!String(dones[0].finalText || '').includes(PLANTED_SECRET), 'C. planted secret must not reach the chat');
    console.log('C. runner: one retry -> controlled provider-error fail, no restart ok');
  }

  // ---- D. redactSecrets sanity ----
  {
    const out = redactSecrets(`Authorization: Bearer abcdef123456789, api_key=supersecretvalue, "token": "tknvalue1234"`);
    assert.ok(!out.includes('abcdef123456789'), 'D. bearer token redacted');
    assert.ok(!out.includes('supersecretvalue'), 'D. api_key value redacted');
    assert.ok(!out.includes('tknvalue1234'), 'D. token value redacted');
    assert.ok(out.includes('[REDACTED]'), 'D. redaction markers present');
    console.log('D. redactSecrets ok');
  }

  console.log('\nprovider-parse-error smoke: ALL PASS');
  process.exit(0);
}

main().catch((err) => {
  console.error('provider-parse-error smoke FAILED:', err);
  process.exit(1);
});