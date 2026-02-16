import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

export interface SwarmAgent {
    id: string;
    name: string;
    role: string;
    specialization: string;
    status: 'idle' | 'working' | 'completed' | 'error';
    parentId?: string; // For replicated agents
    modelId?: string;
    profileId?: string;
    assignedTasks: string[];
    completedTasks: string[];
    results: AgentResult[];
    createdAt: string;
}

export interface AgentResult {
    taskId: string;
    output: string;
    completedAt: string;
    success: boolean;
}

export interface AgentTask {
    id: string;
    agentId: string;
    prompt: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
    result?: string;
    createdAt: string;
}

interface SwarmData {
    agents: SwarmAgent[];
    tasks: AgentTask[];
    messages: AgentMessage[];
    collaborations: CollaborationSession[];
}

export interface AgentMessage {
    id: string;
    fromAgentId: string;
    fromAgentName: string;
    toAgentId: string | 'all';  // 'all' for broadcasts
    content: string;
    timestamp: string;
    collaborationId?: string;
}

export interface CollaborationSession {
    id: string;
    goal: string;
    agentIds: string[];
    status: 'active' | 'completed' | 'failed';
    messages: AgentMessage[];
    result?: string;
    startedAt: string;
    completedAt?: string;
}

export class AgentSwarm {
    private filePath: string;
    private data: SwarmData;
    private executeCallback?: (agentId: string, prompt: string) => Promise<string>;

    constructor() {
        this.filePath = path.join(process.cwd(), 'swarm_data.json');
        this.data = this.load();
    }

    // Set the callback that actually runs agent prompts through the LLM
    setExecutor(callback: (agentId: string, prompt: string) => Promise<string>) {
        this.executeCallback = callback;
    }

    private load(): SwarmData {
        const empty: SwarmData = { agents: [], tasks: [], messages: [], collaborations: [] };
        if (fs.existsSync(this.filePath)) {
            try {
                const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
                return {
                    agents: Array.isArray(raw.agents) ? raw.agents : [],
                    tasks: Array.isArray(raw.tasks) ? raw.tasks : [],
                    messages: Array.isArray(raw.messages) ? raw.messages : [],
                    collaborations: Array.isArray(raw.collaborations) ? raw.collaborations : []
                };
            } catch {
                return empty;
            }
        }
        return empty;
    }

    private save() {
        fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
    }

    // ===== AGENT CRUD =====

    createAgent(name: string, role: string, specialization: string, modelId?: string, profileId?: string): SwarmAgent {
        const agent: SwarmAgent = {
            id: uuidv4().slice(0, 8),
            name,
            role,
            specialization,
            status: 'idle',
            modelId,
            profileId,
            assignedTasks: [],
            completedTasks: [],
            results: [],
            createdAt: new Date().toISOString()
        };
        this.data.agents.push(agent);
        this.save();
        console.log(`[Swarm] Created agent: ${name} (${agent.id})`);
        return agent;
    }

    getAgent(id: string): SwarmAgent | undefined {
        return this.data.agents.find(a => a.id === id);
    }

    getAgentByName(name: string): SwarmAgent | undefined {
        return this.data.agents.find(a => a.name.toLowerCase() === name.toLowerCase());
    }

    listAgents(): SwarmAgent[] {
        return this.data.agents;
    }

    deleteAgent(id: string): boolean {
        const idx = this.data.agents.findIndex(a => a.id === id);
        if (idx >= 0) {
            this.data.agents.splice(idx, 1);
            this.save();
            return true;
        }
        return false;
    }

    updateAgent(id: string, updates: Partial<SwarmAgent>): boolean {
        const agent = this.getAgent(id);
        if (!agent) return false;
        Object.assign(agent, updates);
        this.save();
        return true;
    }

    // ===== AGENT REPLICATION =====

    replicateAgent(agentId: string, count: number): SwarmAgent[] {
        const parent = this.getAgent(agentId);
        if (!parent) return [];

        const clones: SwarmAgent[] = [];
        for (let i = 1; i <= count; i++) {
            const clone: SwarmAgent = {
                id: uuidv4().slice(0, 8),
                name: `${parent.name}-${i}`,
                role: parent.role,
                specialization: parent.specialization,
                status: 'idle',
                parentId: parent.id,
                modelId: parent.modelId,
                profileId: parent.profileId,
                assignedTasks: [],
                completedTasks: [],
                results: [],
                createdAt: new Date().toISOString()
            };
            this.data.agents.push(clone);
            clones.push(clone);
        }
        this.save();
        console.log(`[Swarm] Replicated ${parent.name} x${count}`);
        return clones;
    }

