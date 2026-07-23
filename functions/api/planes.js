// /api/planes — the global air-traffic snapshot (same pattern as /api/ships).
//
// The PC fleet agent sweeps ~26 dense flight regions worldwide through the
// community ADS-B APIs (home IP — gentle pacing, no Cloudflare-egress rate
// trouble) and POSTs a merged snapshot every ~90s. The map GETs it and
// paints global air traffic instantly.
//
// Row format: [hex, lat, lon, altFt(-1=ground), gs, track, category, callsign, type]

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function safeEqual(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(String(a));
  const bb = enc.encode(String(b));
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

export async function onRequest({ request, env }) {
  if (!env.SUBSCRIBERS) return json({ error: "kv_not_bound" }, 503);

  if (request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
    const tokenOk = !!env.DEV_ACCESS_TOKEN && safeEqual(body.token || "", env.DEV_ACCESS_TOKEN);
    if (!tokenOk) return json({ error: "unauthorized" }, 401);
    if (!Array.isArray(body.planes)) return json({ error: "planes_missing" }, 400);
    const snapshot = { at: Date.now(), count: body.planes.length, planes: body.planes.slice(0, 15000) };
    await env.SUBSCRIBERS.put("planes:snapshot", JSON.stringify(snapshot), { expirationTtl: 900 });
    return json({ ok: true, stored: snapshot.count });
  }

  if (request.method === "GET") {
    const raw = await env.SUBSCRIBERS.get("planes:snapshot");
    if (!raw) return json({ error: "no_snapshot", hint: "fleet agent has not pushed planes yet" }, 404);
    return new Response(raw, {
      headers: { "content-type": "application/json", "cache-control": "public, max-age=20" },
    });
  }

  return json({ error: "method" }, 405);
}
