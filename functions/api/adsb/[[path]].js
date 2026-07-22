// Proxy for the free community flight-data APIs (both lack CORS headers, so
// the browser can't call them directly). No keys involved — the value of the
// proxy is CORS + edge caching + a strict scope so it can't be abused as an
// open relay.
//
//   /api/adsb/point/{lat}/{lon}/{radius} → api.adsb.lol/v2/point (live aircraft)
//   /api/adsb/route/{callsign}           → api.adsbdb.com/v0/callsign (route DB)

export async function onRequest({ request, params }) {
  if (request.method !== "GET") {
    return new Response(JSON.stringify({ error: "GET only" }), { status: 405, headers: { "content-type": "application/json" } });
  }
  const parts = Array.isArray(params.path) ? params.path : [params.path].filter(Boolean);
  let upstream = null, ttl = 0;

  if (parts[0] === "point" && parts.length === 4) {
    const [lat, lon, radius] = parts.slice(1).map(Number);
    if (![lat, lon, radius].every(Number.isFinite) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return new Response(JSON.stringify({ error: "bad coordinates" }), { status: 400, headers: { "content-type": "application/json" } });
    }
    upstream = `https://api.adsb.lol/v2/point/${lat}/${lon}/${Math.min(250, Math.max(1, radius))}`;
    ttl = 5; // live positions — cache only enough to absorb bursts
  } else if (parts[0] === "route" && parts.length === 2) {
    const cs = String(parts[1]).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
    if (!cs) return new Response(JSON.stringify({ error: "bad callsign" }), { status: 400, headers: { "content-type": "application/json" } });
    upstream = `https://api.adsbdb.com/v0/callsign/${cs}`;
    ttl = 86400; // routes are quasi-static
  } else {
    return new Response(JSON.stringify({ error: "endpoint not allowed" }), { status: 403, headers: { "content-type": "application/json" } });
  }

  const cache = caches.default;
  const cacheKey = new Request(upstream);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const res = await fetch(upstream, { headers: { accept: "application/json" } });
  const body = await res.text();
  const out = new Response(body, {
    status: res.status,
    headers: {
      "content-type": "application/json",
      "cache-control": res.ok ? `public, max-age=${ttl}` : "no-store",
      "access-control-allow-origin": "*",
    },
  });
  if (res.ok) await cache.put(cacheKey, out.clone());
  return out;
}