    // ===== TASK ASSIGNMENT =====

    assignTask(agentId: string, taskDescription: string): AgentTask {
        const task: AgentTask = {
            id: uuidv4().slice(0, 8),
            agentId,
            prompt: taskDescription,
            status: 'pending',
            createdAt: new Date().toISOString()
        };
        this.data.tasks.push(task);

        const agent = this.getAgent(agentId);
        if (agent) {
            agent.assignedTasks.push(task.id);
        }
        this.save();
        return task;
    }

    // ===== PARALLEL EXECUTION =====

    async runAgent(agentId: string): Promise<AgentResult[]> {
        const agent = this.getAgent(agentId);
        if (!agent) return [];

        if (!this.executeCallback) {
            console.error('[Swarm] No executor callback set!');
            return [];
        }

        agent.status = 'working';
        this.save();

        const pendingTasks = this.data.tasks.filter(
            t => t.agentId === agentId && t.status === 'pending'
        );

        const results: AgentResult[] = [];

        for (const task of pendingTasks) {
            task.status = 'running';
            this.save();

            try {
                const prompt = `You are ${agent.name}, a ${agent.role} specializing in ${agent.specialization}.\n\nYour task: ${task.prompt}\n\nProvide a thorough response.`;

                console.log(`[Swarm] ${agent.name} starting task: ${task.prompt.slice(0, 50)}...`);

                const output = await this.executeCallback(agentId, prompt);

                task.status = 'completed';
                task.result = output;

                const result: AgentResult = {
                    taskId: task.id,
                    output,
                    completedAt: new Date().toISOString(),
                    success: true
                };
                agent.results.push(result);
                agent.completedTasks.push(task.id);
                results.push(result);

                console.log(`[Swarm] ${agent.name} completed task: ${task.id}`);
            } catch (err: any) {
                task.status = 'failed';
                task.result = err.message;

                results.push({
                    taskId: task.id,
                    output: err.message,
                    completedAt: new Date().toISOString(),
                    success: false
                });
            }
            this.save();
        }

        agent.status = pendingTasks.length > 0 ? 'completed' : 'idle';
        this.save();

        return results;
    }

    async runAllAgents(): Promise<Map<string, AgentResult[]>> {
        const results = new Map<string, AgentResult[]>();

        // Get all agents with pending tasks
        const agentsWithTasks = this.data.agents.filter(a =>
            this.data.tasks.some(t => t.agentId === a.id && t.status === 'pending')
        );

        console.log(`[Swarm] Running ${agentsWithTasks.length} agents in parallel...`);

        // Run all in parallel
        const promises = agentsWithTasks.map(async (agent) => {
            const agentResults = await this.runAgent(agent.id);
            return { agentId: agent.id, results: agentResults };
        });

        const allResults = await Promise.all(promises);

        for (const { agentId, results: agentResults } of allResults) {
            results.set(agentId, agentResults);
        }

        return results;
    }

    // ===== STATUS =====

    getStatus(): { agents: number; pendingTasks: number; completedTasks: number; working: number } {
        return {
            agents: this.data.agents.length,
            pendingTasks: this.data.tasks.filter(t => t.status === 'pending').length,
            completedTasks: this.data.tasks.filter(t => t.status === 'completed').length,
            working: this.data.agents.filter(a => a.status === 'working').length
        };
    }

    getAgentStatus(agentId: string): {
        agent?: SwarmAgent;
        pendingTasks: AgentTask[];
        completedTasks: AgentTask[];
    } {
        const agent = this.getAgent(agentId);
        if (!agent) return { pendingTasks: [], completedTasks: [] };

        return {
            agent,
            pendingTasks: this.data.tasks.filter(t => t.agentId === agentId && t.status === 'pending'),
            completedTasks: this.data.tasks.filter(t => t.agentId === agentId && t.status === 'completed')
        };
    }

    // ===== INTER-AGENT MESSAGING =====

