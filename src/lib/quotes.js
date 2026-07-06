// Quote layer for the market monitor. Snapshot quotes only (price + day
// change) — full candle history lives in src/lib/data.js.
//
// Crypto: ONE Binance 24hr-ticker call covers every symbol (public CORS API).
// Stocks/indices/FX/futures: the /api/yahoo proxy v8 chart endpoint. Do NOT
// switch to v7/finance/quote — that endpoint is auth-gated and returns 401.

const YAHOO_CHART = "/api/yahoo/v8/finance/chart";
const BINANCE_24H = "https://api.binance.com/api/v3/ticker/24hr";

// Module-level cache so tab revisits within the TTL are instant.
const TTL_MS = 120_000;
const cache = new Map(); // symbol -> { at: ms epoch, quote: { price, changePct } }

function getCached(symbol) {
  const hit = cache.get(symbol);
  return hit && Date.now() - hit.at < TTL_MS ? hit.quote : null;
}

function setCached(symbol, quote) {
  cache.set(symbol, { at: Date.now(), quote });
}

// Single stock-like quote via the Yahoo chart endpoint: last two valid daily
// closes give prevClose; meta.regularMarketPrice is preferred for the live
// price when present (intraday it's fresher than the last close).
export async function fetchStockQuote(symbol) {
  const url = `${YAHOO_CHART}/${encodeURIComponent(symbol.toUpperCase())}?range=5d&interval=1d`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Yahoo-Fehler ${res.status} für "${symbol}"`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) {
    throw new Error(json?.chart?.error?.description || `Keine Daten für "${symbol}".`);
  }

  const closes = (result.indicators?.quote?.[0]?.close || []).filter(
    (c) => c != null && Number.isFinite(c)
  );
  if (closes.length < 2) throw new Error(`Zu wenige Datenpunkte für "${symbol}".`);

  const lastClose = closes[closes.length - 1];
  const prevClose = closes[closes.length - 2];
  const metaPrice = result.meta?.regularMarketPrice;
  const price = Number.isFinite(metaPrice) ? metaPrice : lastClose;
  const changePct = prevClose ? ((price - prevClose) / prevClose) * 100 : null;

  return { symbol: symbol.toUpperCase(), price, changePct, prevClose };
}

// All USDT crypto tickers in one call (no symbol param → full list).
// Returns Map<symbol, { price, changePct }>.
export async function fetchAllCryptoTickers() {
  const res = await fetch(BINANCE_24H);
  if (!res.ok) throw new Error(`Binance-Fehler ${res.status}`);
  const rows = await res.json();
  const map = new Map();
  for (const r of rows) {
    if (typeof r?.symbol !== "string" || !r.symbol.endsWith("USDT")) continue;
    const price = +r.lastPrice;
    const changePct = +r.priceChangePercent;
    if (!Number.isFinite(price)) continue;
    map.set(r.symbol, { price, changePct: Number.isFinite(changePct) ? changePct : null });
  }
  return map;
}

// Tiny worker pool: never more than `limit` requests in flight.
async function mapLimit(items, limit, fn) {
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// Resolve quotes for a mixed list of entries [{ market, symbol, name }].
// One Binance call covers all crypto entries; stocks are fetched in parallel
// with a concurrency limit of 6. Individual failures never reject the whole
// call — the affected entry just carries { price: null, changePct: null }.
// Returns Map<symbol, { market, symbol, name, price, changePct }>.
export async function fetchQuotes(entries) {
  const out = new Map();
  const misses = [];

  for (const e of entries) {
    const hit = getCached(e.symbol);
    if (hit) out.set(e.symbol, { ...e, ...hit });
    else misses.push(e);
  }

  const cryptoMisses = misses.filter((e) => e.market === "crypto");
  const stockMisses = misses.filter((e) => e.market !== "crypto");
  const jobs = [];

  if (cryptoMisses.length) {
    jobs.push(
      fetchAllCryptoTickers()
        .then((tickers) => {
          for (const e of cryptoMisses) {
            const t = tickers.get(e.symbol.toUpperCase());
            if (t) {
              setCached(e.symbol, t);
              out.set(e.symbol, { ...e, ...t });
            } else {
              out.set(e.symbol, { ...e, price: null, changePct: null });
            }
          }
        })
        .catch(() => {
          for (const e of cryptoMisses) out.set(e.symbol, { ...e, price: null, changePct: null });
        })
    );
  }

  if (stockMisses.length) {
    jobs.push(
      mapLimit(stockMisses, 6, async (e) => {
        try {
          const { price, changePct } = await fetchStockQuote(e.symbol);
          setCached(e.symbol, { price, changePct });
          out.set(e.symbol, { ...e, price, changePct });
        } catch {
          out.set(e.symbol, { ...e, price: null, changePct: null });
        }
      })
    );
  }

  await Promise.all(jobs);
  return out;
}
