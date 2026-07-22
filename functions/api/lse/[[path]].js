// Server-side proxy for the London Strategic Edge data API
// (https://data-api.londonstrategicedge.com). The API key lives ONLY in the
// Cloudflare secret LSE_API_KEY — it is attached server-side and never reaches
// the browser, logs, or the repo.
//
// Without the secret the proxy answers 503, so the UI can degrade gracefully
// ("London data not configured") instead of breaking.

const BASE = "https://data-api.londonstrategicedge.com";

// Strict allowlist — this must never become an open proxy. Each entry is a
// path prefix on the LSE data API.
const ALLOWED = [
  "health",
  "v1/candles",
  "v1/indicators",
  "v1/bond-yields",
  "v1/economic-calendar",
  "indicators",
  "bond-yields",
  "economic-calendar",
];

export async function onRequest({ request, params, env }) {
  if (request.method !== "GET") {
    return new Response(JSON.stringify({ error: "GET only" }), { status: 405, headers: { "content-type": "application/json" } });
  }
  if (!env.LSE_API_KEY) {
    return new Response(JSON.stringify({ error: "London data not configured (LSE_API_KEY secret missing)" }), {
      status: 503, headers: { "content-type": "application/json" },
    });
  }
  const path = Array.isArray(params.path) ? params.path.join("/") : params.path || "";
  if (!ALLOWED.some((p) => path === p || path.startsWith(p + "/") || path.startsWith(p + "?"))) {
    return new Response(JSON.stringify({ error: "endpoint not allowed" }), { status: 403, headers: { "content-type": "application/json" } });
  }

  const url = new URL(request.url);
  const upstream = `${BASE}/${path}${url.search}`;

  // Edge-cache successful answers briefly: candle history is daily data, and
  // repeated backtests of the same symbol shouldn't re-hit the upstream.
  const cache = caches.default;
  const cacheKey = new Request(upstream); // key excludes our secret header
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const res = await fetch(upstream, { headers: { "x-api-key": env.LSE_API_KEY, accept: "application/json" } });
  const body = await res.text();
  const out = new Response(body, {
    status: res.status,
    headers: {
      "content-type": res.headers.get("content-type") || "application/json",
      "cache-control": res.ok ? "public, max-age=600" : "no-store",
      "access-control-allow-origin": "*",
    },
  });
  if (res.ok) await cache.put(cacheKey, out.clone());
  return out;
}
