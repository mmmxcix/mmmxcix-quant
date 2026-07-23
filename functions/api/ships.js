// /api/ships — the fleet snapshot store (worldmonitor pattern).
//
// aisstream.io delivers rich data to residential connections but stays
// SILENT toward Cloudflare egress, so a server-side relay is a dead end.
// Instead the user's 24/7 PC (scripts/ais-agent.mjs) holds the aisstream
// connection and POSTs a compact fleet snapshot here every ~45s; the map
// GETs it and paints the whole world instantly instead of filling a live
// stream from zero.
//
// Snapshot row format (arrays, to keep 20k+ vessels small):
//   [mmsi, lat, lon, sog, cog, type, name, destination]

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extra },
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
    if (!Array.isArray(body.ships)) return json({ error: "ships_missing" }, 400);
    const snapshot = {
      at: Date.now(),
      count: body.ships.length,
      ships: body.ships.slice(0, 30000),
    };
    // 30-min TTL: a dead agent leaves a clearly-stale snapshot, not a zombie.
    await env.SUBSCRIBERS.put("ships:snapshot", JSON.stringify(snapshot), { expirationTtl: 1800 });
    return json({ ok: true, stored: snapshot.count });
  }

  if (request.method === "GET") {
    const raw = await env.SUBSCRIBERS.get("ships:snapshot");
    if (!raw) return json({ error: "no_snapshot", hint: "fleet agent has not pushed yet" }, 404);
    return new Response(raw, {
      headers: {
        "content-type": "application/json",
        // Edge-cache 30s: every visitor shares one KV read per half minute.
        "cache-control": "public, max-age=30",
      },
    });
  }

  return json({ error: "method" }, 405);
}
