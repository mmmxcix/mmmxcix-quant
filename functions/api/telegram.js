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

function safeEqual(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(String(a)), bb = enc.encode(String(b));
  if (ab.length !== bb.length) return false;
  let d = 0;
  for (let i = 0; i < ab.length; i++) d |= ab[i] ^ bb[i];
  return d === 0;
}

const PUSH_FRESH_MS = 10 * 60_000; // MTProto store counts as live for 10 min

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
  const { request, env } = context;
  const db = env.DB;

  // POST — the local MTProto poller (scripts/telegram-mtproto.mjs) pushes messages
  // it read via Telegram's native protocol (catches image-caption channels like
  // FirstSquawk/DeItaone that the t.me/s/ scrape can't). Token-gated, stored in D1.
  if (request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
    if (!env.DEV_ACCESS_TOKEN || !safeEqual(body.token || "", env.DEV_ACCESS_TOKEN)) return json({ error: "unauthorized" }, 401);
    if (db && Array.isArray(body.items)) {
      try {
        await db.prepare("INSERT INTO argus_kv (key, data, updated_at) VALUES ('telegram', ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at")
          .bind(JSON.stringify(body.items.slice(0, 150)), Date.now()).run();
      } catch (e) { return json({ error: "db_write_failed" }, 503); }
    }
    return json({ ok: true, stored: body.items?.length || 0 });
  }

  // GET — prefer the MTProto-pushed store when it's fresh (richer, faster), else
  // fall back to the public t.me/s/ scrape below.
  if (db) {
    try {
      const row = await db.prepare("SELECT data, updated_at FROM argus_kv WHERE key = 'telegram'").first();
      if (row && Date.now() - row.updated_at < PUSH_FRESH_MS) {
        return json({ ok: true, items: JSON.parse(row.data), source: "mtproto", note: "OSINT — unverified, fast (MTProto)." }, 200, { "cache-control": "public, max-age=30" });
      }
    } catch { /* fall through to scrape */ }
  }

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
