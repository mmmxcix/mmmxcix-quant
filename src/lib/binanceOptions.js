// binanceOptions.js — Binance European options (eapi) as a data source: the live
// chain per underlying, and the derived numbers a vol trader actually reads
// (ATM IV term structure, 25-delta skew, put/call ratios, open interest).
//
// Public and keyless, but reachable ONLY from a plain machine: the options host
// (eapi) sends no CORS headers (so no browser), AND it answers every request
// from Cloudflare Workers with a CloudFront 403 (so no Pages-Function proxy —
// both verified 2026-09-01; spot/futures and the BVOL archive are fine). So the
// live fetchers below run in Node on the user's PC — scripts/binance-options-
// relay.mjs builds the overview here and pushes it to /api/binance-options as a
// compact snapshot — and the browser reads that snapshot (fetchOptionsSnapshot).
// Under `vite dev` a middleware runs the same Node fetchers, so the panel is
// live locally without a relay. The summary math is pure and exported for tests.
//
// SHAPE OF THE UPSTREAM, measured 2026-09-01 (worth knowing before "optimising"):
//   • exchangeInfo   1.2 MB raw / 33 KB gzipped, weight 1. The contract master:
//                    exact expiry (crypto settles 08:00 UTC, the new XAU/XAG
//                    contracts 21:00 UTC — so expiry is NOT parsed from the symbol).
//   • mark           all 1,946 contracts in one call (weight 5, ~100 KB gz).
//                    `?underlying=` is accepted and IGNORED — it always returns
//                    everything, so one call serves every underlying.
//   • ticker         same: one call, all contracts (weight 40, ~90 KB gz).
//   • index          1 per underlying, weight 1.
//   • openInterest   per (underlying, expiry) — the only per-expiry call, so it
//                    is bounded here (expiries ≤ 90 days, ≤ 8 per underlying).
// Limit: 400 request-weight per minute per IP. A full overview costs ~50 + one
// call per OI expiry (~35 today); the big three are cached for a minute in-process.
//
// IVs from Binance are FRACTIONS (0.763 = 76.3%); a bidIV of -1.0 means "no bid"
// and is mapped to null. All Greeks are Binance's own (one surface per
// underlying: a call and put on the same strike share one markIV).

export const EAPI = "https://eapi.binance.com/eapi/v1";
/** 24h turnover below this, in USDT, and the underlying is tagged illiquid.
 *  Context: BTC options on Binance turn ~8M USDT/day, ETH ~2M; BNB/SOL ~15-25k,
 *  XRP/DOGE/XAU ~3-6k, XAG < 1k. The gold/silver contracts are weeks old. */
export const ILLIQUID_TURNOVER_USDT = 100_000;
export const OI_MAX_DAYS = 90;
export const OI_MAX_EXPIRIES = 8;

const INFO_TTL = 10 * 60_000;
const MARKET_TTL = 60_000;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const positive = (v) => { const n = num(v); return n != null && n > 0 ? n : null; };
const sum = (arr, f) => arr.reduce((a, x) => a + (f(x) || 0), 0);

