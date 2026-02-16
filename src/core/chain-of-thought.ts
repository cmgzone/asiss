import { ModelProvider } from './models';

/**
 * Chain-of-Thought Planner — Decomposes complex tasks into sub-steps,
 * executes sequentially, validates each step, and synthesizes results.
 */

export interface PlanStep {
    id: number;
    description: string;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
    result?: string;
    error?: string;
    startedAt?: number;
    completedAt?: number;
}

export interface ExecutionPlan {
    goal: string;
    steps: PlanStep[];
    status: 'planning' | 'executing' | 'completed' | 'failed';
    synthesis?: string;
    createdAt: number;
    completedAt?: number;
}

// Signals that the planner should be used
const COMPLEXITY_SIGNALS = [
    /\b(step[- ]?by[- ]?step|multi[- ]?step|chain[- ]?of[- ]?thought)\b/i,
    /\b(and then|after that|next|finally|first|second|third)\b.*\b(then|next|also)\b/i,
    /\b(plan|roadmap|strategy|approach)\b.*\b(implement|build|create|design)\b/i,
    /\b(debug|investigate|diagnose)\b.*\b(and|then|also)\b/i,
];

export class ChainOfThoughtPlanner {

    /**
     * Determine if a message warrants multi-step planning.
     */
    shouldDecompose(message: string): boolean {
        if (message.length < 60) return false;

        // Check for explicit complexity signals
        if (COMPLEXITY_SIGNALS.some(p => p.test(message))) return true;

        // Count distinct action verbs — multiple implies multi-step
        const actions = message.match(/\b(create|build|implement|add|update|fix|remove|test|deploy|configure|set up|install|migrate)\b/gi);
        if (actions && new Set(actions.map(a => a.toLowerCase())).size >= 3) return true;

        // Multiple numbered items or bullets
        const bullets = (message.match(/^[\s]*[-*•\d]+[.)]\s/gm) || []).length;
        if (bullets >= 3) return true;

        return false;
    }

    /**
     * Decompose a complex goal into ordered sub-steps using the LLM.
     */
    async decompose(goal: string, model: ModelProvider): Promise<ExecutionPlan> {
        const plan: ExecutionPlan = {
            goal,
            steps: [],
            status: 'planning',
            createdAt: Date.now()
        };

        const prompt = [
            'Break down the following task into 3-8 clear, sequential sub-steps.',
            'Each step should be a single, concrete action that can be independently validated.',
            'Output ONLY a JSON array of strings, each being one step description.',
            'Do NOT include explanations outside the JSON array.',
            '',
            `Task: ${goal}`
        ].join('\n');

        try {
            const resp = await model.generate(prompt, 'You are a task decomposition assistant. Output only valid JSON.', []);
            const content = (resp.content || '').trim();

            // Parse JSON array from response
            const jsonMatch = content.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
                const steps: string[] = JSON.parse(jsonMatch[0]);
                plan.steps = steps.map((desc, i) => ({
                    id: i + 1,
                    description: desc,
                    status: 'pending'
                }));
            } else {
                // Fallback: split by newlines
                const lines = content.split('\n')
                    .map(l => l.replace(/^\d+[.)]\s*/, '').trim())
                    .filter(l => l.length > 10);
                plan.steps = lines.map((desc, i) => ({
                    id: i + 1,
                    description: desc,
                    status: 'pending'
                }));
            }

            plan.status = plan.steps.length > 0 ? 'executing' : 'failed';
        } catch (err: any) {
            console.error('[ChainOfThought] Decomposition failed:', err.message);
            plan.status = 'failed';
        }

        return plan;
    }

    /**
     * Validate whether a step's result achieves its objective.
     */
    async validateStep(step: PlanStep, model: ModelProvider): Promise<{ valid: boolean; feedback: string }> {
        if (!step.result) return { valid: false, feedback: 'No result to validate' };

        const prompt = [
            `Step goal: "${step.description}"`,
            `Step result: "${step.result.slice(0, 2000)}"`,
            '',
            'Did the result achieve the step goal? Answer with JSON: { "valid": true/false, "feedback": "brief reason" }'
        ].join('\n');

        try {
            const resp = await model.generate(prompt, 'You are a task validation assistant. Output only valid JSON.', []);
            const content = (resp.content || '').trim();
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                return { valid: Boolean(parsed.valid), feedback: String(parsed.feedback || '') };
            }
        } catch { /* ignore */ }

        // Fallback: assume valid if there's substantial output
        return { valid: step.result.length > 20, feedback: 'Auto-validated by output length' };
    }

    /**
     * Synthesize all step results into a final coherent answer.
     */
    async synthesize(plan: ExecutionPlan, model: ModelProvider): Promise<string> {
        const stepSummaries = plan.steps
            .filter(s => s.status === 'completed' && s.result)
            .map(s => `Step ${s.id} (${s.description}): ${(s.result || '').slice(0, 1000)}`)
            .join('\n\n');

        if (!stepSummaries) return 'No steps were completed successfully.';

        const prompt = [
            `Original goal: ${plan.goal}`,
            '',
            'The following steps were executed:',
            stepSummaries,
            '',
            'Synthesize these results into a clear, coherent final response for the user.',
            'Include all important details and outcomes. Be concise but comprehensive.'
        ].join('\n');

        try {
            const resp = await model.generate(prompt, 'You are synthesizing multi-step task results into a final answer.', []);
            return (resp.content || '').trim() || 'Synthesis complete.';
        } catch (err: any) {
            return `Steps completed but synthesis failed: ${err.message}`;
        }
    }

    /**
     * Get a human-readable progress summary of the plan.
     */
    getProgressSummary(plan: ExecutionPlan): string {
        const completed = plan.steps.filter(s => s.status === 'completed').length;
        const failed = plan.steps.filter(s => s.status === 'failed').length;
        const total = plan.steps.length;

        const lines = [
            `📋 **Plan: ${plan.goal}** (${completed}/${total} steps done${failed > 0 ? `, ${failed} failed` : ''})`,
            ...plan.steps.map(s => {
                const icon = s.status === 'completed' ? '✅' : s.status === 'failed' ? '❌' : s.status === 'running' ? '🔄' : '⬜';
                return `${icon} Step ${s.id}: ${s.description}`;
            })
        ];

        return lines.join('\n');
    }
}

// Singleton
export const chainOfThought = new ChainOfThoughtPlanner();
