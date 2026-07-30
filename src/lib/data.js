// Market data layer. All functions return candles in the shared format:
// { time: unix seconds, open, high, low, close, volume }, ascending by time.
//
// Crypto comes straight from Binance (their public API allows browser CORS).
// Stocks go through /api/yahoo/* — a Cloudflare Pages Function in production
// and a vite dev-server proxy locally (see vite.config.js) — because Yahoo
// blocks cross-origin browser requests.

const BINANCE = "https://api.binance.com/api/v3";
const BINANCE_FAPI = "https://fapi.binance.com/fapi/v1";

/**
 * Perpetual funding-rate history for a Binance USDⓈ-M perp, over [fromSec, toSec].
 * Returns [{ time (unix sec), rate (fraction, e.g. 0.0001 = 0.01%) }] ascending.
 * Public endpoint, browser-callable (Binance sends permissive CORS). Funding
 * stamps ~every 8h; ignoring them makes crypto backtests overstate longs.
 */
export async function fetchFunding(symbol, fromSec, toSec) {
  const sym = symbol.toUpperCase();
  const endMs = Math.floor(toSec * 1000);
  let out = [];
  let start = Math.floor(fromSec * 1000);
  for (let guard = 0; guard < 60; guard++) {
    const url = `${BINANCE_FAPI}/fundingRate?symbol=${encodeURIComponent(sym)}&startTime=${start}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) {
      if (res.status === 400) throw new Error(`No perp funding for "${sym}" on Binance Futures (e.g. BTCUSDT).`);
      throw new Error(`Binance funding error ${res.status}`);
    }
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows) out.push({ time: Math.floor(r.fundingTime / 1000), rate: +r.fundingRate });
    const last = rows[rows.length - 1].fundingTime;
    if (rows.length < 1000 || last >= endMs) break;
    start = last + 1;
  }
  return out.filter((f) => f.time <= toSec);
}
const YAHOO = "/api/yahoo/v8/finance/chart";

export const MARKETS = [
  { id: "crypto", label: "Crypto" },
  { id: "stock", label: "Stocks / ETFs" },
];

// Interval ids are unified across markets; each entry knows its per-source
// mapping plus a sensible default range for stocks (Yahoo wants range+interval).
// `yahoo: null` = crypto-only interval (Yahoo has no free intraday sub-1h and
// intraday history is heavily capped, so we keep those to Binance).
export const INTERVALS = [
  { id: "1s", label: "1s", binance: "1s", yahoo: null, markets: ["crypto"] },
  { id: "1m", label: "1m", binance: "1m", yahoo: "1m", markets: ["crypto", "stock"] },
  { id: "5m", label: "5m", binance: "5m", yahoo: "5m", markets: ["crypto", "stock"] },
  { id: "15m", label: "15m", binance: "15m", yahoo: "15m", markets: ["crypto", "stock"] },
  { id: "30m", label: "30m", binance: "30m", yahoo: "30m", markets: ["crypto", "stock"] },
  { id: "1h", label: "1h", binance: "1h", yahoo: "60m", markets: ["crypto", "stock"] },
  { id: "2h", label: "2h", binance: "2h", yahoo: null, markets: ["crypto"] },
  { id: "4h", label: "4h", binance: "4h", yahoo: null, markets: ["crypto"] },
  { id: "1d", label: "1D", binance: "1d", yahoo: "1d", markets: ["crypto", "stock"] },
  { id: "1w", label: "1W", binance: "1w", yahoo: "1wk", markets: ["crypto", "stock"] },
  { id: "1M", label: "1M", binance: "1M", yahoo: "1mo", markets: ["crypto", "stock"] },
];

// Which intervals are "intraday" (sub-daily). Yahoo caps intraday history
// hard, so we clamp the allowed ranges per interval below.
const INTRADAY = new Set(["1s", "1m", "5m", "15m", "30m", "1h", "2h", "4h"]);

export const RANGES = [
  { id: "1h", label: "1H", yahoo: null, days: 1 / 24 },
  { id: "5d", label: "5D", yahoo: "5d", days: 5 },
  { id: "1mo", label: "1M", yahoo: "1mo", days: 30 },
  { id: "3mo", label: "3M", yahoo: "3mo", days: 90 },
  { id: "6mo", label: "6M", yahoo: "6mo", days: 180 },
  { id: "1y", label: "1Y", yahoo: "1y", days: 365 },
  { id: "5y", label: "5Y", yahoo: "5y", days: 1825 },
  { id: "max", label: "Max", yahoo: "max", days: 36500 },
];

// Ranges that make sense for a given interval (avoids e.g. 1-minute over Max,
// which no free source serves and would freeze the browser). Returns the
// RANGES subset valid for `intervalId`. Pass `market` where known: Yahoo caps
// 1-minute stock data at 8 DAYS per request, so offering "1M" there just
// produces an Unprocessable Entity error — Binance has no such cap.
export function rangesFor(intervalId, market) {
  // 1-second candles: Binance returns ~16 min per 1000-kline call; keep the
  // window short (older history still lazy-loads on left-pan).
  if (intervalId === "1s") return RANGES.filter((r) => ["1h", "5d"].includes(r.id));
  if (intervalId === "1m") {
    const ids = market === "stock" ? ["5d"] : ["5d", "1mo"];
    return RANGES.filter((r) => ids.includes(r.id));
  }
  if (["5m", "15m", "30m"].includes(intervalId)) return RANGES.filter((r) => ["5d", "1mo", "3mo"].includes(r.id));
  if (INTRADAY.has(intervalId)) return RANGES.filter((r) => ["1mo", "3mo", "6mo", "1y"].includes(r.id));
  if (intervalId === "1M") return RANGES.filter((r) => ["5y", "max"].includes(r.id));
  return RANGES.filter((r) => !["1h", "5d"].includes(r.id)); // daily/weekly: 1mo..max
}

export const WATCHLIST = [
  { market: "crypto", symbol: "BTCUSDT", name: "Bitcoin" },
  { market: "crypto", symbol: "ETHUSDT", name: "Ethereum" },
  { market: "crypto", symbol: "SOLUSDT", name: "Solana" },
  { market: "stock", symbol: "SPY", name: "S&P 500 ETF" },
  { market: "stock", symbol: "QQQ", name: "Nasdaq 100 ETF" },
  { market: "stock", symbol: "AAPL", name: "Apple" },
  { market: "stock", symbol: "NVDA", name: "NVIDIA" },
  { market: "stock", symbol: "TSLA", name: "Tesla" },
];

function intervalDef(id) {
  const def = INTERVALS.find((i) => i.id === id);
  if (!def) throw new Error(`Unknown interval: ${id}`);
  return def;
}

// Seconds per Binance interval string — drives how many klines a range needs.
// Seconds per interval id (used for pagination math and data-sanity checks).
export const INTERVAL_SECONDS = {
  "1s": 1, "1m": 60, "5m": 300, "15m": 900, "30m": 1800,
  "1h": 3600, "2h": 7200, "4h": 14400, "1d": 86400, "1w": 604800, "1M": 2592000,
};
const BINANCE_INTERVAL_SEC = INTERVAL_SECONDS;

// Hard cap on candles per dataset — keeps charts and backtests responsive
// while still giving e.g. 2.7 years of 4h or 16 years of daily data.
const MAX_CRYPTO_BARS = 6000;

async function fetchBinance(symbol, interval, rangeDays, window) {
  // Binance caps at 1000 klines per call; paginate backwards with endTime
  // until the range (or the MAX_CRYPTO_BARS cap) is covered. `window`
  // ({from,to} unix sec) overrides the relative range for period backtests.
  const sec = BINANCE_INTERVAL_SEC[interval] || 86400;
  const spanSec = window ? window.to - window.from : rangeDays * 86400;
  const need = Math.min(MAX_CRYPTO_BARS, Math.ceil(spanSec / sec));
  const cutoff = window ? window.from : Date.now() / 1000 - rangeDays * 86400;

  let out = [];
  let end = window ? window.to * 1000 : Date.now();
  while (out.length < need) {
    const url = `${BINANCE}/klines?symbol=${encodeURIComponent(symbol.toUpperCase())}&interval=${interval}&endTime=${end}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) {
      if (res.status === 400) throw new Error(`Symbol "${symbol}" not found on Binance (e.g. BTCUSDT).`);
      throw new Error(`Binance error ${res.status}`);
    }
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) break;
    out = [
      ...rows.map((r) => ({
        time: Math.floor(r[0] / 1000),
        open: +r[1],
        high: +r[2],
        low: +r[3],
        close: +r[4],
        volume: +r[5],
      })),
      ...out,
    ];
    end = rows[0][0] - 1;
    if (rows.length < 1000) break; // history exhausted
    if (out[0].time <= cutoff) break; // range covered
  }
  return out.filter((c) => c.time >= cutoff).slice(-MAX_CRYPTO_BARS);
}

