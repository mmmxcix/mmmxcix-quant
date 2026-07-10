// autoAnnotate.js — pure detection functions that turn a candle array into
// chart annotations: swing pivots, support/resistance levels, trendlines,
// fair value gaps (with fill tracking), an automatic Fibonacci swing, and
// double-top/bottom patterns. Rendering happens in AutoAnnotateLayer; all
// functions here are deterministic and side-effect free so they can be tested
// in Node.

/** Mean high-low range — the tolerance unit all detectors scale with. */
function avgRange(candles) {
  if (!candles.length) return 0;
  let s = 0;
  for (const c of candles) s += c.high - c.low;
  return s / candles.length;
}

/**
 * Fractal swing pivots: a swing high is a bar whose high is the maximum of the
 * ±lookback window (lows symmetric). The last `lookback` bars can't confirm.
 * @returns {{ highs: {index,time,price}[], lows: {index,time,price}[] }}
 */
export function findPivots(candles, lookback = 5) {
  const highs = [], lows = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    let isH = true, isL = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high > candles[i].high) isH = false;
      if (candles[j].low < candles[i].low) isL = false;
      if (!isH && !isL) break;
    }
    if (isH) highs.push({ index: i, time: candles[i].time, price: candles[i].high });
    if (isL) lows.push({ index: i, time: candles[i].time, price: candles[i].low });
  }
  return { highs, lows };
}

/**
 * Support/resistance levels: cluster pivot prices, keep the strongest.
 * Strength = number of touches, tie-broken by recency.
 * @returns {{ price, touches, kind: "support"|"resistance", lastIndex }[]}
 */
