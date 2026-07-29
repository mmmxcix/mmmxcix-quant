// indicators.js — pure, dependency-free technical indicators.
//
// Shared data contract:
//   candle = { time /* unix SECONDS */, open, high, low, close, volume }
//   candle arrays are ascending by time.
//
// Every function returns an array ALIGNED with its input: index i of the
// output corresponds to index i of the input. Bars that fall inside the
// indicator's warm-up window are `null`.

/**
 * Extract the close prices from a candle array.
 * @param {Array<{close:number}>} candles
 * @returns {number[]}
 */
export function closes(candles) {
  return candles.map((c) => c.close);
}

/**
 * Simple Moving Average.
 * @param {number[]} values
 * @param {number} period
 * @returns {(number|null)[]}
 */
export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;

  // Rolling-sum implementation: O(n) instead of O(n * period).
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * Exponential Moving Average, seeded with the SMA of the first `period`
 * values (the classic convention).
 * @param {number[]} values
 * @param {number} period
 * @returns {(number|null)[]}
 */
export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;

  const alpha = 2 / (period + 1);

  // Seed: SMA over the first `period` values.
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  seed /= period;
  out[period - 1] = seed;

  // Recursive EMA from there on.
  for (let i = period; i < values.length; i++) {
    out[i] = values[i] * alpha + out[i - 1] * (1 - alpha);
  }
  return out;
}

/**
 * Relative Strength Index with Wilder smoothing.
 * First value appears at index `period` (needs `period` price changes).
 * @param {number[]} values
 * @param {number} period
 * @returns {(number|null)[]}
 */
export function rsi(values, period) {
  const out = new Array(values.length).fill(null);
  if (period <= 0 || values.length <= period) return out;

  // Seed averages from the first `period` deltas.
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  // Wilder smoothing: avg = (prevAvg * (period - 1) + current) / period.
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/**
 * Rate of Change in percent: 100 * (v[i] - v[i-period]) / v[i-period].
 * @param {number[]} values
 * @param {number} period
 * @returns {(number|null)[]}
 */
export function roc(values, period) {
  const out = new Array(values.length).fill(null);
  if (period <= 0) return out;
  for (let i = period; i < values.length; i++) {
    const base = values[i - period];
    if (base === 0) continue; // avoid division by zero, leave null
    out[i] = (100 * (values[i] - base)) / base;
  }
  return out;
}

/**
 * Average True Range with Wilder smoothing.
 * TR[0] = high - low; ATR seeded as SMA of the first `period` TRs, so the
 * first ATR value appears at index `period - 1`.
 * @param {Array<{high:number, low:number, close:number}>} candles
 * @param {number} period
 * @returns {(number|null)[]}
 */
export function atr(candles, period) {
  const out = new Array(candles.length).fill(null);
  if (period <= 0 || candles.length < period) return out;

  // True range series.
  const tr = new Array(candles.length);
  tr[0] = candles[0].high - candles[0].low;
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    tr[i] = Math.max(
      c.high - c.low,
      Math.abs(c.high - prevClose),
      Math.abs(c.low - prevClose)
    );
  }

  // Seed with the simple average of the first `period` TRs.
  let seed = 0;
  for (let i = 0; i < period; i++) seed += tr[i];
  out[period - 1] = seed / period;

  // Wilder smoothing.
  for (let i = period; i < candles.length; i++) {
    out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
  }
  return out;
}

/**
 * Bollinger Bands: SMA mid line with `mult` population standard deviations.
 * @param {number[]} values
 * @param {number} period
 * @param {number} mult
 * @returns {({upper:number, mid:number, lower:number}|null)[]}
 */
export function bollinger(values, period, mult) {
  const out = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;

  // Rolling sums of x and x^2 for O(n) mean/variance.
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    sumSq += values[i] * values[i];
    if (i >= period) {
      sum -= values[i - period];
      sumSq -= values[i - period] * values[i - period];
    }
    if (i >= period - 1) {
      const mean = sum / period;
      // Population variance; clamp tiny negative float noise to zero.
      const variance = Math.max(0, sumSq / period - mean * mean);
      const dev = Math.sqrt(variance) * mult;
      out[i] = { upper: mean + dev, mid: mean, lower: mean - dev };
    }
  }
  return out;
}

/**
 * Donchian Channel over the PRIOR `period` bars, EXCLUDING the current bar
 * (so a breakout can be detected against the channel without look-ahead).
 * out[i] uses candles[i - period .. i - 1]; first value at index `period`.
 * @param {Array<{high:number, low:number}>} candles
 * @param {number} period
 * @returns {({upper:number, lower:number}|null)[]}
 */
