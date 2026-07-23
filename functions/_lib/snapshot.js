// Shared helper for the fleet-agent snapshot endpoints (ships/planes/fires/
// conflicts/disasters/projects/jamming). Same contract everywhere:
//   POST { token, [key]: rows[] }  → stored to KV under `${kv}:snapshot`
//   GET                            → the raw snapshot, edge-cached
// The token is checked against DEV_ACCESS_TOKEN in constant time.

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

/**
 * @param {string} field  body key holding the rows (e.g. "disasters")
 * @param {string} kv     KV key prefix (e.g. "disasters")
 * @param {number} cap    max rows kept
 * @param {number} ttl    KV expiration seconds
 * @param {number} maxAge GET edge cache seconds
 */
export function makeSnapshotHandler(field, kv, cap, ttl, maxAge) {
  return async function onRequest({ request, env }) {
    if (!env.SUBSCRIBERS) return json({ error: "kv_not_bound" }, 503);

    if (request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
      if (!env.DEV_ACCESS_TOKEN || !safeEqual(body.token || "", env.DEV_ACCESS_TOKEN))
        return json({ error: "unauthorized" }, 401);
      if (!Array.isArray(body[field])) return json({ error: `${field}_missing` }, 400);
      const snapshot = { at: Date.now(), count: body[field].length, [field]: body[field].slice(0, cap) };
      await env.SUBSCRIBERS.put(`${kv}:snapshot`, JSON.stringify(snapshot), { expirationTtl: ttl });
      return json({ ok: true, stored: snapshot.count });
    }

    if (request.method === "GET") {
      const raw = await env.SUBSCRIBERS.get(`${kv}:snapshot`);
      if (!raw) return json({ error: "no_snapshot", hint: `agent has not pushed ${field} yet` }, 404);
      return new Response(raw, {
        headers: { "content-type": "application/json", "cache-control": `public, max-age=${maxAge}` },
      });
    }

    return json({ error: "method" }, 405);
  };
}
