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
  "v1/l3-equities",
  "indicators",
  "bond-yields",
  "economic-calendar",
  "l3-equities",
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
  const url = new URL(request.url);

  // Build the upstream URL FIRST, then allowlist the NORMALISED pathname. Checking the
  // raw path let `v1/candles/../../../dataset/…` pass the prefix test and then normalise
  // (fetch collapses ../ and \) onto a non-allowlisted endpoint — still on the LSE host,
  // still carrying the owner's API key (CWE-22, check-vs-use gap). Now the collapsed path
  // is what's authorised, and the host must not have moved.
  let upstreamUrl;
  try { upstreamUrl = new URL(`${BASE}/${path}${url.search}`); }
  catch { return new Response(JSON.stringify({ error: "bad path" }), { status: 400, headers: { "content-type": "application/json" } }); }
  const baseHost = new URL(BASE).host;
  const normPath = upstreamUrl.pathname.replace(/^\/+/, "");
  if (upstreamUrl.host !== baseHost || !ALLOWED.some((p) => normPath === p || normPath.startsWith(p + "/"))) {
    return new Response(JSON.stringify({ error: "endpoint not allowed" }), { status: 403, headers: { "content-type": "application/json" } });
  }

  const upstream = upstreamUrl.toString();

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
