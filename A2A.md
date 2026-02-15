# A2A (FastA2A-Compatible) Agent Collaboration

This project exposes an A2A server endpoint and a client skill so multiple Gitu instances can collaborate using the A2A protocol (FastA2A-compatible).

## Quick Start
1. Ensure `A2A` is enabled in `config.json`.
2. Optional: set `A2A_AUTH_TOKEN` in `.env` if you want to require bearer auth.
3. Start Gitu, then fetch the agent card from `/.well-known/agent.json` or `/.well-known/agent-card.json`.

## Server Endpoints
Agent Card (public unless `a2a.protectAgentCard` is true):
- `/.well-known/agent.json`
- `/.well-known/agent-card.json`
- `/v1/card`
- `/agent/authenticatedExtendedCard` (auth only)

JSON-RPC endpoint (default):
- `http://localhost:3210/a2a`

JSON-RPC methods:
- `message/send`
- `tasks/get`
- `tasks/cancel`
- `tasks/list`
- `agent/authenticatedExtendedCard` (also accepts `agent/getAuthenticatedExtendedCard`)

REST compatibility:
- `POST /v1/message:send`
- `GET /v1/tasks`
- `GET /v1/tasks/:id`
- `POST /v1/tasks/:id:cancel`
- `POST /v1/message:stream` returns 501 (streaming not supported)

## Client Skill (Outbound Calls)
Use the `a2a_client` skill to talk to other agents:
- `peer_list`
- `discover`
- `send`
- `task_get`
- `task_cancel`

Example (JSON-RPC):
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "message/send",
  "params": {
    "message": {
      "kind": "message",
      "messageId": "msg-1",
      "role": "user",
      "parts": [{ "kind": "text", "text": "Hello from another agent." }]
    },
    "configuration": {
      "blocking": true,
      "historyLength": 10
    }
  }
}
```

## Configuration
Add or edit the `a2a` block in `config.json`:
```json
{
  "a2a": {
    "enabled": true,
    "port": 3210,
    "rpcPath": "/a2a",
    "protocolVersion": "0.3.0",
    "authTokenEnv": "A2A_AUTH_TOKEN",
    "protectAgentCard": false,
    "maxHistory": 50,
    "blockingTimeoutMs": 60000,
    "peers": [
      {
        "id": "remote-1",
        "url": "http://127.0.0.1:4000/a2a",
        "description": "Remote Gitu instance",
        "authTokenEnv": "REMOTE_A2A_TOKEN"
      }
    ]
  }
}
```

## Security
- For direct URLs, enable `trustedActions.allow` with `a2a_send`.
- Prefer `authTokenEnv` instead of hard-coding secrets in `config.json`.
