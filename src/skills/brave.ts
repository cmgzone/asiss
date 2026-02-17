import { Skill } from '../core/skills';

interface BraveSearchResult {
  title: string;
  url: string;
  description: string;
}

interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
}

interface BraveApiResponse {
  web?: {
    results?: BraveWebResult[];
  };
}

export class BraveSearchSkill implements Skill {
  name = 'brave_search';
  description = 'Search the web using Brave Search API. IMPORTANT: After receiving results, you MUST synthesize them into a comprehensive professional report with sections (Executive Summary, Key Findings, Detailed Analysis, Sources). Never just list links — always write a full analytical report.';
  inputSchema = {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      maxResults: { type: 'number', description: 'Max results to return (default 5, max 20)' },
      country: { type: 'string', description: 'Country code for results, e.g. "US" (optional)' },
    },
    required: ['query'],
  };

  async execute(params: any): Promise<any> {
    const apiKey = process.env.BRAVE_SEARCH_API_KEY;
    if (!apiKey) {
      return {
        error: 'BRAVE_SEARCH_API_KEY is not set in environment.',
        fix: 'Add BRAVE_SEARCH_API_KEY=your_key to your .env file. Get a free key at https://api.search.brave.com/',
      };
    }

    const query = String(params?.query || '').trim();
    if (!query) {
      return { error: 'query is required' };
    }

    const maxResults = Math.min(20, Math.max(1, typeof params?.maxResults === 'number' ? params.maxResults : 5));
    const country = typeof params?.country === 'string' ? params.country : undefined;

    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(maxResults));
    if (country) {
      url.searchParams.set('country', country);
    }

    try {
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': apiKey,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          error: `Brave API error: ${response.status} ${response.statusText}`,
          details: errorText.slice(0, 500),
        };
      }

      const data: BraveApiResponse = await response.json();
      const webResults = data?.web?.results || [];

      const results: BraveSearchResult[] = webResults.slice(0, maxResults).map((r: BraveWebResult) => ({
        title: r.title || '',
        url: r.url || '',
        description: r.description || '',
      }));

      return {
        query,
        _synthesisInstructions: 'You MUST now write a comprehensive, professional research report based on these results. Include: Executive Summary, Key Findings with data points, Detailed Analysis, and numbered source citations. Do NOT just list these links.',
        results,
        count: results.length,
      };
    } catch (err: any) {
      return {
        error: 'Failed to call Brave Search API',
        details: err?.message || String(err),
      };
    }
  }
}
