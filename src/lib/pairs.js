// pairs.js — statistical-arbitrage primitives: a Kalman-filtered dynamic hedge
// ratio and an Ornstein-Uhlenbeck fit of the resulting spread.
//
// A static hedge ratio (one OLS β over the whole window) goes stale as the
// relationship drifts. The Kalman filter treats β as a hidden state that walks
// slowly, so the spread stays centered. The spread's mean-reversion speed is
// then read off an OU fit — half-life = how many bars to close half the gap —
// which is what tells you whether a pair is *tradeable* at all.
//
// Pure functions, verified in Node identically to the browser. Educational.

/**
 * 2-state Kalman hedge ratio: observation A_t = β_t·B_t + c_t + noise, with
 * [β, c] a slow random walk. Returns the β/intercept path and the innovation
 * (the live spread) with its standardized z-score.
 * @param {number[]} A  dependent price series
 * @param {number[]} B  independent price series (same length as A)
 * @param {number} delta  process-noise knob (smaller = stiffer β). 1e-4 default.
 */
export function kalmanHedge(A, B, delta = 1e-4) {
  const n = Math.min(A.length, B.length);
  if (n < 30) return null;
  let beta = [0, 0];            // [hedge ratio, intercept]
  let P = [[1, 0], [0, 1]];     // state covariance
  const Vw = delta / (1 - delta); // process noise scale
  // Measurement noise ≈ variance of A's returns × recent price² (rough, stable).
  let R = 1e-3 * (A[n - 1] * A[n - 1]);
  const betaSeries = [], spread = [], zseries = [];

  for (let t = 0; t < n; t++) {
    const H = [B[t], 1];
    // Predict: β random-walks, so add process noise to the diagonal.
    P = [[P[0][0] + Vw, P[0][1]], [P[1][0], P[1][1] + Vw]];
    // Innovation
    const yhat = H[0] * beta[0] + H[1] * beta[1];
    const e = A[t] - yhat;
    // S = H P H' + R
    const PHt = [P[0][0] * H[0] + P[0][1] * H[1], P[1][0] * H[0] + P[1][1] * H[1]];
    const S = H[0] * PHt[0] + H[1] * PHt[1] + R;
    // Kalman gain K = P H' / S
    const K = [PHt[0] / S, PHt[1] / S];
    // Update state + covariance
    beta = [beta[0] + K[0] * e, beta[1] + K[1] * e];
    P = [
      [P[0][0] - K[0] * PHt[0], P[0][1] - K[0] * PHt[1]],
      [P[1][0] - K[1] * PHt[0], P[1][1] - K[1] * PHt[1]],
    ];
    betaSeries.push(beta[0]);
    spread.push(e);
    zseries.push(e / Math.sqrt(S));
  }
  // Warm-up: the first ~20 innovations are dominated by the diffuse prior.
  const warm = Math.min(20, Math.floor(n / 5));
  return {
    beta: beta[0], intercept: beta[1],
    betaSeries, spread,
    z: zseries[n - 1],
    spreadStable: spread.slice(warm),
  };
}

/** Ordinary least squares hedge ratio: A ≈ β·B + c over the whole window.
 *  Unbiased and stable — the honest "how much B per unit A" number. */
export function olsHedge(A, B) {
  const n = Math.min(A.length, B.length);
  const mA = A.reduce((s, v) => s + v, 0) / n;
  const mB = B.reduce((s, v) => s + v, 0) / n;
  let sBB = 0, sBA = 0;
  for (let i = 0; i < n; i++) { sBB += (B[i] - mB) ** 2; sBA += (B[i] - mB) * (A[i] - mA); }
  const beta = sBB > 0 ? sBA / sBB : 0;
  return { beta, intercept: mA - beta * mB };
}

/**
 * OU fit of a spread via the AR(1) discretization S_{t+1}=a+b·S_t+ε.
 * @returns {{halfLife, mu, theta, sigmaEq, z}} — halfLife in bars (Infinity if
 *   not mean-reverting), z = standardized distance of the last spread from μ.
 */
export function ouFit(spread) {
  const n = spread.length;
  if (n < 30) return null;
  const x = spread.slice(0, -1), y = spread.slice(1);
  const m = x.length;
  const mx = x.reduce((s, v) => s + v, 0) / m;
  const my = y.reduce((s, v) => s + v, 0) / m;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < m; i++) { sxx += (x[i] - mx) ** 2; sxy += (x[i] - mx) * (y[i] - my); }
  const b = sxx > 0 ? sxy / sxx : 1;
  const a = my - b * mx;
  // Residual variance of the AR(1) fit.
  let sse = 0;
  for (let i = 0; i < m; i++) { const r = y[i] - (a + b * x[i]); sse += r * r; }
  const sigmaAr = Math.sqrt(sse / Math.max(1, m - 2));

  const meanReverting = b > 0 && b < 1;
  const theta = meanReverting ? -Math.log(b) : 0;
  const halfLife = meanReverting ? Math.log(2) / theta : Infinity;
  const mu = Math.abs(1 - b) > 1e-9 ? a / (1 - b) : mx;
  // Equilibrium std of the OU process.
  const sigmaEq = meanReverting ? sigmaAr / Math.sqrt(1 - b * b) : sigmaAr;
  const last = spread[n - 1];
  const z = sigmaEq > 0 ? (last - mu) / sigmaEq : 0;
  return { halfLife, mu, theta, sigmaEq, z, b };
}

/**
 * Full pairs analysis from two aligned close-price series.
 * @returns {{beta, halfLife, z, signal, spread, betaSeries, mu, sigmaEq}}
 *   signal: "long spread" (buy A / sell β·B) · "short spread" · "flat"
 */
export function analyzePair(A, B) {
  const n = Math.min(A.length, B.length);
  if (n < 60) return null;
  // OLS gives the stable, unbiased hedge ratio (the Kalman confounds β with the
  // price level). Mean reversion is tested on the FIXED-β residual spread_t =
  // A_t − β·B_t − c: stationary only if the pair really cointegrates; for two
  // unrelated random walks this is itself a random walk (half-life → ∞), which
  // correctly rejects the pair. The Kalman β path is kept only to show drift.
  const { beta, intercept } = olsHedge(A, B);
  const spread = [];
  for (let t = 0; t < n; t++) spread.push(A[t] - beta * B[t] - intercept);
  const ou = ouFit(spread);
  if (!ou) return null;
  const k = kalmanHedge(A, B);
  const z = ou.z;
  const tradeable = Number.isFinite(ou.halfLife) && ou.halfLife <= 60; // ~3 trading months
  let signal = "flat";
  if (tradeable) {
    if (z <= -2) signal = "long spread";       // spread cheap → buy A, sell β·B
    else if (z >= 2) signal = "short spread";  // spread rich → sell A, buy β·B
  }
  return {
    beta, intercept,
    halfLife: ou.halfLife, mu: ou.mu, sigmaEq: ou.sigmaEq,
    z, signal, tradeable,
    spread, betaSeries: k ? k.betaSeries : null,
  };
}
