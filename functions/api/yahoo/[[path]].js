// Thin server-side proxy for Yahoo Finance (browsers can't call it directly
// because of CORS). Mirrors the vite dev proxy in vite.config.js:
//   /api/yahoo/v8/finance/chart/AAPL?range=1y&interval=1d
//   → https://query1.finance.yahoo.com/v8/finance/chart/AAPL?...
export async function onRequest({ request, params }) {
  const url = new URL(request.url);
  const path = Array.isArray(params.path) ? params.path.join("/") : params.path || "";
  if (!path.startsWith("v8/finance/") && !path.startsWith("v1/finance/")) {
    return new Response(JSON.stringify({ error: "unsupported path" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  const target = `https://query1.finance.yahoo.com/${path}${url.search}`;
  const upstream = await fetch(target, {
    headers: { "user-agent": "Mozilla/5.0 (compatible; mmmxcix-quant/1.0)" },
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=300",
    },
  });
}
