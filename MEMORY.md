# MEMORY.md

## Project Notes
- Repo: myassis (local personal assistant with channels + skills).
- System prompt: loaded from SOUL.md (fallback to src/soul.md).

## Recent Fixes
- Agent automation: configurable max tool turns via config.agent.maxTurns; clearer pause messaging.
- Telegram: streaming responses supported so OpenRouter streamed output reaches Telegram.
- Project manager: action enum + action normalization + idempotent project_create; duplicates removed from projects_data.json.
- MCP filesystem: stdio args now resolve ./ to an absolute path to avoid allowed-dir confusion.
