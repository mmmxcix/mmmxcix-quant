// correlation.js — cross-asset correlation matrix (London Strategic Edge-style).
//
// Daily log returns, aligned by UTC calendar date, correlated PAIRWISE-complete:
// each pair uses only the dates both series traded. That matters for mixed
// baskets — crypto trades weekends, stocks don't, and silently zero-filling the
// gap would drag every stock↔crypto correlation toward zero.

import { fetchCandles } from "@/lib/data";

/** A symbol the matrix can hold. Crypto = Binance pair, everything else Yahoo. */
export const detectMarket = (sym) => (/USDT$/i.test(sym.trim()) ? "crypto" : "stock");

export const DEFAULT_BASKET = [
  "SPY", "QQQ", "NVDA", "AAPL", "TSLA", "GLD", "TLT", "BTCUSDT", "ETHUSDT", "EURUSD=X",
];

const dateKey = (unixSec) => new Date(unixSec * 1000).toISOString().slice(0, 10);

/** candles → Map(dateKey → daily log return). */
export function dailyLogReturns(candles) {
  const m = new Map();
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1].close, cur = candles[i].close;
    if (prev > 0 && cur > 0) m.set(dateKey(candles[i].time), Math.log(cur / prev));
  }
  return m;
}

/**
 * Fetch daily closes for every symbol in the basket. Returns
 * { series: {sym → Map(date → ret)}, failed: [sym] } — one bad ticker must
 * not blank the whole matrix.
 */
export async function fetchBasketReturns(symbols, range = "1y") {
  const settled = await Promise.allSettled(
    symbols.map((sym) =>
      fetchCandles({ market: detectMarket(sym), symbol: sym, interval: "1d", range })
    )
  );
  const series = {}, failed = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value.length >= 20) series[symbols[i]] = dailyLogReturns(r.value);
    else failed.push(symbols[i]);
  });
  return { series, failed };
}

/** Pearson correlation of two date→return maps over their common dates. */
export function pairCorrelation(a, b) {
  const xs = [], ys = [];
  for (const [d, x] of a) {
    const y = b.get(d);
    if (y !== undefined) { xs.push(x); ys.push(y); }
  }
  const n = xs.length;
  if (n < 20) return { r: null, n }; // too few overlapping days to mean anything
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n, my = sy / n;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    cov += dx * dy; vx += dx * dx; vy += dy * dy;
  }
  const denom = Math.sqrt(vx * vy);
  return { r: denom === 0 ? null : cov / denom, n };
}

/**
 * Full matrix over the fetched series. Returns { symbols, matrix, counts }
 * where matrix[i][j] is r (null when undefined) and counts[i][j] the number
 * of overlapping observations.
 */
export function correlationMatrix(series) {
  const symbols = Object.keys(series);
  const k = symbols.length;
  const matrix = Array.from({ length: k }, () => new Array(k).fill(null));
  const counts = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let i = 0; i < k; i++) {
    matrix[i][i] = 1;
    counts[i][i] = series[symbols[i]].size;
    for (let j = i + 1; j < k; j++) {
      const { r, n } = pairCorrelation(series[symbols[i]], series[symbols[j]]);
      matrix[i][j] = matrix[j][i] = r;
      counts[i][j] = counts[j][i] = n;
    }
  }
  return { symbols, matrix, counts };
}

/**
 * Greedy chain seriation: order symbols so highly correlated ones sit next to
 * each other — turns the heatmap from noise into visible blocks. Start at the
 * strongest pair, then repeatedly append the outsider most correlated with the
 * current chain end.
 */
export function seriationOrder({ symbols, matrix }) {
  const k = symbols.length;
  if (k <= 2) return symbols.map((_, i) => i);
  let bi = 0, bj = 1, best = -Infinity;
  for (let i = 0; i < k; i++) for (let j = i + 1; j < k; j++) {
    const r = matrix[i][j];
    if (r !== null && r > best) { best = r; bi = i; bj = j; }
  }
  const order = [bi, bj];
  const used = new Set(order);
  while (order.length < k) {
    const tail = order[order.length - 1];
    let next = -1, nb = -Infinity;
    for (let j = 0; j < k; j++) {
      if (used.has(j)) continue;
      const r = matrix[tail][j];
      const score = r === null ? -2 : r; // unknowns go last
      if (score > nb) { nb = score; next = j; }
    }
    order.push(next); used.add(next);
  }
  return order;
}

/** Insight extraction: extremes + the best diversifier for the basket. */
export function matrixInsights({ symbols, matrix }) {
  let hi = null, lo = null;
  const k = symbols.length;
  for (let i = 0; i < k; i++) for (let j = i + 1; j < k; j++) {
    const r = matrix[i][j];
    if (r === null) continue;
    if (!hi || r > hi.r) hi = { a: symbols[i], b: symbols[j], r };
    if (!lo || r < lo.r) lo = { a: symbols[i], b: symbols[j], r };
  }
  // Best diversifier = lowest mean |r| against everything else.
  let diversifier = null;
  for (let i = 0; i < k; i++) {
    let sum = 0, cnt = 0;
    for (let j = 0; j < k; j++) {
      if (i === j || matrix[i][j] === null) continue;
      sum += Math.abs(matrix[i][j]); cnt++;
    }
    if (cnt === 0) continue;
    const avg = sum / cnt;
    if (!diversifier || avg < diversifier.avg) diversifier = { sym: symbols[i], avg };
  }
  return { hi, lo, diversifier };
}
