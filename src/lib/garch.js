// garch.js — GARCH(1,1) conditional-volatility estimation, plain JS.
//
// Volatility clusters: calm follows calm, storms follow storms. A single
// realized-vol number can't see that; GARCH(1,1) models today's variance as
//   σ²_t = ω + α·ε²_{t-1} + β·σ²_{t-1}
// so it reacts to the last shock (α) while remembering the recent regime (β).
// Persistence α+β near 1 means shocks fade slowly. We fit by variance
// targeting (ω pinned to the sample variance) + a small grid search over
// (α, β) maximizing the Gaussian log-likelihood — no external optimizer, so
// it runs identically in the browser and in a Node unit test.

const TRADING_DAYS = 252;

function logLik(eps2, alpha, beta, uncondVar) {
  const omega = (1 - alpha - beta) * uncondVar;
  let s2 = uncondVar; // seed with the unconditional variance
  let ll = 0;
  for (let i = 0; i < eps2.length; i++) {
    s2 = omega + alpha * (i > 0 ? eps2[i - 1] : uncondVar) + beta * s2;
    if (s2 <= 1e-14) return -Infinity;
    ll += -0.5 * (Math.log(s2) + eps2[i] / s2);
  }
  return ll;
}

/**
 * Fit GARCH(1,1) to a return series.
 * @param {number[]} returns  simple or log returns
 * @returns {null | {omega, alpha, beta, persistence, uncondVol, currentVol,
 *   fwd1, fwd10, logLik}}   vols are ANNUALIZED (%); fwdN = annualized vol
 *   implied by the N-day-ahead variance path. null if too little data.
 */
export function garchFit(returns) {
  const r = returns.filter((x) => Number.isFinite(x));
  if (r.length < 100) return null;
  const mu = r.reduce((a, b) => a + b, 0) / r.length;
  const eps2 = r.map((x) => (x - mu) ** 2);
  const uncondVar = eps2.reduce((a, b) => a + b, 0) / eps2.length;
  if (uncondVar <= 0) return null;

  // Coarse grid over (α, β), then one refinement pass around the best cell.
  let best = { alpha: 0.05, beta: 0.9, ll: -Infinity };
  const scan = (as, bs) => {
    for (const alpha of as) for (const beta of bs) {
      if (alpha + beta >= 0.999 || alpha <= 0 || beta <= 0) continue;
      const ll = logLik(eps2, alpha, beta, uncondVar);
      if (ll > best.ll) best = { alpha, beta, ll };
    }
  };
  const lin = (lo, hi, n) => Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1));
  scan(lin(0.01, 0.30, 30), lin(0.50, 0.98, 30));
  const da = 0.02, db = 0.03;
  scan(lin(Math.max(0.001, best.alpha - da), best.alpha + da, 15),
       lin(Math.max(0.5, best.beta - db), Math.min(0.995, best.beta + db), 15));

  const { alpha, beta } = best;
  const omega = (1 - alpha - beta) * uncondVar;

  // Replay to get the latest conditional variance σ²_{t}.
  let s2 = uncondVar;
  for (let i = 0; i < eps2.length; i++) {
    s2 = omega + alpha * (i > 0 ? eps2[i - 1] : uncondVar) + beta * s2;
  }

  // h-step-ahead variance: σ²_{t+h} = V + (α+β)^h (σ²_{t+1} − V).
  const persistence = alpha + beta;
  const s2Next = omega + alpha * eps2[eps2.length - 1] + beta * s2;
  const fwdVar = (h) => {
    let cum = 0;
    for (let k = 1; k <= h; k++) cum += uncondVar + Math.pow(persistence, k - 1) * (s2Next - uncondVar);
    return cum / h; // average per-day variance over the horizon
  };
  const ann = (v) => Math.sqrt(v * TRADING_DAYS) * 100;

  return {
    omega, alpha, beta, persistence,
    uncondVol: ann(uncondVar),
    currentVol: ann(s2),
    fwd1: ann(s2Next),
    fwd10: ann(fwdVar(10)),
    logLik: best.ll,
  };
}
