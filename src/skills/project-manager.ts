import fs from 'fs';
import path from 'path';
import { Skill } from '../core/skills';
import { v4 as uuidv4 } from 'uuid';
import { agentSwarm } from '../core/agent-swarm';

// ===== DATA TYPES =====

interface Project {
    id: string;
    name: string;
    description?: string;
    deadline?: string;
    status: 'active' | 'completed' | 'on-hold';
    createdAt: string;
}

interface Task {
    id: string;
    projectId: string;
    title: string;
    description?: string;
    priority: 'high' | 'medium' | 'low';
    status: 'todo' | 'in-progress' | 'done';
    assignedAgentId?: string;
    timeSpent: number; // hours
    dueDate?: string;
    createdAt: string;
    completedAt?: string;
}

interface Milestone {
    id: string;
    projectId: string;
    name: string;
    targetDate: string;
    progress: number; // 0-100
    createdAt: string;
}

interface RecurringTask {
    id: string;
    projectId?: string;
    title: string;
    frequency: 'daily' | 'weekly' | 'monthly';
    lastRun?: string;
    nextRun: string;
    createdAt: string;
}

interface ProjectData {
    projects: Project[];
    tasks: Task[];
    milestones: Milestone[];
    recurringTasks: RecurringTask[];
}

// ===== SKILL =====

export class ProjectManagerSkill implements Skill {
    name = 'project_manager';
    description = `Advanced project management with AI agent teams.

PROJECT ACTIONS:
- project_create (name, description?, deadline?)
- project_list
- project_kanban (projectId) - view tasks grouped by status
- project_complete (projectId)

TASK ACTIONS:
- task_create (projectId, title, description?, priority?, dueDate?)
- task_list (projectId?)
- task_update_status (taskId, status: todo|in-progress|done)
- task_set_priority (taskId, priority: high|medium|low)
- task_track_time (taskId, hours)
- task_assign_agent (taskId, agentId)

MILESTONE ACTIONS:
- milestone_create (projectId, name, targetDate)
- milestone_update (milestoneId, progress)
- milestone_list (projectId?)

RECURRING TASK ACTIONS:
- recurring_create (title, frequency: daily|weekly|monthly, projectId?)
- recurring_list

AGENT TEAM ACTIONS:
- agent_create (name, role, specialization)
- agent_list
- agent_delete (agentId)
- agent_assign_task (agentId, taskDescription)
- agent_run (agentId) - execute agent's tasks
- agent_run_all - run all agents in parallel
- agent_replicate (agentId, count) - clone agent for parallel work
- agent_status (agentId?)`;

    private static readonly actionEnum = [
        'project_create',
        'project_list',
        'project_kanban',
        'project_complete',
        'task_create',
        'task_list',
        'task_update_status',
        'task_set_priority',
        'task_track_time',
        'task_assign_agent',
        'milestone_create',
        'milestone_update',
        'milestone_list',
        'recurring_create',
        'recurring_list',
        'agent_create',
        'agent_list',
        'agent_delete',
        'agent_assign_task',
        'agent_run',
        'agent_run_all',
        'agent_replicate',
        'agent_status'
    ] as const;

    inputSchema = {
        type: "object",
        properties: {
            action: {
                type: "string",
                enum: ProjectManagerSkill.actionEnum as unknown as string[],
                description: "The action to perform"
            },
            // Project params
            projectId: { type: "string" },
            name: { type: "string" },
            description: { type: "string" },
            deadline: { type: "string" },
            // Task params
            taskId: { type: "string" },
            title: { type: "string" },
            priority: { type: "string", enum: ["high", "medium", "low"] },
            status: { type: "string" },
            dueDate: { type: "string" },
            hours: { type: "number" },
            // Milestone params
            milestoneId: { type: "string" },
            targetDate: { type: "string" },
            progress: { type: "number" },
            // Recurring params
            frequency: { type: "string", enum: ["daily", "weekly", "monthly"] },
            // Agent params
            agentId: { type: "string" },
            agentName: { type: "string" },
            role: { type: "string" },
            specialization: { type: "string" },
            taskDescription: { type: "string" },
            count: { type: "number" }
        },
        required: ["action"]
    };

    private filePath: string;
    private data: ProjectData;

    constructor() {
        this.filePath = path.join(process.cwd(), 'projects_data.json');
        this.data = this.load();
    }

    private normalizeAction(action: unknown, params: any): string {
        const a = typeof action === 'string' ? action.trim() : '';
        if (!a) return '';
        const lower = a.toLowerCase();

        if (lower === 'list') return 'project_list';
        if (lower === 'projects' || lower === 'project_list') return 'project_list';
        if (lower === 'tasks') return params?.projectId ? 'task_list' : 'task_list';
        if (lower === 'create') return params?.projectId ? 'task_create' : 'project_create';
        if (lower === 'create_project') return 'project_create';
        if (lower === 'create_task') return 'task_create';

        return a;
    }

    private normalizeString(value: unknown): string {
        return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
    }

