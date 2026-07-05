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
  { id: "crypto", label: "Krypto" },
  { id: "stock", label: "Aktien / ETFs" },
];

// Interval ids are unified across markets; each entry knows its per-source
// mapping plus a sensible default range for stocks (Yahoo wants range+interval).
export const INTERVALS = [
  { id: "15m", label: "15m", binance: "15m", yahoo: null, markets: ["crypto"] },
  { id: "1h", label: "1h", binance: "1h", yahoo: null, markets: ["crypto"] },
  { id: "4h", label: "4h", binance: "4h", yahoo: null, markets: ["crypto"] },
  { id: "1d", label: "1D", binance: "1d", yahoo: "1d", markets: ["crypto", "stock"] },
  { id: "1w", label: "1W", binance: "1w", yahoo: "1wk", markets: ["crypto", "stock"] },
];

export const RANGES = [
  { id: "3mo", label: "3M", yahoo: "3mo", days: 90 },
  { id: "1y", label: "1J", yahoo: "1y", days: 365 },
  { id: "5y", label: "5J", yahoo: "5y", days: 1825 },
  { id: "max", label: "Max", yahoo: "max", days: 36500 },
];

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
  if (!def) throw new Error(`Unbekanntes Intervall: ${id}`);
  return def;
}

async function fetchBinance(symbol, interval, rangeDays) {
  // Binance caps at 1000 klines per call — enough for 1000 days daily or
  // ~40 days hourly, fine for v1. Filter by range client-side.
  const url = `${BINANCE}/klines?symbol=${encodeURIComponent(symbol.toUpperCase())}&interval=${interval}&limit=1000`;
  const res = await fetch(url);
  if (!res.ok) {
    if (res.status === 400) throw new Error(`Symbol "${symbol}" bei Binance nicht gefunden (z. B. BTCUSDT).`);
    throw new Error(`Binance-Fehler ${res.status}`);
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
  if (!res.ok) throw new Error(`Datenabruf fehlgeschlagen (${res.status}) — Symbol korrekt? (z. B. AAPL, SPY, ^GSPC)`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(json?.chart?.error?.description || `Keine Daten für "${symbol}".`);
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
    throw new Error(`Intervall ${iDef.label} ist für diesen Markt nicht verfügbar.`);
  }
  const candles =
    market === "crypto"
      ? await fetchBinance(symbol, iDef.binance, rDef.days)
      : await fetchYahoo(symbol, iDef.yahoo, rDef.yahoo);
  if (candles.length < 2) throw new Error(`Zu wenige Datenpunkte für "${symbol}".`);
  return candles;
}