// ── transport ────────────────────────────────────────────────────────────────
async function getJson(path, timeoutMs = 20_000) {
  const signal = typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined;
  const res = await fetch(`${EAPI}/${path}`, { signal });
  if (!res.ok) {
    const err = new Error(res.status === 429 ? "Binance options rate limit — wait a minute." : `Binance options error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Session cache for the three whole-market calls. A failed load is dropped so
// the next caller retries instead of inheriting the rejection for a minute.
const cache = new Map();
function memo(key, ttl, loader) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.promise;
  const promise = loader().catch((e) => { cache.delete(key); throw e; });
  cache.set(key, { at: Date.now(), promise });
  return promise;
}
/** Drop the session cache (tests, or a manual refresh). */
export function clearBinanceOptionsCache() { cache.clear(); }

// ── normalisation ─────────────────────────────────────────────────────────────
/** "BTC-260925-83000-C" → { base, yymmdd, strike, side } (null when not a contract symbol). */
export function parseSymbol(symbol) {
  const m = /^([A-Z0-9]+)-(\d{6})-([\d.]+)-([CP])$/.exec(String(symbol || ""));
  if (!m) return null;
  return { base: m[1], yymmdd: m[2], strike: Number(m[3]), side: m[4] === "P" ? "PUT" : "CALL" };
}

/**
 * Merge exchangeInfo + mark + ticker into flat, typed contracts. Expired and
 * non-trading contracts are dropped. `oi`/`oiUsd` start null — open interest is
 * a separate, bounded fetch (attachOpenInterest).
 */
export function normalizeContracts(info, marks, tickers, now = Date.now()) {
  const markBy = new Map((Array.isArray(marks) ? marks : []).map((m) => [m.symbol, m]));
  const tickBy = new Map((Array.isArray(tickers) ? tickers : []).map((t) => [t.symbol, t]));
  const out = [];
  for (const s of info?.optionSymbols || []) {
    if (s.status && s.status !== "TRADING") continue;
    const expiryMs = num(s.expiryDate);
    if (!expiryMs || expiryMs <= now) continue;
    const parsed = parseSymbol(s.symbol);
    const m = markBy.get(s.symbol) || {};
    const t = tickBy.get(s.symbol) || {};
    out.push({
      symbol: s.symbol,
      underlying: s.underlying || (parsed ? `${parsed.base}USDT` : null),
      base: s.baseAsset || parsed?.base || null,
      yymmdd: parsed?.yymmdd || null,
      expiry: new Date(expiryMs).toISOString().slice(0, 10),
      expiryMs,
      dte: (expiryMs - now) / 86400_000,
      strike: num(s.strikePrice) ?? parsed?.strike ?? null,
      side: (s.side || parsed?.side) === "PUT" ? "PUT" : "CALL",
      markPrice: num(m.markPrice),
      markIV: positive(m.markIV),
      bidIV: positive(m.bidIV),
      askIV: positive(m.askIV),
      delta: num(m.delta), gamma: num(m.gamma), vega: num(m.vega), theta: num(m.theta),
      bid: positive(t.bidPrice), ask: positive(t.askPrice), last: positive(t.lastPrice),
      volume: num(t.volume) ?? 0,
      amountUsdt: num(t.amount) ?? 0,
      tradeCount: num(t.tradeCount) ?? 0,
      oi: null, oiUsd: null,
    });
  }
  return out;
}

// ── summary math (pure) ───────────────────────────────────────────────────────
/** Linear interpolation on {x,y} points, clamped to the end points. null when empty. */
export function interpolateAt(points, x) {
  const pts = (points || []).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)).sort((a, b) => a.x - b.x);
  if (!pts.length) return null;
  if (x <= pts[0].x) return pts[0].y;
  if (x >= pts[pts.length - 1].x) return pts[pts.length - 1].y;
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i].x) {
      const a = pts[i - 1], b = pts[i];
      const t = b.x === a.x ? 0 : (x - a.x) / (b.x - a.x);
      return a.y + (b.y - a.y) * t;
    }
  }
  return null;
}

/**
 * ATM implied vol for one expiry: markIV per strike (call and put averaged where
 * both quote), interpolated to the index price. Beyond the listed strikes the
 * nearest one is used — an index outside the strike range is a data problem,
 * not a reason to extrapolate.
 */
export function atmIvAtIndex(rows, indexPrice) {
  if (!(indexPrice > 0)) return null;
  const byStrike = new Map();
  for (const r of rows || []) {
    if (!(r.markIV > 0) || !(r.strike > 0)) continue;
    const s = byStrike.get(r.strike) || { n: 0, iv: 0 };
    s.n++; s.iv += r.markIV;
    byStrike.set(r.strike, s);
  }
  const pts = [...byStrike].map(([k, s]) => ({ x: k, y: s.iv / s.n }));
  return interpolateAt(pts, indexPrice);
}

/**
 * IV at a target delta on ONE side of the chain (0.25 for calls, -0.25 for
 * puts), interpolated between the two contracts whose deltas bracket it. No
 * clamping: if the chain does not reach that delta the answer is null, because
 * a "25-delta skew" read off a 40-delta option is not one.
 */
export function ivAtDelta(rows, targetDelta) {
  const pts = (rows || [])
    .filter((r) => r.markIV > 0 && Number.isFinite(r.delta))
    .map((r) => ({ x: r.delta, y: r.markIV }))
    .sort((a, b) => a.x - b.x);
  if (pts.length < 2 || targetDelta < pts[0].x || targetDelta > pts[pts.length - 1].x) return null;
  return interpolateAt(pts, targetDelta);
}

/** Puts over calls on a field (volume, oi, amountUsdt). null when calls carry nothing. */
export function putCallRatio(rows, field = "volume") {
  const calls = sum((rows || []).filter((r) => r.side === "CALL"), (r) => r[field]);
  const puts = sum((rows || []).filter((r) => r.side === "PUT"), (r) => r[field]);
  return calls > 0 ? puts / calls : null;
}

/**
 * Per-expiry and whole-chain summaries for ONE underlying's contracts.
 * Returns { expiries[], term[], atmIv30, skew30, pcrVolume, pcrOi, oiUsd, oi,
 *           turnover24h, volume24h, contractCount, oiExpiries, illiquid }.
 * (`contractCount`, not `contracts` — fetchOptionChain spreads this next to the
 * contract ARRAY, and the count silently replaced it once.)
 * IVs are fractions; skew is put25 − call25 in the same units.
 */
export function summarizeChain(contracts, indexPrice, { illiquidBelow = ILLIQUID_TURNOVER_USDT } = {}) {
  const byExpiry = new Map();
  for (const c of contracts || []) {
    if (!(c.dte > 0)) continue;
    const list = byExpiry.get(c.expiryMs) || [];
    list.push(c);
    byExpiry.set(c.expiryMs, list);
  }
  const expiries = [...byExpiry.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([expiryMs, rows]) => {
      const calls = rows.filter((r) => r.side === "CALL");
      const puts = rows.filter((r) => r.side === "PUT");
      const callIv25 = ivAtDelta(calls, 0.25);
      const putIv25 = ivAtDelta(puts, -0.25);
      const hasOi = rows.some((r) => r.oi != null);
      return {
        expiry: rows[0].expiry, expiryMs, dte: rows[0].dte, yymmdd: rows[0].yymmdd,
        contracts: rows.length,
        atmIv: atmIvAtIndex(rows, indexPrice),
        callIv25, putIv25,
        skew25: callIv25 != null && putIv25 != null ? putIv25 - callIv25 : null,
        pcrVolume: putCallRatio(rows, "volume"),
        pcrOi: hasOi ? putCallRatio(rows, "oi") : null,
        volume: sum(rows, (r) => r.volume),
        turnover: sum(rows, (r) => r.amountUsdt),
        oi: hasOi ? sum(rows, (r) => r.oi) : null,
        oiUsd: hasOi ? sum(rows, (r) => r.oiUsd) : null,
      };
    });

  const term = expiries.filter((e) => e.atmIv != null).map((e) => ({ expiry: e.expiry, dte: e.dte, atmIv: e.atmIv, skew25: e.skew25 }));
  const withOi = expiries.filter((e) => e.oi != null);
  const all = [...byExpiry.values()].flat();
  const turnover24h = sum(all, (r) => r.amountUsdt);
  return {
    expiries,
    term,
    atmIv30: interpolateAt(term.map((t) => ({ x: t.dte, y: t.atmIv })), 30),
    skew30: interpolateAt(term.filter((t) => t.skew25 != null).map((t) => ({ x: t.dte, y: t.skew25 })), 30),
    pcrVolume: putCallRatio(all, "volume"),
    pcrOi: withOi.length ? putCallRatio(all.filter((r) => r.oi != null), "oi") : null,
    oi: withOi.length ? sum(withOi, (e) => e.oi) : null,
    oiUsd: withOi.length ? sum(withOi, (e) => e.oiUsd) : null,
    oiExpiries: withOi.length,
    turnover24h,
    volume24h: sum(all, (r) => r.volume),
    contractCount: all.length,
    illiquid: turnover24h < illiquidBelow,
  };
}

// ── open interest (the one per-expiry call, so bounded) ──────────────────────
async function mapPool(items, concurrency, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}

/**
 * Fill `oi`/`oiUsd` on a COPY of the contracts for the nearest expiries per
 * underlying (dte ≤ maxDays, at most maxExpiries each). Returns
 * { contracts, requested, failed } — a failed expiry simply keeps null OI.
 */
export async function attachOpenInterest(contracts, { maxDays = OI_MAX_DAYS, maxExpiries = OI_MAX_EXPIRIES, concurrency = 4 } = {}) {
  const perUnderlying = new Map();
  for (const c of contracts) {
    if (!(c.dte > 0 && c.dte <= maxDays) || !c.base || !c.yymmdd) continue;
    const set = perUnderlying.get(c.base) || new Map();
    set.set(c.yymmdd, c.dte);
    perUnderlying.set(c.base, set);
  }
  const targets = [];
  for (const [base, set] of perUnderlying) {
    [...set.entries()].sort((a, b) => a[1] - b[1]).slice(0, maxExpiries).forEach(([yymmdd]) => targets.push({ base, yymmdd }));
  }
  const oiBy = new Map();
  let failed = 0;
  await mapPool(targets, concurrency, async ({ base, yymmdd }) => {
    try {
      const rows = await getJson(`openInterest?underlyingAsset=${encodeURIComponent(base)}&expiration=${yymmdd}`);
      for (const r of Array.isArray(rows) ? rows : []) oiBy.set(r.symbol, { oi: num(r.sumOpenInterest) ?? 0, oiUsd: num(r.sumOpenInterestUsd) ?? 0 });
      // An expiry the endpoint knows but lists no row for is genuinely zero, not unknown.
      for (const c of contracts) if (c.base === base && c.yymmdd === yymmdd && !oiBy.has(c.symbol)) oiBy.set(c.symbol, { oi: 0, oiUsd: 0 });
    } catch { failed++; }
  });
  return {
    contracts: contracts.map((c) => (oiBy.has(c.symbol) ? { ...c, ...oiBy.get(c.symbol) } : c)),
    requested: targets.length,
    failed,
  };
}

// ── fetchers ─────────────────────────────────────────────────────────────────
async function loadMarket() {
  const [info, marks, tickers] = await Promise.all([
    memo("exchangeInfo", INFO_TTL, () => getJson("exchangeInfo")),
    memo("mark", MARKET_TTL, () => getJson("mark")),
    memo("ticker", MARKET_TTL, () => getJson("ticker")),
  ]);
  const now = Date.now();
  return { at: now, contracts: normalizeContracts(info, marks, tickers, now) };
}

async function fetchIndex(underlying) {
  const d = await getJson(`index?underlying=${encodeURIComponent(underlying)}`);
  return num(d?.indexPrice);
}

/** Underlyings with live contracts, e.g. ["BTCUSDT","ETHUSDT",…] — most-traded first. */
export async function fetchUnderlyings() {
  const { contracts } = await loadMarket();
  const turnover = new Map();
  for (const c of contracts) turnover.set(c.underlying, (turnover.get(c.underlying) || 0) + c.amountUsdt);
  return [...turnover.entries()].sort((a, b) => b[1] - a[1]).map(([u]) => u);
}

/**
 * The normalised chain for one underlying plus its summaries and index price.
 * { underlying, base, indexPrice, at, contracts[], oiCoverage, expiries[], term[],
 *   atmIv30, skew30, pcrVolume, pcrOi, oi, oiUsd, turnover24h, contractCount, illiquid }
 */
export async function fetchOptionChain(underlying, opts = {}) {
  const u = String(underlying || "").toUpperCase();
  const { contracts: all, at } = await loadMarket();
  const mine = all.filter((c) => c.underlying === u);
  if (!mine.length) throw new Error(`No Binance options for "${u}" (try BTCUSDT or ETHUSDT).`);
  const [indexPrice, oi] = await Promise.all([fetchIndex(u), attachOpenInterest(mine, opts)]);
  const summary = summarizeChain(oi.contracts, indexPrice, opts);
  return {
    underlying: u, base: mine[0].base, indexPrice, at,
    contracts: oi.contracts,
    oiCoverage: { maxDays: opts.maxDays ?? OI_MAX_DAYS, requested: oi.requested, failed: oi.failed },
    ...summary,
  };
}

/**
 * One row per underlying (summaries only, no contract lists) — the overview
 * table. Shares the three whole-market calls, so it costs one index call per
 * underlying plus the bounded OI calls.
 */
export async function fetchOptionsOverview(opts = {}) {
  const { contracts: all, at } = await loadMarket();
  const underlyings = [...new Set(all.map((c) => c.underlying).filter(Boolean))];
  const [oi, indexes] = await Promise.all([
    attachOpenInterest(all, opts),
    Promise.all(underlyings.map((u) => fetchIndex(u).catch(() => null))),
  ]);
  const rows = underlyings.map((u, i) => {
    const mine = oi.contracts.filter((c) => c.underlying === u);
    return { underlying: u, base: mine[0]?.base || u, indexPrice: indexes[i], ...summarizeChain(mine, indexes[i], opts) };
  });
  rows.sort((a, b) => b.turnover24h - a.turnover24h);
  return { at, rows, oiCoverage: { maxDays: opts.maxDays ?? OI_MAX_DAYS, requested: oi.requested, failed: oi.failed } };
}

// ── the browser's view: the relayed snapshot ─────────────────────────────────
/**
 * The latest overview snapshot from /api/binance-options (pushed by the PC-side
 * relay; computed live by the vite dev middleware). Resolves to
 * { ok, at, ageMin, overview:[{ underlying, base, index, atmIv30, skew25, pcVol,
 *   pcOi, oi, oiUsd, oiExpiries, turnover, expiries, contracts, illiquid,
 *   term:[{expiry,dte,atmIv}], skewByExpiry:[{expiry,dte,skew25}] }], meta }.
 * Throws with `code` = the API's error ("not_synced" when nothing was pushed yet).
 */
export async function fetchOptionsSnapshot({ base = "" } = {}) {
  const res = await fetch(`${base}/api/binance-options`);
  const data = await res.json().catch(() => null);
  if (!data) throw Object.assign(new Error("Options snapshot service unreachable."), { code: "unreachable" });
  if (!data.ok) {
    const msg = data.error === "not_synced" ? "No Binance options snapshot yet — the relay hasn't pushed one."
      : data.error === "rate_limited" ? "Too many requests — wait a minute."
      : data.detail || data.error || "Request failed.";
    throw Object.assign(new Error(msg), { code: data.error || "error" });
  }
  return data;
}

// ── BVOL history (served by /api/bvol from the nightly-synced archive) ───────
export const BVOL_SYMBOLS = ["BTCBVOLUSDT", "ETHBVOLUSDT"];

/** { symbol, at, from, to, days, daily:[{time,open,high,low,close}], hourly:[{time,value}], stale } */
export async function fetchBvolHistory(symbol, { base = "" } = {}) {
  const res = await fetch(`${base}/api/bvol?symbol=${encodeURIComponent(symbol)}`);
  const data = await res.json().catch(() => null);
  if (!data) throw new Error("BVOL service unreachable.");
  if (!data.ok) {
    if (data.error === "not_synced") throw new Error("The BVOL history hasn't been synced yet — run scripts/bvol-backfill.mjs --push once.");
    if (data.error === "rate_limited") throw new Error("Too many requests — wait a minute.");
    throw new Error(data.detail || data.error || "Request failed.");
  }
  return data;
}
