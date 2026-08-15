// insider-prices.mjs — daily history for the symbols a study needs, cached.
//
// Yahoo's chart endpoint is free and keyless, and it punishes parallel bursts
// from one IP by returning EMPTY results rather than an error — which reads as
// "this company has no price history" and would quietly delete exactly the names
// that matter. scripts/marketdata.mjs solved that by going strictly sequential;
// a few thousand symbols cannot afford that, so this fetcher paces itself, keeps
// concurrency low, and treats a suspicious run of empties as throttling to be
// retried rather than as data.
//
// Everything lands in a disk cache: a study is rerun many times while its
// parameters are argued about, and re-downloading a thousand symbols each time
// is how a measurement stops being repeated at all.

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Yahoo returns nothing at all for delisted tickers, which is the bias below. */
async function fetchOne(symbol, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(20_000) });
  if (res.status === 429) return { throttled: true };
  if (!res.ok) return { candles: [] };
  const r = (await res.json())?.chart?.result?.[0];
  if (!r) return { candles: [] };
  const ts = r.timestamp || [], q = r.indicators?.quote?.[0] || {};
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    out.push({ time: ts[i], open: o, high: h, low: l, close: c, volume: q.volume?.[i] ?? 0 });
  }
  return { candles: out };
}

/**
 * Load daily candles for many symbols.
 *
 * @param {string[]} symbols
 * @param {object} o  { dir, range, concurrency, paceMs, onProgress }
 * @returns {{prices: Record<string, Array>, missing: string[]}}
 *   `missing` is the survivorship list and is meant to be REPORTED, not hidden:
 *   a ticker Yahoo cannot serve is usually one that was acquired or delisted,
 *   and silently dropping those biases every result upward.
 */
export async function loadPrices(symbols, { dir, range = "10y", concurrency = 3, paceMs = 120, onProgress } = {}) {
  mkdirSync(dir, { recursive: true });
  const prices = {}, missing = [];
  const queue = [...new Set(symbols.filter(Boolean))];
  let done = 0, throttleBackoff = 0;

  const cachePath = (s) => join(dir, `${s.replace(/[^A-Z0-9.\-^]/gi, "_")}.json`);

  async function worker() {
    while (queue.length) {
      const sym = queue.shift();
      const path = cachePath(sym);
      if (existsSync(path)) {
        try {
          const c = JSON.parse(readFileSync(path, "utf8"));
          if (c.candles?.length) prices[sym] = c.candles; else missing.push(sym);
          onProgress?.(++done, symbols.length);
          continue;
        } catch { /* corrupt cache entry — refetch */ }
      }
      let got = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (throttleBackoff) { await sleep(throttleBackoff); }
        try { got = await fetchOne(sym, range); } catch { got = null; }
        if (got?.throttled) { throttleBackoff = Math.min(30_000, (throttleBackoff || 2_000) * 2); got = null; continue; }
        if (got) { throttleBackoff = Math.max(0, throttleBackoff / 2 | 0); break; }
        await sleep(500 * (attempt + 1));
      }
      const candles = got?.candles || [];
      writeFileSync(path, JSON.stringify({ symbol: sym, at: Date.now(), candles }));
      if (candles.length) prices[sym] = candles; else missing.push(sym);
      onProgress?.(++done, symbols.length);
      await sleep(paceMs);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return { prices, missing };
}
