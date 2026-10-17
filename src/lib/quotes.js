// Quote layer for the market monitor. Snapshot quotes only (price + day
// change) — full candle history lives in src/lib/data.js.
//
// Crypto: ONE Binance 24hr-ticker call covers every symbol (public CORS API).
// Stocks/indices/FX/futures: ONE /api/yahoo v7/finance/quote?symbols=… call
// per tick for the whole list (the proxy attaches Yahoo's crumb + cookie; v7
// returns 401 without them). Each Pages Function invocation counts against the
// free plan's 100k/day, and the per-symbol v8 chart path cost the Monitor 28 of
// them per tick. The v8 path stays as the fallback for symbols the batch
// doesn't return, or when the batch request fails outright.
//
// Dev-only upgrade: with the IBKR gateway feature enabled (Tools page, dev
// token required), stock quotes come real-time from the local Client Portal
// Gateway in one batch, with Yahoo as automatic per-symbol fallback.

import { ibkrActive, fetchIbkrQuotes } from "./ibkr.js";

const YAHOO_CHART = "/api/yahoo/v8/finance/chart";
const YAHOO_QUOTE = "/api/yahoo/v7/finance/quote";
// Symbols per v7 request. The whole Monitor (28) fits in one; the cap only
// keeps a very long watchlist's URL a sane length.
const BATCH_MAX = 50;
const QUOTE_FIELDS = "regularMarketPrice,regularMarketChangePercent,regularMarketPreviousClose,regularMarketTime";
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
  lastGood.set(symbol, { at: Date.now(), quote });
}

// Last successful quote per symbol, kept past the TTL. A failed poll used to
// turn a known price into `null`, and pages that summed values (Portfolio)
// then counted the position as $0 while still counting its cost: a fake loss.
// Callers that opt in (`keepStale`) get the last good price back, marked
// `stale` with its `asOf`, so they can show it labelled and leave it out of
// any total that claims to be current.
const lastGood = new Map(); // symbol -> { at, quote }

/**
 * Resolve a failed lookup: the last good quote marked stale, or an explicit
 * "no quote" when there has never been one. Pure, exported for tests.
 */
export function staleOrMissing(entry, good) {
  if (good && Number.isFinite(good.quote?.price)) {
    return { ...entry, ...good.quote, stale: true, asOf: good.at };
  }
  return { ...entry, price: null, changePct: null, stale: true, asOf: null };
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

/**
 * Parse a v7/finance/quote response into Map<SYMBOL, { price, changePct, prevClose }>.
 * Only rows with a finite price are kept; a symbol Yahoo didn't return (or
 * returned without a price) is simply absent, and the caller falls back.
 * changePct is Yahoo's regularMarketChangePercent, already in percent; when it
 * is missing it is derived from regularMarketPreviousClose. Pure, for tests.
 */
export function parseQuoteBatch(json) {
  const out = new Map();
  for (const r of json?.quoteResponse?.result || []) {
    const symbol = typeof r?.symbol === "string" ? r.symbol.toUpperCase() : null;
    const price = r?.regularMarketPrice;
    if (!symbol || !Number.isFinite(price)) continue;
    const prevClose = Number.isFinite(r.regularMarketPreviousClose) ? r.regularMarketPreviousClose : null;
    const changePct = Number.isFinite(r.regularMarketChangePercent)
      ? r.regularMarketChangePercent
      : prevClose ? ((price - prevClose) / prevClose) * 100 : null;
    out.set(symbol, { price, changePct, prevClose });
  }
  return out;
}

/** One batched v7 request per BATCH_MAX symbols. Throws if a request fails. */
export async function fetchStockQuotesBatch(symbols) {
  const upper = [...new Set(symbols.map((s) => s.toUpperCase()))];
  const out = new Map();
  for (let i = 0; i < upper.length; i += BATCH_MAX) {
    const chunk = upper.slice(i, i + BATCH_MAX);
    const url = `${YAHOO_QUOTE}?symbols=${chunk.map(encodeURIComponent).join(",")}&fields=${QUOTE_FIELDS}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Yahoo quote batch ${res.status}`);
    for (const [k, v] of parseQuoteBatch(await res.json())) out.set(k, v);
  }
  return out;
}

const YAHOO_SPARK = "/api/yahoo/v8/finance/spark";

