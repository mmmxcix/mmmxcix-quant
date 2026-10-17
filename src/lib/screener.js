// Market screener. Scans a universe of symbols and computes per-symbol metrics
// (day change, volume, RSI, SMA-position) for filtering/sorting in the UI.
//
// Crypto: Binance 24h ticker gives change% + volume for ALL pairs in one call;
// we take the top N by volume, then fetch daily klines for each to compute RSI
// and SMA. Stocks: a curated liquid universe fetched daily via the Yahoo proxy.
// Results are cached for 5 minutes to keep it cheap.

import { sma, rsi } from "./indicators.js";

const BINANCE = "https://api.binance.com/api/v3";
import { fetchRetry, mapLimit } from "./netRetry.js";

const YAHOO = "/api/yahoo/v8/finance/chart";
const CACHE_TTL = 5 * 60 * 1000;
const PARTIAL_TTL = 60 * 1000; // a scan with holes is cached only this long
const cache = new Map(); // key → { t, data }

// Curated liquid stock/ETF universe for the stock screener.
// [symbol, name, sector, employees] — sector + headcount are STATIC metadata
// (approximate, headcounts drift slowly) so the screener can filter/sort by
// company type without another rate-limited API. null employees = ETF.
export const STOCK_UNIVERSE = [
  ["AAPL", "Apple", "Tech", 164000], ["MSFT", "Microsoft", "Software", 228000],
  ["NVDA", "NVIDIA", "Semiconductors", 36000], ["GOOGL", "Alphabet", "Tech", 183000],
  ["AMZN", "Amazon", "Tech", 1550000], ["META", "Meta", "Tech", 74000],
  ["TSLA", "Tesla", "Automotive", 125000], ["AVGO", "Broadcom", "Semiconductors", 37000],
  ["JPM", "JPMorgan", "Banks", 317000], ["V", "Visa", "Payments", 31000],
  ["MA", "Mastercard", "Payments", 35000], ["LLY", "Eli Lilly", "Pharma", 47000],
  ["UNH", "UnitedHealth", "Healthcare", 440000], ["XOM", "Exxon Mobil", "Energy", 61000],
  ["JNJ", "Johnson & Johnson", "Pharma", 138000],
  ["WMT", "Walmart", "Retail", 2100000], ["PG", "Procter & Gamble", "Consumer", 108000],
  ["HD", "Home Depot", "Retail", 470000], ["KO", "Coca-Cola", "Consumer", 79000],
  ["PEP", "PepsiCo", "Consumer", 318000], ["COST", "Costco", "Retail", 333000],
  ["MCD", "McDonald's", "Consumer", 150000], ["NFLX", "Netflix", "Media", 14000],
  ["AMD", "AMD", "Semiconductors", 28000], ["INTC", "Intel", "Semiconductors", 109000],
  ["CSCO", "Cisco", "Tech", 90000], ["ORCL", "Oracle", "Software", 164000],
  ["CRM", "Salesforce", "Software", 76000],
  ["ADBE", "Adobe", "Software", 30000], ["PYPL", "PayPal", "Payments", 24000],
  ["DIS", "Disney", "Media", 225000], ["BA", "Boeing", "Aerospace", 171000],
  ["NKE", "Nike", "Consumer", 80000],
  ["PLTR", "Palantir", "Software", 4000], ["UBER", "Uber", "Tech", 31000],
  ["BAC", "Bank of America", "Banks", 213000], ["PFE", "Pfizer", "Pharma", 88000],
  ["T", "AT&T", "Telecom", 150000], ["VZ", "Verizon", "Telecom", 105000],
  ["CVX", "Chevron", "Energy", 46000],
  // Biotech — so the company-type filter has a real biotech bucket.
  ["AMGN", "Amgen", "Biotech", 27000], ["GILD", "Gilead", "Biotech", 18000],
  ["MRNA", "Moderna", "Biotech", 5600], ["REGN", "Regeneron", "Biotech", 13400],
  ["VRTX", "Vertex", "Biotech", 5400],
  ["SPY", "S&P 500 ETF", "ETF", null], ["QQQ", "Nasdaq 100 ETF", "ETF", null],
  ["DIA", "Dow Jones ETF", "ETF", null],
  ["IWM", "Russell 2000 ETF", "ETF", null], ["GLD", "Gold ETF", "ETF", null],
  ["ARKK", "ARK Innovation", "ETF", null],
];



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

  // A coin whose klines we could not fetch has price/volume from the ticker
  // but NO RSI/SMA. Those rows used to carry nulls that silently failed every
  // RSI/trend filter — "not oversold" when the truth was "not checked". Now
  // the fetch is retried, a row it still fails on is flagged
  // `metricsUnavailable`, and the scan names it in `unreachable`.
  const unreachable = [];
  const enriched = await mapLimit(top, 8, async (t) => {
    try {
      const k = await fetchRetry(`${BINANCE}/klines?symbol=${t.symbol}&interval=1d&limit=250`);
      const rows = await k.json();
      return { ...t, ...metricsFromCloses(rows.map((r) => +r[4])) };
    } catch {
      unreachable.push(t.symbol);
      return { ...t, rsi: null, sma50: null, sma200: null, metricsUnavailable: true };
    }
  });

  enriched.unreachable = unreachable;
  enriched.universeSize = top.length;
  enriched.partialMetrics = true; // unreachable rows stay listed, only their indicators are missing
  // A partial scan is kept briefly, so a rescan a minute later can fill it in.
  cache.set(key, { t: unreachable.length ? Date.now() - CACHE_TTL + PARTIAL_TTL : Date.now(), data: enriched });
  return enriched;
}

