// /api/vol — free options & volatility data from the public DoltHub database
// `post-no-preference/options` (SQL over HTTP, no key, no signup).
//
// Why a proxy and not a direct browser call: the same reasons as /api/yahoo —
// we control the SQL (the endpoint takes a symbol, never raw SQL from the
// client), we cache in D1 so a busy page doesn't hammer a free public service,
// and the response shape stays ours even if the upstream schema shifts.
//
// What it serves, none of which Yahoo's option endpoint can give us:
//   ?what=iv&symbol=SPY      IV/HV history + 52w extremes → IV RANK & PERCENTILE
//   ?what=chain&symbol=SPY   the most recent full chain (strike, bid/ask, IV, delta)
//   ?what=leaders            highest / lowest IV-rank names across the database
//
// Two tables upstream (2,321 symbols, 2019-02-09 → today, updated daily):
//   option_chain        date, act_symbol, expiration, strike, call_put, bid, ask, vol, delta, …
//   volatility_history  date, act_symbol, hv_current, iv_current, iv_year_high/low (+ dates), …
//
// GOTCHA worth keeping: the DoltHub branch is `master`, NOT `main` — a `main`
// ref returns {"query_execution_status":"Error", …"branch not found"} with HTTP 200.

import { rateLimit, clientIp } from "../_lib/ratelimit.mjs";

const DOLT = "https://www.dolthub.com/api/v1alpha1/post-no-preference/options/master";
const TTL_MS = 6 * 60 * 60 * 1000; // 6h — this data is end-of-day, it does not move intraday
const MAX_SYMBOL = 12;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// Symbols are the ONLY client-controlled input that reaches SQL, and they are
// hard-restricted to a ticker shape before interpolation — no quotes, no
// wildcards, no separators can survive this.
const cleanSymbol = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9.\-]/g, "").slice(0, MAX_SYMBOL);

