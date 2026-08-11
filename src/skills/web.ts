import { Skill } from '../core/skills';
import dns from 'dns';
import net from 'net';

type FetchResult = {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string | null;
  raw?: string;
  text: string;
};

const dnsLookupAll = dns.promises.lookup;

const isPrivateIp = (ip: string) => {
  if (!net.isIP(ip)) return false;
  if (ip === '127.0.0.1' || ip === '::1') return true;
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return true;
  if (ip.startsWith('169.254.')) return true;
  if (ip === '0.0.0.0') return true;
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true;
  if (ip.startsWith('fe80:')) return true;
  return false;
};

const ensureSafeUrl = async (inputUrl: string) => {
  let url: URL;
  try {
    url = new URL(inputUrl);
  } catch {
    throw new Error('Invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http/https URLs are allowed');
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.local')) {
    throw new Error('Localhost URLs are not allowed');
  }
  if (net.isIP(hostname) && isPrivateIp(hostname)) {
    throw new Error('Private network URLs are not allowed');
  }
  const addrs = await dnsLookupAll(hostname, { all: true });
  for (const a of addrs) {
    if (isPrivateIp(a.address)) {
      throw new Error('Resolved to private network address; blocked');
    }
  }
  return url;
};

const decodeHtml = (value: string) => {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
};

const stripHtml = (html: string) => {
  let t = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  t = t.replace(/<style[\s\S]*?<\/style>/gi, '');
  t = t.replace(/<\/(p|div|br|li|h\d)>/gi, '\n');
  t = t.replace(/<[^>]+>/g, ' ');
  t = decodeHtml(t);
  t = t.replace(/[ \t]+\n/g, '\n');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
};

const fetchText = async (inputUrl: string, timeoutMs: number, maxChars: number, includeRaw = false): Promise<FetchResult> => {
  const url = await ensureSafeUrl(inputUrl);
  let lastError: unknown;
  // Transient network/DNS failures (EAI_AGAIN, aborts) are common; retry once
  // with a short backoff before surfacing the error to the agent.
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url.toString(), {
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'user-agent': 'myassis/1.0 (+https://localhost)',
          'accept': 'text/html,text/plain;q=0.9,*/*;q=0.1',
        },
      });

      const contentType = res.headers.get('content-type');
      const raw = await res.text();
      const extracted = contentType && contentType.toLowerCase().includes('text/html')
        ? stripHtml(raw)
        : raw.trim();
      const text = extracted.length > maxChars ? extracted.slice(0, maxChars) : extracted;

      return {
        url: url.toString(),
        finalUrl: res.url || url.toString(),
        status: res.status,
        contentType,
        ...(includeRaw ? { raw } : {}),
        text,
      };
    } catch (error) {
      lastError = error;
      if (attempt === 0) {
        await new Promise(resolve => setTimeout(resolve, 600));
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Fetch failed');
};

export class WebFetchSkill implements Skill {
  name = 'web_fetch';
  description = 'Fetch a web page (http/https) and return readable text. Blocks localhost/private networks.';
  capabilities = ['web_fetch'];
  inputSchema = {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to fetch (http/https)' },
      timeoutMs: { type: 'number', description: 'Timeout in ms (default 20000)' },
      maxChars: { type: 'number', description: 'Max characters to return (default 20000)' },
    },
    required: ['url'],
  };

  async execute(params: any): Promise<any> {
    const timeoutMs = typeof params?.timeoutMs === 'number' ? params.timeoutMs : 20000;
    const maxChars = typeof params?.maxChars === 'number' ? params.maxChars : 20000;
    const result = await fetchText(String(params?.url || ''), timeoutMs, maxChars);
    return result;
  }
}

export class WebSearchSkill implements Skill {
  name = 'web_search';
  description = 'Search the web via DuckDuckGo HTML and return candidate sources. No API key required. For research, fetch the strongest sources and report only claims supported by their returned text. Cite the source URLs and never invent missing facts, dates, metrics, model names, or quotations.';
  capabilities = ['web_search'];
  inputSchema = {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      maxResults: { type: 'number', description: 'Max results (default 5)' },
    },
    required: ['query'],
  };

  async execute(params: any): Promise<any> {
    const q = String(params?.query || '').trim();
    const maxResults = typeof params?.maxResults === 'number' ? params.maxResults : 5;
    if (!q) return { results: [] };

    const searchUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
    const fetched = await fetchText(searchUrl, 20000, 40000, true);

    const extractResultUrl = (href: string): string | null => {
      const decodedHref = decodeHtml(href || '').trim();
      if (!decodedHref) return null;
      const absolute = decodedHref.startsWith('//')
        ? `https:${decodedHref}`
        : decodedHref.startsWith('/')
          ? `https://duckduckgo.com${decodedHref}`
          : decodedHref;

      try {
        const parsed = new URL(absolute);
        const duckHost = parsed.hostname.toLowerCase().includes('duckduckgo.com');
        const uddg = parsed.searchParams.get('uddg');
        if (uddg) return uddg;
        if (duckHost) return null;
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.toString();
      } catch {
        return null;
      }
      return null;
    };

    const results: Array<{ title: string; url: string }> = [];
    const seen = new Set<string>();
    const html = fetched.raw || fetched.text;
    const patterns = [
      /<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
      /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
    ];

    for (const linkRe of patterns) {
      let m: RegExpExecArray | null;
      while ((m = linkRe.exec(html)) && results.length < maxResults) {
        const url = extractResultUrl(m[1]);
        const title = stripHtml(m[2]).replace(/\s+/g, ' ').trim();
        if (url && title && !seen.has(url)) {
          seen.add(url);
          results.push({ title, url });
        }
      }
      if (results.length >= maxResults) break;
    }

    return { query: q, results, source: fetched.finalUrl };
  }
}

