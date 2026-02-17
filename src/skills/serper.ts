import { Skill } from '../core/skills';
import fetch from 'node-fetch';

export class SerperSkill implements Skill {
    name = 'serper_search';
    description = 'Search the web using Google Search via Serper API. Best for high-quality, up-to-date information. IMPORTANT: After receiving results, you MUST synthesize them into a comprehensive professional report with sections (Executive Summary, Key Findings, Detailed Analysis, Sources). Never just list links — always write a full analytical report.';

    inputSchema = {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'The search query'
            },
            type: {
                type: 'string',
                enum: ['search', 'images', 'news', 'places'],
                description: 'Type of search (default: search)',
                default: 'search'
            },
            num: {
                type: 'number',
                description: 'Number of results (default: 10)',
                default: 10
            }
        },
        required: ['query']
    };

    private apiKey: string;

    constructor(apiKey?: string) {
        this.apiKey = apiKey || process.env.SERPER_API_KEY || '';
    }

    async execute(args: any): Promise<any> {
        if (!this.apiKey) {
            this.apiKey = process.env.SERPER_API_KEY || '';
        }

        if (!this.apiKey) {
            return { error: 'Configuration Error: SERPER_API_KEY is missing. Please add it to your .env file.' };
        }

        const { query, type = 'search', num = 10 } = args;
        const endpoint = `https://google.serper.dev/${type}`;

        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'X-API-KEY': this.apiKey,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    q: query,
                    num: num,
                    gl: 'us',
                    hl: 'en'
                })
            });

            if (!response.ok) {
                throw new Error(`Serper API error: ${response.status} ${response.statusText}`);
            }

            const data: any = await response.json();

            // Format results based on type for better AI consumption
            if (type === 'search') {
                const organic = (data.organic || []).map((r: any) => ({
                    title: r.title,
                    link: r.link,
                    snippet: r.snippet,
                    date: r.date
                }));

                const answerBox = data.answerBox ? {
                    title: data.answerBox.title,
                    answer: data.answerBox.answer || data.answerBox.snippet
                } : null;

                return {
                    _synthesisInstructions: 'You MUST now write a comprehensive, professional research report based on these results. Include: Executive Summary, Key Findings with data points, Detailed Analysis, and numbered source citations. Do NOT just list these links.',
                    answerBox,
                    results: organic,
                    related: (data.relatedSearches || []).map((r: any) => r.query)
                };
            }

            if (type === 'news') {
                return {
                    news: (data.news || []).map((n: any) => ({
                        title: n.title,
                        link: n.link,
                        source: n.source,
                        date: n.date,
                        snippet: n.snippet
                    }))
                };
            }

            return data;

        } catch (error: any) {
            console.error('[SerperSkill] Error:', error);
            return { error: `Search failed: ${error.message}` };
        }
    }
}
