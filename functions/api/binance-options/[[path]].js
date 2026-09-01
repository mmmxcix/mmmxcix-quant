// Thin server-side proxy for Binance European Options (eapi.binance.com).
// Mirrors the vite dev proxy in vite.config.js, the same way /api/yahoo does.
//
// WHY A PROXY WHEN SPOT GOES DIRECT: Binance's spot (api.binance.com) and
// futures (fapi) hosts send `Access-Control-Allow-Origin: *`, so src/lib/data.js
// calls them from the browser. The options host does NOT — verified 2026-09-01:
// no CORS header at all on eapi, so every direct browser call fails. Public,
// keyless, GET-only data; nothing secret is attached here.
//
// Two things this proxy is careful about:
//   • an exact-match allowlist (no prefixes, no path segments) — this must never
//     become an open proxy, and exact names sidestep the `../` normalisation
//     trap the LSE proxy documents;
//   • edge caching per endpoint. All visitors share this function's egress IPs
//     against Binance's 400-weight/minute limit, and `mark` / `ticker` are
//     ~0.5 MB responses that change every second — a short shared cache turns
//     N page loads into one upstream call per colo per tier.

const BASE = "https://eapi.binance.com/eapi/v1";

// endpoint → edge cache seconds
const ALLOWED = {
  exchangeInfo: 600,     // the contract master; listings change daily
  mark: 30,              // mark prices, IVs, Greeks — the surface
  ticker: 30,            // 24h volume / turnover / bid-ask
  index: 10,             // underlying index price
  openInterest: 60,      // per (underlying, expiry)
  klines: 60,
  depth: 5,
  exerciseHistory: 300,
};

function json(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export async function onRequest({ request, params }) {
  if (request.method !== "GET") return json({ error: "GET only" }, 405);
  const path = Array.isArray(params.path) ? params.path.join("/") : params.path || "";
  const ttl = Object.prototype.hasOwnProperty.call(ALLOWED, path) ? ALLOWED[path] : null;
  if (ttl == null) return json({ error: "unsupported path" }, 400);

  const url = new URL(request.url);
  const upstream = await fetch(`${BASE}/${path}${url.search}`, {
    headers: { accept: "application/json" },
    cf: { cacheTtl: ttl, cacheEverything: true },
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": "application/json",
      "cache-control": `public, max-age=${ttl}`,
      // Surface Binance's own weight counter so a 429 can be diagnosed from the browser.
      ...(upstream.headers.get("x-mbx-used-weight-1m") ? { "x-mbx-used-weight-1m": upstream.headers.get("x-mbx-used-weight-1m") } : {}),
    },
  });
}
