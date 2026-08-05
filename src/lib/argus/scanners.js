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
// `invalidation` (optional) = the structural level at which the SETUP THESIS is
// wrong on a CLOSE (e.g. a breakout that closes back below the level it broke), so
// Argus can bail EARLY — before the wider hard stop — when the reason is gone. It
// defaults to `retest` (the broken level) since that's usually exactly it.
function longSetup(kind, entry, stop, strength, reason, retest, rMult = 2, invalidation = retest) {
  return { state: "triggered", kind, side: "long", entry, stop, target: entry + rMult * (entry - stop), rMult, strength, reason, retest, invalidation };
}
function shortSetup(kind, entry, stop, strength, reason, retest, rMult = 2, invalidation = retest) {
  return { state: "triggered", kind, side: "short", entry, stop, target: entry - rMult * (stop - entry), rMult, strength, reason, retest, invalidation };
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

/** Fair Value Gap (ICT) — a 3-candle imbalance (bar i-2 and bar i don't overlap,
 *  created by a strong bar i-1). Price tends to return to "rebalance" the gap; we
 *  trade the reaction when a recent, still-unfilled gap is retested and holds. */
export function fvg(candles, { lookback = 12, atrPeriod = 14, minGapAtr = 0.2 } = {}) {
  const n = candles.length;
  if (n < lookback + atrPeriod + 3) return null;
  const A = atr(candles, atrPeriod);
  if (!(A > 0)) return null;
  const c = candles[n - 1];
  for (let i = n - 2; i >= n - lookback && i >= 2; i--) {
    const a = candles[i - 2], b = candles[i];
    // Bullish FVG: gap between bar(i-2).high and bar(i).low. Long on a retest.
    if (a.high < b.low && b.low - a.high >= minGapAtr * A) {
      const gapTop = b.low, gapBot = a.high;
      const filled = candles.slice(i + 1, n - 1).some((x) => x.close < gapBot); // gap already eaten
      if (!filled && c.low <= gapTop && c.close > gapBot && c.close >= c.open) {
        const stop = Math.min(gapBot, c.low) - 0.2 * A;
        const sw = priorHigh(candles, 20);
        // Invalidation = the gap must HOLD: a close back below its bottom means the
        // imbalance failed (tighter than the wick-based stop).
        return longSetup("fvg", c.close, stop, 0.6, `Bullish FVG retest ${gapBot.toFixed(4)}–${gapTop.toFixed(4)}`, gapTop, clampR((sw - c.close) / (c.close - stop)), gapBot);
      }
    }
    // Bearish FVG: gap between bar(i-2).low and bar(i).high. Short on a retest.
    if (a.low > b.high && a.low - b.high >= minGapAtr * A) {
      const gapBot = b.high, gapTop = a.low;
      const filled = candles.slice(i + 1, n - 1).some((x) => x.close > gapTop);
      if (!filled && c.high >= gapBot && c.close < gapTop && c.close <= c.open) {
        const stop = Math.max(gapTop, c.high) + 0.2 * A;
        const sw = priorLow(candles, 20);
        return shortSetup("fvg", c.close, stop, 0.6, `Bearish FVG retest ${gapBot.toFixed(4)}–${gapTop.toFixed(4)}`, gapBot, clampR((c.close - sw) / (stop - c.close)), gapTop);
      }
    }
  }
  return null;
}

/** Inverse FVG (ICT) — a fair-value gap that PRICE CLOSED THROUGH inverts polarity:
 *  a bullish gap that fails becomes resistance (short on the retest), and vice-versa.
 *  A strong continuation signal — the level that should have held didn't. */
export function inverseFvg(candles, { lookback = 24, atrPeriod = 14, minGapAtr = 0.2 } = {}) {
  const n = candles.length;
  if (n < lookback + atrPeriod + 3) return null;
  const A = atr(candles, atrPeriod);
  if (!(A > 0)) return null;
  const c = candles[n - 1];
  for (let i = n - 3; i >= n - lookback && i >= 2; i--) {
    const a = candles[i - 2], b = candles[i];
    // Bullish FVG that later CLOSED below its bottom → now resistance → short retest.
    if (a.high < b.low && b.low - a.high >= minGapAtr * A) {
      const gapBot = a.high, gapTop = b.low;
      if (candles.slice(i + 1, n).some((x) => x.close < gapBot) && c.high >= gapBot && c.high <= gapTop * 1.002 && c.close < gapBot) {
        const stop = Math.max(gapTop, c.high) + 0.2 * A;
        const sw = priorLow(candles, 20);
        return shortSetup("ifvg", c.close, stop, 0.65, `Inverse FVG rejection ${gapBot.toFixed(4)}`, gapBot, clampR((c.close - sw) / (stop - c.close)));
      }
    }
    // Bearish FVG that later CLOSED above its top → now support → long retest.
    if (a.low > b.high && a.low - b.high >= minGapAtr * A) {
      const gapTop = a.low, gapBot = b.high;
      if (candles.slice(i + 1, n).some((x) => x.close > gapTop) && c.low <= gapTop && c.low >= gapBot * 0.998 && c.close > gapTop) {
        const stop = Math.min(gapBot, c.low) - 0.2 * A;
        const sw = priorHigh(candles, 20);
        return longSetup("ifvg", c.close, stop, 0.65, `Inverse FVG support ${gapTop.toFixed(4)}`, gapTop, clampR((sw - c.close) / (c.close - stop)));
      }
    }
  }
  return null;
}

/** Opening Range Breakout — the first bars of the session set a range; a break of it
 *  is a classic day-trade. Uses the most recent UTC-day open as the session anchor
 *  (crypto is 24h; stocks/futures use their own hours upstream). */
export function openingRange(candles, { orbBars = 6, atrPeriod = 14 } = {}) {
  const n = candles.length;
  if (n < atrPeriod + orbBars + 2) return null;
  const A = atr(candles, atrPeriod);
  if (!(A > 0)) return null;
  const day = (t) => new Date((t || 0) * 1000).getUTCDate();
  let start = -1;
  for (let i = n - 1; i > 0; i--) { if (day(candles[i].time) !== day(candles[i - 1].time)) { start = i; break; } }
  if (start < 0 || n - start < orbBars + 1) return null; // no fresh session / range not formed yet
  if (n - start > orbBars * 10) return null;             // too deep into the day — not an ORB anymore
  const range = candles.slice(start, start + orbBars);
  const orbHi = Math.max(...range.map((x) => x.high)), orbLo = Math.min(...range.map((x) => x.low));
  const c = candles[n - 1];
  if (c.close > orbHi) return longSetup("orb", c.close, Math.max(orbLo, c.close - 1.5 * A), Math.min(1, (c.close - orbHi) / A + 0.3), `Broke opening range high ${orbHi.toFixed(4)}`, orbHi, clampR(2.5));
  if (c.close < orbLo) return shortSetup("orb", c.close, Math.min(orbHi, c.close + 1.5 * A), Math.min(1, (orbLo - c.close) / A + 0.3), `Broke opening range low ${orbLo.toFixed(4)}`, orbLo, clampR(2.5));
  return null;
}

/** Liquidity sweep / stop hunt — price spikes through a recent swing to grab stops,
 *  then closes back inside. A reversal day-traders love: the breakout was a trap. */
export function liquiditySweep(candles, { n = 20, atrPeriod = 14 } = {}) {
  const len = candles.length;
  if (len < n + atrPeriod + 2) return null;
  const A = atr(candles, atrPeriod);
  if (!(A > 0)) return null;
  const c = candles[len - 1];
  const hi = priorHigh(candles, n), lo = priorLow(candles, n);
  // Bearish sweep: wicked above the prior high but closed back below → short.
  if (c.high > hi && c.close < hi && c.high - c.close > 0.3 * A) {
    const stop = c.high + 0.2 * A;
    const sw = priorLow(candles, n);
    return shortSetup("liquidity-sweep", c.close, stop, Math.min(1, (c.high - hi) / A + 0.4), `Swept ${n}-bar high ${hi.toFixed(4)} and rejected`, hi, clampR((c.close - sw) / (stop - c.close)));
  }
  // Bullish sweep: wicked below the prior low but reclaimed it → long.
  if (c.low < lo && c.close > lo && c.close - c.low > 0.3 * A) {
    const stop = c.low - 0.2 * A;
    const sw = priorHigh(candles, n);
    return longSetup("liquidity-sweep", c.close, stop, Math.min(1, (lo - c.low) / A + 0.4), `Swept ${n}-bar low ${lo.toFixed(4)} and reclaimed`, lo, clampR((sw - c.close) / (c.close - stop)));
  }
  return null;
}

/** Simple moving average of the last `p` closes. */
function sma(candles, p) {
  if (candles.length < p) return null;
  const s = candles.slice(-p);
  return s.reduce((a, c) => a + c.close, 0) / p;
}

/** Pullback in a trend — the classic high-odds CONTINUATION setup. In an up-stack
 *  (fast SMA > slow SMA) price dips back to a mid moving average and closes back up
 *  off it → join the trend; mirror for a down-stack. Invalidation = a close back
 *  through that MA (the trend structure broke). */
export function pullback(candles, { fast = 10, slow = 30, maLen = 20, atrPeriod = 14, nearAtr = 0.6 } = {}) {
  const n = candles.length;
  if (n < Math.max(slow, maLen) + atrPeriod + 2) return null;
  const A = atr(candles, atrPeriod);
  if (!(A > 0)) return null;
  const c = candles[n - 1], prev = candles[n - 2];
  const f = sma(candles, fast), s = sma(candles, slow), ma = sma(candles, maLen);
  if (f == null || s == null || ma == null) return null;
  // Uptrend: dipped to the MA (this bar or the last), then closed bullish above it.
  if (f > s && Math.min(c.low, prev.low) <= ma + nearAtr * A && c.close > ma && c.close > c.open && c.close > prev.close) {
    const stop = Math.min(c.low, ma - 0.6 * A);
    const sw = priorHigh(candles, 20);
    return longSetup("pullback", c.close, stop, 0.6, `Pullback to MA${maLen} in uptrend`, ma, clampR((sw - c.close) / (c.close - stop)));
  }
  // Downtrend: rallied to the MA, then closed bearish back below it.
  if (f < s && Math.max(c.high, prev.high) >= ma - nearAtr * A && c.close < ma && c.close < c.open && c.close < prev.close) {
    const stop = Math.max(c.high, ma + 0.6 * A);
    const sw = priorLow(candles, 20);
    return shortSetup("pullback", c.close, stop, 0.6, `Pullback to MA${maLen} in downtrend`, ma, clampR((c.close - sw) / (stop - c.close)));
  }
  return null;
}

/** Momentum / expansion — a strong, decisive thrust in the trend's direction: a big
 *  move over `roc` bars (in ATR units), an expanded body, and a close near the bar's
 *  extreme. A continuation chase, so no retest wait and no early invalidation (give
 *  it room); the ATR stop bounds the risk. */
export function momentum(candles, { roc = 10, atrPeriod = 14, bodyMult = 1.5, fast = 10, slow = 30 } = {}) {
  const n = candles.length;
  if (n < roc + atrPeriod + 22) return null;
  const A = atr(candles, atrPeriod);
  if (!(A > 0)) return null;
  const c = candles[n - 1], past = candles[n - 1 - roc];
  const thrust = (c.close - past.close) / A;                 // signed move in ATR over `roc` bars
  const body = Math.abs(c.close - c.open);
  const avgBody = candles.slice(n - 21, n - 1).reduce((a, x) => a + Math.abs(x.close - x.open), 0) / 20;
  const range = (c.high - c.low) || A;
  const closePos = (c.close - c.low) / range;                // 1 = closed at the high, 0 = at the low
  const f = sma(candles, fast), s = sma(candles, slow);
  if (f == null || s == null) return null;
  if (thrust > 2.2 && f > s && body > bodyMult * avgBody && closePos > 0.7) {
    const stop = Math.min(c.low, c.close - 1.2 * A);
    const sw = priorHigh(candles, 30);
    return longSetup("momentum", c.close, stop, Math.min(1, thrust / 4), `Momentum thrust +${thrust.toFixed(1)} ATR/${roc}b`, undefined, clampR(Math.max(2, (sw - c.close) / (c.close - stop))));
  }
  if (thrust < -2.2 && f < s && body > bodyMult * avgBody && closePos < 0.3) {
    const stop = Math.max(c.high, c.close + 1.2 * A);
    const sw = priorLow(candles, 30);
    return shortSetup("momentum", c.close, stop, Math.min(1, -thrust / 4), `Momentum thrust ${thrust.toFixed(1)} ATR/${roc}b`, undefined, clampR(Math.max(2, (c.close - sw) / (stop - c.close))));
  }
  return null;
}

export const SCANNERS = [breakout, vwapReclaim, meanReversion, fvg, inverseFvg, openingRange, liquiditySweep, pullback, momentum];

// Reversal-type setups are ALLOWED to fade the higher-timeframe bias (that's their
// whole point) — they're never tagged "counter-trend", so they don't lose conviction
// for it. Continuation setups still note alignment.
const REVERSAL_KINDS = new Set(["mean-reversion", "liquidity-sweep", "ifvg"]);

/**
 * Run all scanners on the 5m timeframe, gated by the 15m structure + 1h bias.
 * A trend setup must align with the higher-TF bias; mean-reversion may fade it.
 * @returns { triggered: setup[], forming: candidate[] }
 */
export function scan({ c5, c15, c1h }) {
  const bias = higherBias(c1h);
  // Current volatility regime (ATR as a fraction of price on the 5m), attached to
  // every setup so the agent's risk gate can size down / skip when it's extreme.
  const A5 = atr(c5, 14), lastClose = c5[c5.length - 1]?.close;
  const atrPct = A5 > 0 && lastClose > 0 ? A5 / lastClose : null;
  const triggered = [], forming = [];
  for (const fn of SCANNERS) {
    const r = fn(c5);
    if (!r) continue;
    const isRev = REVERSAL_KINDS.has(r.kind);
    // The higher-TF bias is carried, NOT used as a hard gate. A real day-trader
    // considers counter-trend signals too — so we emit every coherent setup and
    // tag whether it aligns with the 1h bias; the agent folds that into conviction
    // (lower leverage against the trend) and its learning can veto losing buckets.
    const aligned = isRev || (r.side === "long" && bias !== "down") || (r.side === "short" && bias !== "up");
    const setup = { ...r, timeframe: "5m", bias, aligned, atrPct };
    if (r.state === "triggered") triggered.push(setup);
    else forming.push(setup);
  }
  return { triggered, forming, bias };
}
