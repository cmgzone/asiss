/**
 * ai-news.ts — Fetch the latest AI headlines with NO API key required.
 *
 * Pulls the Google News RSS search feed, parses the XML, and prints the
 * top N (default 15) headlines with source, publish date, and link.
 *
 * Usage:
 *   npx ts-node scripts/ai-news.ts
 *   npx ts-node scripts/ai-news.ts "generative ai"
 *   npx ts-node scripts/ai-news.ts "ai regulation" 10
 *
 * Notes:
 *   - Works on Node 18+ (uses the global `fetch`) and falls back to the
 *     already-installed `node-fetch` package on older runtimes.
 *   - No API key, account, or environment variable is needed.
 */

const DEFAULT_QUERY = "artificial intelligence";
const DEFAULT_LIMIT = 15;

/** A single parsed news item. */
interface NewsItem {
  title: string;
  link: string;
  source: string;
  pubDate: string;
}

/**
 * Resolve a fetch implementation: prefer the built-in global `fetch`
 * (Node 18+), otherwise dynamically load `node-fetch` (v2, already a dep).
 */
async function resolveFetch(): Promise<typeof fetch> {
  const g = globalThis as { fetch?: typeof fetch };
  if (typeof g.fetch === "function") {
    return g.fetch.bind(globalThis);
  }
  // node-fetch v2 is CommonJS; default export is the fetch function.
  const mod: any = await import("node-fetch");
  return (mod.default ?? mod) as typeof fetch;
}

/** Build the Google News RSS search URL for a query. */
function buildFeedUrl(query: string): string {
  const q = encodeURIComponent(query);
  return `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
}

/** Remove CDATA wrappers, HTML tags, and decode common HTML entities. */
function cleanText(raw: string): string {
  if (!raw) return "";
  let text = raw;
  // Strip CDATA sections: <![CDATA[ ... ]]>
  text = text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  // Remove any HTML tags (e.g. <a href=...>Title</a>).
  text = text.replace(/<[^>]+>/g, "");
  // Decode a handful of common HTML entities.
  const entities: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
    "&nbsp;": " ",
  };
  text = text.replace(/&amp;|&lt;|&gt;|&quot;|&#39;|&apos;|&nbsp;/g, (m) => entities[m] ?? m);
  // Decode numeric entities like &#8217;
  text = text.replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(parseInt(code, 10)));
  return text.trim();
}

/** Extract the inner text of the first matching XML tag within a block. */
function extractTag(block: string, tag: string): string {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(block);
  return match ? match[1] : "";
}

/**
 * Parse Google News RSS XML into news items.
 *
 * Google News encodes the source as a <source url="...">Name</source> tag,
 * and appends " - Source" to the <title>. We prefer the <source> tag and
 * strip the trailing " - Source" from the title for a clean headline.
 */
function parseFeed(xml: string): NewsItem[] {
  const items: NewsItem[] = [];
  const itemRegex = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const rawTitle = cleanText(extractTag(block, "title"));
    const link = cleanText(extractTag(block, "link"));
    const pubDate = cleanText(extractTag(block, "pubDate"));
    const source = cleanText(extractTag(block, "source"));

    // Titles look like "Headline - Source"; drop the trailing source name.
    let title = rawTitle;
    if (source && title.endsWith(` - ${source}`)) {
      title = title.slice(0, -(` - ${source}`.length)).trim();
    }

    if (title) {
      items.push({
        title,
        link,
        source: source || "Unknown source",
        pubDate: pubDate || "Unknown date",
      });
    }
  }

  return items;
}

/** Format a pubDate string into a compact, readable form. */
function formatDate(pubDate: string): string {
  const d = new Date(pubDate);
  if (isNaN(d.getTime())) return pubDate;
  return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const query = args[0] && args[0].trim() ? args[0].trim() : DEFAULT_QUERY;
  const limit = args[1] && Number.isFinite(Number(args[1])) ? Math.max(1, parseInt(args[1], 10)) : DEFAULT_LIMIT;

  const url = buildFeedUrl(query);
  console.log(`\nAI News — query: "${query}" (top ${limit})`);
  console.log(`Feed: ${url}\n`);

  const doFetch = await resolveFetch();

  let xml: string;
  try {
    const res = await doFetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ai-news-script/1.0)" },
    });
    if (!res.ok) {
      console.error(`Request failed: HTTP ${res.status} ${res.statusText}`);
      process.exitCode = 1;
      return;
    }
    xml = await res.text();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Could not fetch AI news (network error): ${message}`);
    console.error("Check your internet connection and try again.");
    process.exitCode = 1;
    return;
  }

  const items = parseFeed(xml).slice(0, limit);
  if (items.length === 0) {
    console.log("No news items were found in the feed.");
    return;
  }

  items.forEach((item, i) => {
    const num = String(i + 1).padStart(2, " ");
    console.log(`${num}. ${item.title}`);
    console.log(`    Source: ${item.source}  |  ${formatDate(item.pubDate)}`);
    console.log(`    ${item.link}\n`);
  });

  console.log(`Showing ${items.length} of the latest headlines for "${query}".`);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Unexpected error: ${message}`);
  process.exitCode = 1;
});