async function dolt(sql) {
  const r = await fetch(`${DOLT}?q=${encodeURIComponent(sql)}`, {
    headers: { accept: "application/json" },
  });
  if (!r.ok) throw new Error(`dolthub ${r.status}`);
  const d = await r.json();
  // Upstream reports query failures with HTTP 200 + a status field.
  if (d.query_execution_status !== "Success") {
    throw new Error(String(d.query_execution_message || "query failed").slice(0, 120));
  }
  return d.rows || [];
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** IV rank & percentile from a 52-week window — the metric options traders
 *  actually act on ("is vol expensive relative to its own last year?"), and the
 *  one thing a live chain alone can never tell you.
 *   rank       = (iv − low) / (high − low)        · where in the 52w band it sits
 *   percentile = share of the last year's days with a LOWER iv than today
 */
function ivStats(latest, history) {
  const iv = num(latest.iv_current);
  const hi = num(latest.iv_year_high);
  const lo = num(latest.iv_year_low);
  const rank = iv != null && hi != null && lo != null && hi > lo ? ((iv - lo) / (hi - lo)) * 100 : null;
  const series = history.map((r) => num(r.iv_current)).filter((v) => v != null);
  const pct = iv != null && series.length >= 20
    ? (series.filter((v) => v < iv).length / series.length) * 100
    : null;
  return { rank, percentile: pct, samples: series.length };
}

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const what = url.searchParams.get("what") || "iv";
  const symbol = cleanSymbol(url.searchParams.get("symbol"));
  const db = env.DB;

  // Public endpoint → rate-limited, so nobody can use us to hammer DoltHub.
  const rl = rateLimit(`vol:${clientIp(request)}`, 20, 60_000);
  if (!rl.ok) return json({ ok: false, error: "rate_limited" }, 429);

  const key = `vol:v1:${what}:${symbol || "-"}`;
  const readCache = async () => {
    try {
      const row = await db?.prepare("SELECT data FROM argus_kv WHERE key=?").bind(key).first();
      if (!row) return null;
      const parsed = JSON.parse(row.data);
      return Date.now() - (parsed.at || 0) < TTL_MS ? parsed : null;
    } catch { return null; }
  };
  const writeCache = (obj) =>
    db?.prepare("INSERT INTO argus_kv (key,data,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at")
      .bind(key, JSON.stringify(obj), Date.now()).run().catch(() => {});

  const cached = await readCache();
  if (cached) return json({ ...cached, cached: true });

  try {
    // ── IV / HV history for one symbol ───────────────────────────────────
    if (what === "iv") {
      if (!symbol) return json({ ok: false, error: "no_symbol" }, 400);
      const rows = await dolt(
        `SELECT date, hv_current, iv_current, iv_year_high, iv_year_high_date, iv_year_low, iv_year_low_date, hv_year_high, hv_year_low
         FROM volatility_history WHERE act_symbol='${symbol}' ORDER BY date DESC LIMIT 260`
      );
      if (!rows.length) return json({ ok: false, error: "no_data", symbol }, 404);
      const latest = rows[0];
      const stats = ivStats(latest, rows);
      const out = {
        ok: true, at: Date.now(), symbol,
        date: latest.date,
        iv: num(latest.iv_current),
        hv: num(latest.hv_current),
        // IV over HV: the premium the market charges over what actually moved.
        ivPremium: num(latest.iv_current) != null && num(latest.hv_current) ? num(latest.iv_current) / num(latest.hv_current) : null,
        yearHigh: num(latest.iv_year_high), yearHighDate: latest.iv_year_high_date,
        yearLow: num(latest.iv_year_low), yearLowDate: latest.iv_year_low_date,
        ivRank: stats.rank, ivPercentile: stats.percentile,
        // Ascending series for charting (iv vs hv over the last year).
        history: rows.slice().reverse().map((r) => ({ d: r.date, iv: num(r.iv_current), hv: num(r.hv_current) })),
      };
      await writeCache(out);
      return json(out);
    }

    // ── most recent full chain for one symbol ────────────────────────────
    if (what === "chain") {
      if (!symbol) return json({ ok: false, error: "no_symbol" }, 400);
      const dRows = await dolt(`SELECT MAX(date) AS d FROM option_chain WHERE act_symbol='${symbol}'`);
      const date = dRows?.[0]?.d;
      if (!date) return json({ ok: false, error: "no_data", symbol }, 404);
      const rows = await dolt(
        `SELECT expiration, strike, call_put, bid, ask, vol, delta, gamma, theta, vega
         FROM option_chain WHERE act_symbol='${symbol}' AND date='${date}'
         ORDER BY expiration, strike LIMIT 1200`
      );
      const out = {
        ok: true, at: Date.now(), symbol, date,
        expiries: [...new Set(rows.map((r) => r.expiration))],
        rows: rows.map((r) => ({
          expiry: r.expiration, strike: num(r.strike), side: r.call_put,
          bid: num(r.bid), ask: num(r.ask), iv: num(r.vol),
          delta: num(r.delta), gamma: num(r.gamma), theta: num(r.theta), vega: num(r.vega),
        })),
      };
      await writeCache(out);
      return json(out);
    }

    // ── cross-market IV-rank leaders ─────────────────────────────────────
    // One query over the latest snapshot: where is premium richest/cheapest
    // right now? This is the screener a premium seller opens first.
    if (what === "leaders") {
      const dRows = await dolt("SELECT MAX(date) AS d FROM volatility_history");
      const date = dRows?.[0]?.d;
      if (!date) return json({ ok: false, error: "no_data" }, 404);
      const rows = await dolt(
        `SELECT act_symbol, iv_current, hv_current, iv_year_high, iv_year_low
         FROM volatility_history
         WHERE date='${date}' AND iv_current IS NOT NULL AND iv_year_high > iv_year_low
         LIMIT 4000`
      );
      const scored = rows.map((r) => {
        const iv = num(r.iv_current), hi = num(r.iv_year_high), lo = num(r.iv_year_low), hv = num(r.hv_current);
        return {
          symbol: r.act_symbol, iv, hv,
          ivRank: iv != null && hi != null && lo != null ? ((iv - lo) / (hi - lo)) * 100 : null,
          ivPremium: iv != null && hv ? iv / hv : null,
        };
      }).filter((r) => r.ivRank != null && Number.isFinite(r.ivRank));
      scored.sort((a, b) => b.ivRank - a.ivRank);
      const out = {
        ok: true, at: Date.now(), date, universe: scored.length,
        rich: scored.slice(0, 25),                       // vol expensive vs its own year
        cheap: scored.slice(-25).reverse(),              // vol cheap vs its own year
      };
      await writeCache(out);
      return json(out);
    }

    return json({ ok: false, error: "bad_what" }, 400);
  } catch (e) {
    // Upstream is a free community service — degrade, never 500 the page.
    return json({ ok: false, error: "upstream_unavailable", detail: String(e.message || e).slice(0, 140) }, 503);
  }
}
