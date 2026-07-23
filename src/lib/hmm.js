// hmm.js — a Gaussian Hidden Markov Model, dependency-free, in the browser.
//
// This is the engine behind regime detection: the market's true state (bull /
// bear / choppy) is HIDDEN; all we observe is price-derived data (returns,
// volatility). An HMM infers the hidden state sequence from the observations
// and — crucially — the transition probabilities between states, so it can flag
// a regime change before it is obvious. It's the technique Baum (co-founder of
// Renaissance) built; here it's a compact, honest implementation.
//
// Emissions are Gaussian with DIAGONAL covariance (each feature independent
// given the state) — the standard, robust choice for low-dimensional financial
// features. All the forward/backward maths runs in LOG space, because a few
// hundred daily bars multiply enough small probabilities to underflow float64
// otherwise.
//
// Pure module: no DOM, no fetch. fit() is deterministic given a seed.

const LOG_2PI = Math.log(2 * Math.PI);
const VAR_FLOOR = 1e-6; // keep a state from collapsing onto a single point

// ── small deterministic PRNG (mulberry32) so fits are reproducible ──────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function logSumExp(arr) {
  let max = -Infinity;
  for (const v of arr) if (v > max) max = v;
  if (max === -Infinity) return -Infinity;
  let sum = 0;
  for (const v of arr) sum += Math.exp(v - max);
  return max + Math.log(sum);
}

// log N(x | mean, var) for a diagonal-covariance Gaussian.
function logGauss(x, mean, variance) {
  let lp = 0;
  for (let d = 0; d < x.length; d++) {
    const v = variance[d];
    const diff = x[d] - mean[d];
    lp += -0.5 * (LOG_2PI + Math.log(v) + (diff * diff) / v);
  }
  return lp;
}

// Per-timestep, per-state log emission probability matrix.
function logEmissions(X, means, vars) {
  const T = X.length, K = means.length;
  const B = Array.from({ length: T }, () => new Float64Array(K));
  for (let t = 0; t < T; t++) {
    for (let k = 0; k < K; k++) B[t][k] = logGauss(X[t], means[k], vars[k]);
  }
  return B;
}

// ── k-means++ style init so EM starts from spread-out centres ───────────────
function initMeans(X, K, rnd) {
  const T = X.length, D = X[0].length;
  const centres = [X[Math.floor(rnd() * T)].slice()];
  while (centres.length < K) {
    const d2 = new Float64Array(T);
    let sum = 0;
    for (let t = 0; t < T; t++) {
      let best = Infinity;
      for (const c of centres) {
        let dist = 0;
        for (let d = 0; d < D; d++) { const df = X[t][d] - c[d]; dist += df * df; }
        if (dist < best) best = dist;
      }
      d2[t] = best; sum += best;
    }
    let r = rnd() * sum, idx = 0;
    while (idx < T - 1 && (r -= d2[idx]) > 0) idx++;
    centres.push(X[idx].slice());
  }
  return centres;
}

/**
 * Fit a Gaussian HMM by Baum-Welch (EM).
 * @param {number[][]} X  observations, T timesteps × D features
 * @param {object} opts   { K=3, iters=50, seed=1, tol=1e-4 }
 * @returns {{K,D,startLog,transLog,means,vars,logLik,iterations}}
 */
