// Cloudflare Pages Function: aggregates finance RSS feeds server-side.
// No npm deps — runs in workerd. Parses RSS with regex/string ops.

// category: "markets" | "crypto" | "business"
// access: "free" | "partial-paywall"
// tier: 1 = wire services + official/government sources (authoritative, slow);
//       2 = mainstream finance media (fast, secondary). The freshness monitor
//       reports per-feed health so a source that quietly dies is visible, not
//       silently dropped.
const FEEDS = [
  // ── Tier 1: official / government + wire-grade mainstream (primary). Reuters
  // and AP no longer publish public RSS, so the wire tier here is the official
  // government sources (Fed / SEC / BLS — the actual market-movers) plus the
  // highest-credibility mainstream desks that still offer open feeds. ──
  {
    source: 'Federal Reserve',
    url: 'https://www.federalreserve.gov/feeds/press_all.xml',
    category: 'business',
    access: 'free',
    tier: 1,
  },
  {
    source: 'SEC',
    url: 'https://www.sec.gov/news/pressreleases.rss',
    category: 'business',
    access: 'free',
    tier: 1,
  },
  {
    source: 'BLS',
    url: 'https://www.bls.gov/feed/bls_latest.rss',
    category: 'business',
    access: 'free',
    tier: 1,
  },
  {
    source: 'BBC Business',
    url: 'https://feeds.bbci.co.uk/news/business/rss.xml',
    category: 'business',
    access: 'free',
    tier: 1,
  },
  {
    source: 'The Guardian',
    url: 'https://www.theguardian.com/business/rss',
    category: 'business',
    access: 'free',
    tier: 1,
  },
  {
    source: 'NPR Business',
    url: 'https://feeds.npr.org/1006/rss.xml',
    category: 'business',
    access: 'free',
    tier: 1,
  },
  // ── Tier 2: mainstream finance media (fast, secondary) ──
  {
    source: 'CNBC',
    url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664',
    category: 'business',
    access: 'free',
    tier: 2,
  },
  {
    source: 'Yahoo Finance',
    url: 'https://finance.yahoo.com/news/rssindex',
    category: 'markets',
    access: 'free',
    tier: 2,
  },
  {
    source: 'CoinDesk',
    url: 'https://www.coindesk.com/arc/outboundfeeds/rss/',
    category: 'crypto',
    access: 'free',
    tier: 2,
  },
  {
    source: 'MarketWatch',
    url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories',
    category: 'markets',
    access: 'partial-paywall',
    tier: 2,
  },
  {
    source: 'Investing.com',
    url: 'https://www.investing.com/rss/news.rss',
    category: 'markets',
    access: 'free',
    tier: 2,
  },
  {
    source: 'Cointelegraph',
    url: 'https://cointelegraph.com/rss',
    category: 'crypto',
    access: 'free',
    tier: 2,
  },
  // ── Tier 1 (official/primary): company press-release wires. Straight from
  // the company, not third-party paraphrase — the best source for exact,
  // material facts (earnings, deals, regulatory filings), especially for
  // small caps that mainstream desks rarely cover. Scoped to business-
  // relevant categories (PR Newswire's site-wide "all releases" feed also
  // carries politics/sports/religion — deliberately excluded). ──
  {
    source: 'PR Newswire (Financial)',
    url: 'https://www.prnewswire.com/rss/financial-services-latest-news/financial-services-latest-news-list.rss',
    category: 'business',
    access: 'free',
    tier: 1,
    kind: 'press',
  },
  {
    source: 'PR Newswire (Tech)',
    url: 'https://www.prnewswire.com/rss/technology-latest-news/technology-latest-news-list.rss',
    category: 'business',
    access: 'free',
    tier: 1,
    kind: 'press',
  },
  {
    source: 'PR Newswire (Health)',
    url: 'https://www.prnewswire.com/rss/health-latest-news/health-latest-news-list.rss',
    category: 'business',
    access: 'free',
    tier: 1,
    kind: 'press',
  },
];

const FEED_TIMEOUT_MS = 10000;
const MAX_ITEMS = 150;
const MAX_ITEMS_PER_FEED = 20; // stops a high-volume wire (PR Newswire) from crowding out everything else
const DESC_MAX = 240;

function stripCdata(str) {
  return str.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

// Named entities we see in RSS/Atom headlines. Numeric (&#8217; &#x2019;) is
// handled generically below — miss those and you get literal "SpaceX&#39;s".
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  mdash: '—', ndash: '–', hellip: '…', middot: '·',
  trade: '™', reg: '®', copy: '©', deg: '°',
  eacute: 'é', egrave: 'è', agrave: 'à', uuml: 'ü',
  ouml: 'ö', auml: 'ä', szlig: 'ß',
};

function decodeEntities(str) {
  return String(str || '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => codePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => codePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, name) =>
      Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : m)
    .replace(/&amp;/g, '&'); // catch a double-encoded &amp; wrapping a numeric entity
}

