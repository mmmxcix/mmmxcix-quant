// /api/argus — state for the Argus day-trading agent (see docs/DAYTRADER_AGENT.md).
// Stored in Cloudflare D1 (env.DB, table argus_kv) — NOT KV — because a 24/7 agent
// persists every couple of minutes and KV's free tier allows only 1,000 writes/day
// (which it exhausted, freezing the public display). D1 allows 100,000 writes/day.
// Keys in argus_kv: "snapshot" (state+theses+ledger+journal+skills) and "commands".
// GET is public (paper-trading display, educational). POST is token/admin-gated.

import { isAdminRequest } from "../_lib/auth.mjs";
import { archiveTrades, appendHistory } from "../_lib/archive.mjs";

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
  const db = env.DB;
  const kv = env.SUBSCRIBERS; // legacy, read-only fallback for the one-time migration
  if (!db) return json({ error: "db_not_bound" }, 503);

  const read = async (key) => {
    try { const row = await db.prepare("SELECT data FROM argus_kv WHERE key = ?").bind(key).first(); return row ? JSON.parse(row.data) : null; }
    catch { return null; }
  };
  const write = (key, obj) => db.prepare(
    "INSERT INTO argus_kv (key, data, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at"
  ).bind(key, JSON.stringify(obj), Date.now()).run();
  // Snapshot with a one-time fallback to the old KV copy, so open theses carry
  // over the migration until the agent's next persist rewrites it into D1.
  const readSnap = async () => {
    const d = await read("snapshot");
    if (d) return d;
    if (kv) { try { const s = JSON.parse((await kv.get("argus:snapshot")) || "null"); if (s) return s; } catch { /* none */ } }
    return null;
  };

  if (request.method === "GET") {
    const what = new URL(request.url).searchParams.get("what") || "all";
    if (what === "all") {
      const snap = await readSnap();
      return json({ ok: true, state: snap?.state || null, theses: snap?.theses || [], ledger: snap?.ledger || [], journal: snap?.journal || [], skills: snap?.skills || [], retainedSkills: snap?.retainedSkills || [], invalReviews: snap?.invalReviews || [], invalStats: snap?.invalStats || {} });
    }
    // The ONLY valid non-"all" read is the agent's command poll. Binding an arbitrary
    // `what` as a D1 key let a PUBLIC caller read private argus_kv rows (prefs:watchlist/
    // portfolio, backtest:executor, biasv4:*, telegram, snapshot) — an authorization
    // bypass (CWE-639). Deny by default; only "commands" is served here.
    if (what === "commands") return json({ ok: true, commands: (await read("commands")) || [] });
    return json({ error: "bad_what" }, 400);
  }

  if (request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "bad_json" }, 400); }

    // Dev command channel — the human (admin session, NOT the machine token) queues
    // an instruction the agent acts on next cycle: force-close an open thesis, or
    // cancel a forming/planned setup. Session-gated like /api/generate.
    if (body.command) {
      if (!(await isAdminRequest(env, request))) return json({ error: "unauthorized" }, 401);
      const c = body.command;
      const type = c?.type === "cancel" ? "cancel" : c?.type === "close" ? "close" : c?.type === "reset" ? "reset" : null;
      // reset has no per-thesis target — give it a fixed id so de-dupe still works.
      const id = typeof c?.id === "string" ? c.id.slice(0, 64) : (type === "reset" ? "reset" : null);
      const reason = typeof c?.reason === "string" ? c.reason.slice(0, 200) : "";
      if (!type || !id) return json({ error: "bad_command" }, 400);
      try {
        let q = (await read("commands")) || [];
        q = q.filter((x) => !(x.id === id && x.type === type)); // de-dupe
        q.push({ type, id, reason, at: Date.now() });
        await write("commands", q.slice(-50));
      } catch (e) {
        return json({ error: "db_write_failed" }, 503);
      }
      return json({ ok: true, queued: { type, id } });
    }

    if (!env.DEV_ACCESS_TOKEN || !safeEqual(body.token || "", env.DEV_ACCESS_TOKEN)) return json({ error: "unauthorized" }, 401);
    // The agent drains the command queue by acking the ids it has handled.
    if (Array.isArray(body.commandAck) && body.commandAck.length) {
      try {
        const q = (await read("commands")) || [];
        const done = new Set(body.commandAck);
        await write("commands", q.filter((x) => !done.has(x.id)));
      } catch { /* best effort */ }
    }

    // Full reset — wipe the snapshot + command queue.
    if (body.reset === true) {
      try {
        await db.prepare("DELETE FROM argus_kv").run();
        if (kv) { try { await Promise.all([kv.delete("argus:snapshot"), kv.delete("argus:commands")]); } catch { /* legacy */ } }
      } catch (e) {
        return json({ error: "db_reset_failed" }, 503);
      }
      return json({ ok: true, reset: true });
    }

    // Persist the whole agent state as ONE row.
    try {
      let snap = (await readSnap()) || { state: null, theses: [], ledger: [], journal: [], skills: [] };
      if (body.state) snap.state = { ...body.state, at: Date.now() };
      if (Array.isArray(body.theses)) snap.theses = body.theses.slice(0, 200);
      if (Array.isArray(body.journal)) snap.journal = body.journal.slice(0, 300);
      if (Array.isArray(body.skills)) snap.skills = body.skills.slice(0, 50);
      // retainedSkills = knowledge crystallised before a reset that must survive the
      // journal being cleared (the fresh journal starts empty after a reset).
      if (Array.isArray(body.retainedSkills)) snap.retainedSkills = body.retainedSkills.slice(0, 50);
      // Retrospective-review state: the pending 12h/24h queue and the learned per-kind
      // invalidation tally (the latter survives a reset — it's earned knowledge).
      if (Array.isArray(body.invalReviews)) snap.invalReviews = body.invalReviews.slice(0, 200);
      if (body.invalStats && typeof body.invalStats === "object") snap.invalStats = body.invalStats;
      // ledgerReplace REPLACES the closed-trade ledger (used by the reset to clear
      // the book); ledgerAdd merges new closes into it (the normal path).
      if (Array.isArray(body.ledgerReplace)) {
        snap.ledger = body.ledgerReplace.slice(0, LEDGER_CAP);
      } else if (Array.isArray(body.ledgerAdd) && body.ledgerAdd.length) {
        const byId = new Map((snap.ledger || []).map((c) => [c.id, c]));
        for (const c of body.ledgerAdd) byId.set(c.id, c);
        snap.ledger = [...byId.values()].sort((a, b) => (b.exitAt || 0) - (a.exitAt || 0)).slice(0, LEDGER_CAP);
      }
      await write("snapshot", snap);
    } catch (e) {
      return json({ error: "db_write_failed" }, 503);
    }

    // The durable record underneath the blob (functions/_lib/archive.mjs): the
    // snapshot is capped at 500 trades and is OVERWRITTEN every cycle, so
    // without this there is no way to keep more history than fits in one JSON
    // value, and no way to answer "what did equity do last week" at all.
    //
    // Deliberately AFTER the response-critical write and outside its try: an
    // archive that fails must never stop a 24/7 agent from saving its state.
    // Nothing here is ever read back by this endpoint, so the two stores cannot
    // disagree on screen.
    try {
      const closed = Array.isArray(body.ledgerReplace) ? body.ledgerReplace
        : Array.isArray(body.ledgerAdd) ? body.ledgerAdd : [];
      if (closed.length) await archiveTrades(db, closed);
      if (body.state) await appendHistory(db, body.state);
    } catch { /* the archive is best-effort by design */ }

    return json({ ok: true });
  }

  return json({ error: "method" }, 405);
}
