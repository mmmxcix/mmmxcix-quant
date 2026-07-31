// /api/telegram — OSINT / breaking-news feed from public Telegram channels.
//
// This is worldmonitor's "faster than TV" edge: OSINT Telegram channels break
// events minutes ahead of the wire services. We read the PUBLIC web preview
// (t.me/s/<channel>) — plain HTML, no API key, no auth, no MTProto — parse the
// latest posts, and merge them newest-first. Cached via the Cloudflare Cache API
// (NOT KV), so it never touches the KV write budget.
//
// These are UNVERIFIED OSINT sources — fast, not authoritative. Labelled as such.

// Curated public channels — verified active + relevant (crypto/finance first,
// then breaking + geopolitics OSINT). Tunable; dead channels are skipped safely.
const CHANNELS = [
  { user: "WatcherGuru", tag: "crypto" },
  { user: "cointelegraph", tag: "crypto" },
  { user: "financialjuice", tag: "finance" },
  { user: "disclosetv", tag: "breaking" },
  { user: "insiderpaper", tag: "breaking" },
  { user: "clashreport", tag: "geopolitics" },
  { user: "WarMonitors", tag: "geopolitics" },
];

const CACHE_TTL = 120; // seconds — OSINT wants freshness, but be gentle on t.me
const PER_CHANNEL = 6;
const MAX_ITEMS = 60;

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*", ...extraHeaders },
  });
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&nbsp;/g, " ");
}

function stripHtml(html) {
  return decodeEntities(
    String(html)
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  ).replace(/\n{3,}/g, "\n\n").trim();
}

// Parse the newest posts out of a t.me/s/ preview page. Each message container
// carries a text div then a dated permalink; media-only posts (no text) are
// skipped. Regex, not a DOM parser (workerd has none).
function parsePreview(html, channel, tag) {
  const re = /tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>[\s\S]*?tgme_widget_message_date[^>]*href="([^"]+)"[\s\S]*?datetime="([^"]+)"/g;
  const out = [];
  let m;
  while ((m = re.exec(html)) && out.length < PER_CHANNEL * 3) {
    const text = stripHtml(m[1]);
    const url = m[2];
    const time = Date.parse(m[3]);
    if (text && text.length > 4 && Number.isFinite(time)) {
      out.push({ channel, tag, text: text.slice(0, 500), url, time });
    }
  }
  // Newest are at the BOTTOM of the preview page → take the last PER_CHANNEL.
  return out.slice(-PER_CHANNEL);
}

async function fetchChannel({ user, tag }) {
  try {
    const res = await fetch(`https://t.me/s/${encodeURIComponent(user)}`, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; mmmxcix-quant/1.0)" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    return parsePreview(await res.text(), user, tag);
  } catch { return []; }
}

export async function onRequest(context) {
  const { request } = context;
  const cacheKey = new Request(new URL(request.url).origin + "/api/telegram", request);
  let cache = null;
  try {
    cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  } catch { /* no cache in local dev */ }

  const settled = await Promise.allSettled(CHANNELS.map(fetchChannel));
  const items = settled
    .filter((s) => s.status === "fulfilled")
    .flatMap((s) => s.value)
    .sort((a, b) => b.time - a.time)
    .slice(0, MAX_ITEMS);

  const response = json(
    { ok: true, items, channels: CHANNELS.length, note: "OSINT — unverified, fast. Public Telegram previews." },
    200,
    { "cache-control": `public, max-age=${CACHE_TTL}` }
  );
  try { if (cache) context.waitUntil(cache.put(cacheKey, response.clone())); } catch { /* ignore */ }
  return response;
}