export async function scanStocks() {
  const key = "stocks";
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_TTL) return hit.data;

  // A symbol we could not REACH is a hole in the scan, not a symbol with no
  // data — and the screener used to lose both the same way, quietly showing a
  // partial universe as if it were the whole list. Transient statuses are
  // retried with backoff (lib/netRetry.js); what is still missing is named.
  const unreachable = [];
  const rows = await mapLimit(STOCK_UNIVERSE, 6, async ([symbol, name, sector, employees]) => {
    try {
      const res = await fetchRetry(`${YAHOO}/${symbol}?range=1y&interval=1d`);
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
        sector: sector || null,
        employees: employees ?? null,
        price,
        changePct: ((price - prev) / prev) * 100,
        volume: vols[vols.length - 1] ?? 0,
        ...metricsFromCloses(closesArr),
      };
    } catch (e) {
      if (e?.status || e?.transient) unreachable.push(symbol);
      return null;
    }
  });

  const data = rows.filter(Boolean);
  // Carried on the array so the page can say the list is incomplete without
  // changing the shape every caller already destructures.
  data.unreachable = unreachable;
  data.universeSize = STOCK_UNIVERSE.length;
  cache.set(key, { t: Date.now(), data });
  return data;
}

// Apply the UI filter set to a scanned row list. `f` = {
//   minChange, maxChange (numbers|null, percent),
//   rsi: "any"|"oversold"|"overbought",
//   trend: "any"|"above50"|"below50"|"above200"|"below200",
//   minVolume (number|null)
// }
// Rows whose indicators could not be fetched (`metricsUnavailable`) cannot be
// judged by an RSI/trend filter. They are left out of the result like any
// non-match, but `unevaluable()` names them so the page can say "not checked"
// instead of letting them pass for "checked and rejected".
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

/** Rows an indicator filter is active on but could not evaluate (no metrics). */
export function unevaluable(rows, f) {
  const needsMetrics = (f.rsi && f.rsi !== "any") || (f.trend && f.trend !== "any");
  return needsMetrics ? rows.filter((r) => r.metricsUnavailable) : [];
}
