// /api/conflicts — organized-violence events (UCDP candidate, via fleet agent).
//
// The PC agent downloads the last ~6 monthly UCDP GED *candidate* CSVs
// (Uppsala Conflict Data Program — free, no key, the academic gold standard;
// "candidate" = preliminary monthly coding, revised in the annual release)
// every 12h and pushes a compact snapshot. UCDP publishes monthly, so a long
// KV TTL is honest.
//
// Row format: [lat, lon, best, type, date, country, sideA, sideB]
//   best = best fatality estimate; type: 1 state-based, 2 non-state, 3 one-sided

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
    if (!Array.isArray(body.conflicts)) return json({ error: "conflicts_missing" }, 400);
    const snapshot = { at: Date.now(), count: body.conflicts.length, conflicts: body.conflicts.slice(0, 9000) };
    await env.SUBSCRIBERS.put("conflicts:snapshot", JSON.stringify(snapshot), { expirationTtl: 14 * 86400 });
    return json({ ok: true, stored: snapshot.count });
  }

  if (request.method === "GET") {
    const raw = await env.SUBSCRIBERS.get("conflicts:snapshot");
    if (!raw) return json({ error: "no_snapshot", hint: "fleet agent has not pushed conflicts yet" }, 404);
    return new Response(raw, {
      headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" },
    });
  }

  return json({ error: "method" }, 405);
}
