// Quote layer for the market monitor. Snapshot quotes only (price + day
// change) — full candle history lives in src/lib/data.js.
//
// Crypto: ONE Binance 24hr-ticker call covers every symbol (public CORS API).
// Stocks/indices/FX/futures: the /api/yahoo proxy v8 chart endpoint. Do NOT
// switch to v7/finance/quote — that endpoint is auth-gated and returns 401.
//
// Dev-only upgrade: with the IBKR gateway feature enabled (Tools page, dev
// token required), stock quotes come real-time from the local Client Portal
// Gateway in one batch, with Yahoo as automatic per-symbol fallback.

import { ibkrActive, fetchIbkrQuotes } from "./ibkr.js";

const YAHOO_CHART = "/api/yahoo/v8/finance/chart";
const BINANCE_24H = "https://api.binance.com/api/v3/ticker/24hr";

// Module-level cache so tab revisits within the TTL are instant. Kept short:
// the edge cache already serves 30s for quote-style requests, so a long
// client TTL would only add staleness on top.
const TTL_MS = 30_000;
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
  if (!res.ok) throw new Error(`Yahoo error ${res.status} for "${symbol}"`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) {
    throw new Error(json?.chart?.error?.description || `No data for "${symbol}".`);
  }

  const closes = (result.indicators?.quote?.[0]?.close || []).filter(
    (c) => c != null && Number.isFinite(c)
  );
  if (closes.length < 2) throw new Error(`Too few data points for "${symbol}".`);

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
  if (!res.ok) throw new Error(`Binance error ${res.status}`);
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
  const useIbkr = ibkrActive();

  for (const e of entries) {
    // With IBKR live quotes on, stocks always bypass the client cache — the
    // gateway is local and rate-limit-free, so caching only adds staleness.
    const hit = useIbkr && e.market !== "crypto" ? null : getCached(e.symbol);
    if (hit) out.set(e.symbol, { ...e, ...hit });
    else misses.push(e);
  }

  const cryptoMisses = misses.filter((e) => e.market === "crypto");
  let stockMisses = misses.filter((e) => e.market !== "crypto");
  const jobs = [];

  if (stockMisses.length && useIbkr) {
    try {
      const live = await fetchIbkrQuotes(stockMisses.map((e) => e.symbol));
      const rest = [];
      for (const e of stockMisses) {
        const q = live.get(e.symbol.toUpperCase());
        if (q) {
          setCached(e.symbol, q); // fallback freshness if IBKR drops mid-session
          out.set(e.symbol, { ...e, ...q, source: "ibkr" });
        } else {
          rest.push(e);
        }
      }
      stockMisses = rest;
    } catch {
      /* gateway down — full Yahoo fallback below */
    }
  }

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
