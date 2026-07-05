// Cloudflare Pages Function: aggregates finance RSS feeds server-side.
// No npm deps — runs in workerd. Parses RSS with regex/string ops.

const FEEDS = [
  {
    source: 'CNBC',
    url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664',
  },
  {
    source: 'Yahoo Finance',
    url: 'https://finance.yahoo.com/news/rssindex',
  },
  {
    source: 'CoinDesk',
    url: 'https://www.coindesk.com/arc/outboundfeeds/rss/',
  },
  {
    source: 'MarketWatch',
    url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories',
  },
];

const FEED_TIMEOUT_MS = 10000;
const MAX_ITEMS = 60;
const DESC_MAX = 240;

function stripCdata(str) {
  return str.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripHtml(str) {
  return str.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractTag(block, tag) {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? match[1].trim() : '';
}

function cleanText(raw) {
  return decodeEntities(stripHtml(stripCdata(raw))).trim();
}

function parseFeed(xml, source) {
  const items = [];
  const itemBlocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];

  for (const block of itemBlocks) {
    const title = cleanText(extractTag(block, 'title'));
    if (!title) continue;

    let link = cleanText(extractTag(block, 'link'));
    if (!link) {
      // Some feeds put the URL in a guid element.
      const guid = cleanText(extractTag(block, 'guid'));
      if (/^https?:\/\//.test(guid)) link = guid;
    }
    if (!link) continue;

    let pubDate = '';
    const rawDate =
      extractTag(block, 'pubDate') || extractTag(block, 'dc:date') || '';
    if (rawDate) {
      const d = new Date(cleanText(rawDate));
      if (!isNaN(d.getTime())) pubDate = d.toISOString();
    }

    let description = cleanText(extractTag(block, 'description'));
    if (description.length > DESC_MAX) {
      description = description.slice(0, DESC_MAX - 1).trimEnd() + '…';
    }

    items.push({ title, link, source, pubDate, description });
  }

  return items;
}

async function fetchFeed(feed) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
  try {
    const res = await fetch(feed.url, {
      signal: controller.signal,
      headers: {
        'user-agent':
          'Mozilla/5.0 (compatible; mmmxcix-quant-news/1.0; +https://mmmxcix.com)',
        accept: 'application/rss+xml, application/xml, text/xml, */*',
      },
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    return parseFeed(xml, feed.source);
  } finally {
    clearTimeout(timer);
  }
}

export async function onRequest(context) {
  const { request } = context;

  const jsonHeaders = {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'cache-control': 'public, max-age=300',
  };

  // Optional edge cache (5 min).
  let cache = null;
  let cacheKey = null;
  try {
    cache = caches.default;
    cacheKey = new Request(new URL(request.url).toString(), { method: 'GET' });
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  } catch {
    // caches.default unavailable (e.g. local dev) — continue without cache.
  }

  const results = await Promise.allSettled(FEEDS.map(fetchFeed));

  const items = [];
  let successes = 0;
  for (const result of results) {
    if (result.status === 'fulfilled') {
      successes++;
      items.push(...result.value);
    }
  }

  let body;
  if (successes === 0) {
    body = { items: [], error: 'feeds_unavailable' };
  } else {
    items.sort((a, b) => {
      const ta = a.pubDate ? Date.parse(a.pubDate) : 0;
      const tb = b.pubDate ? Date.parse(b.pubDate) : 0;
      return tb - ta;
    });
    body = { items: items.slice(0, MAX_ITEMS) };
  }

  const response = new Response(JSON.stringify(body), {
    status: 200,
    headers: jsonHeaders,
  });

  if (cache && cacheKey && successes > 0) {
    try {
      context.waitUntil(cache.put(cacheKey, response.clone()));
    } catch {
      // Ignore cache write failures.
    }
  }

  return response;
}
