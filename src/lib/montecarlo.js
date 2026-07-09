// montecarlo.js — bootstrap Monte Carlo on per-trade returns.
//
// The core idea (taught in Academy → Futures & Prop-Firm → validation toolkit):
// a single backtest shows ONE ordering of trades. Resampling the same trades
// with replacement thousands of times shows the DISTRIBUTION of outcomes the
// same edge can produce — median result, spread, worst-case drawdowns, and the
// probability that the observed edge is just luck.
//
// All returns here are per-trade fractional equity returns (e.g. +0.012 =
// +1.2% of equity on that trade), compounded multiplicatively.

/** Deterministic 32-bit RNG so a given seed reproduces a run exactly. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** q-quantile (0..1) of a numeric array (non-mutating, linear interpolation). */
export function quantile(arr, q) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/**
 * Run a bootstrap Monte Carlo.
 *
 * @param {Object} opts
 * @param {number[]} opts.returns        Per-trade fractional returns to resample.
 * @param {number}  [opts.paths=1000]    Simulated paths.
 * @param {number}  [opts.steps]         Trades per path (default: returns.length).
 * @param {number}  [opts.initialCapital=10000]
 * @param {number}  [opts.seed=1]        RNG seed (same seed → same result).
 * @returns {{
 *   bands: { q: number, values: number[] }[],  // equity percentile bands, index 0 = start
 *   finals: number[],                          // final equity per path
 *   maxDDs: number[],                          // max drawdown per path (fraction, 0.18 = −18%)
 *   stats: {
 *     pLossPct: number,          // % of paths ending at or below start
 *     medianReturnPct: number,
 *     p5ReturnPct: number, p95ReturnPct: number,
 *     medianMaxDDPct: number, p95MaxDDPct: number,
 *   },
 * }}
 */
export function runMonteCarlo({ returns, paths = 1000, steps, initialCapital = 10000, seed = 1 }) {
  const n = returns?.length || 0;
  const empty = { bands: [], finals: [], maxDDs: [], stats: { pLossPct: 0, medianReturnPct: 0, p5ReturnPct: 0, p95ReturnPct: 0, medianMaxDDPct: 0, p95MaxDDPct: 0 } };
  if (n === 0) return empty;

  let m = Math.max(1, Math.floor(steps || n));
  let p = Math.max(1, Math.floor(paths));
  // Keep the full equity matrix bounded (percentiles need every path per step).
  const MAX_CELLS = 2_000_000;
  if (p * m > MAX_CELLS) p = Math.max(100, Math.floor(MAX_CELLS / m));

  const rand = mulberry32(seed);
  // eq[step][path] — grouped by step so per-step percentile extraction is cheap.
  const eq = Array.from({ length: m + 1 }, () => new Float64Array(p));
  const finals = new Array(p);
  const maxDDs = new Array(p);

  for (let j = 0; j < p; j++) {
    let e = initialCapital;
    let peak = e;
    let maxDD = 0;
    eq[0][j] = e;
    for (let i = 1; i <= m; i++) {
      const r = returns[Math.floor(rand() * n)];
      e *= 1 + r;
      if (e < 0) e = 0; // a >100% loss trade can't take equity negative
      if (e > peak) peak = e;
      const dd = peak > 0 ? (peak - e) / peak : 0;
      if (dd > maxDD) maxDD = dd;
      eq[i][j] = e;
    }
    finals[j] = e;
    maxDDs[j] = maxDD;
  }

  // Percentile bands across paths at every step.
  const QS = [0.05, 0.25, 0.5, 0.75, 0.95];
  const bands = QS.map((q) => ({ q, values: new Array(m + 1) }));
  const scratch = new Float64Array(p);
  for (let i = 0; i <= m; i++) {
    scratch.set(eq[i]);
    scratch.sort();
    for (const b of bands) {
      const pos = (p - 1) * b.q;
      const lo = Math.floor(pos), hi = Math.ceil(pos);
      b.values[i] = lo === hi ? scratch[lo] : scratch[lo] + (scratch[hi] - scratch[lo]) * (pos - lo);
    }
  }

  const retPct = (v) => (v / initialCapital - 1) * 100;
  const losses = finals.filter((f) => f <= initialCapital).length;
  return {
    bands,
    finals,
    maxDDs,
    stats: {
      pLossPct: (losses / p) * 100,
      medianReturnPct: retPct(quantile(finals, 0.5)),
      p5ReturnPct: retPct(quantile(finals, 0.05)),
      p95ReturnPct: retPct(quantile(finals, 0.95)),
      medianMaxDDPct: quantile(maxDDs, 0.5) * 100,
      p95MaxDDPct: quantile(maxDDs, 0.95) * 100,
    },
  };
}

/** Share of paths whose max drawdown reached `limitPct` (e.g. 4 → −4%). */
export function breachProbabilityPct(maxDDs, limitPct) {
  if (!maxDDs.length || !(limitPct > 0)) return 0;
  const lim = limitPct / 100;
  return (maxDDs.filter((d) => d >= lim).length / maxDDs.length) * 100;
}

/**
 * Build the exact trade-return distribution for the expectancy playground:
 * `winRate`% of trades win +avgWinR·risk, the rest lose −avgLossR·risk, where
 * risk is the per-trade risk as a fraction of equity. The Monte Carlo's
 * resampling supplies the randomness, so the base array can be deterministic.
 */
export function buildPlaygroundReturns({ winRate, avgWinR, avgLossR, riskPct, trades = 100 }) {
  const risk = riskPct / 100;
  const wins = Math.round((winRate / 100) * trades);
  const out = new Array(trades);
  for (let i = 0; i < trades; i++) {
    out[i] = i < wins ? avgWinR * risk : -avgLossR * risk;
  }
  return out;
}

/** Expectancy in R per trade: winRate·avgWinR − lossRate·avgLossR. */
export function expectancyR({ winRate, avgWinR, avgLossR }) {
  const wr = winRate / 100;
  return wr * avgWinR - (1 - wr) * avgLossR;
}

/** Histogram bins for the drawdown distribution: [{ x0, x1, count }]. */
export function histogram(values, binCount = 24) {
  if (!values.length) return [];
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (lo === hi) { lo -= 0.5; hi += 0.5; }
  const w = (hi - lo) / binCount;
  const bins = Array.from({ length: binCount }, (_, i) => ({ x0: lo + i * w, x1: lo + (i + 1) * w, count: 0 }));
  for (const v of values) {
    let idx = Math.floor((v - lo) / w);
    if (idx >= binCount) idx = binCount - 1;
    if (idx < 0) idx = 0;
    bins[idx].count++;
  }
  return bins;
}
