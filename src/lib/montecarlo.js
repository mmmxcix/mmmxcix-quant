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

/** One standard-normal draw (Box–Muller) from a uniform RNG. */
function boxMuller(rand) {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** q-quantile of an ALREADY-SORTED ascending array (linear interpolation). */
function qSorted(s, q) {
  if (!s.length) return 0;
  const pos = (s.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/**
 * Geometric Brownian Motion forward "risk cone": simulate `paths` price paths from
 * S0 under GBM — S_{t+1} = S_t · exp[(μ − ½σ²) + σ·Z] — and return percentile bands
 * over time. This is the parametric cousin of the trade-bootstrap MC: instead of
 * resampling past trades it projects where the PRICE could go from its drift and
 * vol. μ and σ are PER STEP (e.g. daily log-return mean and std). Deterministic
 * for a given seed. The ½σ² is the Itô correction (see the Academy lesson).
 * @returns {{ bands:{q,values[]}[], finals:number[], stats:Object } | null}
 */
export function gbmCone({ S0, mu = 0, sigma, steps = 60, paths = 2000, seed = 1, quantiles = [0.05, 0.25, 0.5, 0.75, 0.95] }) {
  if (!(S0 > 0) || !(sigma > 0) || steps < 1) return null;
  const rand = mulberry32(seed);
  const drift = mu - 0.5 * sigma * sigma;
  const cols = Array.from({ length: steps + 1 }, () => new Float64Array(paths));
  for (let p = 0; p < paths; p++) {
    let s = S0;
    cols[0][p] = s;
    for (let t = 1; t <= steps; t++) { s *= Math.exp(drift + sigma * boxMuller(rand)); cols[t][p] = s; }
  }
  const bands = quantiles.map((q) => ({ q, values: new Array(steps + 1) }));
  for (let t = 0; t <= steps; t++) {
    const sorted = Array.from(cols[t]).sort((a, b) => a - b);
    quantiles.forEach((q, qi) => { bands[qi].values[t] = qSorted(sorted, q); });
  }
  const finals = Array.from(cols[steps]).sort((a, b) => a - b);
  return {
    bands, finals,
    stats: {
      median: qSorted(finals, 0.5), p5: qSorted(finals, 0.05), p95: qSorted(finals, 0.95),
      pUpPct: (finals.filter((x) => x > S0).length / paths) * 100,
      medianRetPct: (qSorted(finals, 0.5) / S0 - 1) * 100,
      p5RetPct: (qSorted(finals, 0.05) / S0 - 1) * 100,
      p95RetPct: (qSorted(finals, 0.95) / S0 - 1) * 100,
    },
  };
}

/** Estimate per-step GBM parameters (log-return mean μ and std σ) from candles. */
export function estimateGbmParams(candles) {
  const cl = (candles || []).map((c) => c.close).filter((x) => x > 0);
  if (cl.length < 20) return null;
  const r = [];
  for (let i = 1; i < cl.length; i++) r.push(Math.log(cl[i] / cl[i - 1]));
  const mu = r.reduce((a, b) => a + b, 0) / r.length;
  const sigma = Math.sqrt(r.reduce((a, b) => a + (b - mu) ** 2, 0) / (r.length - 1));
  return { mu, sigma, n: r.length };
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

/**
 * Drawdown topology — simulate GBM-with-fat-tails portfolio paths and map how
 * the DRAWDOWN distribution evolves over the horizon (the "topology" surface
 * from the Anomalies page): z = path density at (day, drawdown depth).
 *
 * Model: daily return = μ·dt + σ·√dt·ε where ε ~ N(0,1), except with
 * probability `fatProb` the shock is scaled by `fatScale` (a crude but
 * effective two-regime fat-tail mixture).
 *
 * @param {Object} opts
 * @param {number} [opts.muPct=12]     Annual drift in %.
 * @param {number} [opts.sigmaPct=22]  Annual vol in %.
 * @param {number} [opts.days=252]     Horizon in trading days.
 * @param {number} [opts.paths=2000]
 * @param {number} [opts.fatProb=0.05] P(fat shock) per day.
 * @param {number} [opts.fatScale=4]   Shock multiplier on fat days.
 * @param {number} [opts.seed=7]
 * @param {number} [opts.gridW=64]     Surface columns (time).
 * @param {number} [opts.gridH=40]     Surface rows (drawdown depth).
 * @returns {{
 *   surface: number[][],          // gridH×gridW, log-scaled density 0..1 (row 0 = 0% DD)
 *   ddMax: number,                // depth (fraction) of the last row
 *   medianDD: {x,y}[], p95DD: {x,y}[],  // per-day drawdown quantiles (x = day, y = %)
 *   finals: number[],             // terminal equity multiples (start = 1)
 *   stats: { medianMaxDDPct, p95MaxDDPct, var95Pct, pDD20Pct, medianTerminalPct },
 * }}
 */
export function simulateDrawdownTopology({
  muPct = 12, sigmaPct = 22, days = 252, paths = 2000,
  fatProb = 0.05, fatScale = 4, seed = 7, gridW = 64, gridH = 40,
} = {}) {
  const dt = 1 / 252;
  const drift = (muPct / 100) * dt;
  const vol = (sigmaPct / 100) * Math.sqrt(dt);
  const rand = mulberry32(seed);
  // Box-Muller, consuming two uniforms per normal.
  const normal = () => {
    const u = Math.max(rand(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  };

  const m = Math.max(10, Math.floor(days));
  const p = Math.max(50, Math.floor(paths));
  const dd = Array.from({ length: m }, () => new Float64Array(p)); // dd[day][path]
  const finals = new Array(p);
  const maxDDs = new Array(p);

  for (let j = 0; j < p; j++) {
    let e = 1, peak = 1, maxDD = 0;
    for (let i = 0; i < m; i++) {
      let shock = normal();
      if (rand() < fatProb) shock *= fatScale;
      e *= 1 + drift + vol * shock;
      if (e < 0) e = 0;
      if (e > peak) peak = e;
      const d = peak > 0 ? (peak - e) / peak : 1;
      dd[i][j] = d;
      if (d > maxDD) maxDD = d;
    }
    finals[j] = e;
    maxDDs[j] = maxDD;
  }

  // Per-day drawdown quantiles (as % lines over the surface).
  const medianDD = new Array(m), p95DD = new Array(m);
  const scratch = new Float64Array(p);
  const q = (qq) => {
    const pos = (p - 1) * qq;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return lo === hi ? scratch[lo] : scratch[lo] + (scratch[hi] - scratch[lo]) * (pos - lo);
  };
  for (let i = 0; i < m; i++) {
    scratch.set(dd[i]);
    scratch.sort();
    medianDD[i] = { x: i + 1, y: q(0.5) * 100 };
    p95DD[i] = { x: i + 1, y: q(0.95) * 100 };
  }

  // Density surface: bucket (day → column, drawdown depth → row), log-scale
  // the counts so the long tail stays visible, normalize to 0..1.
  const ddMax = Math.max(0.05, quantile(maxDDs, 0.99));
  const surface = Array.from({ length: gridH }, () => new Array(gridW).fill(0));
  for (let i = 0; i < m; i++) {
    const col = Math.min(gridW - 1, Math.floor((i / m) * gridW));
    for (let j = 0; j < p; j++) {
      let row = Math.floor((dd[i][j] / ddMax) * gridH);
      if (row >= gridH) row = gridH - 1;
      surface[row][col] += 1;
    }
  }
  let zMax = 0;
  for (const row of surface) for (const v of row) { if (v > zMax) zMax = v; }
  const logMax = Math.log1p(zMax);
  for (const row of surface) {
    for (let c = 0; c < gridW; c++) row[c] = logMax > 0 ? Math.log1p(row[c]) / logMax : 0;
  }

  return {
    surface,
    ddMax,
    medianDD,
    p95DD,
    finals,
    stats: {
      medianMaxDDPct: quantile(maxDDs, 0.5) * 100,
      p95MaxDDPct: quantile(maxDDs, 0.95) * 100,
      var95Pct: (quantile(finals, 0.05) - 1) * 100,
      pDD20Pct: (maxDDs.filter((d) => d >= 0.2).length / p) * 100,
      medianTerminalPct: (quantile(finals, 0.5) - 1) * 100,
    },
  };
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
