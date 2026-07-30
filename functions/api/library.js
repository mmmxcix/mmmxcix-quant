// /api/library — the strategy library, server-side in D1 (env.DB) so it's shared
// across devices and can be managed continuously by Cortex, instead of living in
// one browser's localStorage. D1's free tier allows 100,000 writes/day (vs KV's
// 1,000), which is what continuous re-testing needs.
//
// Admin-session gated (the dev's private lab), exactly like /api/generate — the
// browser sends its cookie, no token travels from the client. Each row stores the
// full entry as JSON `data` plus denormalised columns (status / candidate_id /
// name / symbol) for querying and Cortex-candidate de-duplication.

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

// Two callers: the dev in a browser (admin session cookie) and the Cortex agent
// on the PC (machine token — header for GET, body for POST), which is what lets
// the agent re-test and re-file the library on its own.
async function authorized(env, request, body) {
  if (await isAdminRequest(env, request)) return true;
  const tok = request.headers.get("x-lab-token") || body?.token || "";
  return !!env.DEV_ACCESS_TOKEN && safeEqual(tok, env.DEV_ACCESS_TOKEN);
}

const OWNER = "dev"; // single-tenant for now; ready to key by user id later
const CAP = 2000;    // safety ceiling on library size

// Pull the denormalised columns out of a full entry object.
function cols(e) {
  return {
    id: String(e.id),
    status: String(e.status || "factory").slice(0, 20),
    candidate_id: e.candidateId ? String(e.candidateId).slice(0, 80) : null,
    name: e.name ? String(e.name).slice(0, 200) : null,
    symbol: e.symbol ? String(e.symbol).slice(0, 40) : null,
  };
}

export async function onRequest({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: "db_not_bound" }, 503);

  if (request.method === "GET") {
    if (!(await authorized(env, request, null))) return json({ error: "unauthorized" }, 401);
    try {
      const { results } = await db
        .prepare("SELECT data FROM library WHERE owner = ? ORDER BY updated_at DESC LIMIT ?")
        .bind(OWNER, CAP)
        .all();
      const entries = (results || []).map((r) => { try { return JSON.parse(r.data); } catch { return null; } }).filter(Boolean);
      return json({ ok: true, entries });
    } catch (e) {
      return json({ error: "db_read_failed", detail: String(e?.message || e) }, 503);
    }
  }

  if (request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
    if (!(await authorized(env, request, body))) return json({ error: "unauthorized" }, 401);
    const now = Date.now();
    try {
      // Remove by id.
      if (body.remove) {
        await db.prepare("DELETE FROM library WHERE owner = ? AND id = ?").bind(OWNER, String(body.remove)).run();
        return json({ ok: true });
      }
      // Status change (the lifecycle move) — cheap, keeps the JSON in sync.
      if (body.setStatus?.id) {
        const status = String(body.setStatus.status || "factory").slice(0, 20);
        const row = await db.prepare("SELECT data FROM library WHERE owner = ? AND id = ?").bind(OWNER, String(body.setStatus.id)).first();
        if (row) {
          let e = {}; try { e = JSON.parse(row.data); } catch { /* corrupt */ }
          e.status = status;
          await db.prepare("UPDATE library SET data = ?, status = ?, updated_at = ? WHERE owner = ? AND id = ?")
            .bind(JSON.stringify(e), status, now, OWNER, String(body.setStatus.id)).run();
        }
        return json({ ok: true });
      }
      // Upsert one or many entries (save-from-backtest, import, migration).
      const list = Array.isArray(body.bulkUpsert) ? body.bulkUpsert : body.upsert ? [body.upsert] : [];
      if (list.length) {
        const stmt = db.prepare(
          "INSERT INTO library (id, owner, data, status, candidate_id, name, symbol, updated_at) VALUES (?,?,?,?,?,?,?,?) " +
          "ON CONFLICT(id) DO UPDATE SET data=excluded.data, status=excluded.status, candidate_id=excluded.candidate_id, name=excluded.name, symbol=excluded.symbol, updated_at=excluded.updated_at"
        );
        const batch = list.slice(0, CAP).map((e) => {
          const c = cols(e);
          return stmt.bind(c.id, OWNER, JSON.stringify(e), c.status, c.candidate_id, c.name, c.symbol, now);
        });
        if (batch.length) await db.batch(batch);
        return json({ ok: true, count: batch.length });
      }
      return json({ error: "empty" }, 400);
    } catch (e) {
      return json({ error: "db_write_failed", detail: String(e?.message || e) }, 503);
    }
  }

  return json({ error: "method" }, 405);
}
