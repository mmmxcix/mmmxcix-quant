// pairsScreen.js — rank a whole universe by whether a pair is worth trading.
//
// pairs.js answers "does THIS pair mean-revert". Running it across a universe is
// a different question, and a more dangerous one: ten symbols make 45 pairs, and
// the best-looking half-life out of 45 draws is a prize that chance hands out
// more often than cointegration does. A screener that only sorted by half-life
// would be a data-mining machine pointed at our own capital.
//
// So this one does four things a naive screener does not:
//
//   1. Tests stationarity with an **Engle–Granger ADF** t-statistic, whose
//      critical values account for β having been ESTIMATED from the same data.
//      Plain ADF values are far too generous here and would pass junk.
//   2. Charges for the **direction choice**. A↔B and B↔A are two different
//      regressions; keeping the better one is a second test, so its p-value is
//      doubled (Bonferroni within the pair) before anything else sees it.
//   3. Corrects across every pair tested with **Benjamini–Hochberg**, and reports
//      how many survivors the null alone would have produced.
//   4. Judges the half-life against a usable band and against **round-trip cost**:
//      a spread whose two-sigma swing cannot pay the fees is not an opportunity,
//      however beautifully it reverts.
//
// Pure functions — no fetching, no aliases — so Node tests and the browser run
// exactly the same code.

import { olsHedge, ouFit } from "./pairs.js";

/** Align two date→close maps onto their shared dates, oldest first. */
export function alignCloses(mapA, mapB) {
  const A = [], B = [], dates = [];
  for (const d of [...mapA.keys()].sort()) {
    const a = mapA.get(d), b = mapB.get(d);
    if (a > 0 && b > 0) { A.push(a); B.push(b); dates.push(d); }
  }
  return { A, B, dates };
}

// ── small OLS with standard errors (normal equations + Gaussian elimination) ──
function solve(M, v) {
  const n = v.length;
  const a = M.map((row, i) => [...row, v[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[piv][c])) piv = r;
    if (Math.abs(a[piv][c]) < 1e-12) return null;   // singular — caller reports "no fit"
    [a[c], a[piv]] = [a[piv], a[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = a[r][c] / a[c][c];
      for (let k = c; k <= n; k++) a[r][k] -= f * a[c][k];
    }
  }
  return a.map((row, i) => row[n] / row[i]);   // diagonal after Gauss–Jordan
}

/** OLS of y on the columns of X (intercept must be included by the caller).
 *  @returns {{beta:number[], se:number[], dof:number} | null} */
export function olsFit(X, y) {
  const n = y.length, k = X[0]?.length || 0;
  if (!k || n <= k + 1) return null;
  const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty = new Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < k; a++) {
      Xty[a] += X[i][a] * y[i];
      for (let b = 0; b < k; b++) XtX[a][b] += X[i][a] * X[i][b];
    }
  }
  const beta = solve(XtX, Xty);
  if (!beta) return null;
  let sse = 0;
  for (let i = 0; i < n; i++) {
    let p = 0;
    for (let a = 0; a < k; a++) p += X[i][a] * beta[a];
    sse += (y[i] - p) ** 2;
  }
  const dof = n - k;
  const s2 = sse / dof;
  // Standard errors need the diagonal of (X'X)⁻¹ — one solve per column.
  const se = new Array(k).fill(NaN);
  for (let c = 0; c < k; c++) {
    const e = new Array(k).fill(0); e[c] = 1;
    const col = solve(XtX, e);
    if (col) se[c] = Math.sqrt(Math.max(0, s2 * col[c]));
  }
  return { beta, se, dof };
}

/**
 * Augmented Dickey–Fuller t-statistic on a spread:
 *   Δs_t = α + γ·s_{t-1} + Σ φ_i·Δs_{t-i} + ε
 * The t-statistic of γ is the test statistic; more negative = faster reversion.
 * Lags soak up serial correlation in the residual, which otherwise makes the
 * test look far more significant than it is.
 */