/**
 * Parse a v8/finance/spark response into Map<SYMBOL, closes[]> (ascending,
 * nulls dropped). Spark carries close series only — no quote fields — so it
 * feeds sparklines and nothing else. Two response shapes are in the wild:
 *   { "AAPL": { symbol, timestamp:[…], close:[…] }, … }                (flat)
 *   { spark: { result: [{ symbol, response:[{ indicators:{ quote:[{ close }] } }] }] } }
 * Both are accepted. Pure, for tests.
 */
export function parseSparkBatch(json) {
  const out = new Map();
  const put = (sym, closes) => {
    if (typeof sym !== "string" || !Array.isArray(closes)) return;
    const clean = closes.filter((c) => Number.isFinite(c));
    if (clean.length >= 2) out.set(sym.toUpperCase(), clean);
  };
  if (Array.isArray(json?.spark?.result)) {
    for (const r of json.spark.result) put(r?.symbol, r?.response?.[0]?.indicators?.quote?.[0]?.close);
    return out;
  }
  for (const [k, v] of Object.entries(json || {})) {
    if (v && typeof v === "object") put(v.symbol || k, v.close);
  }
  return out;
}

/** Close series for many symbols in one request (sparklines only). */
export async function fetchSparks(symbols, { range = "3mo", interval = "1d" } = {}) {
  const upper = [...new Set(symbols.map((s) => s.toUpperCase()))];
  const out = new Map();
  for (let i = 0; i < upper.length; i += BATCH_MAX) {
    const chunk = upper.slice(i, i + BATCH_MAX);
    const res = await fetch(`${YAHOO_SPARK}?symbols=${chunk.map(encodeURIComponent).join(",")}&range=${range}&interval=${interval}`);
    if (!res.ok) throw new Error(`Yahoo spark ${res.status}`);
    for (const [k, v] of parseSparkBatch(await res.json())) out.set(k, v);
  }
  return out;
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
export async function fetchQuotes(entries, { keepStale = false } = {}) {
  const out = new Map();
  // A miss: with keepStale, fall back to the last good quote (labelled stale);
  // otherwise the historical shape, price/changePct null.
  const miss = (e) => keepStale
    ? staleOrMissing(e, lastGood.get(e.symbol))
    : { ...e, price: null, changePct: null };
  const misses = [];
  const useIbkr = ibkrActive();

  for (const e of entries) {
    // With IBKR live quotes on, stocks always bypass the client cache — the
    // gateway is local and rate-limit-free, so caching only adds staleness.
    const hit = useIbkr && e.market !== "crypto" ? null : getCached(e.symbol);
    if (hit) out.set(e.symbol, { ...e, ...hit, stale: false, asOf: cache.get(e.symbol).at });
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
          out.set(e.symbol, { ...e, ...q, source: "ibkr", stale: false, asOf: Date.now() });
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
              out.set(e.symbol, { ...e, ...t, stale: false, asOf: Date.now() });
            } else {
              out.set(e.symbol, miss(e));
            }
          }
        })
        .catch(() => {
          for (const e of cryptoMisses) out.set(e.symbol, miss(e));
        })
    );
  }

  if (stockMisses.length) {
    jobs.push((async () => {
      // One request for the whole list. Whatever it doesn't cover — the batch
      // failed, or Yahoo left a symbol out — goes through the old per-symbol
      // path, so a batch outage is never worse than before.
      let batch = new Map();
      try { batch = await fetchStockQuotesBatch(stockMisses.map((e) => e.symbol)); } catch { /* fall back below */ }
      const rest = [];
      for (const e of stockMisses) {
        const q = batch.get(e.symbol.toUpperCase());
        if (!q) { rest.push(e); continue; }
        setCached(e.symbol, { price: q.price, changePct: q.changePct });
        out.set(e.symbol, { ...e, price: q.price, changePct: q.changePct, stale: false, asOf: Date.now() });
      }
      await mapLimit(rest, 6, async (e) => {
        try {
          const { price, changePct } = await fetchStockQuote(e.symbol);
          setCached(e.symbol, { price, changePct });
          out.set(e.symbol, { ...e, price, changePct, stale: false, asOf: Date.now() });
        } catch {
          out.set(e.symbol, miss(e));
        }
      });
    })());
  }

  await Promise.all(jobs);
  return out;
}
