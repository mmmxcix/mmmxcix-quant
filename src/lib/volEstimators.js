// volEstimators.js — realised-volatility estimators that use the whole candle,
// not just the close.
//
// WHY: close-to-close throws away three quarters of every bar. A stock that
// swung 4% intraday and closed flat reads as ZERO volatility to it. The
// range-based estimators below use open/high/low/close and are several times
// more efficient — Parkinson needs roughly a fifth of the sample of
// close-to-close for the same confidence, Yang-Zhang about an eighth — which
// matters enormously when you only have a few hundred bars.
//
// PROVENANCE: implemented from the published formulas (Parkinson 1980; Garman
// & Klass 1980; Rogers & Satchell 1991; Yang & Zhang 2000; Hodges & Tompkins
// 2002), NOT ported from jasonstrimpel/volatility-trading, which is GPL-3.0 —
// copying that code would force this project under the GPL. The mathematics is
// published science and free to implement; the implementation here is our own.
//
// All functions take ascending candles [{open,high,low,close}] and return the
// ANNUALISED volatility as a fraction (0.24 = 24%), or null when the window
// cannot be filled. `periodsPerYear` must match the bar size.

const LN = Math.log;

/** Annualisation factor per bar size — same table the backtest engine uses. */
export const PERIODS_PER_YEAR = {
  "1m": 525600, "5m": 105120, "15m": 35040, "30m": 17520,
  "1h": 8760, "2h": 4380, "4h": 2190, "1d": 252, "1w": 52, "1M": 12,
};

function tail(candles, window) {
  if (!Array.isArray(candles) || candles.length < window + 1) return null;
  return candles.slice(-window);
}

const ok = (c) => c && c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0;

/**
 * Close-to-close — the classic sample standard deviation of log returns.
 * Included as the BASELINE the others have to beat, not because it is good.
 */
export function closeToClose(candles, window = 30, periodsPerYear = 252) {
  if (!Array.isArray(candles) || candles.length < window + 1) return null;
  const slice = candles.slice(-(window + 1));
  const r = [];
  for (let i = 1; i < slice.length; i++) {
    if (!ok(slice[i]) || !ok(slice[i - 1])) return null;
    r.push(LN(slice[i].close / slice[i - 1].close));
  }
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const v = r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1);
  return Math.sqrt(v * periodsPerYear);
}

/**
 * Parkinson (1980) — high/low range only. ~5x more efficient than
 * close-to-close, but it cannot see overnight gaps (it assumes continuous
 * trading), so it UNDERSTATES vol for anything that gaps.
 */
export function parkinson(candles, window = 30, periodsPerYear = 252) {
  const slice = tail(candles, window);
  if (!slice) return null;
  const k = 1 / (4 * LN(2));
  let sum = 0;
  for (const c of slice) {
    if (!ok(c)) return null;
    sum += k * LN(c.high / c.low) ** 2;
  }
  return Math.sqrt((sum / slice.length) * periodsPerYear);
}

/**
 * Garman–Klass (1980) — range AND close-open. ~7x efficient. Still blind to
 * gaps (it treats the open as the previous close).
 */
export function garmanKlass(candles, window = 30, periodsPerYear = 252) {
  const slice = tail(candles, window);
  if (!slice) return null;
  let sum = 0;
  for (const c of slice) {
    if (!ok(c)) return null;
    const hl = LN(c.high / c.low) ** 2;
    const co = LN(c.close / c.open) ** 2;
    sum += 0.5 * hl - (2 * LN(2) - 1) * co;
  }
  const v = sum / slice.length;
  return v > 0 ? Math.sqrt(v * periodsPerYear) : 0;
}

/**
 * Rogers–Satchell (1991) — the first one that stays unbiased when the price
 * has a DRIFT. Parkinson and Garman-Klass both assume zero drift and inflate
 * during a strong trend; this one does not. Still gap-blind.
 */
export function rogersSatchell(candles, window = 30, periodsPerYear = 252) {
  const slice = tail(candles, window);
  if (!slice) return null;
  let sum = 0;
  for (const c of slice) {
    if (!ok(c)) return null;
    const h = LN(c.high / c.close), hO = LN(c.high / c.open);
    const l = LN(c.low / c.close), lO = LN(c.low / c.open);
    sum += h * hO + l * lO;
  }
  const v = sum / slice.length;
  return v > 0 ? Math.sqrt(v * periodsPerYear) : 0;
}

/**
 * Yang–Zhang (2000) — the one to use by default. Combines overnight (gap),
 * open-to-close and Rogers-Satchell components, so it is BOTH drift-independent
 * AND gap-aware, at roughly 8x the efficiency of close-to-close.
 */
export function yangZhang(candles, window = 30, periodsPerYear = 252) {
  if (!Array.isArray(candles) || candles.length < window + 1) return null;
  const slice = candles.slice(-(window + 1));
  const n = window;
  const overnight = [], openClose = [];
  let rs = 0;
  for (let i = 1; i < slice.length; i++) {
    const c = slice[i], p = slice[i - 1];
    if (!ok(c) || !ok(p)) return null;
    overnight.push(LN(c.open / p.close));   // close → next open (the gap)
    openClose.push(LN(c.close / c.open));   // the session itself
    rs += LN(c.high / c.close) * LN(c.high / c.open) + LN(c.low / c.close) * LN(c.low / c.open);
  }
  const varOf = (xs) => {
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    return xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  };
  const vo = varOf(overnight);
  const vc = varOf(openClose);
  const vrs = rs / n;
  // k minimises the variance of the estimator (Yang & Zhang, eq. 10)
  const k = 0.34 / (1.34 + (n + 1) / (n - 1));
  const v = vo + k * vc + (1 - k) * vrs;
  return v > 0 ? Math.sqrt(v * periodsPerYear) : 0;
}

/**
 * Hodges–Tompkins (2002) bias adjustment for OVERLAPPING windows. Rolling a
 * window over a series reuses each bar many times, so the estimates are
 * correlated and their spread is understated — this scales that back up.
 * @param sigma  an estimate from an overlapping rolling window
 * @param n      number of observations in the whole series
 * @param window window length used
 */
export function hodgesTompkins(sigma, n, window) {
  if (!(sigma > 0) || !(n > window) || window < 2) return sigma ?? null;
  const h = window, m = n - h + 1;
  const adj = 1 / (1 - h / m + (h * h - 1) / (3 * m * m));
  return sigma * Math.sqrt(adj);
}

/** Every estimator at once, for a side-by-side read. */
export function allEstimators(candles, window = 30, periodsPerYear = 252) {
  return {
    closeToClose: closeToClose(candles, window, periodsPerYear),
    parkinson: parkinson(candles, window, periodsPerYear),
    garmanKlass: garmanKlass(candles, window, periodsPerYear),
    rogersSatchell: rogersSatchell(candles, window, periodsPerYear),
    yangZhang: yangZhang(candles, window, periodsPerYear),
  };
}

/** What each estimator is for, in one line — used by the UI so the numbers
 *  arrive with their caveats attached instead of as bare figures. */
export const ESTIMATOR_NOTES = {
  closeToClose: "Baseline. Ignores everything that happened inside the bar — a wild day that closes flat reads as calm.",
  parkinson: "High/low range. ~5× more efficient, but blind to overnight gaps, so it understates gappy names.",
  garmanKlass: "Range + body. ~7× efficient; also gap-blind, and it assumes no drift.",
  rogersSatchell: "Drift-independent — it does not inflate during a strong trend, unlike Parkinson/Garman-Klass.",
  yangZhang: "The default. Gap-aware AND drift-independent, ~8× the efficiency of close-to-close.",
};
