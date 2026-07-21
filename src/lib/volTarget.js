// volTarget.js — GARCH(1,1) volatility forecasting and vol-targeted position
// sizing. The "how much", not the "which way" (that's hmmRegime.js).
//
// Robert Engle won the 2003 Nobel for ARCH — the observation that volatility
// CLUSTERS: violent days follow violent days, so tomorrow's magnitude is
// forecastable even when tomorrow's direction is not. Bollerslev's GARCH(1,1)
// is the tool desks still use:
//
//   variance_t = omega + alpha * shock_{t-1}^2 + beta * variance_{t-1}
//
// omega is the asset's baseline, alpha the reaction to yesterday's shock, beta
// the persistence (memory). For most assets beta ≈ 0.85–0.90 — volatility is
// almost as persistent as mathematically possible, which is exactly why the
// forecast is useful.
//
// Sizing: scale the position INVERSELY to forecast volatility — small when the
// market is violent, full when it is calm. Tested (see the paper agent docs):
// on SPY this roughly HALVES the max drawdown while keeping the Sharpe, because
// it shrinks exposure right before the crashes that volatility clustering warns
// about. It trades a little return for much less risk; it is not a return
// booster.
//
// Pure module: no DOM, no fetch. Causal by construction — the forecast for bar
// t uses only shocks up to t-1.

/**
 * GARCH(1,1) one-step-ahead volatility forecast, aligned to `rets`.
 * forecast[t] is the conditional volatility for return t, using info up to t-1.
 * @param {number[]} rets  per-bar simple returns
 * @param {object} opts    { alpha=0.10, beta=0.88 }  (crypto is spikier: 0.15/0.85)
 * @returns {number[]} forecast volatility (sigma) per bar
 */
export function garchVolForecast(rets, { alpha = 0.10, beta = 0.88 } = {}) {
  const n = rets.length;
  if (n < 2) return new Array(n).fill(0);
  const lrVar = rets.reduce((a, r) => a + r * r, 0) / n; // long-run variance
  const omega = Math.max(0, (1 - alpha - beta)) * lrVar;
  const out = new Array(n);
  let v = lrVar; // running conditional variance
  for (let t = 0; t < n; t++) {
    out[t] = Math.sqrt(Math.max(v, 1e-12)); // forecast for bar t (pre-shock → causal)
    v = omega + alpha * rets[t] * rets[t] + beta * v; // update AFTER observing r_t
  }
  return out;
}

/** Simple returns from a candle array. */
function returnsOf(candles) {
  const r = [];
  for (let i = 1; i < candles.length; i++) {
    const p = candles[i - 1].close;
    if (p > 0) r.push(candles[i].close / p - 1);
  }
  return r;
}

/**
 * The vol-target position weight for the LAST bar of `candles` — causal.
 *
 * weight = target_vol / current_forecast_vol, clamped. The target defaults to a
 * recent percentile of the forecast itself, so the weight is ≈1 on average and
 * mainly DE-RISKS when volatility is elevated (the safe, drawdown-cutting mode).
 *
 * @param {Array} candles
 * @param {object} opts { alpha, beta, targetPctile=0.5, cap=2, floor=0.25, lookback=400 }
 * @returns {number} multiplier for the base position size (e.g. 0.4 → 40% of base)
 */
export function volTargetWeight(candles, { alpha, beta, targetPctile = 0.5, cap = 2, floor = 0.25, lookback = 400 } = {}) {
  const rets = returnsOf(candles);
  if (rets.length < 40) return 1; // not enough history — don't scale
  const fvol = garchVolForecast(rets, { alpha, beta });
  const current = fvol[fvol.length - 1];
  if (!(current > 0)) return 1;

  // Target = a percentile of the RECENT forecast distribution (causal — all past).
  const window = fvol.slice(-lookback).filter((v) => v > 0).sort((a, b) => a - b);
  const target = window[Math.floor(targetPctile * (window.length - 1))] || current;

  const w = target / current;
  return Math.min(cap, Math.max(floor, w));
}

/** Annualisation factor per interval — for reporting the forecast vol in %. */
const BARS_PER_YEAR = { "1m": 525600, "5m": 105120, "15m": 35040, "30m": 17520, "1h": 8760, "4h": 2190, "1d": 252, "1w": 52, "1M": 12 };

/**
 * Reporting helper: the current annualised forecast vol (%) and the sizing
 * weight, for showing the "how much" state on the Coach page.
 */
export function volTargetInfo(candles, interval = "1d", opts = {}) {
  const rets = returnsOf(candles);
  if (rets.length < 40) return { weight: 1, annVolPct: null };
  const fvol = garchVolForecast(rets, opts);
  const barsYr = BARS_PER_YEAR[interval] || 252;
  return {
    weight: +volTargetWeight(candles, opts).toFixed(2),
    annVolPct: +(fvol[fvol.length - 1] * Math.sqrt(barsYr) * 100).toFixed(1),
  };
}
