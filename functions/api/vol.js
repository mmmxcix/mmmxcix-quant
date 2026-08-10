// /api/vol — free options & volatility data (IV rank / percentile) sourced from
// the public DoltHub `post-no-preference/options` database.
//
// ARCHITECTURE — why a synced snapshot and not a live proxy:
// DoltHub's free SQL API is generous but SLOW and row-capped. Measured Aug 2026:
// a per-symbol history query takes 13-55s (filtering by act_symbol is a full
// scan — the table's key order is by DATE), and every response is capped at
// 1000 rows. That is fine for a nightly job and completely unusable for a page
// a human is waiting on.
//
// So: one scheduled SYNC pulls the whole latest snapshot (all ~2,300 symbols,
// paginated 1000 at a time) into D1, and every read serves from D1 in
// milliseconds. The snapshot carries iv_current, hv_current, the 52-week
// high/low WITH dates, and the week/month-ago readings — enough for IV rank,
// IV percentile-by-band, the premium ratio and a small trend, without ever
// touching the upstream on a user request.
//
//   GET  ?what=iv&symbol=SPY   one symbol's volatility card
//   GET  ?what=leaders         richest / cheapest IV rank across the universe
//   GET  ?what=status          when the snapshot was last synced
//   POST { token, sync: true } refresh the snapshot (dev token or admin cookie)
//
// GOTCHA worth keeping: the DoltHub branch is `master`, NOT `main` — a `main`
// ref returns {"query_execution_status":"Error", …"branch not found"} on HTTP 200.

import { rateLimit, clientIp } from "../_lib/ratelimit.mjs";
import { isAdminRequest } from "../_lib/auth.mjs";

const DOLT = "https://www.dolthub.com/api/v1alpha1/post-no-preference/options/master";
const SNAP_KEY = "vol:snapshot:v1";
const PAGE = 1000;      // DoltHub caps every response at 1000 rows
const MAX_PAGES = 4;    // ~2.3k symbols today; 4 pages is headroom, not a limit we expect to hit
const STALE_MS = 4 * 24 * 60 * 60 * 1000; // flag a snapshot older than 4 days

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// The only client-controlled value that ever reaches SQL, hard-restricted to a
// ticker shape first — no quotes, wildcards or separators can survive this.
const cleanSymbol = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9.\-]/g, "").slice(0, 12);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

async function dolt(sql) {
  const r = await fetch(`${DOLT}?q=${encodeURIComponent(sql)}`, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`dolthub http ${r.status}`);
  const d = await r.json();
  // Upstream reports failures with HTTP 200 + a status field. "RowLimit" means
  // the page was truncated at 1000 — expected, and why we paginate.
  const st = d.query_execution_status;
  if (st !== "Success" && st !== "RowLimit") {
    throw new Error(String(d.query_execution_message || "query failed").slice(0, 140));
  }
  return { rows: d.rows || [], truncated: st === "RowLimit" };
}

/** IV rank: where today's implied vol sits inside its own 52-week band.
 *  This is the number options traders act on — "IV 28%" is meaningless alone,
 *  "IV rank 92" says premium is near its most expensive in a year. */
function rankOf(iv, hi, lo) {
  if (iv == null || hi == null || lo == null || !(hi > lo)) return null;
  return Math.max(0, Math.min(100, ((iv - lo) / (hi - lo)) * 100));
}

// ── snapshot storage (D1 argus_kv, same table as the other cached endpoints) ──
async function readSnapshot(db) {
  try {
    const row = await db?.prepare("SELECT data FROM argus_kv WHERE key=?").bind(SNAP_KEY).first();
    return row ? JSON.parse(row.data) : null;
  } catch { return null; }
}

async function writeSnapshot(db, snap) {
  await db?.prepare(
    "INSERT INTO argus_kv (key,data,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at"
  ).bind(SNAP_KEY, JSON.stringify(snap), Date.now()).run();
}

