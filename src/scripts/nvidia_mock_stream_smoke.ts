import { NvidiaProvider } from '../agents/nvidia-provider';

async function* fakeStream() {
  yield { choices: [{ delta: { content: 'Hello ' } }] };
  yield { choices: [{ delta: { content: 'world' } }] };
  yield {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'tc_1',
              function: {
                name: 'playwright',
                arguments: '{"action":"screenshot","url":"https://example.com","headless":true}'
              }
            }
          ]
        }
      }
    ]
  };
}

async function main() {
  const provider = new NvidiaProvider('dummy', 'dummy-model');
  (provider as any).client = {
    chat: {
      completions: {
        create: async () => fakeStream()
      }
    }
  };

  const res = await provider.generateStream(
    'prompt',
    'system',
    [
      {
        name: 'playwright',
        description: 'test',
        inputSchema: { type: 'object', properties: {}, required: [] }
      }
    ],
    () => {}
  );

  if (res.content !== 'Hello world') throw new Error(`Unexpected content: ${res.content}`);
  if (!res.toolCalls || res.toolCalls.length !== 1) throw new Error(`Missing toolCalls`);
  if (res.toolCalls[0].name !== 'playwright') throw new Error(`Unexpected tool name`);
  if (res.toolCalls[0].arguments?.url !== 'https://example.com') throw new Error(`Unexpected tool args`);
  process.stdout.write('OK\n');
}

main().catch((e) => {
  process.stderr.write(String(e?.stack || e) + '\n');
  process.exit(1);
});
