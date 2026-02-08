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
        const empty: SwarmData = { agents: [], tasks: [] };
        if (fs.existsSync(this.filePath)) {
            try {
                return JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
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

    createAgent(name: string, role: string, specialization: string): SwarmAgent {
        const agent: SwarmAgent = {
            id: uuidv4().slice(0, 8),
            name,
            role,
            specialization,
            status: 'idle',
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
}

// Singleton instance
export const agentSwarm = new AgentSwarm();
