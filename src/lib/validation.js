// validation.js — the anti-overfitting pipeline: walk-forward analysis,
// Deflated Sharpe Ratio (López de Prado), and a price-noise robustness test.
// Pure functions over the existing backtest engine; all testable in Node.

import { runBacktest } from "./backtest.js";

// ── math helpers ────────────────────────────────────────────────────────────

/** Acklam's rational approximation of the inverse normal CDF. */
export function invNorm(p) {
  if (!(p > 0) || !(p < 1)) return NaN;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  let q, r;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= 1 - pl) {
    q = p - 0.5; r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

/** Standard normal CDF: Φ(x) = ½(1 + erf(x/√2)), erf via Abramowitz–Stegun 7.1.26. */
export function normCdf(x) {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + Math.sign(x) * erf);
}

function moments(returns) {
  const n = returns.length;
  const mean = returns.reduce((s, x) => s + x, 0) / n;
  let m2 = 0, m3 = 0, m4 = 0;
  for (const x of returns) {
    const d = x - mean;
    m2 += d * d; m3 += d * d * d; m4 += d * d * d * d;
  }
  m2 /= n; m3 /= n; m4 /= n;
  const sd = Math.sqrt(m2);
  return { mean, sd, skew: sd > 0 ? m3 / sd ** 3 : 0, kurt: sd > 0 ? m4 / sd ** 4 : 3 };
}

/**
 * Information Coefficient of a strategy's signal: the correlation between the
 * position it took at each bar (+1 long / −1 short, from runBacktest's `signals`)
 * and the NEXT bar's return. Measured only on ACTIVE bars — "when it's in the
 * market, does its direction actually PREDICT?". An IC near zero (or negative)
 * means the backtest edge was path-luck, not a real signal — the replication test
 * a paper-sourced strategy must pass on unseen data. Pearson; null on too few bars.
 * @returns {{ ic: number|null, n: number }}
 */
export function signalIC(candles, signals) {
  if (!Array.isArray(candles) || !Array.isArray(signals)) return { ic: null, n: 0 };
  const xs = [], ys = [];
  for (let i = 0; i < signals.length - 1; i++) {
    const s = signals[i];
    if (!s) continue;                       // only bars where it held a position
    const c0 = candles[i]?.close, c1 = candles[i + 1]?.close;
    if (!(c0 > 0) || c1 == null) continue;
    xs.push(s); ys.push(c1 / c0 - 1);
  }
  const n = xs.length;
  if (n < 20) return { ic: null, n };
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  if (sxx <= 0 || syy <= 0) return { ic: null, n };
  return { ic: sxy / Math.sqrt(sxx * syy), n };
}

/** Per-bar returns from an equity curve. */
export function equityReturns(equity) {
  const out = [];
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1].value;
    if (prev > 0) out.push(equity[i].value / prev - 1);
  }
  return out;
}

// ── Deflated Sharpe Ratio ───────────────────────────────────────────────────

/**
 * Deflated Sharpe Ratio (Bailey & López de Prado): the probability that the
 * observed Sharpe is real, after correcting for non-normal returns AND for
 * how many strategy variants were tried before this one was picked.
 *
 * @param {number[]} returns  per-bar strategy returns
 * @param {number}   nTrials  how many variants/configs were tested in total
 * @returns {null|{dsr, srHat, sr0, skew, kurt, T}}  dsr = P(true SR > 0)
 */
export function deflatedSharpe(returns, nTrials = 1) {
  const T = returns.length;
  if (T < 30) return null;
  const { mean, sd, skew, kurt } = moments(returns);
  if (!(sd > 0)) return null;
  const srHat = mean / sd; // per-bar Sharpe
  const N = Math.max(1, Math.round(nTrials));
  // Expected maximum Sharpe among N zero-skill trials (Euler–Mascheroni form),
  // using the cross-trial SR variance approximated by the estimator variance.
  const gamma = 0.5772156649;
  const srVar = (1 - skew * srHat + ((kurt - 1) / 4) * srHat * srHat) / (T - 1);
  const sr0 = N > 1
    ? Math.sqrt(Math.max(srVar, 0)) * ((1 - gamma) * invNorm(1 - 1 / N) + gamma * invNorm(1 - 1 / (N * Math.E)))
    : 0;
  const denom = Math.sqrt(Math.max(1e-12, 1 - skew * srHat + ((kurt - 1) / 4) * srHat * srHat));
  const dsr = normCdf(((srHat - sr0) * Math.sqrt(T - 1)) / denom);
  return { dsr, srHat, sr0, skew, kurt, T };
}

// ── Walk-forward analysis ───────────────────────────────────────────────────

/**
 * Build a coarse parameter grid from a builder strategy's param definitions:
 * {min, default, max} per param (deduplicated), capped at `maxCombos` combos.
 */
export function paramGrid(params, maxCombos = 48) {
  const axes = params.map((p) => {
    const vals = [...new Set([p.min, p.default, (p.min + p.max) / 2, p.max]
      .map((v) => (p.step >= 1 ? Math.round(v) : +v.toFixed(2))))];
    return { key: p.key, vals };
  });
  let combos = [{}];
  for (const ax of axes) {
    const next = [];
    for (const c of combos) for (const v of ax.vals) next.push({ ...c, [ax.key]: v });
    combos = next;
    if (combos.length > maxCombos * 4) break; // runaway guard before capping
  }
  if (combos.length > maxCombos) {
    // Thin evenly so every region of the grid stays represented.
    const step = combos.length / maxCombos;
    combos = Array.from({ length: maxCombos }, (_, i) => combos[Math.floor(i * step)]);
  }
  return combos;
}

