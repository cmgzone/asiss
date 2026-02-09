# AI Model Management

Gitu now supports using any OpenAI-compatible AI model (Ollama, LM Studio, vLLM, etc.).

## Quick Start

### 1. List Models
```
/models
```

### 2. Add a Model
**Add a local Ollama model:**
```
/model add ollama llama3
```
*(Assumes http://localhost:11434)*

**Add a custom OpenAI-compatible model:**
(Use the chat or `/model add` command directly)

```
/model add openchat openai http://localhost:1234/v1 sk-ignored openchat-3.5
```

### 3. Switch Models
-   **Web UI:** Use the dropdown in the top-right corner.
-   **Chat:** `/model use llama3`

## Supported Providers

1.  **OpenRouter** (Default) - Access to GPT-4, Claude 3, Gemini, Llama 3 via one API.
2.  **Ollama** - Run local LLMs easily.
3.  **LM Studio** - Local inference server.
4.  **vLLM** - High-performance inference.
5.  **OpenAI** - Direct OpenAI API access.

## Configuration

Models are saved to `models.json`. You can edit this file manually if needed:

```json
[
  {
    "id": "llama3",
    "name": "llama3",
    "provider": "ollama",
    "modelName": "llama3",
    "baseUrl": "http://localhost:11434/v1",
    "apiKey": "ollama",
    "enabled": true
  }
]
```

## Using with Agents

You can create agents that use specific models:

1.  Switch to the model: `/model use llama3`
2.  Create the agent: `/agent create LocalBot - You are a local AI.`
3.  (Future support: Bind agents to specific models permanently)