    private findExactDuplicateProject(name: string, description: string, deadline?: string) {
        const needleName = this.normalizeString(name).toLowerCase();
        const needleDesc = this.normalizeString(description).toLowerCase();
        const needleDeadline = this.normalizeString(deadline || '').toLowerCase();
        return this.data.projects.find((p) => {
            const pName = this.normalizeString(p.name).toLowerCase();
            const pDesc = this.normalizeString(p.description || '').toLowerCase();
            const pDeadline = this.normalizeString(p.deadline || '').toLowerCase();
            return pName === needleName && pDesc === needleDesc && pDeadline === needleDeadline && p.status !== 'completed';
        });
    }

    private dedupeExactProjects() {
        const byKey = new Map<string, Project>();
        const kept: Project[] = [];
        const sorted = [...this.data.projects].sort((a, b) => {
            const ta = Date.parse(a.createdAt || '');
            const tb = Date.parse(b.createdAt || '');
            if (Number.isFinite(ta) && Number.isFinite(tb)) return ta - tb;
            return 0;
        });
        for (const p of sorted) {
            const key = `${this.normalizeString(p.name).toLowerCase()}|${this.normalizeString(p.description || '').toLowerCase()}|${this.normalizeString(p.deadline || '').toLowerCase()}`;
            if (byKey.has(key)) continue;
            byKey.set(key, p);
            kept.push(p);
        }
        const removed = this.data.projects.length - kept.length;
        if (removed > 0) {
            this.data.projects = kept;
            this.save();
        }
        return removed;
    }