export function detectLevels(candles, { lookback = 5, maxLevels = 6 } = {}) {
  if (candles.length < lookback * 2 + 2) return [];
  const { highs, lows } = findPivots(candles, lookback);
  const pivots = [...highs, ...lows].sort((a, b) => a.price - b.price);
  if (!pivots.length) return [];

  const tol = avgRange(candles) * 1.2;
  const clusters = [];
  let cur = [pivots[0]];
  for (let i = 1; i < pivots.length; i++) {
    if (pivots[i].price - cur[cur.length - 1].price <= tol) cur.push(pivots[i]);
    else { clusters.push(cur); cur = [pivots[i]]; }
  }
  clusters.push(cur);

  const lastClose = candles[candles.length - 1].close;
  const n = candles.length;
  return clusters
    .filter((c) => c.length >= 2)
    .map((c) => {
      const price = c.reduce((s, p) => s + p.price, 0) / c.length;
      const lastIndex = Math.max(...c.map((p) => p.index));
      return {
        price,
        touches: c.length,
        lastIndex,
        kind: price >= lastClose ? "resistance" : "support",
        score: c.length * 2 + lastIndex / n,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, maxLevels);
}

// Price of the line through (i1,p1)-(i2,p2) at bar index i (index space keeps
// weekend gaps from bending time-based slopes).
const lineAt = (a, b, i) => a.price + ((b.price - a.price) / (b.index - a.index)) * (i - a.index);

/**
 * Trendlines from the two most recent swing points: an ascending support line
 * through rising swing lows, and/or a descending resistance line through
 * falling swing highs. Lines that recent closes already crossed hard are
 * discarded (the trend they described is broken).
 * @returns {{ kind:"up"|"down", p1:{time,price}, p2:{time,price} }[]}  p2 is projected to the last bar.
 */
export function detectTrendlines(candles, { lookback = 5 } = {}) {
  if (candles.length < lookback * 4) return [];
  const { highs, lows } = findPivots(candles, lookback);
  const lastIdx = candles.length - 1;
  const tol = avgRange(candles);
  const out = [];

  const tryLine = (pivs, kind) => {
    if (pivs.length < 2) return;
    const a = pivs[pivs.length - 2];
    const b = pivs[pivs.length - 1];
    if (kind === "up" && !(b.price > a.price)) return;
    if (kind === "down" && !(b.price < a.price)) return;
    // Reject if price has already broken the line meaningfully after pivot b.
    for (let i = b.index + 1; i <= lastIdx; i++) {
      const lp = lineAt(a, b, i);
      if (kind === "up" && candles[i].close < lp - tol) return;
      if (kind === "down" && candles[i].close > lp + tol) return;
    }
    out.push({
      kind,
      p1: { time: a.time, price: a.price },
      p2: { time: candles[lastIdx].time, price: lineAt(a, b, lastIdx) },
      anchor: { time: b.time, price: b.price },
    });
  };

  tryLine(lows, "up");
  tryLine(highs, "down");
  return out;
}

/**
 * Fair value gaps — strict 3-candle imbalances. Bullish: candle[i].low sits
 * above candle[i-2].high; the zone is EXACTLY that gap, frozen at formation
 * (later candles never resize it, so the box always matches the three candles
 * that created it). Forward tracking only classifies:
 *   - fully traded through (price reached the far edge) → gap removed,
 *   - touched but not filled → kept, flagged `tested` (drawn fainter).
 * The still-forming last candle can't create a gap (it could still un-form).
 * Only gaps from the recent `window` of bars compete for the maxCount slots —
 * without that, ancient unfilled gaps far from the current price hog every
 * slot and starve the gaps the user is actually looking at.
 * @returns {{ kind:"bull"|"bear", top, bottom, fromTime, index, tested }[]}
 */
export function detectFVGs(candles, { maxCount = 12, minMult = 0.1, window = 400 } = {}) {
  const n = candles.length;
  if (n < 4) return [];
  const unit = avgRange(candles);
  const start = Math.max(2, n - window);
  const raw = [];
  for (let i = start; i < n - 1; i++) {
    const a = candles[i - 2], c = candles[i];
    if (c.low > a.high && c.low - a.high >= unit * minMult) {
      raw.push({ kind: "bull", top: c.low, bottom: a.high, fromTime: candles[i - 1].time, index: i });
    } else if (a.low > c.high && a.low - c.high >= unit * minMult) {
      raw.push({ kind: "bear", top: a.low, bottom: c.high, fromTime: candles[i - 1].time, index: i });
    }
  }

  const active = [];
  for (const g of raw) {
    let filled = false;
    let tested = false;
    for (let j = g.index + 1; j < n; j++) {
      if (g.kind === "bull") {
        if (candles[j].low <= g.bottom) { filled = true; break; }
        if (candles[j].low < g.top) tested = true;
      } else {
        if (candles[j].high >= g.top) { filled = true; break; }
        if (candles[j].high > g.bottom) tested = true;
      }
    }
    if (!filled) active.push({ ...g, tested });
  }
  return active.slice(-maxCount);
}

/**
 * The dominant swing for an automatic Fibonacci retracement: lowest low and
 * highest high of the window; direction = whichever extreme came second.
 * @returns {{ p1:{time,price}, p2:{time,price} } | null}  p1 = swing start, p2 = swing end.
 */
export function autoFibSwing(candles, { window = 250 } = {}) {
  if (candles.length < 10) return null;
  const slice = candles.slice(-window);
  let iLo = 0, iHi = 0;
  for (let i = 1; i < slice.length; i++) {
    if (slice[i].low < slice[iLo].low) iLo = i;
    if (slice[i].high > slice[iHi].high) iHi = i;
  }
  if (iLo === iHi) return null;
  const lo = { time: slice[iLo].time, price: slice[iLo].low };
  const hi = { time: slice[iHi].time, price: slice[iHi].high };
  // Low first → uptrend swing (retracement measured off the rally), else down.
  return iLo < iHi ? { p1: lo, p2: hi } : { p1: hi, p2: lo };
}

/**
 * Double top / double bottom on the most recent pivots: two swing highs within
 * tolerance of each other, separated by a meaningful valley (the neckline).
 * @returns {{ type:"double-top"|"double-bottom", a, b, neckline }[]}
 */
export function detectDoublePatterns(candles, { lookback = 5 } = {}) {
  if (candles.length < lookback * 4) return [];
  const { highs, lows } = findPivots(candles, lookback);
  const tol = avgRange(candles) * 1.2;
  const out = [];

  if (highs.length >= 2) {
    const a = highs[highs.length - 2], b = highs[highs.length - 1];
    if (Math.abs(a.price - b.price) <= tol && b.index - a.index >= 4) {
      let valley = Infinity;
      for (let i = a.index; i <= b.index; i++) valley = Math.min(valley, candles[i].low);
      if (Math.min(a.price, b.price) - valley >= tol * 1.5) {
        out.push({ type: "double-top", a, b, neckline: valley });
      }
    }
  }
  if (lows.length >= 2) {
    const a = lows[lows.length - 2], b = lows[lows.length - 1];
    if (Math.abs(a.price - b.price) <= tol && b.index - a.index >= 4) {
      let peak = -Infinity;
      for (let i = a.index; i <= b.index; i++) peak = Math.max(peak, candles[i].high);
      if (peak - Math.max(a.price, b.price) >= tol * 1.5) {
        out.push({ type: "double-bottom", a, b, neckline: peak });
      }
    }
  }
  return out;
}
