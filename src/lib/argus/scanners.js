// argus/scanners.js — deterministic intraday setup scanners (Phase 0, no LLM).
// Each scanner reads an array of candles for ONE timeframe and returns:
//   { state:"triggered", kind, side, entry, stop, target, strength, reason }
//   { state:"forming",   kind, side, trigger, reason }   (approaching, not yet)
//   null
// Stops are structural/volatility-based (swing ± ATR). The reward:risk (target) is
// NOT fixed — each scanner picks it from the situation (the measured move of the
// broken range, the distance to the next swing, the mean), so a strong setup can aim
// 4:1+ while a marginal one settles for ~1.5:1. Clamped to a sane band.
import { atr, vwap, priorHigh, priorLow } from "./core.js";

const R_MIN = 1.5, R_MAX = 5;   // reward:risk band — Argus chooses within it per setup
/** Clamp a situational reward:risk into the sane band (guards NaN/∞/negatives). */
function clampR(r) { return !(r > R_MIN) ? R_MIN : r > R_MAX ? R_MAX : r; }

// `retest` (optional) = the level that was broken/reclaimed. A momentum entry taken
// at the close is often a chase; the agent may instead wait for price to pull back
// to this level for a better fill (see tryOpen's "wait for better entry").
// `rMult` = the reward:risk this setup targets (situational, see above).
function longSetup(kind, entry, stop, strength, reason, retest, rMult = 2) {
  return { state: "triggered", kind, side: "long", entry, stop, target: entry + rMult * (entry - stop), rMult, strength, reason, retest };
}
function shortSetup(kind, entry, stop, strength, reason, retest, rMult = 2) {
  return { state: "triggered", kind, side: "short", entry, stop, target: entry - rMult * (stop - entry), rMult, strength, reason, retest };
}

/** Higher-timeframe bias from a fast/slow SMA stack. */
export function higherBias(candles, { fast = 10, slow = 30 } = {}) {
  if (candles.length < slow) return "flat";
  const sma = (p) => { const s = candles.slice(-p); return s.reduce((a, c) => a + c.close, 0) / s.length; };
  const f = sma(fast), s = sma(slow), c = candles[candles.length - 1].close;
  if (c > f && f > s) return "up";
  if (c < f && f < s) return "down";
  return "flat";
}

/** N-bar range breakout with a forming state as price approaches the edge. */
export function breakout(candles, { n = 20, atrPeriod = 14 } = {}) {
  if (candles.length < n + atrPeriod + 2) return null;
  const c = candles[candles.length - 1];
  const A = atr(candles, atrPeriod);
  if (!(A > 0)) return null;
  const hi = priorHigh(candles, n), lo = priorLow(candles, n);
  if (c.close > hi) {
    const strength = Math.min(1, (c.close - hi) / A);       // how decisively it broke
    return longSetup("breakout", c.close, Math.min(lo, c.close - 1.5 * A), strength, `Close broke ${n}-bar high ${hi.toFixed(4)}`, hi, clampR(2 + 3 * strength));
  }
  if (c.close < lo) {
    const strength = Math.min(1, (lo - c.close) / A);
    return shortSetup("breakout", c.close, Math.max(hi, c.close + 1.5 * A), strength, `Close broke ${n}-bar low ${lo.toFixed(4)}`, lo, clampR(2 + 3 * strength));
  }
  if (hi - c.close > 0 && hi - c.close < 0.35 * A) return { state: "forming", kind: "breakout", side: "long", trigger: hi, reason: `Approaching ${n}-bar high ${hi.toFixed(4)}` };
  if (c.close - lo > 0 && c.close - lo < 0.35 * A) return { state: "forming", kind: "breakout", side: "short", trigger: lo, reason: `Approaching ${n}-bar low ${lo.toFixed(4)}` };
  return null;
}

