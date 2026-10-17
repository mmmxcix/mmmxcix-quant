// Thin server-side proxy for Yahoo Finance (browsers can't call it directly
// because of CORS). Mirrors the vite dev proxy in vite.config.js.
//
// Allowed endpoints: chart (v8), search (v1), option chains (v7), batched
// quotes (v7 quote?symbols=A,B,C — the Monitor/Watchlist/Portfolio tick, one
// request for the whole list), quote summaries (v10, for the anomaly screens:
// short interest & key stats), and the fundamentals timeseries (ws/, for
// balance-sheet items like accruals). v7/v10 require Yahoo's "crumb" + cookie
// anti-bot handshake, which this proxy performs (and caches) transparently;
// v8/v1/ws do not.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Obtain a { cookie, crumb } session for the crumb-protected endpoints. Cached
// in the Cloudflare edge cache for ~25 minutes so we don't re-handshake per call.
const SESSION_KEY = "https://yahoo-session.internal/crumb";

async function getSession({ fresh = false } = {}) {
  const cache = caches.default;
  const cacheKey = new Request(SESSION_KEY);
  const cached = fresh ? null : await cache.match(cacheKey);
  if (cached) {
    const data = await cached.json();
    if (data.cookie && data.crumb) return data;
  }

  // Step 1: a request that hands back Yahoo's consent cookie.
  const r1 = await fetch("https://fc.yahoo.com/", { headers: { "user-agent": UA }, redirect: "manual" });
  const setCookies = typeof r1.headers.getSetCookie === "function"
    ? r1.headers.getSetCookie()
    : [r1.headers.get("set-cookie")].filter(Boolean);
  const cookie = setCookies.map((sc) => sc.split(";")[0]).filter(Boolean).join("; ");

  // Step 2: exchange the cookie for a crumb.
  const r2 = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "user-agent": UA, cookie, accept: "text/plain" },
  });
  const crumb = (await r2.text()).trim();
  const session = { cookie, crumb };

  if (cookie && crumb && !crumb.includes("<")) {
    await cache.put(
      cacheKey,
      new Response(JSON.stringify(session), { headers: { "cache-control": "max-age=1500" } })
    );
  }
  return session;
}

export async function onRequest({ request, params }) {
  const url = new URL(request.url);
  const path = Array.isArray(params.path) ? params.path.join("/") : params.path || "";

  const isChart = path.startsWith("v8/finance/");
  const isSearch = path.startsWith("v1/finance/");
  const isOptions = path.startsWith("v7/finance/options/");
  const isQuote = path === "v7/finance/quote";
  const isSummary = path.startsWith("v10/finance/quoteSummary/");
  const isTimeseries = path.startsWith("ws/fundamentals-timeseries/");
  if (!isChart && !isSearch && !isOptions && !isQuote && !isSummary && !isTimeseries) {
    return new Response(JSON.stringify({ error: "unsupported path" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const needsCrumb = isOptions || isQuote || isSummary || isTimeseries;
  // Build headers + query for one attempt; `fresh` forces a new handshake.
  const prepare = async (fresh) => {
    const headers = { "user-agent": UA };
    let search = url.search;
    if (needsCrumb) {
      try {
        const { cookie, crumb } = await getSession({ fresh });
        if (cookie) headers.cookie = cookie;
        if (crumb) {
          const sep = search ? "&" : "?";
          search = `${search}${sep}crumb=${encodeURIComponent(crumb)}`;
        }
      } catch {
        /* fall through — Yahoo will return its own error if the handshake failed */
      }
    }
    return { headers, search };
  };

  // Cache tiers: fundamentals change at most daily (1h). Chart requests split
  // by freshness need — the Charts page polls the forming bar (intraday
  // intervals) and the quote layer polls range=5d, so those must not sit in a
  // 5-minute edge cache; long history requests can.
  let ttl = 300;
  if (isOptions) ttl = 60;
  else if (isQuote) ttl = 30; // same freshness tier as range=5d chart quotes
  else if (isSummary || isTimeseries) ttl = 3600;
  else if (isChart) {
    const interval = url.searchParams.get("interval") || "";
    const range = url.searchParams.get("range") || "";
    const isIntraday = /[mh]$/.test(interval) && !interval.endsWith("mo");
    if (isIntraday || range === "1d" || range === "5d") ttl = 30;
  }
  const send = async (fresh) => {
    const { headers, search } = await prepare(fresh);
    return fetch(`https://query1.finance.yahoo.com/${path}${search}`, {
      headers,
      cf: { cacheTtl: ttl, cacheEverything: true },
    });
  };
  let upstream = await send(false);
  // A cached crumb that Yahoo has since invalidated answers 401 for ~25 min
  // (the session cache lifetime). Re-handshake once instead of waiting it out.
  if (needsCrumb && upstream.status === 401) upstream = await send(true);
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "cache-control": `public, max-age=${ttl}`,
    },
  });
}
