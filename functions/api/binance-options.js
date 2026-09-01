// /api/binance-options — the latest Binance options OVERVIEW snapshot (ATM IV
// term structure, 25-delta skew, put/call ratios, open interest per
// underlying), pushed from the user's PC by scripts/binance-options-relay.mjs.
//
// WHY PUSHED, NOT PROXIED: Binance's options host answers every request from
// Cloudflare Workers with a CloudFront 403 (measured in production; the Yahoo
// proxy and the BVOL archive from the same edge are fine), and it sends no CORS
// headers so the browser can't read it either. The one place that reaches it
// is the PC, so the chain is summarised there and stored here — one compact
// JSON blob in D1 argus_kv, the same arrangement as /api/vol and /api/bvol.
//
//   GET                          { ok, at, ageMin, overview[], meta } — 503 not_synced when empty
//   POST { token, overview, meta } store a snapshot (dev token or admin cookie, like /api/bvol)

import { rateLimit, clientIp } from "../_lib/ratelimit.mjs";
import { isAdminRequest } from "../_lib/auth.mjs";
import { validateOverviewSnapshot, cleanMeta } from "../_lib/binanceOptions.mjs";

const KEY = "binance-options:overview:v1";

function json(body, status = 200, cache = "no-store") {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": cache },
  });
}

async function readSnapshot(db) {
  try {
    const row = await db.prepare("SELECT data FROM argus_kv WHERE key=?").bind(KEY).first();
    return row ? JSON.parse(row.data) : null;
  } catch { return null; }
}

async function writeSnapshot(db, snap) {
  await db.prepare(
    "INSERT INTO argus_kv (key,data,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at"
  ).bind(KEY, JSON.stringify(snap), snap.at).run();
}

export async function onRequest({ request, env }) {
  const db = env.DB;
  if (!db) return json({ ok: false, error: "db_not_bound" }, 503);

  if (request.method === "POST") {
    let body = {};
    try { body = await request.json(); } catch { return json({ ok: false, error: "bad_json" }, 400); }
    const tokenOk = !!env.DEV_ACCESS_TOKEN &&
      (request.headers.get("x-lab-token") === env.DEV_ACCESS_TOKEN || body?.token === env.DEV_ACCESS_TOKEN);
    if (!tokenOk && !(await isAdminRequest(env, request))) return json({ ok: false, error: "unauthorized" }, 401);

    const v = validateOverviewSnapshot(body.overview);
    if (!v.ok) return json({ ok: false, error: v.error }, 400);
    const snap = { at: Date.now(), overview: v.overview, meta: cleanMeta(body.meta) };
    try {
      await writeSnapshot(db, snap);
      return json({ ok: true, stored: snap.overview.length, at: snap.at });
    } catch (e) {
      return json({ ok: false, error: "store_failed", detail: String(e.message || e).slice(0, 160) }, 502);
    }
  }

  if (request.method !== "GET") return json({ ok: false, error: "method" }, 405);

  const rl = rateLimit(`binance-options:${clientIp(request)}`, 30, 60_000);
  if (!rl.ok) return json({ ok: false, error: "rate_limited" }, 429);

  const snap = await readSnapshot(db);
  // Nothing pushed yet is a setup state (relay not running), not a user error.
  if (!snap?.overview?.length) return json({ ok: false, error: "not_synced" }, 503);
  return json({
    ok: true, at: snap.at, ageMin: Math.max(0, Math.round((Date.now() - snap.at) / 60_000)),
    overview: snap.overview, meta: snap.meta || null,
  }, 200, "public, max-age=60");
}