/**
 * Walk-forward analysis for BUILDER strategies: split the data into `folds`
 * sequential windows; optimize the parameter grid on window i (by total
 * return), then test those frozen parameters on window i+1. Only the stitched
 * out-of-sample segments count.
 *
 * @returns {{ folds: Array, oosReturnPct, oosProfitFactor, oosTrades,
 *             profitableFolds, testedCombos, verdict }}
 */
export function walkForwardBuilder({ candles, strategy, folds = 5, feeBps = 10, positionPct = 100, maxCombos = 48 }) {
  const combos = paramGrid(strategy.params, maxCombos);
  const seg = Math.floor(candles.length / folds);
  if (seg < 120) return null; // too little data per fold
  const results = [];
  let equityMult = 1;
  const oosTrades = [];

  for (let f = 0; f < folds - 1; f++) {
    const train = candles.slice(f * seg, (f + 1) * seg);
    const test = candles.slice((f + 1) * seg, f + 1 === folds - 1 ? candles.length : (f + 2) * seg);
    // Optimize on train.
    let best = null;
    for (const params of combos) {
      const r = runBacktest({ candles: train, signalFn: strategy.build(params), initialCapital: 10000, feeBps, positionPct });
      if (!best || r.metrics.totalReturnPct > best.ret) best = { params, ret: r.metrics.totalReturnPct };
    }
    // Test frozen params out-of-sample.
    const oos = runBacktest({ candles: test, signalFn: strategy.build(best.params), initialCapital: 10000, feeBps, positionPct });
    equityMult *= 1 + oos.metrics.totalReturnPct / 100;
    oosTrades.push(...oos.trades);
    results.push({
      fold: f + 1,
      params: best.params,
      trainReturnPct: best.ret,
      oosReturnPct: oos.metrics.totalReturnPct,
      oosPF: oos.metrics.profitFactor,
      oosTradeCount: oos.metrics.tradeCount,
    });
  }

  const wins = oosTrades.filter((t) => t.pnl > 0);
  const gp = wins.reduce((s, t) => s + t.pnl, 0);
  const gl = oosTrades.reduce((s, t) => s + (t.pnl < 0 ? -t.pnl : 0), 0);
  const profitableFolds = results.filter((r) => r.oosReturnPct > 0).length;
  const oosReturnPct = (equityMult - 1) * 100;
  const verdict = oosReturnPct > 0 && profitableFolds >= Math.ceil(results.length / 2) ? "pass" : "fail";
  return {
    folds: results,
    oosReturnPct,
    oosProfitFactor: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0,
    oosTrades: oosTrades.length,
    profitableFolds,
    totalFolds: results.length,
    testedCombos: combos.length,
    verdict,
  };
}

/**
 * K-fold consistency for CODE strategies (no parameters to optimize): run the
 * strategy independently on each sequential fold and check it doesn't live
 * off a single lucky window.
 */
export function kFoldCode({ candles, makeSignalFn, folds = 5, feeBps = 10, positionPct = 100 }) {
  const seg = Math.floor(candles.length / folds);
  if (seg < 120) return null;
  const results = [];
  for (let f = 0; f < folds; f++) {
    const slice = candles.slice(f * seg, f === folds - 1 ? candles.length : (f + 1) * seg);
    const r = runBacktest({ candles: slice, signalFn: makeSignalFn(), initialCapital: 10000, feeBps, positionPct });
    results.push({ fold: f + 1, returnPct: r.metrics.totalReturnPct, pf: r.metrics.profitFactor, trades: r.metrics.tradeCount });
  }
  const profitable = results.filter((r) => r.returnPct > 0).length;
  return {
    folds: results,
    profitableFolds: profitable,
    totalFolds: folds,
    verdict: profitable >= Math.ceil(folds * 0.6) ? "pass" : "fail",
  };
}

// ── Price-noise robustness ─────────────────────────────────────────────────

/**
 * Re-run the strategy on `runs` noisy copies of the data: every bar's OHLC is
 * shifted by iid Gaussian noise sized in average-true-range units. A real
 * edge survives small perturbations; a curve-fit one shatters.
 */
export function noiseTest({ candles, makeSignalFn, runs = 25, noiseAtrMult = 0.25, feeBps = 10, positionPct = 100, seed = 1 }) {
  if (candles.length < 100) return null;
  let atrSum = 0;
  for (const c of candles) atrSum += c.high - c.low;
  const unit = (atrSum / candles.length) * noiseAtrMult;

  // Deterministic gaussian noise (Box–Muller over mulberry32).
  let s = seed >>> 0;
  const rand = () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => {
    const u = Math.max(rand(), 1e-12), v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };

  const base = runBacktest({ candles, signalFn: makeSignalFn(), initialCapital: 10000, feeBps, positionPct });
  const rets = [];
  for (let r = 0; r < runs; r++) {
    const noisy = candles.map((c) => {
      const e = gauss() * unit;
      return { time: c.time, open: c.open + e, high: c.high + e, low: c.low + e, close: c.close + e, volume: c.volume };
    });
    const res = runBacktest({ candles: noisy, signalFn: makeSignalFn(), initialCapital: 10000, feeBps, positionPct });
    rets.push(res.metrics.totalReturnPct);
  }
  rets.sort((a, b) => a - b);
  const q = (p) => rets[Math.min(rets.length - 1, Math.floor(p * rets.length))];
  const profitable = rets.filter((x) => x > 0).length;
  return {
    baseReturnPct: base.metrics.totalReturnPct,
    medianReturnPct: q(0.5),
    p10ReturnPct: q(0.1),
    p90ReturnPct: q(0.9),
    profitableShare: profitable / rets.length,
    runs,
    verdict: q(0.5) > 0 && profitable / rets.length >= 0.6 ? "pass" : "fail",
  };
}