export function donchian(candles, period) {
  const out = new Array(candles.length).fill(null);
  if (period <= 0 || candles.length <= period) return out;

  for (let i = period; i < candles.length; i++) {
    let upper = -Infinity;
    let lower = Infinity;
    for (let j = i - period; j < i; j++) {
      if (candles[j].high > upper) upper = candles[j].high;
      if (candles[j].low < lower) lower = candles[j].low;
    }
    out[i] = { upper, lower };
  }
  return out;
}

/**
 * MACD (Moving Average Convergence Divergence).
 * macd = EMA(fast) − EMA(slow); signal = EMA(macd, signalPeriod);
 * histogram = macd − signal. Returns an array aligned to `values`; entries are
 * null during warm-up, otherwise { macd, signal, hist }.
 * @param {number[]} values
 * @param {number} fast  default 12
 * @param {number} slow  default 26
 * @param {number} signalPeriod default 9
 * @returns {({macd:number, signal:number, hist:number}|null)[]}
 */
export function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
  const out = new Array(values.length).fill(null);
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);

  // MACD line where both EMAs exist.
  const macdLine = values.map((_, i) =>
    emaFast[i] === null || emaSlow[i] === null ? null : emaFast[i] - emaSlow[i]
  );

  // Signal = EMA of the (non-null) MACD line. Run the EMA over the compact
  // series, then map results back to their original indices.
  const startIdx = macdLine.findIndex((v) => v !== null);
  if (startIdx === -1) return out;
  const compact = macdLine.slice(startIdx).map((v) => v ?? 0);
  const signalCompact = ema(compact, signalPeriod);

  for (let j = 0; j < compact.length; j++) {
    const i = startIdx + j;
    const sig = signalCompact[j];
    if (sig === null) continue;
    out[i] = { macd: macdLine[i], signal: sig, hist: macdLine[i] - sig };
  }
  return out;
}

/**
 * Rolling linear-regression channel: the least-squares line fitted through the
 * last `period` values at each bar. The single line captures BOTH ideas a
 * regression carries — its slope is trend/momentum, and a price's distance from
 * it (in residual-standard-deviations, `z`) is a stretch that tends to snap back.
 *
 * At each bar i (for i >= period-1), fits y = a + b·x over x = 0..period-1
 * (x = period-1 is the current bar), and reports the line at the current bar.
 *   - value: the fitted line at the current bar (a + b·(period-1))
 *   - slope: b, in price units per bar
 *   - slopePct: slope as a fraction of the line value over the whole window
 *     (b·period / value) — a scale-free "how far the trend travels across the
 *     window", comparable across instruments and prices
 *   - resStd: population std-dev of the residuals (the channel half-width unit)
 *   - z: (current price − line) / resStd — how many channel units price sits
 *     from its own trendline (negative = below the line)
 * @param {number[]} values
 * @param {number} period
 * @returns {({value:number, slope:number, slopePct:number, resStd:number, z:number}|null)[]}
 */
export function linreg(values, period) {
  const out = new Array(values.length).fill(null);
  if (period < 2 || values.length < period) return out;
  // x = 0..period-1 is fixed each window, so its sums are constant.
  const n = period;
  const sumX = (n * (n - 1)) / 2;
  const sumXX = ((n - 1) * n * (2 * n - 1)) / 6;
  const denom = n * sumXX - sumX * sumX; // > 0 for n >= 2
  for (let i = period - 1; i < values.length; i++) {
    let sumY = 0, sumXY = 0;
    for (let k = 0; k < n; k++) {
      const y = values[i - (n - 1) + k];
      sumY += y;
      sumXY += k * y;
    }
    const b = (n * sumXY - sumX * sumY) / denom; // slope
    const a = (sumY - b * sumX) / n;             // intercept
    // Residual population variance around the fitted line.
    let ss = 0;
    for (let k = 0; k < n; k++) {
      const y = values[i - (n - 1) + k];
      const resid = y - (a + b * k);
      ss += resid * resid;
    }
    const resStd = Math.sqrt(ss / n);
    const value = a + b * (n - 1); // line at the current bar
    const price = values[i];
    out[i] = {
      value,
      slope: b,
      slopePct: value !== 0 ? (b * n) / value : 0,
      resStd,
      z: resStd > 0 ? (price - value) / resStd : 0,
    };
  }
  return out;
}