function codePoint(cp) {
  try { return Number.isFinite(cp) ? String.fromCodePoint(cp) : ''; }
  catch { return ''; }
}

function stripHtml(str) {
  return str.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractTag(block, tag) {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? match[1].trim() : '';
}

function cleanText(raw) {
  // Decode BEFORE stripping: a source that HTML-escapes its own markup (e.g.
  // "&lt;p&gt;...&lt;/p&gt;") only becomes a literal tag after decoding, so
  // stripping first (the old order) let those tags leak into the output.
  return stripHtml(decodeEntities(stripCdata(raw))).trim();
}

function parseFeed(xml, feed) {
  const items = [];
  const itemBlocks = (xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || []).slice(0, MAX_ITEMS_PER_FEED);

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

    items.push({
      title,
      link,
      source: feed.source,
      category: feed.category,
      access: feed.access,
      tier: feed.tier || 2,
      // Tier says how authoritative; KIND says what it actually is. Tier 1 holds
      // two different animals — government/statistical releases and company
      // press-release wires — and both belong there (a company's own filing IS a
      // primary source). But "show me tier 1" then returns a Fed statement and a
      // corporate award announcement side by side, and a caller cannot separate
      // them. This is the missing axis, not a re-tiering.
      kind: feed.kind || (feed.tier === 1 ? 'official' : 'media'),
      pubDate,
      description,
    });
  }

  return items;
}

// Returns a structured result per feed (never throws) so the freshness monitor
// can report which sources are live and how fresh — a dead feed shows up as
// { ok: false } instead of being silently dropped from the aggregate.
async function fetchFeed(feed) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
  try {
    const res = await fetch(feed.url, {
      signal: controller.signal,
      headers: {
        // SEC and some gov feeds require a declared, contactable UA.
        'user-agent':
          'mmmxcix-quant-news/1.0 (admin@mmmxcix.com) Mozilla/5.0 (compatible; +https://mmmxcix.com)',
        accept: 'application/rss+xml, application/xml, text/xml, */*',
      },
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (!res.ok) return { feed, ok: false, items: [], error: `HTTP ${res.status}` };
    const xml = await res.text();
    const items = parseFeed(xml, feed);
    return { feed, ok: true, items, error: items.length ? null : 'no_items' };
  } catch (e) {
    return { feed, ok: false, items: [], error: String(e?.name === 'AbortError' ? 'timeout' : (e?.message || e)).slice(0, 60) };
  } finally {
    clearTimeout(timer);
  }
}

// Age (minutes) of the newest item in a feed, or null if none have a date.
function newestAgeMin(items) {
  let newest = 0;
  for (const it of items) {
    const t = it.pubDate ? Date.parse(it.pubDate) : 0;
    if (Number.isFinite(t) && t > newest) newest = t;
  }
  return newest ? Math.max(0, Math.round((Date.now() - newest) / 60000)) : null;
}

export async function onRequest(context) {
  const { request } = context;

  const jsonHeaders = {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'cache-control': 'public, max-age=90',
  };

  // Optional edge cache (90s — matches News.jsx's live-refresh interval; still
  // free-tier edge caching, just a shorter window than before).
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

  const results = await Promise.all(FEEDS.map(fetchFeed));

  const items = [];
  let successes = 0;
  const feedHealth = [];
  for (const r of results) {
    if (r.ok) { successes++; items.push(...r.items); }
    feedHealth.push({
      source: r.feed.source,
      category: r.feed.category,
      tier: r.feed.tier || 2,
      ok: r.ok,
      items: r.items.length,
      newestAgeMin: newestAgeMin(r.items),
      error: r.error || null,
    });
  }
  // Freshness monitor: a live feed is one that returned items AND whose newest
  // headline is recent (Tier-1 official feeds move slowly, so their window is
  // wider than fast media). "stale" = returned but nothing fresh; "down" = fetch
  // failed. Surfaced in meta so the UI can flag a rotting pipeline.
  const STALE_AFTER_MIN = { 1: 60 * 24 * 3, 2: 60 * 12 }; // tier-1 3d, tier-2 12h
  for (const f of feedHealth) {
    f.status = !f.ok ? 'down'
      : f.newestAgeMin == null ? 'stale'
      : f.newestAgeMin > (STALE_AFTER_MIN[f.tier] || STALE_AFTER_MIN[2]) ? 'stale'
      : 'live';
  }

  const meta = {
    fetchedAt: Date.now(),
    feeds: feedHealth.sort((a, b) => (a.tier - b.tier) || a.source.localeCompare(b.source)),
    live: feedHealth.filter((f) => f.status === 'live').length,
    total: feedHealth.length,
  };

  let body;
  if (successes === 0) {
    body = { items: [], error: 'feeds_unavailable', meta };
  } else {
    items.sort((a, b) => {
      const ta = a.pubDate ? Date.parse(a.pubDate) : 0;
      const tb = b.pubDate ? Date.parse(b.pubDate) : 0;
      return tb - ta;
    });
    body = { items: items.slice(0, MAX_ITEMS), meta };
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
