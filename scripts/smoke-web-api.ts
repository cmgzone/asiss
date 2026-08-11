import assert from 'assert';

async function main() {
  process.env.GITU_API_KEY = 'gitu-smoke-test-key';
  const { WebChannel } = await import('../src/channels/web/server');
  const port = 3219;
  const channel = new WebChannel(port);
  channel.onMessage(async message => {
    const runId = `run-${message.id}`;
    channel.sendStreamEvent(message.senderId, { type: 'assistant_start', runId, messageId: runId });
    channel.sendStreamEvent(message.senderId, { type: 'assistant_delta', runId, messageId: runId, text: `Echo: ${message.content}` });
    channel.sendStreamEvent(message.senderId, { type: 'assistant_done', runId, messageId: runId, finalText: `Echo: ${message.content}` });
  });
  channel.start();

  const headers = { Authorization: `Bearer ${process.env.GITU_API_KEY}`, 'Content-Type': 'application/json' };
  await new Promise(resolve => setTimeout(resolve, 150));

  const completionResponse = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers,
    body: JSON.stringify({ model: 'gitu-agent', messages: [{ role: 'user', content: 'hello api' }] })
  });
  assert.equal(completionResponse.status, 200);
  const completion: any = await completionResponse.json();
  assert.equal(completion.choices[0].message.content, 'Echo: user: hello api');
  assert.ok(completion.gitu.trajectory_id);

  const streamResponse = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers,
    body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'hello stream' }] })
  });
  assert.equal(streamResponse.status, 200);
  const streamText = await streamResponse.text();
  assert.match(streamText, /chat\.completion\.chunk/);
  assert.match(streamText, /Echo: user: hello stream/);
  assert.match(streamText, /data: \[DONE\]/);

  const connectorResponse = await fetch(`http://127.0.0.1:${port}/api/connectors/inbound/test`, {
    method: 'POST', headers,
    body: JSON.stringify({ text: 'hello connector', userId: 'external-user' })
  });
  assert.equal(connectorResponse.status, 200);
  const connector: any = await connectorResponse.json();
  assert.equal(connector.response, 'Echo: hello connector');

  const unauthorized = await fetch(`http://127.0.0.1:${port}/v1/models`);
  assert.equal(unauthorized.status, 401);

  await new Promise<void>((resolve, reject) => {
    (channel as any).server.close((error?: Error) => error ? reject(error) : resolve());
  });
  console.log(JSON.stringify({ completion: true, sse: true, connector: true, authRequired: true }));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
