// /api/world — the three high-frequency layers (ships · planes · GPS jamming)
// in ONE KV key, written once per agent cycle. Cloudflare's free plan allows
// 1000 KV writes/day; pushing ships/planes/jamming as three separate keys
// every 45–90s blew past that. Bundling them into a single ~3-min write keeps
// the whole map live for well under the free budget.
//
// POST { token, ships[], planes[], jamming[] } → world:snapshot
// GET  → { at, ships, planes, jamming }   (edge-cached)

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function safeEqual(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(String(a)), bb = enc.encode(String(b));
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
    if (!env.DEV_ACCESS_TOKEN || !safeEqual(body.token || "", env.DEV_ACCESS_TOKEN))
      return json({ error: "unauthorized" }, 401);
    const snapshot = {
      at: Date.now(),
      ships: Array.isArray(body.ships) ? body.ships.slice(0, 30000) : [],
      planes: Array.isArray(body.planes) ? body.planes.slice(0, 15000) : [],
      jamming: Array.isArray(body.jamming) ? body.jamming.slice(0, 4000) : [],
    };
    await env.SUBSCRIBERS.put("world:snapshot", JSON.stringify(snapshot), { expirationTtl: 1800 });
    return json({ ok: true, ships: snapshot.ships.length, planes: snapshot.planes.length, jamming: snapshot.jamming.length });
  }

  if (request.method === "GET") {
    const raw = await env.SUBSCRIBERS.get("world:snapshot");
    if (!raw) return json({ error: "no_snapshot", hint: "fleet agent has not pushed yet" }, 404);
    return new Response(raw, {
      headers: { "content-type": "application/json", "cache-control": "public, max-age=30" },
    });
  }

  return json({ error: "method" }, 405);
}