    private load(): ProjectData {
        const empty: ProjectData = {
            projects: [],
            tasks: [],
            milestones: [],
            recurringTasks: []
        };
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

    async execute(params: any): Promise<any> {
        const action = this.normalizeAction(params?.action, params);

        try {
            switch (action) {
                // ===== PROJECTS =====
                case 'project_create': {
                    this.dedupeExactProjects();
                    const name = this.normalizeString(params.name || 'Untitled Project');
                    const description = this.normalizeString(params.description || '');
                    const deadline = this.normalizeString(params.deadline || '') || undefined;

                    const existing = this.findExactDuplicateProject(name, description, deadline);
                    if (existing) {
                        return { success: true, message: `Project "${existing.name}" already exists`, project: existing, deduped: true };
                    }

                    const project: Project = {
                        id: uuidv4().slice(0, 8),
                        name,
                        description: description || undefined,
                        deadline,
                        status: 'active',
                        createdAt: new Date().toISOString()
                    };
                    this.data.projects.push(project);
                    this.save();
                    return { success: true, message: `Project "${project.name}" created`, project };
                }

                case 'project_list': {
                    const projects = this.data.projects.map(p => ({
                        ...p,
                        taskCount: this.data.tasks.filter(t => t.projectId === p.id).length,
                        completedTasks: this.data.tasks.filter(t => t.projectId === p.id && t.status === 'done').length
                    }));
                    return { projects };
                }

                case 'project_kanban': {
                    const projectId = params.projectId;
                    const tasks = this.data.tasks.filter(t => t.projectId === projectId);
                    return {
                        todo: tasks.filter(t => t.status === 'todo'),
                        inProgress: tasks.filter(t => t.status === 'in-progress'),
                        done: tasks.filter(t => t.status === 'done')
                    };
                }

                case 'project_complete': {
                    const project = this.data.projects.find(p => p.id === params.projectId);
                    if (!project) return { error: 'Project not found' };
                    project.status = 'completed';
                    this.save();
                    return { success: true, message: `Project "${project.name}" marked complete` };
                }

                // ===== TASKS =====
                case 'task_create': {
                    const task: Task = {
                        id: uuidv4().slice(0, 8),
                        projectId: params.projectId,
                        title: params.title || 'Untitled Task',
                        description: params.description,
                        priority: params.priority || 'medium',
                        status: 'todo',
                        timeSpent: 0,
                        dueDate: params.dueDate,
                        createdAt: new Date().toISOString()
                    };
                    this.data.tasks.push(task);
                    this.save();
                    return { success: true, message: `Task "${task.title}" created`, task };
                }

                case 'task_list': {
                    let tasks = this.data.tasks;
                    if (params.projectId) {
                        tasks = tasks.filter(t => t.projectId === params.projectId);
                    }
                    return { tasks };
                }

                case 'task_update_status': {
                    const task = this.data.tasks.find(t => t.id === params.taskId);
                    if (!task) return { error: 'Task not found' };
                    task.status = params.status;
                    if (params.status === 'done') {
                        task.completedAt = new Date().toISOString();
                    }
                    this.save();
                    return { success: true, message: `Task status updated to "${params.status}"` };
                }

                case 'task_set_priority': {
                    const task = this.data.tasks.find(t => t.id === params.taskId);
                    if (!task) return { error: 'Task not found' };
                    task.priority = params.priority;
                    this.save();
                    return { success: true, message: `Priority set to "${params.priority}"` };
                }

                case 'task_track_time': {
                    const task = this.data.tasks.find(t => t.id === params.taskId);
                    if (!task) return { error: 'Task not found' };
                    task.timeSpent += params.hours || 0;
                    this.save();
                    return { success: true, message: `Added ${params.hours}h. Total: ${task.timeSpent}h` };
                }

                case 'task_assign_agent': {
                    const task = this.data.tasks.find(t => t.id === params.taskId);
                    if (!task) return { error: 'Task not found' };
                    const agent = agentSwarm.getAgent(params.agentId);
                    if (!agent) return { error: 'Agent not found' };
                    task.assignedAgentId = params.agentId;
                    // Also queue the task for the agent
                    agentSwarm.assignTask(params.agentId, `Complete task: ${task.title}\n${task.description || ''}`);
                    this.save();
                    return { success: true, message: `Task assigned to agent "${agent.name}"` };
                }

                // ===== MILESTONES =====
                case 'milestone_create': {
                    const milestone: Milestone = {
                        id: uuidv4().slice(0, 8),
                        projectId: params.projectId,
                        name: params.name || 'Milestone',
                        targetDate: params.targetDate || '',
                        progress: 0,
                        createdAt: new Date().toISOString()
                    };
                    this.data.milestones.push(milestone);
                    this.save();
                    return { success: true, message: `Milestone "${milestone.name}" created`, milestone };
                }

                case 'milestone_update': {
                    const milestone = this.data.milestones.find(m => m.id === params.milestoneId);
                    if (!milestone) return { error: 'Milestone not found' };
                    milestone.progress = Math.min(100, Math.max(0, params.progress || 0));
                    this.save();
                    return { success: true, message: `Milestone progress: ${milestone.progress}%` };
                }

                case 'milestone_list': {
                    let milestones = this.data.milestones;
                    if (params.projectId) {
                        milestones = milestones.filter(m => m.projectId === params.projectId);
                    }
                    return { milestones };
                }

                // ===== RECURRING TASKS =====
                case 'recurring_create': {
                    const nextRun = this.calculateNextRun(params.frequency);
                    const recurring: RecurringTask = {
                        id: uuidv4().slice(0, 8),
                        projectId: params.projectId,
                        title: params.title || 'Recurring Task',
                        frequency: params.frequency || 'daily',
                        nextRun,
                        createdAt: new Date().toISOString()
                    };
                    this.data.recurringTasks.push(recurring);
                    this.save();
                    return { success: true, message: `Recurring task created (${recurring.frequency})`, recurring };
                }

                case 'recurring_list': {
                    return { recurringTasks: this.data.recurringTasks };
                }

                // ===== AGENT ACTIONS =====
                case 'agent_create': {
                    const agent = agentSwarm.createAgent(
                        params.name || params.agentName || 'Agent',
                        params.role || 'general',
                        params.specialization || 'various tasks'
                    );
                    return { success: true, message: `Agent "${agent.name}" created`, agent };
                }

                case 'agent_list': {
                    const agents = agentSwarm.listAgents();
                    return { agents };
                }

                case 'agent_delete': {
                    const deleted = agentSwarm.deleteAgent(params.agentId);
                    return deleted
                        ? { success: true, message: 'Agent deleted' }
                        : { error: 'Agent not found' };
                }

                case 'agent_assign_task': {
                    const agent = agentSwarm.getAgent(params.agentId);
                    if (!agent) return { error: 'Agent not found' };
                    const task = agentSwarm.assignTask(params.agentId, params.taskDescription);
                    return { success: true, message: `Task assigned to ${agent.name}`, task };
                }

                case 'agent_run': {
                    const results = await agentSwarm.runAgent(params.agentId);
                    return {
                        success: true,
                        message: `Agent completed ${results.length} tasks`,
                        results
                    };
                }

                case 'agent_run_all': {
                    const resultsMap = await agentSwarm.runAllAgents();
                    const summary: { agentId: string; taskCount: number }[] = [];
                    resultsMap.forEach((results, agentId) => {
                        summary.push({ agentId, taskCount: results.length });
                    });
                    return {
                        success: true,
                        message: `Parallel execution complete`,
                        summary
                    };
                }

                case 'agent_replicate': {
                    const clones = agentSwarm.replicateAgent(params.agentId, params.count || 2);
                    return {
                        success: true,
                        message: `Created ${clones.length} agent copies`,
                        agents: clones
                    };
                }

                case 'agent_status': {
                    if (params.agentId) {
                        const status = agentSwarm.getAgentStatus(params.agentId);
                        return status;
                    }
                    return agentSwarm.getStatus();
                }

                default:
                    return {
                        error: `Unknown action: ${String(params?.action ?? action)}`,
                        allowedActions: ProjectManagerSkill.actionEnum
                    };
            }
        } catch (err: any) {
            return { error: `ProjectManager error: ${err.message}` };
        }
    }

    private calculateNextRun(frequency: string): string {
        const now = new Date();
        switch (frequency) {
            case 'daily':
                now.setDate(now.getDate() + 1);
                break;
            case 'weekly':
                now.setDate(now.getDate() + 7);
                break;
            case 'monthly':
                now.setMonth(now.getMonth() + 1);
                break;
        }
        return now.toISOString().split('T')[0];
    }
}
