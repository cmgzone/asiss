import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

/**
 * Custom AI Agent System
 * 
 * Allows users to create, manage, and interact with custom AI agents.
 * Each agent has its own persona, skills, and conversation style.
 */

export interface CustomAgentConfig {
    id: string;
    name: string;
    displayName: string;
    description: string;
    persona: string;           // System prompt / personality
    skills: string[];          // List of skill names this agent can use
    temperature?: number;      // AI temperature (0-2)
    model?: string;            // Override model for this agent
    triggers: string[];        // Keywords/phrases that activate this agent
    enabled: boolean;
    createdAt: string;
    updatedAt: string;
    metadata: Record<string, any>;
}

export interface AgentConversation {
    sessionId: string;
    agentId: string;
    messages: AgentMessage[];
    startedAt: string;
    lastMessageAt: string;
}

export interface AgentMessage {
    role: 'user' | 'agent' | 'system';
    content: string;
    timestamp: string;
}

interface AgentData {
    agents: CustomAgentConfig[];
    conversations: AgentConversation[];
}

// Built-in agent templates
const AGENT_TEMPLATES: Record<string, Partial<CustomAgentConfig>> = {
    researcher: {
        name: 'researcher',
        displayName: 'Research Agent',
        description: 'Expert at finding and synthesizing information',
        persona: `You are a Research Agent. Your specialty is finding accurate information, verifying facts, and synthesizing knowledge from multiple sources.

When researching:
- Always cite your sources
- Distinguish between facts and opinions
- Present multiple perspectives when relevant
- Summarize findings clearly
- Highlight confidence levels in your findings`,
        skills: ['web_search', 'web_fetch', 'brave_search'],
        triggers: ['research', 'find out', 'look up', 'investigate']
    },
    coder: {
        name: 'coder',
        displayName: 'Code Agent',
        description: 'Expert programmer and code reviewer',
        persona: `You are a Code Agent. You are an expert programmer who writes clean, efficient, and well-documented code.

When coding:
- Follow best practices and design patterns
- Write readable, maintainable code
- Include helpful comments
- Consider edge cases and error handling
- Suggest tests when appropriate
- Explain your implementation decisions`,
        skills: ['shell', 'read_file', 'write_file', 'apply_patch'],
        triggers: ['code', 'program', 'debug', 'fix bug', 'implement']
    },
    writer: {
        name: 'writer',
        displayName: 'Writing Agent',
        description: 'Creative writer and editor',
        persona: `You are a Writing Agent. You excel at creating engaging, well-structured content for any purpose.

When writing:
- Match the tone to the audience
- Use clear, concise language
- Structure content logically
- Be creative when appropriate
- Edit for clarity and impact
- Adapt your style to the medium (email, blog, tweet, etc.)`,
        skills: ['notes'],
        triggers: ['write', 'draft', 'compose', 'edit', 'proofread']
    },
    analyst: {
        name: 'analyst',
        displayName: 'Data Analyst',
        description: 'Expert at analyzing data and finding insights',
        persona: `You are a Data Analyst Agent. You excel at examining data, finding patterns, and deriving actionable insights.

When analyzing:
- Look for patterns and trends
- Use statistical thinking
- Visualize data when helpful
- Highlight key findings
- Make data-driven recommendations
- Explain your methodology`,
        skills: ['shell', 'read_file'],
        triggers: ['analyze', 'data', 'metrics', 'statistics', 'trends']
    },
    planner: {
        name: 'planner',
        displayName: 'Project Planner',
        description: 'Expert at organizing and planning projects',
        persona: `You are a Project Planner Agent. You excel at breaking down complex projects into manageable tasks.

When planning:
- Break large goals into actionable steps
- Estimate time and resources needed
- Identify dependencies and blockers
- Create realistic timelines
- Anticipate risks and mitigations
- Track progress and milestones`,
        skills: ['project_manager', 'notes', 'scheduler'],
        triggers: ['plan', 'project', 'timeline', 'organize', 'roadmap']
    }
};

export class CustomAgentManager {
    private dataPath: string;
    private agentsDir: string;
    private data: AgentData;

    constructor() {
        this.dataPath = path.join(process.cwd(), 'custom_agents.json');
        this.agentsDir = path.join(process.cwd(), 'agents');
        this.data = { agents: [], conversations: [] };
        this.load();
    }

