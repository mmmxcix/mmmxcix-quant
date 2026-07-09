// Market data layer. All functions return candles in the shared format:
// { time: unix seconds, open, high, low, close, volume }, ascending by time.
//
// Crypto comes straight from Binance (their public API allows browser CORS).
// Stocks go through /api/yahoo/* — a Cloudflare Pages Function in production
// and a vite dev-server proxy locally (see vite.config.js) — because Yahoo
// blocks cross-origin browser requests.

const BINANCE = "https://api.binance.com/api/v3";
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
// RANGES subset valid for `intervalId`.
export function rangesFor(intervalId) {
  // 1-second candles: Binance returns ~16 min per 1000-kline call; keep the
  // window short (older history still lazy-loads on left-pan).
  if (intervalId === "1s") return RANGES.filter((r) => ["1h", "5d"].includes(r.id));
  if (intervalId === "1m") return RANGES.filter((r) => ["5d", "1mo"].includes(r.id));
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

async function fetchBinance(symbol, interval, rangeDays) {
  // Binance caps at 1000 klines per call — enough for 1000 days daily or
  // ~40 days hourly, fine for v1. Filter by range client-side.
  const url = `${BINANCE}/klines?symbol=${encodeURIComponent(symbol.toUpperCase())}&interval=${interval}&limit=1000`;
  const res = await fetch(url);
  if (!res.ok) {
    if (res.status === 400) throw new Error(`Symbol "${symbol}" not found on Binance (e.g. BTCUSDT).`);
    throw new Error(`Binance error ${res.status}`);
  }
  const rows = await res.json();
  const cutoff = Date.now() / 1000 - rangeDays * 86400;
  return rows
    .map((r) => ({
      time: Math.floor(r[0] / 1000),
      open: +r[1],
      high: +r[2],
      low: +r[3],
      close: +r[4],
      volume: +r[5],
    }))
    .filter((c) => c.time >= cutoff);
}

async function fetchYahoo(symbol, yahooInterval, yahooRange) {
  const url = `${YAHOO}/${encodeURIComponent(symbol.toUpperCase())}?range=${yahooRange}&interval=${yahooInterval}&events=div%2Csplit`;
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

export async function fetchCandles({ market, symbol, interval = "1d", range = "1y" }) {
  const iDef = intervalDef(interval);
  const rDef = RANGES.find((r) => r.id === range) || RANGES[1];
  if (!iDef.markets.includes(market)) {
    throw new Error(`Interval ${iDef.label} is not available for this market.`);
  }
  const candles =
    market === "crypto"
      ? await fetchBinance(symbol, iDef.binance, rDef.days)
      : await fetchYahoo(symbol, iDef.yahoo, rDef.yahoo);
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