/** VWAP reclaim / loss — momentum re-entering the value area. */
export function vwapReclaim(candles, { bars = 60, atrPeriod = 14 } = {}) {
  if (candles.length < bars + 2) return null;
  const c = candles[candles.length - 1], prev = candles[candles.length - 2];
  const A = atr(candles, atrPeriod);
  if (!(A > 0)) return null;
  const V = vwap(candles, bars), Vp = vwap(candles.slice(0, -1), bars);
  if (prev.close < Vp && c.close > V) {
    const stop = Math.min(c.low, c.close - 1.2 * A);
    const sw = priorHigh(candles, 20);                       // aim for the next structure
    return longSetup("vwap-reclaim", c.close, stop, 0.6, `Reclaimed VWAP ${V.toFixed(4)}`, V, clampR((sw - c.close) / (c.close - stop)));
  }
  if (prev.close > Vp && c.close < V) {
    const stop = Math.max(c.high, c.close + 1.2 * A);
    const sw = priorLow(candles, 20);
    return shortSetup("vwap-reclaim", c.close, stop, 0.6, `Lost VWAP ${V.toFixed(4)}`, V, clampR((c.close - sw) / (stop - c.close)));
  }
  if (c.close < V && V - c.close < 0.3 * A) return { state: "forming", kind: "vwap-reclaim", side: "long", trigger: V, reason: `Testing VWAP ${V.toFixed(4)} from below` };
  if (c.close > V && c.close - V < 0.3 * A) return { state: "forming", kind: "vwap-reclaim", side: "short", trigger: V, reason: `Testing VWAP ${V.toFixed(4)} from above` };
  return null;
}

/** Mean reversion — fade a stretch far from VWAP, target the mean (only when
 *  reward to the mean is at least 1R). */
export function meanReversion(candles, { bars = 60, atrPeriod = 14, mult = 2.2 } = {}) {
  if (candles.length < bars + 2) return null;
  const c = candles[candles.length - 1];
  const A = atr(candles, atrPeriod), V = vwap(candles, bars);
  if (!(A > 0)) return null;
  const dist = (c.close - V) / A;
  if (dist <= -mult) {
    const entry = c.close, stop = entry - 1.0 * A, target = V;
    if ((target - entry) / (entry - stop) >= 1) return { state: "triggered", kind: "mean-reversion", side: "long", entry, stop, target, strength: Math.min(1, -dist / mult), reason: `Stretched ${dist.toFixed(1)} ATR below VWAP` };
  }
  if (dist >= mult) {
    const entry = c.close, stop = entry + 1.0 * A, target = V;
    if ((entry - target) / (stop - entry) >= 1) return { state: "triggered", kind: "mean-reversion", side: "short", entry, stop, target, strength: Math.min(1, dist / mult), reason: `Stretched ${dist.toFixed(1)} ATR above VWAP` };
  }
  return null;
}

export const SCANNERS = [breakout, vwapReclaim, meanReversion];

/**
 * Run all scanners on the 5m timeframe, gated by the 15m structure + 1h bias.
 * A trend setup must align with the higher-TF bias; mean-reversion may fade it.
 * @returns { triggered: setup[], forming: candidate[] }
 */
export function scan({ c5, c15, c1h }) {
  const bias = higherBias(c1h);
  const triggered = [], forming = [];
  for (const fn of SCANNERS) {
    const r = fn(c5);
    if (!r) continue;
    const isRev = r.kind === "mean-reversion";
    // The higher-TF bias is carried, NOT used as a hard gate. A real day-trader
    // considers counter-trend signals too — so we emit every coherent setup and
    // tag whether it aligns with the 1h bias; the agent folds that into conviction
    // (lower leverage against the trend) and its learning can veto losing buckets.
    const aligned = isRev || (r.side === "long" && bias !== "down") || (r.side === "short" && bias !== "up");
    const setup = { ...r, timeframe: "5m", bias, aligned };
    if (r.state === "triggered") triggered.push(setup);
    else forming.push(setup);
  }
  return { triggered, forming, bias };
}
