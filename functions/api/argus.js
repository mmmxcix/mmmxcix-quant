// /api/argus — state for the Argus day-trading agent (see docs/DAYTRADER_AGENT.md).
// KV keys under "argus:":
//   argus:state    agent → site   heartbeat, equity, heat, bias summary
//   argus:theses   agent → site   the current OPEN theses (overwritten each loop)
//   argus:ledger   agent → site   closed theses (appended, merged by id, capped)
// GET is public (paper-trading display, educational). POST is token-gated.

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function safeEqual(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(String(a)), bb = enc.encode(String(b));
  if (ab.length !== bb.length) return false;
  let d = 0;
  for (let i = 0; i < ab.length; i++) d |= ab[i] ^ bb[i];
  return d === 0;
}

const LEDGER_CAP = 500;

export async function onRequest({ request, env }) {
  const kv = env.SUBSCRIBERS;
  if (!kv) return json({ error: "kv_not_bound" }, 503);

  if (request.method === "GET") {
    const what = new URL(request.url).searchParams.get("what") || "all";
    const read = async (k) => { try { return JSON.parse((await kv.get(`argus:${k}`)) || "null"); } catch { return null; } };
    if (what === "all") {
      const [state, theses, ledger] = await Promise.all([read("state"), read("theses"), read("ledger")]);
      return json({ ok: true, state, theses: theses || [], ledger: ledger || [] });
    }
    return json({ ok: true, [what]: await read(what) });
  }

  if (request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
    if (!env.DEV_ACCESS_TOKEN || !safeEqual(body.token || "", env.DEV_ACCESS_TOKEN)) return json({ error: "unauthorized" }, 401);

    if (body.state) await kv.put("argus:state", JSON.stringify({ ...body.state, at: Date.now() }));
    if (Array.isArray(body.theses)) await kv.put("argus:theses", JSON.stringify(body.theses.slice(0, 200)));
    if (Array.isArray(body.ledgerAdd) && body.ledgerAdd.length) {
      let existing = [];
      try { existing = JSON.parse((await kv.get("argus:ledger")) || "[]"); } catch { /* fresh */ }
      const byId = new Map(existing.map((c) => [c.id, c]));
      for (const c of body.ledgerAdd) byId.set(c.id, c);
      const merged = [...byId.values()].sort((a, b) => (b.exitAt || 0) - (a.exitAt || 0)).slice(0, LEDGER_CAP);
      await kv.put("argus:ledger", JSON.stringify(merged));
    }
    return json({ ok: true });
  }

  return json({ error: "method" }, 405);
}
