import fs from 'fs';
import path from 'path';
import { Skill } from '../core/skills';
import { v4 as uuidv4 } from 'uuid';

interface Invoice {
    id: string;
    client: string;
    items: string[];
    amount: number;
    dueDate: string;
    createdAt: string;
    status: 'pending' | 'paid';
}

interface Contact {
    id: string;
    name: string;
    email?: string;
    phone?: string;
    company?: string;
    notes?: string;
    createdAt: string;
}

interface Followup {
    id: string;
    contactId: string;
    note: string;
    dueDate: string;
    completed: boolean;
    createdAt: string;
}

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
    task: string;
    status: 'todo' | 'in-progress' | 'done';
    createdAt: string;
}

interface FinanceEntry {
    id: string;
    type: 'income' | 'expense';
    amount: number;
    category?: string;
    source?: string;
    date: string;
    notes?: string;
    createdAt: string;
}

interface EmailDraft {
    id: string;
    to: string;
    subject: string;
    body: string;
    createdAt: string;
}

interface Proposal {
    id: string;
    client: string;
    title: string;
    content: string;
    amount?: number;
    createdAt: string;
    status: 'draft' | 'sent' | 'accepted' | 'rejected';
}

interface BusinessData {
    invoices: Invoice[];
    contacts: Contact[];
    followups: Followup[];
    projects: Project[];
    tasks: Task[];
    finance: FinanceEntry[];
    emailDrafts: EmailDraft[];
    proposals: Proposal[];
}

export class BusinessSkill implements Skill {
    name = 'business';
    description = `Business assistant for managing invoices, contacts (CRM), projects, finances, email drafts, and proposals.

Actions:
- invoice_create (client, items, amount, dueDate)
- invoice_list
- invoice_mark_paid (invoiceId)
- crm_add_contact (name, email?, phone?, company?, notes?)
- crm_list_contacts
- crm_add_followup (contactId, note, dueDate)
- crm_list_followups
- project_create (name, description?, deadline?)
- project_add_task (projectId, task)
- project_list
- project_complete_task (taskId)
- finance_log_income (amount, source, date?, notes?)
- finance_log_expense (amount, category, date?, notes?)
- finance_summary (startDate?, endDate?)
- email_draft (to, subject, body)
- email_list_drafts
- proposal_create (client, title, content, amount?)
- proposal_list`;

    inputSchema = {
        type: "object",
        properties: {
            action: {
                type: "string",
                enum: [
                    "invoice_create", "invoice_list", "invoice_mark_paid",
                    "crm_add_contact", "crm_list_contacts", "crm_add_followup", "crm_list_followups",
                    "project_create", "project_add_task", "project_list", "project_complete_task",
                    "finance_log_income", "finance_log_expense", "finance_summary",
                    "email_draft", "email_list_drafts",
                    "proposal_create", "proposal_list"
                ],
                description: "The business action to perform"
            },
            // Generic params - handler picks what it needs
            client: { type: "string" },
            items: { type: "array", items: { type: "string" } },
            amount: { type: "number" },
            dueDate: { type: "string" },
            name: { type: "string" },
            email: { type: "string" },
            phone: { type: "string" },
            company: { type: "string" },
            notes: { type: "string" },
            contactId: { type: "string" },
            note: { type: "string" },
            projectId: { type: "string" },
            task: { type: "string" },
            taskId: { type: "string" },
            invoiceId: { type: "string" },
            source: { type: "string" },
            category: { type: "string" },
            date: { type: "string" },
            startDate: { type: "string" },
            endDate: { type: "string" },
            to: { type: "string" },
            subject: { type: "string" },
            body: { type: "string" },
            title: { type: "string" },
            content: { type: "string" },
            description: { type: "string" },
            deadline: { type: "string" }
        },
        required: ["action"]
    };

    private filePath: string;
    private data: BusinessData;

    constructor() {
        this.filePath = path.join(process.cwd(), 'business_data.json');
        this.data = this.load();
    }

    private load(): BusinessData {
        const emptyData: BusinessData = {
            invoices: [],
            contacts: [],
            followups: [],
            projects: [],
            tasks: [],
            finance: [],
            emailDrafts: [],
            proposals: []
        };

        if (fs.existsSync(this.filePath)) {
            try {
                return JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
            } catch {
                return emptyData;
            }
        }
        return emptyData;
    }

    private save() {
        fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
    }