export function fit(X, { K = 3, iters = 50, seed = 1, tol = 1e-4 } = {}) {
  const T = X.length, D = X[0].length;
  const rnd = mulberry32(seed);

  // init: k-means++ means, global variance, diagonally-biased transitions
  const means = initMeans(X, K, rnd);
  const globalVar = new Float64Array(D);
  {
    const mean = new Float64Array(D);
    for (const x of X) for (let d = 0; d < D; d++) mean[d] += x[d] / T;
    for (const x of X) for (let d = 0; d < D; d++) { const df = x[d] - mean[d]; globalVar[d] += (df * df) / T; }
  }
  const vars = Array.from({ length: K }, () => Float64Array.from(globalVar, (v) => Math.max(v, VAR_FLOOR)));
  const startLog = new Float64Array(K).fill(Math.log(1 / K));
  const transLog = Array.from({ length: K }, () => {
    const row = new Float64Array(K).fill((1 - 0.9) / (K - 1));
    return row.map(() => 0); // placeholder, filled below
  });
  for (let i = 0; i < K; i++) {
    for (let j = 0; j < K; j++) transLog[i][j] = Math.log(i === j ? 0.9 : 0.1 / (K - 1));
  }

  let prevLik = -Infinity, logLik = -Infinity, it = 0;
  for (; it < iters; it++) {
    const B = logEmissions(X, means, vars);

    // ── forward ──
    const alpha = Array.from({ length: T }, () => new Float64Array(K));
    for (let k = 0; k < K; k++) alpha[0][k] = startLog[k] + B[0][k];
    for (let t = 1; t < T; t++) {
      for (let k = 0; k < K; k++) {
        const terms = new Float64Array(K);
        for (let j = 0; j < K; j++) terms[j] = alpha[t - 1][j] + transLog[j][k];
        alpha[t][k] = logSumExp(terms) + B[t][k];
      }
    }
    logLik = logSumExp(alpha[T - 1]);

    // ── backward ──
    const beta = Array.from({ length: T }, () => new Float64Array(K));
    for (let t = T - 2; t >= 0; t--) {
      for (let k = 0; k < K; k++) {
        const terms = new Float64Array(K);
        for (let j = 0; j < K; j++) terms[j] = transLog[k][j] + B[t + 1][j] + beta[t + 1][j];
        beta[t][k] = logSumExp(terms);
      }
    }

    // ── gamma (posterior over states) ──
    const gamma = Array.from({ length: T }, () => new Float64Array(K));
    for (let t = 0; t < T; t++) {
      const terms = new Float64Array(K);
      for (let k = 0; k < K; k++) terms[k] = alpha[t][k] + beta[t][k];
      const norm = logSumExp(terms);
      for (let k = 0; k < K; k++) gamma[t][k] = Math.exp(terms[k] - norm);
    }

    // ── xi sums (expected transitions) ──
    const xiSum = Array.from({ length: K }, () => new Float64Array(K));
    for (let t = 0; t < T - 1; t++) {
      const terms = [];
      for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) {
        terms.push(alpha[t][i] + transLog[i][j] + B[t + 1][j] + beta[t + 1][j]);
      }
      const norm = logSumExp(terms);
      let p = 0;
      for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) {
        xiSum[i][j] += Math.exp(terms[p++] - norm);
      }
    }

    // ── M-step ──
    for (let k = 0; k < K; k++) startLog[k] = Math.log(Math.max(gamma[0][k], 1e-12));
    for (let i = 0; i < K; i++) {
      let denom = 0;
      for (let j = 0; j < K; j++) denom += xiSum[i][j];
      for (let j = 0; j < K; j++) transLog[i][j] = Math.log(Math.max(xiSum[i][j] / (denom || 1), 1e-12));
    }
    for (let k = 0; k < K; k++) {
      let gsum = 0;
      for (let t = 0; t < T; t++) gsum += gamma[t][k];
      gsum = gsum || 1e-12;
      const mean = new Float64Array(D);
      for (let t = 0; t < T; t++) for (let d = 0; d < D; d++) mean[d] += gamma[t][k] * X[t][d];
      for (let d = 0; d < D; d++) mean[d] /= gsum;
      const variance = new Float64Array(D);
      for (let t = 0; t < T; t++) for (let d = 0; d < D; d++) { const df = X[t][d] - mean[d]; variance[d] += gamma[t][k] * df * df; }
      for (let d = 0; d < D; d++) variance[d] = Math.max(variance[d] / gsum, VAR_FLOOR);
      means[k] = Array.from(mean);
      vars[k] = variance;
    }

    if (Math.abs(logLik - prevLik) < tol) { it++; break; }
    prevLik = logLik;
  }

  return { K, D, startLog: Array.from(startLog), transLog: transLog.map((r) => Array.from(r)), means, vars: vars.map((v) => Array.from(v)), logLik, iterations: it };
}

