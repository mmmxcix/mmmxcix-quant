// Market screener. Scans a universe of symbols and computes per-symbol metrics
// (day change, volume, RSI, SMA-position) for filtering/sorting in the UI.
//
// Crypto: Binance 24h ticker gives change% + volume for ALL pairs in one call;
// we take the top N by volume, then fetch daily klines for each to compute RSI
// and SMA. Stocks: a curated liquid universe fetched daily via the Yahoo proxy.
// Results are cached for 5 minutes to keep it cheap.

import { sma, rsi } from "./indicators";

const BINANCE = "https://api.binance.com/api/v3";
const YAHOO = "/api/yahoo/v8/finance/chart";
const CACHE_TTL = 5 * 60 * 1000;
const cache = new Map(); // key → { t, data }

// Curated liquid stock/ETF universe for the stock screener (name shown in UI).
const STOCK_UNIVERSE = [
  ["AAPL", "Apple"], ["MSFT", "Microsoft"], ["NVDA", "NVIDIA"], ["GOOGL", "Alphabet"],
  ["AMZN", "Amazon"], ["META", "Meta"], ["TSLA", "Tesla"], ["AVGO", "Broadcom"],
  ["JPM", "JPMorgan"], ["V", "Visa"], ["MA", "Mastercard"], ["LLY", "Eli Lilly"],
  ["UNH", "UnitedHealth"], ["XOM", "Exxon Mobil"], ["JNJ", "Johnson & Johnson"],
  ["WMT", "Walmart"], ["PG", "Procter & Gamble"], ["HD", "Home Depot"], ["KO", "Coca-Cola"],
  ["PEP", "PepsiCo"], ["COST", "Costco"], ["MCD", "McDonald's"], ["NFLX", "Netflix"],
  ["AMD", "AMD"], ["INTC", "Intel"], ["CSCO", "Cisco"], ["ORCL", "Oracle"], ["CRM", "Salesforce"],
  ["ADBE", "Adobe"], ["PYPL", "PayPal"], ["DIS", "Disney"], ["BA", "Boeing"], ["NKE", "Nike"],
  ["PLTR", "Palantir"], ["UBER", "Uber"], ["BAC", "Bank of America"], ["PFE", "Pfizer"],
  ["T", "AT&T"], ["VZ", "Verizon"], ["CVX", "Chevron"],
  ["SPY", "S&P 500 ETF"], ["QQQ", "Nasdaq 100 ETF"], ["DIA", "Dow Jones ETF"],
  ["IWM", "Russell 2000 ETF"], ["GLD", "Gold ETF"], ["ARKK", "ARK Innovation"],
];

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Compute metrics from a close-price array.
function metricsFromCloses(cl) {
  const last = cl.length - 1;
  if (last < 0) return { rsi: null, sma50: null, sma200: null };
  const r = rsi(cl, 14);
  const s50 = sma(cl, 50);
  const s200 = sma(cl, 200);
  return { rsi: r[last], sma50: s50[last], sma200: s200[last] };
}

export async function scanCrypto({ limit = 30 } = {}) {
  const key = `crypto:${limit}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_TTL) return hit.data;

  const res = await fetch(`${BINANCE}/ticker/24hr`);
  if (!res.ok) throw new Error("Binance ticker unavailable.");
  const all = await res.json();

  const top = all
    .filter((t) => t.symbol.endsWith("USDT") && !/(UP|DOWN|BULL|BEAR)USDT$/.test(t.symbol))
    .map((t) => ({
      market: "crypto",
      symbol: t.symbol,
      name: t.symbol.slice(0, -4),
      price: +t.lastPrice,
      changePct: +t.priceChangePercent,
      volume: +t.quoteVolume, // quote (USDT) volume — comparable across coins
    }))
    .sort((a, b) => b.volume - a.volume)
    .slice(0, limit);

  const enriched = await mapLimit(top, 8, async (t) => {
    try {
      const k = await fetch(`${BINANCE}/klines?symbol=${t.symbol}&interval=1d&limit=250`);
      if (!k.ok) return { ...t, rsi: null, sma50: null, sma200: null };
      const rows = await k.json();
      return { ...t, ...metricsFromCloses(rows.map((r) => +r[4])) };
    } catch {
      return { ...t, rsi: null, sma50: null, sma200: null };
    }
  });

  cache.set(key, { t: Date.now(), data: enriched });
  return enriched;
}

export async function scanStocks() {
  const key = "stocks";
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_TTL) return hit.data;

  const rows = await mapLimit(STOCK_UNIVERSE, 6, async ([symbol, name]) => {
    try {
      const res = await fetch(`${YAHOO}/${symbol}?range=1y&interval=1d`);
      if (!res.ok) return null;
      const json = await res.json();
      const result = json?.chart?.result?.[0];
      const q = result?.indicators?.quote?.[0];
      if (!result || !q) return null;
      const closesArr = (q.close || []).filter((v) => v != null);
      const vols = (q.volume || []).filter((v) => v != null);
      if (closesArr.length < 2) return null;
      const price = result.meta?.regularMarketPrice ?? closesArr[closesArr.length - 1];
      const prev = closesArr[closesArr.length - 2];
      return {
        market: "stock",
        symbol,
        name,
        price,
        changePct: ((price - prev) / prev) * 100,
        volume: vols[vols.length - 1] ?? 0,
        ...metricsFromCloses(closesArr),
      };
    } catch {
      return null;
    }
  });

  const data = rows.filter(Boolean);
  cache.set(key, { t: Date.now(), data });
  return data;
}

// Apply the UI filter set to a scanned row list. `f` = {
//   minChange, maxChange (numbers|null, percent),
//   rsi: "any"|"oversold"|"overbought",
//   trend: "any"|"above50"|"below50"|"above200"|"below200",
//   minVolume (number|null)
// }
export function applyFilters(rows, f) {
  return rows.filter((r) => {
    if (f.minChange != null && r.changePct < f.minChange) return false;
    if (f.maxChange != null && r.changePct > f.maxChange) return false;
    if (f.minVolume != null && r.volume < f.minVolume) return false;
    if (f.rsi === "oversold" && !(r.rsi != null && r.rsi < 30)) return false;
    if (f.rsi === "overbought" && !(r.rsi != null && r.rsi > 70)) return false;
    if (f.trend === "above50" && !(r.sma50 != null && r.price > r.sma50)) return false;
    if (f.trend === "below50" && !(r.sma50 != null && r.price < r.sma50)) return false;
    if (f.trend === "above200" && !(r.sma200 != null && r.price > r.sma200)) return false;
    if (f.trend === "below200" && !(r.sma200 != null && r.price < r.sma200)) return false;
    return true;
  });
}