export function adfTStat(spread, lags = 1) {
  const n = spread.length;
  if (n < 20 + lags) return null;
  const d = [];
  for (let i = 1; i < n; i++) d.push(spread[i] - spread[i - 1]);
  const X = [], y = [];
  for (let i = lags; i < d.length; i++) {
    const row = [1, spread[i]];               // intercept, level term s_{t-1}
    for (let L = 1; L <= lags; L++) row.push(d[i - L]);
    X.push(row); y.push(d[i]);
  }
  const fit = olsFit(X, y);
  if (!fit || !Number.isFinite(fit.se[1]) || fit.se[1] === 0) return null;
  return fit.beta[1] / fit.se[1];
}

// Engle–Granger critical values (two series, constant, no trend) at 1/5/10%:
// −3.90 / −3.34 / −3.04, with plausible anchors either side so the whole range
// maps to something. The result is an APPROXIMATE p-value — good enough to rank
// and to feed a false-discovery correction, not a published test statistic.
const EG_TABLE = [
  [-5.00, 0.0005], [-4.60, 0.001], [-3.90, 0.01], [-3.34, 0.05], [-3.04, 0.10],
  [-2.70, 0.20], [-2.35, 0.35], [-1.90, 0.55], [-1.30, 0.75], [-0.50, 0.92], [0.50, 0.99],
];

/** Approximate Engle–Granger p-value for an ADF t-statistic. */
export function egPValue(t) {
  if (!Number.isFinite(t)) return 1;
  if (t <= EG_TABLE[0][0]) return EG_TABLE[0][1];
  const last = EG_TABLE[EG_TABLE.length - 1];
  if (t >= last[0]) return last[1];
  for (let i = 1; i < EG_TABLE.length; i++) {
    const [t1, p1] = EG_TABLE[i - 1], [t2, p2] = EG_TABLE[i];
    if (t <= t2) return p1 + ((t - t1) / (t2 - t1)) * (p2 - p1);
  }
  return 1;
}

/**
 * Benjamini–Hochberg step-up. Controls the expected FRACTION of false positives
 * among the things you act on — the right control when screening hundreds of
 * candidates, where Bonferroni would leave nothing standing.
 *
 * @returns {{q:number[], survives:boolean[], threshold:number|null, expectedFalse:number}}
 * `q[i]` is the adjusted p-value of test i, monotone in p.
 */
export function benjaminiHochberg(pvalues, alpha = 0.1) {
  const m = pvalues.length;
  const q = new Array(m).fill(1), survives = new Array(m).fill(false);
  if (!m) return { q, survives, threshold: null, expectedFalse: 0 };
  const order = pvalues.map((p, i) => ({ p: Number.isFinite(p) ? p : 1, i })).sort((a, b) => a.p - b.p);
  // Step-up: the largest rank whose p ≤ (rank/m)·α, and everything below it.
  let cut = -1;
  for (let r = m - 1; r >= 0; r--) {
    if (order[r].p <= ((r + 1) / m) * alpha) { cut = r; break; }
  }
  // Adjusted p-values, enforced monotone from the largest downward.
  let running = 1;
  for (let r = m - 1; r >= 0; r--) {
    running = Math.min(running, (order[r].p * m) / (r + 1));
    q[order[r].i] = Math.min(1, running);
  }
  for (let r = 0; r <= cut; r++) survives[order[r].i] = true;
  const nSurv = survives.filter(Boolean).length;
  return {
    q, survives,
    threshold: cut >= 0 ? order[cut].p : null,
    // What the null alone would be expected to hand us at this cut-off.
    expectedFalse: +(alpha * nSurv).toFixed(2),
  };
}

/** One direction of one pair: regress A on B and describe the residual. */
function testDirection(A, B) {
  const { beta, intercept } = olsHedge(A, B);
  const spread = A.map((a, i) => a - beta * B[i] - intercept);
  const ou = ouFit(spread);
  if (!ou) return null;
  const t = adfTStat(spread, 1);
  if (t == null) return null;
  return { beta, intercept, spread, ou, adfT: t };
}