/** Pull the newest full-universe volatility snapshot, paginated. */
async function syncSnapshot(db) {
  const head = await dolt("SELECT MAX(date) AS d FROM volatility_history");
  const date = head.rows?.[0]?.d;
  if (!date) throw new Error("no date in volatility_history");

  const bySymbol = {};
  let fetched = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { rows, truncated } = await dolt(
      `SELECT act_symbol, iv_current, hv_current, iv_year_high, iv_year_low,
              iv_year_high_date, iv_year_low_date, iv_week_ago, iv_month_ago, hv_week_ago
       FROM volatility_history WHERE date='${date}'
       ORDER BY act_symbol LIMIT ${PAGE} OFFSET ${page * PAGE}`
    );
    for (const r of rows) {
      const iv = num(r.iv_current), hi = num(r.iv_year_high), lo = num(r.iv_year_low);
      // Store compactly — this blob is read on every page view.
      bySymbol[r.act_symbol] = {
        iv, hv: num(r.hv_current), hi, lo,
        hiD: r.iv_year_high_date || null, loD: r.iv_year_low_date || null,
        w: num(r.iv_week_ago), m: num(r.iv_month_ago), hvW: num(r.hv_week_ago),
        r: rankOf(iv, hi, lo),
      };
    }
    fetched += rows.length;
    if (!truncated || rows.length < PAGE) break;
  }
  const snap = { date, at: Date.now(), count: Object.keys(bySymbol).length, fetched, bySymbol };
  await writeSnapshot(db, snap);
  return snap;
}

export async function onRequest({ request, env }) {
  const db = env.DB;
  if (!db) return json({ ok: false, error: "db_not_bound" }, 503);
  const url = new URL(request.url);

  // ── POST: refresh the snapshot (privileged — it costs a slow upstream call) ──
  if (request.method === "POST") {
    let body = {};
    try { body = await request.json(); } catch { /* allow an empty body */ }
    const tokenOk = !!env.DEV_ACCESS_TOKEN &&
      (request.headers.get("x-lab-token") === env.DEV_ACCESS_TOKEN || body?.token === env.DEV_ACCESS_TOKEN);
    if (!tokenOk && !(await isAdminRequest(env, request))) return json({ ok: false, error: "unauthorized" }, 401);
    try {
      const snap = await syncSnapshot(db);
      return json({ ok: true, synced: true, date: snap.date, symbols: snap.count });
    } catch (e) {
      return json({ ok: false, error: "sync_failed", detail: String(e.message || e).slice(0, 160) }, 502);
    }
  }

  const rl = rateLimit(`vol:${clientIp(request)}`, 30, 60_000);
  if (!rl.ok) return json({ ok: false, error: "rate_limited" }, 429);

  const snap = await readSnapshot(db);
  const what = url.searchParams.get("what") || "iv";

  if (what === "status") {
    return json({
      ok: true, synced: !!snap, date: snap?.date || null,
      symbols: snap?.count || 0, at: snap?.at || null,
      stale: snap ? Date.now() - snap.at > STALE_MS : null,
    });
  }

  // A missing snapshot is a setup state, not an error the user caused — say so.
  if (!snap) return json({ ok: false, error: "not_synced" }, 503);
  const meta = { date: snap.date, syncedAt: snap.at, stale: Date.now() - snap.at > STALE_MS, universe: snap.count };

  if (what === "iv") {
    const symbol = cleanSymbol(url.searchParams.get("symbol"));
    if (!symbol) return json({ ok: false, error: "no_symbol" }, 400);
    const s = snap.bySymbol[symbol];
    if (!s) return json({ ok: false, error: "no_data", symbol }, 404);
    // Percentile-by-band: the share of the universe trading at a LOWER rank —
    // a cross-sectional read ("is this name's vol expensive versus everything
    // else right now?"), complementing the symbol's own 52-week rank.
    const ranks = Object.values(snap.bySymbol).map((x) => x.r).filter((v) => v != null);
    const cross = s.r != null && ranks.length
      ? (ranks.filter((v) => v < s.r).length / ranks.length) * 100 : null;
    return json({
      ok: true, ...meta, symbol,
      iv: s.iv, hv: s.hv,
      ivPremium: s.iv != null && s.hv ? s.iv / s.hv : null,
      ivRank: s.r, crossPercentile: cross,
      yearHigh: s.hi, yearHighDate: s.hiD, yearLow: s.lo, yearLowDate: s.loD,
      ivWeekAgo: s.w, ivMonthAgo: s.m, hvWeekAgo: s.hvW,
    });
  }

  if (what === "leaders") {
    const rows = Object.entries(snap.bySymbol)
      .map(([symbol, s]) => ({
        symbol, iv: s.iv, hv: s.hv, ivRank: s.r,
        ivPremium: s.iv != null && s.hv ? s.iv / s.hv : null,
      }))
      .filter((r) => r.ivRank != null);
    rows.sort((a, b) => b.ivRank - a.ivRank);
    return json({ ok: true, ...meta, rich: rows.slice(0, 25), cheap: rows.slice(-25).reverse() });
  }

  return json({ ok: false, error: "bad_what" }, 400);
}
