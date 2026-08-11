# Gitu runtime interfaces

Gitu exposes one agent runtime across the web chat, API clients, editor integrations, batches, and inbound connectors. These interfaces use the same memory, tools, checkpoints, provider fallback, skills, and trajectory recording.

## Authentication

Set a long random value in `.env` and restart Gitu:

```dotenv
GITU_API_KEY=replace-with-a-long-random-value
```

Web session tokens are also accepted. Never put the API key in `config.json`, source code, browser URLs, or project files.

## OpenAI-compatible API

Base URL: `http://localhost:3000/v1`

- `GET /v1/models`
- `POST /v1/chat/completions`
- `stream: true` returns OpenAI-style server-sent events and a final `data: [DONE]` row.
- Text plus `image_url` data-URL parts are supported for vision-capable configured models.

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer $GITU_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gitu-agent","messages":[{"role":"user","content":"Inspect this project and report the highest-impact issue."}]}'
```

## Batch runs

`POST /api/batch/run` accepts at most 25 items and a concurrency value from 1 to 6:

```json
{
  "concurrency": 3,
  "items": [
    { "content": "Audit module A", "metadata": { "ticket": "A" } },
    { "content": "Audit module B", "metadata": { "ticket": "B" } }
  ]
}
```

Every item receives its own isolated session and trajectory.

## Editor bridge

`POST /api/editor/request` accepts editor context without requiring an editor-specific extension:

```json
{
  "content": "Fix the selected function and run its tests.",
  "editor": "vscode",
  "file": "src/example.ts",
  "selection": "lines 20-45",
  "projectId": "optional-gitu-project-id"
}
```

## Generic inbound connectors

`POST /api/connectors/inbound/:name` lets authenticated local automation, workflow engines, or messaging bridges invoke the agent:

```json
{
  "text": "Summarize this support request and propose the next action.",
  "userId": "external-user-id",
  "threadId": "external-thread-id",
  "projectId": "optional-gitu-project-id"
}
```

The response contains `response` and `trajectoryId`. Connector names may contain letters, numbers, dashes, and underscores.

## Runtime inspection

The Runtime page in the web UI shows:

- provider health, cooldown, and fallback counters;
- local, Docker, or SSH execution isolation;
- filesystem checkpoints and safety-first rollback;
- redacted API, batch, editor, and connector trajectories;
- lifecycle hook status.

The same data is available to authenticated web sessions through `GET /api/runtime/status`, `GET /api/trajectories`, and `GET /api/checkpoints`.

## Safety boundaries

- Shell execution requires a real project or conversation workspace by default.
- Sensitive environment variables are removed from child processes unless explicitly allowlisted.
- Docker execution defaults to no network, a read-only root, resource limits, and a single workspace mount.
- Rollback creates a safety checkpoint before restoring files.
- Hook and trajectory storage redact common API key formats.
- Portable skills contain declarative instructions; executable learned skills are constrained tool workflows rather than arbitrary JavaScript.
