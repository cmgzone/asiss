import { Skill } from '../core/skills';
import { MemoryManager } from '../core/memory';

export class MemorySkill implements Skill {
    name = 'memory';
    description = 'Search and retrieve past memories and conversations from the long-term memory database.';
    inputSchema = {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['search', 'get_recent'],
                description: 'Action to perform'
            },
            query: {
                type: 'string',
                description: 'Search query (for search action)'
            },
            sessionId: {
                type: 'string',
                description: 'Session ID to filter by (optional)'
            },
            limit: {
                type: 'number',
                description: 'Number of results to return (default: 5)'
            }
        },
        required: ['action']
    };

    private memory: MemoryManager;

    constructor(memory: MemoryManager) {
        this.memory = memory;
    }

    async execute(args: any): Promise<any> {
        const { action, query, sessionId, limit = 5 } = args;

        if (action === 'search') {
            if (!query) return { error: 'Query is required for search' };
            const results = this.memory.search(query, limit);
            return {
                count: results.length,
                results: results.map(r => ({
                    timestamp: new Date(r.timestamp).toISOString(),
                    role: r.role,
                    content: r.content
                }))
            };
        }

        if (action === 'get_recent') {
            if (!sessionId) return { error: 'Session ID is required for get_recent' };
            const results = this.memory.get(sessionId, limit);
            return {
                count: results.length,
                results: results.map(r => ({
                    timestamp: new Date(r.timestamp).toISOString(),
                    role: r.role,
                    content: r.content
                }))
            };
        }

        return { error: 'Invalid action' };
    }
}
