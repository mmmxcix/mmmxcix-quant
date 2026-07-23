// /api/fires — global active-fire snapshot (NASA FIRMS via the fleet agent).
//
// The PC agent fetches the FIRMS VIIRS world CSV (last 24h) every ~30 min
// with the user's MAP_KEY (env var on the PC — the key never reaches this
// repo or the client), dedupes to 0.02° cells, caps to the 12k strongest
// detections, and POSTs the snapshot here. FIRMS itself updates roughly
// every 3h, so a long KV TTL is honest.
//
// Row format: [lat, lon, frp]  (frp = fire radiative power, MW)

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
    if (!Array.isArray(body.fires)) return json({ error: "fires_missing" }, 400);
    const snapshot = { at: Date.now(), count: body.fires.length, fires: body.fires.slice(0, 12000) };
    await env.SUBSCRIBERS.put("fires:snapshot", JSON.stringify(snapshot), { expirationTtl: 7200 });
    return json({ ok: true, stored: snapshot.count });
  }

  if (request.method === "GET") {
    const raw = await env.SUBSCRIBERS.get("fires:snapshot");
    if (!raw) return json({ error: "no_snapshot", hint: "fleet agent has not pushed fires yet" }, 404);
    return new Response(raw, {
      headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
    });
  }

  return json({ error: "method" }, 405);
}
