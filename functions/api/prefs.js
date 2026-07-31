// /api/prefs — durable server storage for the user's small private preferences
// (watchlist, portfolio) so a localStorage clear can NEVER lose them again. Same
// auth model as /api/library: admin session cookie in the browser, or the machine
// DEV_ACCESS_TOKEN. Backed by the existing D1 argus_kv table (key/data) under a
// "prefs:" prefix, so there is no new table or migration to run.

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

async function authorized(env, request, body) {
  if (await isAdminRequest(env, request)) return true;
  const tok = request.headers.get("x-lab-token") || body?.token || "";
  return !!env.DEV_ACCESS_TOKEN && safeEqual(tok, env.DEV_ACCESS_TOKEN);
}

// Only a small allow-list of keys, each a JSON array, capped so this can't be
// abused as general storage.
const ALLOWED = new Set(["watchlist", "portfolio"]);
const MAX_BYTES = 128 * 1024;

export async function onRequest({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: "db_not_bound" }, 503);
  const url = new URL(request.url);

  if (request.method === "GET") {
    if (!(await authorized(env, request, null))) return json({ error: "unauthorized" }, 401);
    const name = String(url.searchParams.get("key") || "");
    if (!ALLOWED.has(name)) return json({ error: "bad_key" }, 400);
    try {
      const row = await db.prepare("SELECT data FROM argus_kv WHERE key = ?").bind(`prefs:${name}`).first();
      return json({ ok: true, data: row ? JSON.parse(row.data) : null });
    } catch (e) {
      return json({ error: "db_read_failed", detail: String(e?.message || e) }, 503);
    }
  }

  if (request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
    if (!(await authorized(env, request, body))) return json({ error: "unauthorized" }, 401);
    const name = String(body.key || "");
    if (!ALLOWED.has(name)) return json({ error: "bad_key" }, 400);
    if (!Array.isArray(body.data)) return json({ error: "data_must_be_array" }, 400);
    const payload = JSON.stringify(body.data);
    if (payload.length > MAX_BYTES) return json({ error: "too_large" }, 413);
    try {
      await db.prepare(
        "INSERT INTO argus_kv (key, data, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at"
      ).bind(`prefs:${name}`, payload, Date.now()).run();
      return json({ ok: true, count: body.data.length });
    } catch (e) {
      return json({ error: "db_write_failed", detail: String(e?.message || e) }, 503);
    }
  }

  return json({ error: "method" }, 405);
}