export const DEFAULT_SCREEN = {
  minOverlap: 120,      // trading days both legs must share
  halfLifeMin: 2,       // faster than this is mostly microstructure and fees
  halfLifeMax: 60,      // ~3 trading months; slower ties capital up for nothing
  alpha: 0.1,           // false-discovery rate we are willing to live with
  costPct: 0.2,         // total round-trip cost of the two legs, in percent
  minEdgeRatio: 3,      // the 2σ swing must be at least 3× the cost
};

/**
 * Screen every pair in a universe.
 *
 * @param {Record<string, Map<string, number>>} closes  symbol → (date → close)
 * @param {object} opts  see DEFAULT_SCREEN
 * @returns {{rows, tested, skipped, alpha, expectedFalse, survivors}}
 *   `rows` is sorted best-first: survivors of the FDR correction ahead of the
 *   rest, then by how much the spread pays relative to its cost.
 */
export function screenPairs(closes, opts = {}) {
  const o = { ...DEFAULT_SCREEN, ...opts };
  const symbols = Object.keys(closes);
  const raw = [], skipped = [];

  for (let i = 0; i < symbols.length; i++) {
    for (let j = i + 1; j < symbols.length; j++) {
      const a = symbols[i], b = symbols[j];
      const { A, B } = alignCloses(closes[a], closes[b]);
      if (A.length < o.minOverlap) { skipped.push({ a, b, n: A.length, why: "not enough shared history" }); continue; }
      // Both directions, then keep the better one — and pay for having looked.
      const fwd = testDirection(A, B), rev = testDirection(B, A);
      const best = !fwd ? rev : !rev ? fwd : (fwd.adfT <= rev.adfT ? fwd : rev);
      if (!best) { skipped.push({ a, b, n: A.length, why: "no usable fit" }); continue; }
      const flipped = best === rev;
      const yLeg = flipped ? b : a, xLeg = flipped ? a : b;
      const lastY = (flipped ? B : A)[A.length - 1];
      const pRaw = Math.min(1, 2 * egPValue(best.adfT)); // two directions were tried
      const halfLife = best.ou.halfLife;
      const sigmaPct = lastY > 0 ? (best.ou.sigmaEq / lastY) * 100 : 0;
      const edgeRatio = o.costPct > 0 ? (2 * sigmaPct) / o.costPct : Infinity;
      raw.push({
        a: yLeg, b: xLeg, n: A.length,
        beta: best.beta, halfLife, z: best.ou.z, mu: best.ou.mu, sigmaEq: best.ou.sigmaEq,
        spread: best.spread, adfT: best.adfT, p: pRaw,
        sigmaPct: +sigmaPct.toFixed(3), edgeRatio: +edgeRatio.toFixed(2),
        bandOk: Number.isFinite(halfLife) && halfLife >= o.halfLifeMin && halfLife <= o.halfLifeMax,
        costOk: edgeRatio >= o.minEdgeRatio,
        signal: Math.abs(best.ou.z) >= 2 ? (best.ou.z <= -2 ? "long spread" : "short spread") : "flat",
      });
    }
  }

  const bh = benjaminiHochberg(raw.map((r) => r.p), o.alpha);
  const rows = raw.map((r, i) => ({
    ...r, q: +bh.q[i].toFixed(4),
    // "Tradeable" is all three claims at once: it reverts (and survives the
    // correction), it reverts at a useful speed, and it pays for its own costs.
    stationary: bh.survives[i],
    tradeable: bh.survives[i] && r.bandOk && r.costOk,
  }));
  rows.sort((x, y) =>
    (y.tradeable - x.tradeable) || (y.stationary - x.stationary) ||
    (y.edgeRatio - x.edgeRatio) || (x.adfT - y.adfT));

  const survivors = rows.filter((r) => r.stationary).length;
  return {
    rows, skipped,
    tested: raw.length, alpha: o.alpha, survivors,
    tradeable: rows.filter((r) => r.tradeable).length,
    // The honest footnote: at this false-discovery rate, this many of the
    // survivors are expected to be noise.
    expectedFalse: bh.expectedFalse,
  };
}