    private load() {
        // Load JSON data
        if (fs.existsSync(this.dataPath)) {
            try {
                this.data = JSON.parse(fs.readFileSync(this.dataPath, 'utf-8'));
            } catch {
                this.data = { agents: [], conversations: [] };
            }
        }

        // Load agents from agents/ directory (YAML/Markdown files)
        this.loadAgentsFromDirectory();
    }

    private loadAgentsFromDirectory() {
        if (!fs.existsSync(this.agentsDir)) {
            fs.mkdirSync(this.agentsDir, { recursive: true });
        }

        const files = fs.readdirSync(this.agentsDir);
        for (const file of files) {
            if (file.endsWith('.md') || file.endsWith('.txt')) {
                this.loadAgentFromFile(path.join(this.agentsDir, file));
            }
        }
    }

    private loadAgentFromFile(filePath: string) {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const fileName = path.basename(filePath, path.extname(filePath));

            // Parse frontmatter if exists
            let persona = content;
            let name = fileName;
            let displayName = fileName;
            let description = '';
            let triggers: string[] = [];
            let skills: string[] = [];

            if (content.startsWith('---')) {
                const endFrontmatter = content.indexOf('---', 3);
                if (endFrontmatter > 0) {
                    const frontmatter = content.slice(3, endFrontmatter).trim();
                    persona = content.slice(endFrontmatter + 3).trim();

                    // Simple YAML parsing
                    for (const line of frontmatter.split('\n')) {
                        const [key, ...valueParts] = line.split(':');
                        const value = valueParts.join(':').trim();
                        if (key.trim() === 'name') name = value;
                        if (key.trim() === 'displayName') displayName = value;
                        if (key.trim() === 'description') description = value;
                        if (key.trim() === 'triggers') {
                            triggers = value.split(',').map(t => t.trim()).filter(Boolean);
                        }
                        if (key.trim() === 'skills') {
                            skills = value.split(',').map(s => s.trim()).filter(Boolean);
                        }
                    }
                }
            }

            // Check if agent already exists
            const existing = this.data.agents.find(a => a.name === name);
            if (!existing) {
                const agent: CustomAgentConfig = {
                    id: `file_${name}`,
                    name,
                    displayName: displayName || name,
                    description: description || `Agent loaded from ${path.basename(filePath)}`,
                    persona,
                    skills,
                    triggers,
                    enabled: true,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    metadata: { sourceFile: filePath }
                };
                this.data.agents.push(agent);
                console.log(`[CustomAgents] Loaded agent from file: ${name}`);
            }
        } catch (err) {
            console.error(`[CustomAgents] Failed to load agent from ${filePath}:`, err);
        }
    }

    private save() {
        // Only save non-file-based agents to JSON
        const jsonAgents = this.data.agents.filter(a => !a.id.startsWith('file_'));
        const saveData = {
            agents: jsonAgents,
            conversations: this.data.conversations
        };
        fs.writeFileSync(this.dataPath, JSON.stringify(saveData, null, 2));
    }

    /**
     * Create a new custom agent
     */
    createAgent(config: {
        name: string;
        displayName?: string;
        description?: string;
        persona: string;
        skills?: string[];
        triggers?: string[];
        temperature?: number;
        model?: string;
    }): CustomAgentConfig {
        const agent: CustomAgentConfig = {
            id: uuidv4().slice(0, 8),
            name: config.name.toLowerCase().replace(/\s+/g, '_'),
            displayName: config.displayName || config.name,
            description: config.description || '',
            persona: config.persona,
            skills: config.skills || [],
            triggers: config.triggers || [],
            temperature: config.temperature,
            model: config.model,
            enabled: true,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            metadata: {}
        };

        this.data.agents.push(agent);
        this.save();
        console.log(`[CustomAgents] Created agent: ${agent.displayName} (${agent.id})`);
        return agent;
    }

    /**
     * Create agent from a template
     */
    createFromTemplate(templateName: string, overrides?: Partial<CustomAgentConfig>): CustomAgentConfig | null {
        const template = AGENT_TEMPLATES[templateName.toLowerCase()];
        if (!template) {
            console.error(`[CustomAgents] Template not found: ${templateName}`);
            return null;
        }

        return this.createAgent({
            name: template.name!,
            displayName: template.displayName,
            description: template.description,
            persona: template.persona!,
            skills: template.skills,
            triggers: template.triggers,
            ...overrides
        });
    }

    /**
     * Get all available templates
     */
    getTemplates(): string[] {
        return Object.keys(AGENT_TEMPLATES);
    }

    /**
     * Get template details
     */
    getTemplate(name: string): Partial<CustomAgentConfig> | undefined {
        return AGENT_TEMPLATES[name.toLowerCase()];
    }

    /**
     * Get an agent by ID or name
     */
    getAgent(idOrName: string): CustomAgentConfig | undefined {
        return this.data.agents.find(
            a => a.id === idOrName ||
                a.name.toLowerCase() === idOrName.toLowerCase() ||
                a.displayName.toLowerCase() === idOrName.toLowerCase()
        );
    }

    /**
     * List all agents
     */
    listAgents(enabledOnly: boolean = false): CustomAgentConfig[] {
        if (enabledOnly) {
            return this.data.agents.filter(a => a.enabled);
        }
        return this.data.agents;
    }

    /**
     * Update an agent
     */
    updateAgent(idOrName: string, updates: Partial<CustomAgentConfig>): boolean {
        const agent = this.getAgent(idOrName);
        if (!agent) return false;

        Object.assign(agent, updates, { updatedAt: new Date().toISOString() });
        this.save();
        return true;
    }

    /**
     * Delete an agent
     */
    deleteAgent(idOrName: string): boolean {
        const idx = this.data.agents.findIndex(
            a => a.id === idOrName || a.name.toLowerCase() === idOrName.toLowerCase()
        );
        if (idx >= 0) {
            const agent = this.data.agents[idx];
            // If it's a file-based agent, also delete the file
            if (agent.metadata?.sourceFile && fs.existsSync(agent.metadata.sourceFile)) {
                fs.unlinkSync(agent.metadata.sourceFile);
            }
            this.data.agents.splice(idx, 1);
            this.save();
            return true;
        }
        return false;
    }

    /**
     * Find agent by trigger phrase
     */
    findByTrigger(text: string): CustomAgentConfig | undefined {
        const lowerText = text.toLowerCase();
        return this.data.agents.find(a =>
            a.enabled && a.triggers.some(t => lowerText.includes(t.toLowerCase()))
        );
    }

    /**
     * Save agent to file (for persistence as .md)
     */
    saveAgentToFile(idOrName: string): string | null {
        const agent = this.getAgent(idOrName);
        if (!agent) return null;

        const content = `---
name: ${agent.name}
displayName: ${agent.displayName}
description: ${agent.description}
triggers: ${agent.triggers.join(', ')}
skills: ${agent.skills.join(', ')}
---

${agent.persona}
`;
        const filePath = path.join(this.agentsDir, `${agent.name}.md`);
        fs.writeFileSync(filePath, content);
        return filePath;
    }

    /**
     * Build the system prompt for an agent
     */
    buildSystemPrompt(agent: CustomAgentConfig): string {
        return `# Agent: ${agent.displayName}

${agent.persona}

---
You are ${agent.displayName}. Stay in character and respond according to your persona above.
${agent.skills.length > 0 ? `\nYou have access to these skills: ${agent.skills.join(', ')}` : ''}
`;
    }

    /**
     * Add a message to conversation history
     */
    addMessage(sessionId: string, agentId: string, role: 'user' | 'agent' | 'system', content: string) {
        let conversation = this.data.conversations.find(
            c => c.sessionId === sessionId && c.agentId === agentId
        );

        if (!conversation) {
            conversation = {
                sessionId,
                agentId,
                messages: [],
                startedAt: new Date().toISOString(),
                lastMessageAt: new Date().toISOString()
            };
            this.data.conversations.push(conversation);
        }

        conversation.messages.push({
            role,
            content,
            timestamp: new Date().toISOString()
        });
        conversation.lastMessageAt = new Date().toISOString();

        // Keep only last 50 messages per conversation
        if (conversation.messages.length > 50) {
            conversation.messages = conversation.messages.slice(-50);
        }

        this.save();
    }

    /**
     * Get conversation history
     */
    getConversation(sessionId: string, agentId: string): AgentMessage[] {
        const conversation = this.data.conversations.find(
            c => c.sessionId === sessionId && c.agentId === agentId
        );
        return conversation?.messages || [];
    }
}

export const customAgentManager = new CustomAgentManager();
