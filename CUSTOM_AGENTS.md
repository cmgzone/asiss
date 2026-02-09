# Custom AI Agents Guide

Create specialized AI agents with unique personas, skills, and personalities.

## Quick Start

### Create from Template
```
/agent template researcher
/agent template coder
/agent template writer
/agent template analyst
/agent template planner
```

### Create Custom Agent
```
/agent create MyHelper - You are a friendly assistant who speaks casually and uses emojis
```

### List Agents
```
/agents
/agent templates
```

### Talk to an Agent
```
@researcher Find the latest news about AI developments
@coder Help me debug this function
@MyHelper What should I work on today? 🤔
```

### Delete Agent
```
/agent delete MyHelper
```

---

## Built-in Templates

| Template | Description | Skills |
|----------|-------------|--------|
| `researcher` | Expert at finding and synthesizing information | web_search, web_fetch, brave_search |
| `coder` | Expert programmer and code reviewer | shell, read_file, write_file |
| `writer` | Creative writer and editor | notes |
| `analyst` | Data analysis and insights | shell, read_file |
| `planner` | Project planning and organization | project_manager, notes, scheduler |

---

## File-Based Agents

Create `.md` files in the `agents/` folder for persistent agents:

```markdown
---
name: sales_agent
displayName: Sales Assistant
description: Helps with sales and customer communication
triggers: sales, customer, deal, prospect
skills: notes, web_search
---

You are a Sales Assistant. You help craft compelling messages,
track deals, and provide sales strategies.

## Your Approach
- Always be helpful and solution-focused
- Understand the customer's needs first
- Provide actionable recommendations
```

Agents in `agents/` are automatically loaded on startup.

---

## Agent Conversations

Each agent maintains its own conversation history per session:
- History is preserved across messages
- Last 50 messages are kept
- Use `@agentname` to switch between agents

---

## Using Agent Skills

When creating an agent, specify which skills it can use:
- `web_search` - Search the internet
- `shell` - Run terminal commands
- `notes` - Read/write notes
- `scheduler` - Schedule tasks
- `brave_search` - Brave search API
- `project_manager` - Manage projects

Template agents come with pre-configured skills.

---

## Tips

1. **Be specific with personas** - The more detailed your persona description, the better the agent performs.

2. **Use triggers wisely** - Triggers can auto-route messages to the right agent.

3. **Separate concerns** - Create different agents for different tasks (research, coding, writing).

4. **Save good agents** - Use the `custom_agents` skill to save agents to files.
