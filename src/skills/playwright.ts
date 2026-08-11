import { Skill } from '../core/skills';
import dns from 'dns';
import net from 'net';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

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

const ensureDir = (dir: string) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

export class PlaywrightSkill implements Skill {
  name = 'playwright';
  description = 'Automate a browser for screenshots, web search, and text extraction. Can run headful (visible) mode. Blocks localhost/private networks by default. Use the "search" action as a fallback web search (no API key needed) and "extract_text" to read any public page.';
  capabilities = ['web_search', 'web_fetch'];
  inputSchema = {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['screenshot', 'extract_text', 'search', 'diagnose'] },
      url: { type: 'string', description: 'http/https URL (required for screenshot/extract_text)' },
      query: { type: 'string', description: 'Search query (required for search action)' },
      maxResults: { type: 'number', description: 'Max search results (default 5)' },
      fullPage: { type: 'boolean', description: 'Full page screenshot (default true)' },
      selector: { type: 'string', description: 'CSS selector for extract_text (optional)' },
      timeoutMs: { type: 'number', description: 'Navigation timeout ms (default 20000)' },
      headless: { type: 'boolean', description: 'If false, show a real browser window (default true)' },
      keepOpenMs: { type: 'number', description: 'Keep browser open after action (ms). Useful when headless=false.' },
      slowMoMs: { type: 'number', description: 'Slow down actions so you can watch (ms per step).' },
      browserChannel: { type: 'string', enum: ['chromium', 'chrome', 'msedge'], description: 'Chromium engine channel (default chromium)' },
      persistent: { type: 'boolean', description: 'If true, use a persistent browser profile directory.' }
    },
    required: ['action']
  };

  async execute(params: any): Promise<any> {
    // Playwright is one of the heaviest dependencies in the process. Load it
    // only when the browser skill is actually used instead of delaying every
    // chat/channel startup.
    const { chromium } = await import('playwright');
    const action = String(params?.action || '').trim();
    const url = typeof params?.url === 'string' ? params.url.trim() : '';
    const timeoutMs = typeof params?.timeoutMs === 'number' ? params.timeoutMs : 20000;
    const fullPage = typeof params?.fullPage === 'boolean' ? params.fullPage : true;
    const selector = typeof params?.selector === 'string' ? params.selector : undefined;
    const headless = typeof params?.headless === 'boolean' ? params.headless : true;
    const keepOpenMsRaw = typeof params?.keepOpenMs === 'number' ? params.keepOpenMs : 0;
    const keepOpenMs = Math.min(300000, Math.max(0, Math.floor(keepOpenMsRaw)));
    const slowMoMsRaw = typeof params?.slowMoMs === 'number' ? params.slowMoMs : 0;
    const slowMoMs = Math.min(5000, Math.max(0, Math.floor(slowMoMsRaw)));
    const browserChannel = typeof params?.browserChannel === 'string' ? params.browserChannel : 'chromium';
    const persistent = typeof params?.persistent === 'boolean' ? params.persistent : false;

    if (action === 'diagnose') {
      const executablePath = chromium.executablePath();
      const executableExists = fs.existsSync(executablePath);
      return {
        playwrightBrowsersPathEnv: process.env.PLAYWRIGHT_BROWSERS_PATH || null,
        chromiumExecutablePath: executablePath,
        chromiumExecutableExists: executableExists
      };
    }

    if (!url && action !== 'search') return { error: 'url is required' };
    const artifactsDir = path.join(process.cwd(), 'artifacts', 'playwright');
    ensureDir(artifactsDir);

    let browser: any;
    let context: any;
    try {
      const launchOptions: any = {
        headless,
        slowMo: slowMoMs || undefined
      };
      if (browserChannel === 'chrome') launchOptions.channel = 'chrome';
      if (browserChannel === 'msedge') launchOptions.channel = 'msedge';

      if (persistent) {
        const userDataDir = path.join(artifactsDir, 'user-data');
        ensureDir(userDataDir);
        context = await chromium.launchPersistentContext(userDataDir, launchOptions);
      } else {
        browser = await chromium.launch(launchOptions);
        context = await browser.newContext();
      }
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (msg.includes('Executable doesn\'t exist') || msg.includes('playwright install')) {
        return {
          error: 'Playwright Chromium is not installed for this user/runtime.',
          fix: [
            'npm run playwright:install',
            'or (install browsers inside the project) npm run playwright:install:local'
          ],
          details: msg
        };
      }
      return { error: msg };
    }
    const page = context.pages?.()?.[0] || await context.newPage();
    try {
      if (action === 'search') {
        const query = String(params?.query || '').trim();
        if (!query) return { error: 'query is required for search action' };
        const maxResults = typeof params?.maxResults === 'number' ? params.maxResults : 5;
        const searchUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

        const links: Array<{ title: string; href: string }> = await page.$$eval(
          'a.result__a',
          (as: any[]) => as.slice(0, 10).map((a) => ({ title: (a.textContent || '').trim(), href: a.getAttribute('href') || '' }))
        ).catch(() => []);

        const results: Array<{ title: string; url: string; snippet: string }> = [];
        for (const link of links.slice(0, maxResults)) {
          let resultUrl = link.href;
          try {
            const parsed = new URL(resultUrl, 'https://duckduckgo.com');
            const uddg = parsed.searchParams.get('uddg');
            if (uddg) resultUrl = decodeURIComponent(uddg);
          } catch { /* keep as-is */ }
          let snippet = '';
          try {
            snippet = await page.evaluate((href: string) => {
              const anchor = document.querySelector(`a.result__a[href="${href}"]`) as any;
              const resultEl = anchor?.closest('.result');
              return (resultEl?.querySelector('.result__snippet')?.textContent || '').trim();
            }, link.href);
          } catch { /* snippet optional */ }
          if (resultUrl) results.push({ title: link.title || '', url: resultUrl, snippet: (snippet || '').trim() });
        }
        return {
          query,
          source: 'playwright+duckduckgo',
          results,
          count: results.length,
          _synthesisInstructions: 'You MUST now write a comprehensive, professional research report based on these results. Include: Executive Summary, Key Findings with data points, Detailed Analysis, and numbered source citations. Do NOT just list these links.'
        };
      }

      const safeUrl = await ensureSafeUrl(url);
      await page.goto(safeUrl.toString(), { waitUntil: 'domcontentloaded', timeout: timeoutMs });

      if (action === 'screenshot') {
        const filename = `screenshot_${new Date().toISOString().replace(/[:.]/g, '-')}_${uuidv4().slice(0, 8)}.png`;
        const filePath = path.join(artifactsDir, filename);
        await page.screenshot({ path: filePath, fullPage });
        return { url: safeUrl.toString(), filePath, headless, persistent, browserChannel };
      }

      if (action === 'extract_text') {
        const title = await page.title();
        const text = selector
          ? await page.locator(selector).first().innerText({ timeout: Math.min(timeoutMs, 10000) })
          : await page.locator('body').innerText({ timeout: Math.min(timeoutMs, 10000) });
        return { url: safeUrl.toString(), finalUrl: page.url(), title, text, headless, persistent, browserChannel };
      }

      return { error: `Unknown action: ${action}` };
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (msg.includes('Executable doesn\'t exist') || msg.includes('playwright install')) {
        return {
          error: 'Playwright Chromium is not installed for this user/runtime.',
          fix: [
            'npm run playwright:install',
            'or (install browsers inside the project) npm run playwright:install:local'
          ],
          details: msg
        };
      }
      return { error: msg };
    } finally {
      if (keepOpenMs > 0) {
        await new Promise((r) => setTimeout(r, keepOpenMs));
      }
      await context?.close?.().catch(() => {});
      await browser?.close?.().catch(() => {});
    }
  }
}
