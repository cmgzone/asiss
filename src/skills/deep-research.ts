import { Skill } from '../core/skills';
import { SerperSkill } from './serper';
import { WebFetchSkill, WebSearchSkill } from './web';

type SourceResult = {
  title: string;
  url: string;
  snippet?: string;
  fetched?: {
    finalUrl?: string;
    status?: number;
    contentType?: string | null;
  };
  content?: string;
};

type ImageResult = {
  title?: string;
  url: string;
  source?: string;
  link?: string;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export class DeepResearchSkill implements Skill {
  name = 'deep_research';
  description = 'Run deep research with sources + optional image search. Returns structured data for synthesis.';
  inputSchema = {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Research topic/query' },
      maxSources: { type: 'number', description: 'Max sources to fetch (default 5)' },
      maxImages: { type: 'number', description: 'Max images to return (default 4)' },
      maxFetchChars: { type: 'number', description: 'Max chars to fetch per source (default 6000)' },
      fetchTimeoutMs: { type: 'number', description: 'Fetch timeout per source in ms (default 12000)' }
    },
    required: ['query']
  };

  async execute(args: any): Promise<any> {
    const query = String(args?.query || '').trim();
    if (!query) return { error: 'query is required' };

    const maxSources = clamp(Number(args?.maxSources ?? 5), 1, 10);
    const maxImages = clamp(Number(args?.maxImages ?? 4), 0, 10);
    const maxFetchChars = clamp(Number(args?.maxFetchChars ?? 6000), 1000, 20000);
    const fetchTimeoutMs = clamp(Number(args?.fetchTimeoutMs ?? 12000), 3000, 20000);

    const warnings: string[] = [];

    const serper = new SerperSkill();
    let searchProvider: 'serper' | 'ddg' = 'serper';
    let results: Array<{ title: string; link: string; snippet?: string }> = [];

    const serperSearch = await serper.execute({ query, type: 'search', num: Math.max(maxSources, 6) });
    if (serperSearch?.error) {
      searchProvider = 'ddg';
      warnings.push('Serper search unavailable; falling back to DuckDuckGo.');
      const ddg = await new WebSearchSkill().execute({ query, maxResults: Math.max(maxSources, 6) });
      results = (ddg?.results || []).map((r: any) => ({
        title: r.title,
        link: r.url,
        snippet: r.snippet
      }));
    } else {
      results = (serperSearch?.results || []).map((r: any) => ({
        title: r.title,
        link: r.link,
        snippet: r.snippet
      }));
    }

    const sources: SourceResult[] = [];
    const fetcher = new WebFetchSkill();
    for (const r of results.slice(0, maxSources)) {
      try {
        const fetched = await fetcher.execute({
          url: r.link,
          timeoutMs: fetchTimeoutMs,
          maxChars: maxFetchChars
        });
        sources.push({
          title: r.title,
          url: r.link,
          snippet: r.snippet,
          fetched: {
            finalUrl: fetched?.finalUrl,
            status: fetched?.status,
            contentType: fetched?.contentType
          },
          content: fetched?.text
        });
      } catch (e: any) {
        sources.push({
          title: r.title,
          url: r.link,
          snippet: r.snippet
        });
      }
    }

    let images: ImageResult[] = [];
    if (searchProvider === 'serper' && maxImages > 0) {
      const imageRes = await serper.execute({ query, type: 'images', num: maxImages });
      const imgList = imageRes?.images || imageRes?.imageResults || [];
      images = (imgList || [])
        .map((img: any) => ({
          title: img.title || img.source || img.link,
          url: img.imageUrl || img.thumbnailUrl || img.url,
          source: img.source,
          link: img.link
        }))
        .filter((img: ImageResult) => typeof img.url === 'string' && img.url.startsWith('http'));
    } else if (maxImages > 0) {
      warnings.push('Image search requires SERPER_API_KEY.');
    }

    return {
      query,
      provider: searchProvider,
      sources,
      images,
      warnings
    };
  }
}
