// equityCurve.js — combine per-symbol daily candles into one Dashboard curve.
//
// Moved out of Dashboard.jsx so the failure path is testable. The bug it fixes:
// the watchlist index weighted every series by 100 / (symbols REQUESTED), then
// silently dropped the ones that failed to load — so with 1 of 5 failing the
// "index" started at 80, a fake 20% drawdown on day one. Portfolio mode had the
// mirror image: a failed position simply vanished from the value. Now weights
// are computed over what actually loaded, and the result names what didn't.

// Align multiple daily candle series on their common timeline and combine them
// (portfolio = Σ shares × close; watchlist = equal-weight index, start 100).
// value(close, t) also receives the bar time so portfolio positions can respect
// their buy/sell window (0 before the buy, frozen proceeds after the sale).
export function combineSeries(entries) {
  if (!entries.length) return [];
  const start = Math.max(...entries.map((e) => e.candles[0].time));
  const times = [...new Set(entries.flatMap((e) => e.candles.map((c) => c.time)))]
    .filter((t) => t >= start)
    .sort((a, b) => a - b);
  const idx = entries.map(() => 0);
  const out = [];
  for (const t of times) {
    let v = 0, ok = true;
    entries.forEach((e, i) => {
      const cs = e.candles;
      while (idx[i] + 1 < cs.length && cs[idx[i] + 1].time <= t) idx[i]++;
      if (cs[idx[i]].time > t) { ok = false; return; }
      v += e.value(cs[idx[i]].close, t); // forward-fill: last known close
    });
    if (ok) out.push({ t: t * 1000, v });
  }
  return out;
}

/**
 * @param mode     "watchlist" | "portfolio"
 * @param specs    [{ symbol, value?(close, t) }] in request order (portfolio
 *                 specs carry their own value fn; watchlist ones don't need one)
 * @param settled  Promise.allSettled results, same order, fulfilled = candles[]
 * @returns { data, loaded, failed: string[] }
 */
export function buildEquityCurve(mode, specs, settled) {
  const ok = [];
  const failed = [];
  settled.forEach((r, i) => {
    const candles = r.status === "fulfilled" ? r.value : null;
    if (candles && candles.length >= 2) ok.push({ spec: specs[i], candles });
    else failed.push(specs[i].symbol);
  });
  const n = ok.length;
  const entries = ok.map(({ spec, candles }) => ({
    candles,
    value: mode === "watchlist"
      // Equal weight over the series that LOADED, so the index starts at 100.
      ? (close) => (close / candles[0].close) * (100 / n)
      : spec.value,
  }));
  return { data: combineSeries(entries), loaded: n, failed };
}
