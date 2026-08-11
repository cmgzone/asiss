import { Skill } from '../core/skills';
import { mainGoalManager } from '../core/main-goal';

export class MainGoalSkill implements Skill {
    name = 'main_goal';
    description = `Manage the user's main chat goal for this session.

Use this to keep the conversation focused:
- status: inspect the active main goal
- set: replace the active main goal when the user clearly changes focus
- note: add progress/context notes
- constraint: add a requirement or constraint
- acceptance: add what "done" means
- complete: mark the main goal done
- clear: clear the active main goal without marking it done`;

    inputSchema = {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['status', 'set', 'note', 'constraint', 'acceptance', 'complete', 'clear'],
                description: 'Action to perform'
            },
            title: {
                type: 'string',
                description: 'Short title for set'
            },
            objective: {
                type: 'string',
                description: 'Detailed objective for set'
            },
            text: {
                type: 'string',
                description: 'Note, constraint, acceptance criterion, or completion note'
            }
        },
        required: ['action']
    };

    async execute(params: any): Promise<any> {
        const sessionId = params.__sessionId || params.sessionId || 'default';
        const action = params.action;

        switch (action) {
            case 'status':
                return {
                    current: mainGoalManager.getCurrent(sessionId),
                    recent: mainGoalManager.getRecent(sessionId).slice(0, 5)
                };

            case 'set': {
                const title = String(params.title || params.objective || '').trim();
                if (!title) return { error: 'title or objective is required' };
                const goal = mainGoalManager.setGoal(sessionId, {
                    title,
                    objective: params.objective || title,
                    origin: 'manual',
                    confidence: 1
                });
                return { success: true, goal };
            }

            case 'note': {
                const text = String(params.text || '').trim();
                if (!text) return { error: 'text is required' };
                const success = mainGoalManager.addNote(sessionId, text);
                return { success, message: success ? 'Main goal note added' : 'No active main goal' };
            }

            case 'constraint': {
                const text = String(params.text || '').trim();
                if (!text) return { error: 'text is required' };
                const success = mainGoalManager.addConstraint(sessionId, text);
                return { success, message: success ? 'Main goal constraint added' : 'No active main goal' };
            }

            case 'acceptance': {
                const text = String(params.text || '').trim();
                if (!text) return { error: 'text is required' };
                const success = mainGoalManager.addAcceptanceCriterion(sessionId, text);
                return { success, message: success ? 'Main goal acceptance criterion added' : 'No active main goal' };
            }

            case 'complete': {
                const success = mainGoalManager.completeGoal(sessionId, params.text);
                return { success, message: success ? 'Main goal completed' : 'No active main goal' };
            }

            case 'clear': {
                const success = mainGoalManager.clearGoal(sessionId, params.text);
                return { success, message: success ? 'Main goal cleared' : 'No active main goal' };
            }

            default:
                return { error: `Unknown action: ${action}` };
        }
    }
}
