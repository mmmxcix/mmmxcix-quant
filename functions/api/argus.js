// /api/argus — state for the Argus day-trading agent (see docs/DAYTRADER_AGENT.md).
// KV keys under "argus:":
//   argus:state    agent → site   heartbeat, equity, heat, bias summary
//   argus:theses   agent → site   the current OPEN theses (overwritten each loop)
//   argus:ledger   agent → site   closed theses (appended, merged by id, capped)
// GET is public (paper-trading display, educational). POST is token-gated.

import { isAdminRequest } from "../_lib/auth.mjs";

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
      // One consolidated key now (see POST) — 5× fewer KV reads/writes than the
      // old five-key layout. Fall back to the legacy keys until the next persist
      // rewrites everything into the snapshot.
      const snap = await read("snapshot");
      if (snap) return json({ ok: true, state: snap.state || null, theses: snap.theses || [], ledger: snap.ledger || [], journal: snap.journal || [], skills: snap.skills || [] });
      const [state, theses, ledger, journal, skills] = await Promise.all([
        read("state"), read("theses"), read("ledger"), read("journal"), read("skills"),
      ]);
      return json({ ok: true, state, theses: theses || [], ledger: ledger || [], journal: journal || [], skills: skills || [] });
    }
    return json({ ok: true, [what]: await read(what) });
  }

  if (request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "bad_json" }, 400); }

    // Dev command channel — the human (admin session, NOT the machine token)
    // queues an instruction the agent acts on next cycle: force-close an open
    // thesis, or cancel a forming/planned setup. Queued in KV; the agent drains
    // it. Session-gated exactly like /api/generate, so the dev UI needs no token.
    if (body.command) {
      if (!(await isAdminRequest(env, request))) return json({ error: "unauthorized" }, 401);
      const c = body.command;
      const type = c?.type === "cancel" ? "cancel" : c?.type === "close" ? "close" : null;
      const id = typeof c?.id === "string" ? c.id.slice(0, 64) : null;
      if (!type || !id) return json({ error: "bad_command" }, 400);
      try {
        let q = [];
        try { q = JSON.parse((await kv.get("argus:commands")) || "[]"); } catch { /* fresh */ }
        q = q.filter((x) => !(x.id === id && x.type === type)); // de-dupe
        q.push({ type, id, at: Date.now() });
        await kv.put("argus:commands", JSON.stringify(q.slice(-50)));
      } catch (e) {
        return json({ error: "kv_write_failed", detail: String(e?.message || e) }, 503);
      }
      return json({ ok: true, queued: { type, id } });
    }

    if (!env.DEV_ACCESS_TOKEN || !safeEqual(body.token || "", env.DEV_ACCESS_TOKEN)) return json({ error: "unauthorized" }, 401);
    // The agent drains the command queue by acking the ids it has handled.
    if (Array.isArray(body.commandAck) && body.commandAck.length) {
      try {
        let q = [];
        try { q = JSON.parse((await kv.get("argus:commands")) || "[]"); } catch { /* fresh */ }
        const done = new Set(body.commandAck);
        await kv.put("argus:commands", JSON.stringify(q.filter((x) => !done.has(x.id))));
      } catch { /* best effort */ }
    }

    // Full reset — wipe state, open theses and the closed ledger. The ledger is
    // append-only by design (merged by id), so clearing it needs an explicit
    // action: used when the paper record was made under conditions we no longer
    // want to judge the agent by.
    if (body.reset === true) {
      try {
        await Promise.all([kv.delete("argus:snapshot"), kv.delete("argus:state"), kv.delete("argus:theses"), kv.delete("argus:ledger"), kv.delete("argus:journal"), kv.delete("argus:skills"), kv.delete("argus:commands")]);
      } catch (e) {
        return json({ error: "kv_reset_failed", detail: String(e?.message || e) }, 503);
      }
      return json({ ok: true, reset: true });
    }

    // Persist the whole agent state as ONE key (argus:snapshot) instead of up to
    // five separate puts per cycle — the old layout was the main consumer of the
    // free-tier daily WRITE budget (~5 writes every 2-15 min). Now it's exactly
    // one write per persist. KV writes can be rejected once the budget is spent;
    // surface that as a clean 503 (the agent retries next cycle).
    try {
      let snap = await read("snapshot");
      if (!snap) { // one-time migration from the legacy keys
        const [state, theses, ledger, journal, skills] = await Promise.all([
          read("state"), read("theses"), read("ledger"), read("journal"), read("skills"),
        ]);
        snap = { state: state || null, theses: theses || [], ledger: ledger || [], journal: journal || [], skills: skills || [] };
      }
      if (body.state) snap.state = { ...body.state, at: Date.now() };
      if (Array.isArray(body.theses)) snap.theses = body.theses.slice(0, 200);
      if (Array.isArray(body.journal)) snap.journal = body.journal.slice(0, 300);
      if (Array.isArray(body.skills)) snap.skills = body.skills.slice(0, 50);
      if (Array.isArray(body.ledgerAdd) && body.ledgerAdd.length) {
        const byId = new Map((snap.ledger || []).map((c) => [c.id, c]));
        for (const c of body.ledgerAdd) byId.set(c.id, c);
        snap.ledger = [...byId.values()].sort((a, b) => (b.exitAt || 0) - (a.exitAt || 0)).slice(0, LEDGER_CAP);
      }
      await kv.put("argus:snapshot", JSON.stringify(snap));
    } catch (e) {
      return json({ error: "kv_write_failed", detail: String(e?.message || e) }, 503);
    }
    return json({ ok: true });
  }

  return json({ error: "method" }, 405);
}