/** Per-timestep posterior state probabilities gamma[t][k] (forward-backward). */
export function posterior(X, model) {
  const { K, means, vars, startLog, transLog } = model;
  const T = X.length;
  const B = logEmissions(X, means, vars);
  const alpha = Array.from({ length: T }, () => new Float64Array(K));
  for (let k = 0; k < K; k++) alpha[0][k] = startLog[k] + B[0][k];
  for (let t = 1; t < T; t++) for (let k = 0; k < K; k++) {
    const terms = new Float64Array(K);
    for (let j = 0; j < K; j++) terms[j] = alpha[t - 1][j] + transLog[j][k];
    alpha[t][k] = logSumExp(terms) + B[t][k];
  }
  const beta = Array.from({ length: T }, () => new Float64Array(K));
  for (let t = T - 2; t >= 0; t--) for (let k = 0; k < K; k++) {
    const terms = new Float64Array(K);
    for (let j = 0; j < K; j++) terms[j] = transLog[k][j] + B[t + 1][j] + beta[t + 1][j];
    beta[t][k] = logSumExp(terms);
  }
  const gamma = Array.from({ length: T }, () => new Array(K));
  for (let t = 0; t < T; t++) {
    const terms = new Float64Array(K);
    for (let k = 0; k < K; k++) terms[k] = alpha[t][k] + beta[t][k];
    const norm = logSumExp(terms);
    for (let k = 0; k < K; k++) gamma[t][k] = Math.exp(terms[k] - norm);
  }
  return gamma;
}

/**
 * FILTERED posterior P(state_t | x_1..t) — forward pass only. This is what a
 * LIVE system actually knows at bar t; posterior() above is smoothed with the
 * benefit of hindsight (it has seen the future). The difference between the
 * two is the model's honest real-time lag. Also returns the one-step prior
 * and the (normalized) emission likelihood per step, so a UI can show
 * prior × likelihood = posterior.
 */
export function filtered(X, model) {
  const { K, means, vars, startLog, transLog } = model;
  const T = X.length;
  const B = logEmissions(X, means, vars);
  const trans = transLog.map((row) => row.map((v) => Math.exp(v)));
  const probs = [], priors = [], likes = [];
  let prev = null;
  for (let t = 0; t < T; t++) {
    const prior = new Array(K);
    for (let k = 0; k < K; k++) {
      if (t === 0) prior[k] = Math.exp(startLog[k]);
      else { let s = 0; for (let j = 0; j < K; j++) s += prev[j] * trans[j][k]; prior[k] = s; }
    }
    // emission likelihood, normalized across states (display + numerics)
    let maxB = -Infinity;
    for (let k = 0; k < K; k++) if (B[t][k] > maxB) maxB = B[t][k];
    const like = new Array(K);
    let sumL = 0;
    for (let k = 0; k < K; k++) { like[k] = Math.exp(B[t][k] - maxB); sumL += like[k]; }
    for (let k = 0; k < K; k++) like[k] /= sumL || 1;
    const post = new Array(K);
    let sum = 0;
    for (let k = 0; k < K; k++) { post[k] = prior[k] * like[k]; sum += post[k]; }
    for (let k = 0; k < K; k++) post[k] = sum > 0 ? post[k] / sum : 1 / K;
    priors.push(prior); likes.push(like); probs.push(post);
    prev = post;
  }
  return { probs, priors, likes };
}

/** Most likely hidden-state sequence (Viterbi), length T. */
export function viterbi(X, model) {
  const { K, means, vars, startLog, transLog } = model;
  const T = X.length;
  const B = logEmissions(X, means, vars);
  const delta = Array.from({ length: T }, () => new Float64Array(K));
  const psi = Array.from({ length: T }, () => new Int32Array(K));
  for (let k = 0; k < K; k++) delta[0][k] = startLog[k] + B[0][k];
  for (let t = 1; t < T; t++) {
    for (let k = 0; k < K; k++) {
      let best = -Infinity, arg = 0;
      for (let j = 0; j < K; j++) {
        const v = delta[t - 1][j] + transLog[j][k];
        if (v > best) { best = v; arg = j; }
      }
      delta[t][k] = best + B[t][k];
      psi[t][k] = arg;
    }
  }
  let last = 0, bestEnd = -Infinity;
  for (let k = 0; k < K; k++) if (delta[T - 1][k] > bestEnd) { bestEnd = delta[T - 1][k]; last = k; }
  const path = new Int32Array(T);
  path[T - 1] = last;
  for (let t = T - 2; t >= 0; t--) path[t] = psi[t + 1][path[t + 1]];
  return Array.from(path);
}