async function fetchYahoo(symbol, yahooInterval, yahooRange, window) {
  // window {from,to} (unix sec) → Yahoo's period1/period2; else relative range.
  const span = window
    ? `period1=${window.from}&period2=${window.to}`
    : `range=${yahooRange}`;
  const url = `${YAHOO}/${encodeURIComponent(symbol.toUpperCase())}?${span}&interval=${yahooInterval}&events=div%2Csplit`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Data request failed (${res.status}) — is the symbol correct? (e.g. AAPL, SPY, ^GSPC)`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(json?.chart?.error?.description || `No data for "${symbol}".`);
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const candles = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (o == null || h == null || l == null || c == null) continue; // holidays/gaps
    candles.push({ time: ts[i], open: o, high: h, low: l, close: c, volume: q.volume?.[i] ?? 0 });
  }
  return candles;
}

// Yahoo SUB-HOUR data (1m..30m) is short AND capped per request, so a plain
// range=3mo on 5m 422s. Availability + per-request window in days — we clamp to
// what exists and fetch in chunks via period1/period2, then stitch. NOTE: 1h
// (60m) is NOT here — Yahoo REJECTS period1/period2 for 60m (422); it must use
// range (works to ~2y). Crypto has full intraday via Binance; this is a
// stock-data ceiling, not a bug.
const YAHOO_SUBHOUR = {
  "1m": { maxDays: 7, chunk: 7 },
  "5m": { maxDays: 58, chunk: 58 },
  "15m": { maxDays: 58, chunk: 58 },
  "30m": { maxDays: 58, chunk: 58 },
};

// Fetch stock sub-hour over [fromSec, toSec], clamped to what Yahoo has and split
// into per-request chunks (period1/period2), then deduped + sorted ascending.
async function fetchYahooIntraday(symbol, yInterval, fromSec, toSec) {
  const cap = YAHOO_SUBHOUR[yInterval];
  const now = Math.floor(Date.now() / 1000);
  const to = Math.min(toSec, now);
  let from = Math.max(fromSec, now - cap.maxDays * 86400); // clamp to available history
  if (to - from < 3600) from = to - cap.chunk * 86400;
  const chunkSec = cap.chunk * 86400;
  const seen = new Map();
  for (let a = from; a < to; a += chunkSec) {
    const b = Math.min(to, a + chunkSec);
    try { for (const c of await fetchYahoo(symbol, yInterval, null, { from: a, to: b })) seen.set(c.time, c); }
    catch { /* a bad chunk shouldn't lose the rest */ }
  }
  return [...seen.values()].sort((x, y) => x.time - y.time);
}

/**
 * Fetch candles. Either a relative `range` (default) or an explicit period
 * `{ from, to }` (unix SECONDS) — the period wins when both are given.
 */
export async function fetchCandles({ market, symbol, interval = "1d", range = "1y", from, to }) {
  const iDef = intervalDef(interval);
  const rDef = RANGES.find((r) => r.id === range) || RANGES[1];
  if (!iDef.markets.includes(market)) {
    throw new Error(`Interval ${iDef.label} is not available for this market.`);
  }
  const window = Number.isFinite(from) && Number.isFinite(to) && to > from ? { from, to } : null;
  const now = Math.floor(Date.now() / 1000);
  const isMaxDaily = !window && range === "max" && (iDef.yahoo === "1d" || iDef.yahoo === "1wk");
  let candles;
  if (market === "crypto") {
    candles = await fetchBinance(symbol, iDef.binance, rDef.days, window);
  } else if (YAHOO_SUBHOUR[iDef.yahoo]) {
    // Sub-hour → chunked + clamped period requests (a plain range 422s past the cap).
    candles = await fetchYahooIntraday(symbol, iDef.yahoo, window ? window.from : now - rDef.days * 86400, window ? window.to : now);
  } else if (iDef.yahoo === "60m" && window) {
    // 1h can't take period1/period2 (422) — a custom window falls back to range=2y
    // (its max), which is the widest 1h history Yahoo serves anyway.
    candles = await fetchYahoo(symbol, "60m", "2y", null);
  } else if (isMaxDaily) {
    // range=max COARSENS daily/weekly to monthly bars — use period1=0 for the FULL
    // daily/weekly history at the requested granularity instead.
    candles = await fetchYahoo(symbol, iDef.yahoo, null, { from: 0, to: now });
  } else {
    candles = await fetchYahoo(symbol, iDef.yahoo, rDef.yahoo, window);
  }
  if (candles.length < 2) throw new Error(`Too few data points for "${symbol}".`);
  return candles;
}

// Live tail: fetch just the few most-recent candles for cheap polling. Used to
// keep an open chart current without re-downloading the whole history. Returns
// a small ascending array (newest last), or [] on any error (caller keeps its
// current data). Crypto polls Binance directly; stocks go through the Yahoo
// proxy with the shortest range that still yields the latest bar.
export async function fetchLatestCandles({ market, symbol, interval = "1d" }) {
  const iDef = intervalDef(interval);
  if (!iDef.markets.includes(market)) return [];
  try {
    if (market === "crypto") {
      const url = `${BINANCE}/klines?symbol=${encodeURIComponent(symbol.toUpperCase())}&interval=${iDef.binance}&limit=3`;
      const res = await fetch(url);
      if (!res.ok) return [];
      const rows = await res.json();
      return rows.map((r) => ({
        time: Math.floor(r[0] / 1000),
        open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5],
      }));
    }
    // Stocks: shortest range that reliably contains the last bar per interval.
    const INTRA = new Set(["1m", "5m", "15m", "30m", "1h"]);
    const yRange = INTRA.has(interval) ? "1d" : interval === "1M" ? "3mo" : "5d";
    const all = await fetchYahoo(symbol, iDef.yahoo, yRange);
    return all.slice(-3);
  } catch {
    return [];
  }
}

// Older history for infinite-scroll charts: fetch candles strictly BEFORE
// `before` (unix seconds). Returns [] when the source has nothing earlier.
export async function fetchOlderCandles({ market, symbol, interval = "1d", before }) {
  const iDef = intervalDef(interval);

  if (market === "crypto") {
    const url = `${BINANCE}/klines?symbol=${encodeURIComponent(symbol.toUpperCase())}&interval=${iDef.binance}&endTime=${before * 1000 - 1}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const rows = await res.json();
    return rows.map((r) => ({
      time: Math.floor(r[0] / 1000),
      open: +r[1],
      high: +r[2],
      low: +r[3],
      close: +r[4],
      volume: +r[5],
    }));
  }

  // Yahoo: explicit period window ending at `before`. Chunk size depends on
  // the interval — daily gets 10-year slabs, weekly 25-year slabs.
  const chunkDays = iDef.yahoo === "1wk" ? 9125 : 3650;
  const period1 = Math.max(0, before - chunkDays * 86400);
  const url = `${YAHOO}/${encodeURIComponent(symbol.toUpperCase())}?period1=${period1}&period2=${before}&interval=${iDef.yahoo}&events=div%2Csplit`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  const ts = result?.timestamp || [];
  const q = result?.indicators?.quote?.[0] || {};
  const candles = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    if (ts[i] >= before) continue;
    candles.push({ time: ts[i], open: o, high: h, low: l, close: c, volume: q.volume?.[i] ?? 0 });
  }
  return candles;
}