    async execute(params: any): Promise<any> {
        const { action } = params;

        try {
            switch (action) {
                // ===== INVOICES =====
                case 'invoice_create': {
                    const invoice: Invoice = {
                        id: uuidv4().slice(0, 8),
                        client: params.client || 'Unknown Client',
                        items: params.items || [],
                        amount: params.amount || 0,
                        dueDate: params.dueDate || '',
                        createdAt: new Date().toISOString(),
                        status: 'pending'
                    };
                    this.data.invoices.push(invoice);
                    this.save();
                    return { success: true, message: `Invoice #${invoice.id} created for ${invoice.client}`, invoice };
                }

                case 'invoice_list': {
                    return { invoices: this.data.invoices };
                }

                case 'invoice_mark_paid': {
                    const inv = this.data.invoices.find(i => i.id === params.invoiceId);
                    if (!inv) return { error: 'Invoice not found' };
                    inv.status = 'paid';
                    this.save();
                    return { success: true, message: `Invoice #${inv.id} marked as paid` };
                }

                // ===== CRM =====
                case 'crm_add_contact': {
                    const contact: Contact = {
                        id: uuidv4().slice(0, 8),
                        name: params.name || 'Unknown',
                        email: params.email,
                        phone: params.phone,
                        company: params.company,
                        notes: params.notes,
                        createdAt: new Date().toISOString()
                    };
                    this.data.contacts.push(contact);
                    this.save();
                    return { success: true, message: `Contact "${contact.name}" added`, contact };
                }

                case 'crm_list_contacts': {
                    return { contacts: this.data.contacts };
                }

                case 'crm_add_followup': {
                    const followup: Followup = {
                        id: uuidv4().slice(0, 8),
                        contactId: params.contactId,
                        note: params.note || '',
                        dueDate: params.dueDate || '',
                        completed: false,
                        createdAt: new Date().toISOString()
                    };
                    this.data.followups.push(followup);
                    this.save();
                    return { success: true, message: 'Follow-up added', followup };
                }

                case 'crm_list_followups': {
                    const pending = this.data.followups.filter(f => !f.completed);
                    return { followups: pending };
                }

                // ===== PROJECTS =====
                case 'project_create': {
                    const project: Project = {
                        id: uuidv4().slice(0, 8),
                        name: params.name || 'Untitled Project',
                        description: params.description,
                        deadline: params.deadline,
                        status: 'active',
                        createdAt: new Date().toISOString()
                    };
                    this.data.projects.push(project);
                    this.save();
                    return { success: true, message: `Project "${project.name}" created`, project };
                }

                case 'project_add_task': {
                    const task: Task = {
                        id: uuidv4().slice(0, 8),
                        projectId: params.projectId,
                        task: params.task || '',
                        status: 'todo',
                        createdAt: new Date().toISOString()
                    };
                    this.data.tasks.push(task);
                    this.save();
                    return { success: true, message: 'Task added', task };
                }

                case 'project_list': {
                    const projects = this.data.projects.map(p => ({
                        ...p,
                        tasks: this.data.tasks.filter(t => t.projectId === p.id)
                    }));
                    return { projects };
                }

                case 'project_complete_task': {
                    const task = this.data.tasks.find(t => t.id === params.taskId);
                    if (!task) return { error: 'Task not found' };
                    task.status = 'done';
                    this.save();
                    return { success: true, message: 'Task completed' };
                }

                // ===== FINANCE =====
                case 'finance_log_income': {
                    const entry: FinanceEntry = {
                        id: uuidv4().slice(0, 8),
                        type: 'income',
                        amount: params.amount || 0,
                        source: params.source,
                        date: params.date || new Date().toISOString().split('T')[0],
                        notes: params.notes,
                        createdAt: new Date().toISOString()
                    };
                    this.data.finance.push(entry);
                    this.save();
                    return { success: true, message: `Income of $${entry.amount} logged`, entry };
                }

                case 'finance_log_expense': {
                    const entry: FinanceEntry = {
                        id: uuidv4().slice(0, 8),
                        type: 'expense',
                        amount: params.amount || 0,
                        category: params.category,
                        date: params.date || new Date().toISOString().split('T')[0],
                        notes: params.notes,
                        createdAt: new Date().toISOString()
                    };
                    this.data.finance.push(entry);
                    this.save();
                    return { success: true, message: `Expense of $${entry.amount} logged`, entry };
                }

                case 'finance_summary': {
                    let entries = this.data.finance;

                    if (params.startDate) {
                        entries = entries.filter(e => e.date >= params.startDate);
                    }
                    if (params.endDate) {
                        entries = entries.filter(e => e.date <= params.endDate);
                    }

                    const totalIncome = entries.filter(e => e.type === 'income').reduce((s, e) => s + e.amount, 0);
                    const totalExpenses = entries.filter(e => e.type === 'expense').reduce((s, e) => s + e.amount, 0);
                    const netProfit = totalIncome - totalExpenses;

                    return {
                        totalIncome,
                        totalExpenses,
                        netProfit,
                        entriesCount: entries.length
                    };
                }

                // ===== EMAIL =====
                case 'email_draft': {
                    const draft: EmailDraft = {
                        id: uuidv4().slice(0, 8),
                        to: params.to || '',
                        subject: params.subject || '',
                        body: params.body || '',
                        createdAt: new Date().toISOString()
                    };
                    this.data.emailDrafts.push(draft);
                    this.save();
                    return { success: true, message: 'Email draft saved', draft };
                }

                case 'email_list_drafts': {
                    return { drafts: this.data.emailDrafts };
                }

                // ===== PROPOSALS =====
                case 'proposal_create': {
                    const proposal: Proposal = {
                        id: uuidv4().slice(0, 8),
                        client: params.client || '',
                        title: params.title || 'Untitled Proposal',
                        content: params.content || '',
                        amount: params.amount,
                        createdAt: new Date().toISOString(),
                        status: 'draft'
                    };
                    this.data.proposals.push(proposal);
                    this.save();
                    return { success: true, message: `Proposal "${proposal.title}" created`, proposal };
                }

                case 'proposal_list': {
                    return { proposals: this.data.proposals };
                }

                default:
                    return { error: `Unknown action: ${action}` };
            }
        } catch (err: any) {
            return { error: `Business skill error: ${err.message}` };
        }
    }
}