    sendMessage(fromAgentId: string, toAgentId: string | 'all', content: string, collaborationId?: string): AgentMessage | null {
        const from = this.getAgent(fromAgentId);
        if (!from) return null;

        const message: AgentMessage = {
            id: uuidv4().slice(0, 8),
            fromAgentId,
            fromAgentName: from.name,
            toAgentId,
            content,
            timestamp: new Date().toISOString(),
            collaborationId
        };

        this.data.messages.push(message);
        // Cap messages at 500
        if (this.data.messages.length > 500) {
            this.data.messages = this.data.messages.slice(-500);
        }
        this.save();
        return message;
    }

    broadcast(fromAgentId: string, content: string): AgentMessage | null {
        return this.sendMessage(fromAgentId, 'all', content);
    }

    getMessages(agentId?: string, limit: number = 50): AgentMessage[] {
        let messages = this.data.messages;
        if (agentId) {
            messages = messages.filter(m =>
                m.fromAgentId === agentId || m.toAgentId === agentId || m.toAgentId === 'all'
            );
        }
        return messages.slice(-limit);
    }

    // ===== COLLABORATION =====

    async collaborate(agentIds: string[], goal: string): Promise<CollaborationSession> {
        const session: CollaborationSession = {
            id: uuidv4().slice(0, 8),
            goal,
            agentIds,
            status: 'active',
            messages: [],
            startedAt: new Date().toISOString()
        };
        this.data.collaborations.push(session);
        this.save();

        if (!this.executeCallback) {
            session.status = 'failed';
            session.result = 'No executor callback set';
            this.save();
            return session;
        }

        console.log(`[Swarm] Collaboration started: ${goal} with ${agentIds.length} agents`);

        const validAgents = agentIds.map(id => this.getAgent(id) || this.getAgentByName(id)).filter(Boolean) as SwarmAgent[];
        if (validAgents.length === 0) {
            session.status = 'failed';
            session.result = 'No valid agents found';
            this.save();
            return session;
        }

        let conversationContext = `**Collaboration Goal:** ${goal}\n\n`;

        try {
            // Each agent takes a turn, seeing previous agents' contributions
            for (const agent of validAgents) {
                agent.status = 'working';
                this.save();

                const prompt = `You are ${agent.name}, a ${agent.role} specializing in ${agent.specialization}.\n\nYou are in a collaboration session with other agents.\n\n${conversationContext}\nIt is now YOUR turn. Contribute your expertise to the goal. Build on what others have said. Be concise and focused.`;

                console.log(`[Swarm] ${agent.name} contributing to collaboration...`);
                const output = await this.executeCallback(agent.id, prompt);

                // Record the message
                const msg: AgentMessage = {
                    id: uuidv4().slice(0, 8),
                    fromAgentId: agent.id,
                    fromAgentName: agent.name,
                    toAgentId: 'all',
                    content: output,
                    timestamp: new Date().toISOString(),
                    collaborationId: session.id
                };
                session.messages.push(msg);
                this.data.messages.push(msg);

                conversationContext += `**${agent.name}** (${agent.role}):\n${output}\n\n`;
                agent.status = 'completed';
                this.save();
            }

            // Final synthesis: ask the first agent to summarize
            const lead = validAgents[0];
            const synthPrompt = `You are ${lead.name}. You led a collaboration session.\n\n${conversationContext}\n\nNow synthesize all contributions into a clear, actionable summary. Highlight key decisions and next steps.`;

            const synthesis = await this.executeCallback(lead.id, synthPrompt);
            session.result = synthesis;
            session.status = 'completed';
            session.completedAt = new Date().toISOString();

            console.log(`[Swarm] Collaboration completed: ${session.id}`);
        } catch (err: any) {
            session.status = 'failed';
            session.result = err.message || 'Collaboration failed';
            session.completedAt = new Date().toISOString();
            console.error(`[Swarm] Collaboration failed:`, err);
        }

        // Cap collaborations at 50
        if (this.data.collaborations.length > 50) {
            this.data.collaborations = this.data.collaborations.slice(-50);
        }
        this.save();
        return session;
    }

    getCollaborations(limit: number = 10): CollaborationSession[] {
        return this.data.collaborations.slice(-limit).reverse();
    }

    getCollaboration(id: string): CollaborationSession | undefined {
        return this.data.collaborations.find(c => c.id === id);
    }
}

// Singleton instance
export const agentSwarm = new AgentSwarm();
