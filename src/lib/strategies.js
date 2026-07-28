// strategies.js — built-in parameterized strategies for the backtester.
//
// Each entry in BUILT_IN_STRATEGIES is:
//   { id, name, description, params: [{ key, label, default, min, max, step }],
//     build(params) => signalFn }
//
// Performance: build() returns a signalFn whose indicator arrays are computed
// lazily ONCE per candles array and cached in a WeakMap keyed by that array,
// so each per-bar call is O(1). When the candle array is replaced (new data),
// the old cache entry is garbage-collected automatically.

import * as ind from "./indicators.js";

// candlesArray -> Map(cacheKey -> precomputed indicator array)
const indicatorCache = new WeakMap();

/**
 * Get (or lazily compute) a derived array for a specific candles array.
 * @param {Array} candles  The candle array (WeakMap key).
 * @param {string} key     Unique key for this indicator + parameter combo.
 * @param {Function} compute () => array aligned with candles
 * @returns {Array}
 */
function cached(candles, key, compute) {
  let perCandles = indicatorCache.get(candles);
  if (!perCandles) {
    perCandles = new Map();
    indicatorCache.set(candles, perCandles);
  }
  if (!perCandles.has(key)) {
    perCandles.set(key, compute());
  }
  return perCandles.get(key);
}

/** Cached close-price series for a candle array. */
function cachedCloses(candles) {
  return cached(candles, "closes", () => ind.closes(candles));
}

export const BUILT_IN_STRATEGIES = [
  {
    id: "sma-crossover",
    name: "SMA Crossover",
    description:
      "Buys when the fast moving average crosses above the slow one, and sells on the cross back down.",
    params: [
      { key: "fast", label: "Fast period", default: 20, min: 2, max: 200, step: 1 },
      { key: "slow", label: "Slow period", default: 50, min: 5, max: 400, step: 1 },
    ],
    build({ fast = 20, slow = 50 } = {}) {
      return (ctx) => {
        const prices = cachedCloses(ctx.candles);
        const f = cached(ctx.candles, `sma:${fast}`, () => ind.sma(prices, fast));
        const s = cached(ctx.candles, `sma:${slow}`, () => ind.sma(prices, slow));
        if (f[ctx.index] === null || s[ctx.index] === null) return "flat";
        return f[ctx.index] > s[ctx.index] ? "long" : "flat";
      };
    },
  },

  {
    id: "ema-crossover",
    name: "EMA Crossover",
    description:
      "Like the SMA crossover, but uses exponential averages that react faster to new prices.",
    params: [
      { key: "fast", label: "Fast period", default: 12, min: 2, max: 200, step: 1 },
      { key: "slow", label: "Slow period", default: 26, min: 5, max: 400, step: 1 },
    ],
    build({ fast = 12, slow = 26 } = {}) {
      return (ctx) => {
        const prices = cachedCloses(ctx.candles);
        const f = cached(ctx.candles, `ema:${fast}`, () => ind.ema(prices, fast));
        const s = cached(ctx.candles, `ema:${slow}`, () => ind.ema(prices, slow));
        if (f[ctx.index] === null || s[ctx.index] === null) return "flat";
        return f[ctx.index] > s[ctx.index] ? "long" : "flat";
      };
    },
  },

  {
    id: "rsi-mean-reversion",
    name: "RSI Mean Reversion",
    description:
      "Buys into oversold markets (RSI below the threshold) and sells once the RSI has recovered.",
    params: [
      { key: "period", label: "RSI period", default: 14, min: 2, max: 100, step: 1 },
      { key: "oversold", label: "Oversold threshold", default: 30, min: 5, max: 50, step: 1 },
      { key: "exitLevel", label: "Exit level", default: 55, min: 30, max: 90, step: 1 },
    ],
    build({ period = 14, oversold = 30, exitLevel = 55 } = {}) {
      return (ctx) => {
        const prices = cachedCloses(ctx.candles);
        const r = cached(ctx.candles, `rsi:${period}`, () => ind.rsi(prices, period));
        const value = r[ctx.index];
        if (value === null) return "flat";
        if (ctx.position === "flat") {
          return value < oversold ? "long" : "flat";
        }
        // In position: hold until the RSI recovers above the exit level.
        return value > exitLevel ? "flat" : "long";
      };
    },
  },

  {
    id: "momentum-roc",
    name: "Momentum (ROC)",
    description:
      "Stays invested while the percentage rate of change is above the threshold, otherwise sits in cash.",
    params: [
      { key: "period", label: "ROC period", default: 20, min: 2, max: 200, step: 1 },
      { key: "threshold", label: "Threshold (%)", default: 0, min: -20, max: 20, step: 0.5 },
    ],
    build({ period = 20, threshold = 0 } = {}) {
      return (ctx) => {
        const prices = cachedCloses(ctx.candles);
        const r = cached(ctx.candles, `roc:${period}`, () => ind.roc(prices, period));
        if (r[ctx.index] === null) return "flat";
        return r[ctx.index] > threshold ? "long" : "flat";
      };
    },
  },

  {
    id: "bollinger-mean-reversion",
    name: "Bollinger Mean Reversion",
    description:
      "Buys when price drops below the lower Bollinger Band and sells on the return to the middle line.",
    params: [
      { key: "period", label: "Period", default: 20, min: 5, max: 200, step: 1 },
      { key: "mult", label: "Std deviations", default: 2, min: 0.5, max: 4, step: 0.1 },
    ],
    build({ period = 20, mult = 2 } = {}) {
      return (ctx) => {
        const prices = cachedCloses(ctx.candles);
        const bands = cached(ctx.candles, `boll:${period}:${mult}`, () =>
          ind.bollinger(prices, period, mult)
        );
        const band = bands[ctx.index];
        if (band === null) return "flat";
        if (ctx.position === "flat") {
          return ctx.close < band.lower ? "long" : "flat";
        }
        // Exit once the price has reverted back to the mid line.
        return ctx.close >= band.mid ? "flat" : "long";
      };
    },
  },

  {
    id: "opening-range-breakout",
    name: "Opening Range Breakout (Intraday)",
    description:
      "Builds an opening range from the first N bars of each UTC day and trades the breakout: stop on the far side of the range, take-profit as a multiple (R) of the range width. Long and short, one trade per day. For intraday intervals (e.g. 5m).",
    params: [
      { key: "rangeBars", label: "Range bars", default: 6, min: 1, max: 120, step: 1 },
      { key: "targetR", label: "Take-profit (R)", default: 1, min: 0.25, max: 10, step: 0.25 },
      { key: "stopBufferPct", label: "Stop buffer (%)", default: 0, min: 0, max: 2, step: 0.05 },
      { key: "longOnly", label: "Long only (1/0)", default: 0, min: 0, max: 1, step: 1 },
    ],
    build({ rangeBars = 6, targetR = 1, stopBufferPct = 0, longOnly = 0 } = {}) {
      // Per-run closure state (runBacktest calls the signalFn once per bar,
      // ascending, so accumulating across bars is safe).
      let hi = -Infinity, lo = Infinity, count = 0, traded = false;
      let side = 0, stop = 0, target = 0;
      return (ctx) => {
        if (ctx.session.isNewDay) {
          hi = -Infinity; lo = Infinity; count = 0; traded = false; side = 0;
        }
        // Phase 1: build the opening range. Returning "flat" also flattens any
        // position carried over from the previous day at the first bar's open.
        if (count < rangeBars) {
          if (ctx.high > hi) hi = ctx.high;
          if (ctx.low < lo) lo = ctx.low;
          count++;
          return "flat";
        }
        // Phase 2: hold the open trade — the engine's brackets do the exiting.
        if (ctx.position !== "flat") {
          return side === 1
            ? { signal: "long", stop, target }
            : { signal: "short", stop, target };
        }
        // Phase 3: one breakout entry per day.
        if (traded) return "flat";
        const width = hi - lo;
        if (width <= 0) return "flat";
        const buf = width * (stopBufferPct / 100);
        if (ctx.close > hi) {
          side = 1; traded = true; stop = lo - buf; target = hi + width * targetR;
          return { signal: "long", stop, target };
        }
        if (!longOnly && ctx.close < lo) {
          side = -1; traded = true; stop = hi + buf; target = lo - width * targetR;
          return { signal: "short", stop, target };
        }
        return "flat";
      };
    },
  },

  {
    id: "donchian-breakout",
    name: "Donchian Breakout",
    description:
      "Buys the breakout above the high of the last N candles and sells when the exit channel low breaks.",
    params: [
      { key: "period", label: "Entry period", default: 20, min: 5, max: 200, step: 1 },
      { key: "exitPeriod", label: "Exit period", default: 10, min: 2, max: 200, step: 1 },
    ],
    build({ period = 20, exitPeriod = 10 } = {}) {
      return (ctx) => {
        // Channels exclude the current bar, so the breakout comparison is
        // against the prior `period` bars only (no look-ahead).
        const entry = cached(ctx.candles, `don:${period}`, () =>
          ind.donchian(ctx.candles, period)
        );
        const exit = cached(ctx.candles, `don:${exitPeriod}`, () =>
          ind.donchian(ctx.candles, exitPeriod)
        );
        const e = entry[ctx.index];
        const x = exit[ctx.index];
        if (ctx.position === "flat") {
          if (e === null) return "flat";
          return ctx.close > e.upper ? "long" : "flat";
        }
        if (x === null) return "long"; // hold until the exit channel is ready
        return ctx.close < x.lower ? "flat" : "long";
      };
    },
  },

  {
    id: "asian-range-london-breakout",
    name: "Asian Range → London Breakout (Intraday FX)",
    description:
      "Builds the Asian-session range (default 00:00–08:00 UTC), then trades the breakout during the London session (up to 13:00 UTC). Markets consolidate overnight and expand into London — this fades that. Stop on the far side of the range, take-profit as a multiple (R) of the range. One trade per day, long & short. For intraday FX (e.g. EUR/USD 1h or finer).",
    params: [
      { key: "asianStart", label: "Asian start (UTC h)", default: 0, min: 0, max: 23, step: 1 },
      { key: "londonOpen", label: "London open / Asian end (UTC h)", default: 8, min: 1, max: 23, step: 1 },
      { key: "londonEnd", label: "London window end (UTC h)", default: 13, min: 2, max: 24, step: 1 },
      { key: "targetR", label: "Take-profit (R)", default: 1.5, min: 0.25, max: 10, step: 0.25 },
      { key: "longOnly", label: "Long only (1/0)", default: 0, min: 0, max: 1, step: 1 },
    ],
    build({ asianStart = 0, londonOpen = 8, londonEnd = 13, targetR = 1.5, longOnly = 0 } = {}) {
      // Per-run closure state; runBacktest calls this once per bar, ascending.
      let hi = -Infinity, lo = Infinity, haveRange = false, traded = false;
      let side = 0, stop = 0, target = 0;
      return (ctx) => {
        if (ctx.session.isNewDay) { hi = -Infinity; lo = Infinity; haveRange = false; traded = false; side = 0; }
        const h = ctx.session.hour;

        // Phase 1: accumulate the Asian range within [asianStart, londonOpen).
        const inAsian = asianStart <= londonOpen
          ? (h >= asianStart && h < londonOpen)
          : (h >= asianStart || h < londonOpen); // window wrapping midnight
        if (inAsian) {
          if (ctx.high > hi) hi = ctx.high;
          if (ctx.low < lo) lo = ctx.low;
          haveRange = hi > lo;
          return "flat";
        }

        // Phase 2: hold an open trade — the engine's brackets do the exiting.
        if (ctx.position !== "flat") {
          return side === 1 ? { signal: "long", stop, target } : { signal: "short", stop, target };
        }

        // Phase 3: one breakout entry during the London window.
        const inLondon = h >= londonOpen && h < londonEnd;
        if (!inLondon || !haveRange || traded) return "flat";
        const width = hi - lo;
        if (width <= 0) return "flat";
        if (ctx.close > hi) {
          side = 1; traded = true; stop = lo; target = hi + width * targetR;
          return { signal: "long", stop, target };
        }
        if (!longOnly && ctx.close < lo) {
          side = -1; traded = true; stop = hi; target = lo - width * targetR;
          return { signal: "short", stop, target };
        }
        return "flat";
      };
    },
  },

  {
    id: "bollinger-squeeze-breakout",
    name: "Bollinger Squeeze Breakout",
    description:
      "Waits for a volatility squeeze — Bollinger band width in the lowest percentile of recent history — then trades the breakout when price closes outside the band. Volatility contraction precedes expansion. Exits back at the mid line. Long & short.",
    params: [
      { key: "period", label: "Period", default: 20, min: 5, max: 200, step: 1 },
      { key: "mult", label: "Std deviations", default: 2, min: 0.5, max: 4, step: 0.1 },
      { key: "lookback", label: "Squeeze lookback", default: 60, min: 10, max: 300, step: 1 },
      { key: "pctile", label: "Squeeze percentile", default: 25, min: 5, max: 60, step: 1 },
      { key: "longOnly", label: "Long only (1/0)", default: 0, min: 0, max: 1, step: 1 },
    ],
    build({ period = 20, mult = 2, lookback = 60, pctile = 25, longOnly = 0 } = {}) {
      return (ctx) => {
        const prices = cachedCloses(ctx.candles);
        const bands = cached(ctx.candles, `boll:${period}:${mult}`, () =>
          ind.bollinger(prices, period, mult)
        );
        // Relative band width per bar — the squeeze/expansion signal.
        const widths = cached(ctx.candles, `bollw:${period}:${mult}`, () =>
          bands.map((b) => (b ? (b.upper - b.lower) / (b.mid || 1) : null))
        );
        const i = ctx.index;
        const b = bands[i];
        if (b === null) return "flat";

        // In a trade: exit on the reversion back through the mid line.
        if (ctx.position === "long") return ctx.close < b.mid ? "flat" : "long";
        if (ctx.position === "short") return ctx.close > b.mid ? "flat" : "short";

        // Need a full lookback of widths behind us.
        if (i < period + lookback) return "flat";
        const prevW = widths[i - 1];
        if (prevW == null) return "flat";

        // Was the bar BEFORE this breakout inside a squeeze (low-percentile width)?
        const window = [];
        for (let j = i - lookback; j < i; j++) if (widths[j] != null) window.push(widths[j]);
        if (window.length < lookback * 0.6) return "flat";
        window.sort((x, y) => x - y);
        const thresh = window[Math.floor((pctile / 100) * (window.length - 1))];
        if (prevW > thresh) return "flat"; // not squeezed

        // Squeeze confirmed → trade the breakout close outside the band.
        if (ctx.close > b.upper) return "long";
        if (!longOnly && ctx.close < b.lower) return "short";
        return "flat";
      };
    },
  },

  {
    id: "ict-silver-bullet",
    name: "ICT Silver Bullet (FVG, Intraday)",
    description:
      "During a fixed one-hour window, finds the most recent Fair Value Gap (a 3-candle price imbalance) and enters when price retraces into it — long for a bullish gap, short for a bearish one. Stop beyond the gap, take-profit as R. One trade per day. Default window 14:00–15:00 UTC (NY AM). Designed for intraday, but the FVG-retrace also validates well on daily equity indices (SPY/QQQ pass k-fold + noise + Deflated Sharpe).",
    params: [
      { key: "windowStart", label: "Window start (UTC h)", default: 14, min: 0, max: 23, step: 1 },
      { key: "windowEnd", label: "Window end (UTC h)", default: 15, min: 1, max: 24, step: 1 },
      { key: "maxGapAge", label: "Max gap age (bars)", default: 12, min: 2, max: 60, step: 1 },
      { key: "targetR", label: "Take-profit (R)", default: 2, min: 0.25, max: 10, step: 0.25 },
      { key: "longOnly", label: "Long only (1/0)", default: 0, min: 0, max: 1, step: 1 },
    ],
    build({ windowStart = 14, windowEnd = 15, maxGapAge = 12, targetR = 2, longOnly = 0 } = {}) {
      let traded = false, side = 0, stop = 0, target = 0;
      let intraday = null; // detected once from bar spacing
      return (ctx) => {
        if (ctx.session.isNewDay) { traded = false; side = 0; }

        // Hold an open trade — brackets exit.
        if (ctx.position !== "flat") {
          return side === 1 ? { signal: "long", stop, target } : { signal: "short", stop, target };
        }

        // The intraday "silver-bullet" hour only makes sense on sub-daily bars.
        // On daily/weekly data there is one bar per day, so filtering by hour is
        // meaningless — worse, it accidentally filters by the data provider's
        // DST-dependent timestamp. Detect the bar spacing once and drop the
        // window on daily+ data (trade the FVG retrace every day instead).
        if (intraday === null) {
          const c = ctx.candles, gaps = [];
          for (let k = 1; k < Math.min(c.length, 30); k++) gaps.push(c[k].time - c[k - 1].time);
          gaps.sort((a, b) => a - b);
          intraday = (gaps[gaps.length >> 1] || 86400) < 23 * 3600;
        }

        const h = ctx.session.hour;
        const inWindow = !intraday ? true
          : windowStart <= windowEnd
            ? (h >= windowStart && h < windowEnd)
            : (h >= windowStart || h < windowEnd);
        if (!inWindow || traded) return "flat";

        const c = ctx.candles;
        const i = ctx.index;
        if (i < 3) return "flat";

        // Walk back to the MOST RECENT Fair Value Gap that formed STRICTLY
        // BEFORE this bar (k ≤ i-1, so its 3 bars k-2..k are all < i). A true
        // FVG trade is a retrace: the gap forms, then a LATER bar returns into
        // it. Allowing k=i would let a gap "form and fill" on the same bar,
        // which is a momentum entry, not a retrace. A bullish FVG:
        // c[k].low > c[k-2].high, leaving zone [c[k-2].high, c[k].low].
        for (let k = i - 1; k >= Math.max(2, i - maxGapAge); k--) {
          const bull = c[k].low - c[k - 2].high;
          const bear = c[k - 2].low - c[k].high;
          if (bull <= 0 && bear <= 0) continue; // no gap at k, keep looking

          // Found the most recent gap — trade it or stand aside, then stop.
          if (bull > 0) {
            const zLow = c[k - 2].high, zHigh = c[k].low;
            // Entry when price retraces down into the gap zone.
            if (ctx.low <= zHigh && ctx.close >= zLow) {
              const risk = ctx.close - zLow;
              if (risk > 0) {
                side = 1; traded = true; stop = zLow; target = ctx.close + risk * targetR;
                return { signal: "long", stop, target };
              }
            }
          } else if (!longOnly && bear > 0) {
            const zHigh = c[k - 2].low, zLow = c[k].high;
            if (ctx.high >= zLow && ctx.close <= zHigh) {
              const risk = zHigh - ctx.close;
              if (risk > 0) {
                side = -1; traded = true; stop = zHigh; target = ctx.close - risk * targetR;
                return { signal: "short", stop, target };
              }
            }
          }
          break; // only the most recent gap is tradable
        }
        return "flat";
      };
    },
  },

  {
    id: "session-range-fade",
    name: "Session Range Fade (Intraday)",
    description:
      "Marks a session range (default 12:00–13:00 UTC, ~US pre-market), then FADES the breakout: if price breaks the range high it goes SHORT toward the low, if it breaks the low it goes LONG toward the high. Stop just beyond the break, take-profit at the opposite side. One trade per day. For intraday data. Counter-breakout — the opposite of the Asian-range strategy.",
    params: [
      { key: "rangeStart", label: "Range start (UTC h)", default: 12, min: 0, max: 23, step: 1 },
      { key: "rangeEnd", label: "Range end (UTC h)", default: 13, min: 1, max: 24, step: 1 },
      { key: "tradeEnd", label: "Trade window end (UTC h)", default: 20, min: 2, max: 24, step: 1 },
      { key: "stopBufferPct", label: "Stop buffer (% of range)", default: 10, min: 0, max: 50, step: 5 },
      { key: "longOnly", label: "Long only (1/0)", default: 0, min: 0, max: 1, step: 1 },
    ],
    build({ rangeStart = 12, rangeEnd = 13, tradeEnd = 20, stopBufferPct = 10, longOnly = 0 } = {}) {
      let hi = -Infinity, lo = Infinity, haveRange = false, traded = false;
      let side = 0, stop = 0, target = 0;
      return (ctx) => {
        if (ctx.session.isNewDay) { hi = -Infinity; lo = Infinity; haveRange = false; traded = false; side = 0; }
        const h = ctx.session.hour;

        // Phase 1: build the session range.
        const inRange = rangeStart <= rangeEnd
          ? (h >= rangeStart && h < rangeEnd)
          : (h >= rangeStart || h < rangeEnd);
        if (inRange) {
          if (ctx.high > hi) hi = ctx.high;
          if (ctx.low < lo) lo = ctx.low;
          haveRange = hi > lo;
          return "flat";
        }

        // Phase 2: hold — brackets exit (stop beyond the break, target at the far side).
        if (ctx.position !== "flat") {
          return side === 1 ? { signal: "long", stop, target } : { signal: "short", stop, target };
        }

        // Phase 3: fade the first breakout in the trade window.
        const inTrade = h >= rangeEnd && h < tradeEnd;
        if (!inTrade || !haveRange || traded) return "flat";
        const width = hi - lo;
        if (width <= 0) return "flat";
        const buf = width * (stopBufferPct / 100);
        if (ctx.close > hi && !longOnly) {
          // broke the high → fade SHORT back toward the low
          side = -1; traded = true; stop = hi + buf; target = lo;
          return { signal: "short", stop, target };
        }
        if (ctx.close < lo) {
          // broke the low → fade LONG back toward the high
          side = 1; traded = true; stop = lo - buf; target = hi;
          return { signal: "long", stop, target };
        }
        return "flat";
      };
    },
  },
  {
    id: "vwap-session-reclaim",
    name: "VWAP Session Reclaim (Intraday)",
    description:
      "The session-VWAP reclaim setup: bias from daily VWAP vs session VWAP, a sweep of the opening range, then a reclaim-and-reject of the session VWAP triggers the entry. Stop beyond the reclaim extreme, take-profit as an R-multiple (the popular version targets the 'nearest swing' — an R-multiple is the testable equivalent). One trade per day, long and short. For intraday intervals (5m/15m) on session markets; defaults are the US cash open in UTC (13:30 summer / 14:30 winter — adjust for DST).",
    params: [
      { key: "sessionStartH", label: "Session start (UTC h)", default: 13, min: 0, max: 23, step: 1 },
      { key: "sessionStartM", label: "Session start (UTC min)", default: 30, min: 0, max: 59, step: 15 },
      { key: "orMinutes", label: "Opening range (min)", default: 30, min: 5, max: 120, step: 5 },
      { key: "targetR", label: "Take-profit (R)", default: 1.5, min: 0.5, max: 5, step: 0.25 },
      { key: "longOnly", label: "Long only (1/0)", default: 0, min: 0, max: 1, step: 1 },
    ],
    build({ sessionStartH = 13, sessionStartM = 30, orMinutes = 30, targetR = 1.5, longOnly = 0 } = {}) {
      // Two anchored VWAPs, accumulated bar by bar (typical price x volume):
      // the DAILY one from the UTC day open, the SESSION one from the cash
      // open. Their relation is the bias filter; the entry is the classic
      // sweep -> reclaim -> reject sequence around the session VWAP.
      let dayPV = 0, dayV = 0, sesPV = 0, sesV = 0, inSession = false;
      let prevDayVwap = null; // yesterday's full-day VWAP — the bias fallback
      let orHi = -Infinity, orLo = Infinity;
      let sweptLow = false, sweptHigh = false, reclaimedAbove = false, reclaimedBelow = false;
      let traded = false, side = 0, stop = 0, target = 0;
      return (ctx) => {
        if (ctx.session.isNewDay) {
          if (dayV > 0) prevDayVwap = dayPV / dayV;
          dayPV = 0; dayV = 0; sesPV = 0; sesV = 0; inSession = false;
          orHi = -Infinity; orLo = Infinity;
          sweptLow = sweptHigh = reclaimedAbove = reclaimedBelow = false;
          traded = false; side = 0;
        }
        const typ = (ctx.high + ctx.low + ctx.close) / 3;
        const vol = ctx.candles[ctx.index].volume ?? 0;
        dayPV += typ * vol; dayV += vol;

        const sesStart = sessionStartH * 60 + sessionStartM;
        const m = ctx.session.minuteOfDay;
        if (m >= sesStart) {
          if (!inSession) { inSession = true; sesPV = 0; sesV = 0; } // fresh session anchor
          sesPV += typ * vol; sesV += vol;
        }
        const dailyVwap = dayV > 0 ? dayPV / dayV : null;
        const sesVwap = sesV > 0 ? sesPV / sesV : null;

        // Hold an open trade -- the engine's brackets do the exiting.
        if (ctx.position !== "flat") {
          return side === 1 ? { signal: "long", stop, target } : { signal: "short", stop, target };
        }
        if (traded || !inSession || dailyVwap == null || sesVwap == null) return "flat";

        // Opening-range build phase (first orMinutes of the session).
        if (m < sesStart + orMinutes) {
          if (ctx.high > orHi) orHi = ctx.high;
          if (ctx.low < orLo) orLo = ctx.low;
          return "flat";
        }
        if (!(orHi > -Infinity) || !(vol > 0)) return "flat";

        // Bias anchor. On 24/7 or futures data the daily VWAP (from the UTC
        // day open) genuinely differs from the session VWAP. Cash-session-only
        // data (Yahoo stocks: no premarket bars) makes the two accumulators
        // IDENTICAL — there the prior day's full VWAP is the honest stand-in
        // for "broader value vs today's session".
        const sameAnchor = Math.abs(dailyVwap - sesVwap) < ctx.close * 1e-9;
        const biasRef = sameAnchor ? prevDayVwap : dailyVwap;
        if (biasRef == null) return "flat";

        // SHORT: bias VWAP above session VWAP (seller bias), price sweeps the
        // opening-range low, retraces to CLOSE above the session VWAP, then
        // closes back below it -> short, stop above the reclaim.
        if (!longOnly && biasRef > sesVwap) {
          if (ctx.low < orLo) sweptLow = true;
          if (sweptLow && ctx.close > sesVwap) reclaimedAbove = true;
          else if (sweptLow && reclaimedAbove && ctx.close < sesVwap) {
            const risk = Math.max(ctx.high, sesVwap) - ctx.close;
            if (risk > 0) {
              traded = true; side = -1;
              stop = ctx.close + risk; target = ctx.close - risk * targetR;
              return { signal: "short", stop, target };
            }
          }
        }
        // LONG mirror: bias VWAP below session VWAP, sweep of the range high,
        // close below the session VWAP, then reclaim above it.
        if (biasRef < sesVwap) {
          if (ctx.high > orHi) sweptHigh = true;
          if (sweptHigh && ctx.close < sesVwap) reclaimedBelow = true;
          else if (sweptHigh && reclaimedBelow && ctx.close > sesVwap) {
            const risk = ctx.close - Math.min(ctx.low, sesVwap);
            if (risk > 0) {
              traded = true; side = 1;
              stop = ctx.close - risk; target = ctx.close + risk * targetR;
              return { signal: "long", stop, target };
            }
          }
        }
        return "flat";
      };
    },
  },

  {
    id: "absolute-momentum",
    name: "Absolute Momentum (Time-Series)",
    description:
      "The tradable single-asset momentum factor (Moskowitz/AQR time-series momentum): hold the asset only while its own trailing return is positive AND price is above a long trend average, otherwise stand in cash. Captures persistent trends and sidesteps the worst drawdowns. (Cross-sectional Value/Quality factors need the multi-asset engine; this is the timing version.)",
    params: [
      { key: "lookback", label: "Momentum lookback (bars)", default: 120, min: 20, max: 400, step: 5 },
      { key: "trend", label: "Trend filter SMA", default: 200, min: 20, max: 400, step: 5 },
      { key: "minRoc", label: "Min return % to hold", default: 0, min: -20, max: 20, step: 1 },
    ],
    build({ lookback = 120, trend = 200, minRoc = 0 } = {}) {
      return (ctx) => {
        const prices = cachedCloses(ctx.candles);
        const r = cached(ctx.candles, `roc:${lookback}`, () => ind.roc(prices, lookback));
        const s = cached(ctx.candles, `sma:${trend}`, () => ind.sma(prices, trend));
        const mom = r[ctx.index], ma = s[ctx.index];
        if (mom === null || ma === null) return "flat";
        // Long only when the trend is up AND absolute momentum is positive.
        return mom > minRoc && ctx.close > ma ? "long" : "flat";
      };
    },
  },

  {
    id: "low-vol-timing",
    name: "Low-Volatility Timing (Factor)",
    description:
      "The low-volatility anomaly as a timing rule: be invested only in CALM regimes — when ATR (volatility) sits below its own longer average and price is above trend — and step aside when volatility expands. Historically low-vol regimes deliver better risk-adjusted returns; this trims exposure into turbulent, drawdown-prone markets.",
    params: [
      { key: "atrPeriod", label: "ATR period", default: 14, min: 5, max: 60, step: 1 },
      { key: "volAvg", label: "Vol baseline (SMA of ATR)", default: 100, min: 20, max: 300, step: 5 },
      { key: "trend", label: "Trend filter SMA", default: 200, min: 20, max: 400, step: 5 },
    ],
    build({ atrPeriod = 14, volAvg = 100, trend = 200 } = {}) {
      return (ctx) => {
        const prices = cachedCloses(ctx.candles);
        const a = cached(ctx.candles, `atr:${atrPeriod}`, () => ind.atr(ctx.candles, atrPeriod));
        // Rolling SMA of ATR over its VALID values only — feeding the null warm-up
        // into ind.sma would poison the running sum with NaN forever.
        const aAvg = cached(ctx.candles, `atrsma:${atrPeriod}:${volAvg}`, () => {
          const out = new Array(a.length).fill(null);
          const q = []; let sum = 0;
          for (let i = 0; i < a.length; i++) {
            if (a[i] == null) continue;
            q.push(a[i]); sum += a[i];
            if (q.length > volAvg) sum -= q.shift();
            if (q.length === volAvg) out[i] = sum / volAvg;
          }
          return out;
        });
        const s = cached(ctx.candles, `sma:${trend}`, () => ind.sma(prices, trend));
        const atrNow = a[ctx.index], base = aAvg[ctx.index], ma = s[ctx.index];
        if (atrNow == null || base == null || ma == null) return "flat";
        // Calm + uptrend → invested; volatility expansion → flat.
        return atrNow < base && ctx.close > ma ? "long" : "flat";
      };
    },
  },

  {
    id: "rolling-vwap-reversion",
    name: "Rolling VWAP Reversion",
    description:
      "A swing (non-intraday) VWAP mean-reversion: buys when price is stretched a set number of ATRs BELOW the rolling volume-weighted average price (value), and exits back at the VWAP. Volume-weighting anchors 'fair value' to where real trade happened, so the fade reverts to a level the market actually defended.",
    params: [
      { key: "period", label: "VWAP window (bars)", default: 50, min: 10, max: 300, step: 5 },
      { key: "atrPeriod", label: "ATR period", default: 14, min: 5, max: 60, step: 1 },
      { key: "stretch", label: "Entry stretch (ATRs below)", default: 2, min: 0.5, max: 6, step: 0.25 },
    ],
    build({ period = 50, atrPeriod = 14, stretch = 2 } = {}) {
      return (ctx) => {
        const a = cached(ctx.candles, `atr:${atrPeriod}`, () => ind.atr(ctx.candles, atrPeriod));
        const vwap = cached(ctx.candles, `rvwap:${period}`, () => {
          const c = ctx.candles, out = new Array(c.length).fill(null);
          const typ = [], vol = [];
          let pv = 0, v = 0;
          for (let i = 0; i < c.length; i++) {
            const t = (c[i].high + c[i].low + c[i].close) / 3, u = c[i].volume ?? 0;
            typ.push(t); vol.push(u);
            pv += t * u; v += u;
            if (i >= period) { pv -= typ[i - period] * vol[i - period]; v -= vol[i - period]; }
            if (i >= period - 1 && v > 0) out[i] = pv / v;
          }
          return out;
        });
        const vw = vwap[ctx.index], atrNow = a[ctx.index];
        if (vw == null || atrNow == null || !(atrNow > 0)) return "flat";
        if (ctx.position === "flat") {
          return ctx.close < vw - stretch * atrNow ? "long" : "flat"; // stretched below value → buy
        }
        return ctx.close >= vw ? "flat" : "long"; // exit once price reverts to VWAP
      };
    },
  },

  {
    id: "turtle-breakout",
    name: "Turtle Breakout (Trend-Filtered)",
    description:
      "The classic Donchian trend-following breakout (Turtle system) with a long-trend filter: enters long on a close above the N-bar high, but only while price is above a long moving average (so it doesn't buy breakouts inside a downtrend), and exits on a close below the shorter M-bar low. Rides sustained momentum; the trend filter cuts the whipsaws pure breakouts suffer in chop.",
    params: [
      { key: "entryN", label: "Entry channel (bars)", default: 20, min: 5, max: 200, step: 1 },
      { key: "exitN", label: "Exit channel (bars)", default: 10, min: 3, max: 100, step: 1 },
      { key: "trend", label: "Trend filter SMA", default: 100, min: 20, max: 400, step: 5 },
    ],
    build({ entryN = 20, exitN = 10, trend = 100 } = {}) {
      return (ctx) => {
        const prices = cachedCloses(ctx.candles);
        const dcIn = cached(ctx.candles, `dc:${entryN}`, () => ind.donchian(ctx.candles, entryN));
        const dcOut = cached(ctx.candles, `dc:${exitN}`, () => ind.donchian(ctx.candles, exitN));
        const s = cached(ctx.candles, `sma:${trend}`, () => ind.sma(prices, trend));
        const up = dcIn[ctx.index]?.upper, lo = dcOut[ctx.index]?.lower, ma = s[ctx.index];
        if (up == null || lo == null || ma == null) return "flat";
        if (ctx.position === "flat") {
          return ctx.close > up && ctx.close > ma ? "long" : "flat"; // breakout in an uptrend
        }
        return ctx.close < lo ? "flat" : "long"; // trail out on the shorter-channel break
      };
    },
  },

  {
    id: "keltner-breakout",
    name: "Keltner Channel Breakout",
    description:
      "A volatility breakout: goes long when price closes above an EMA plus a multiple of ATR (an expansion out of the value channel), and exits back at the EMA mid-line. Because the band is ATR-scaled, the trigger self-adjusts to each market's volatility instead of a fixed distance.",
    params: [
      { key: "period", label: "EMA / ATR period", default: 20, min: 5, max: 100, step: 1 },
      { key: "mult", label: "ATR multiple", default: 1.5, min: 0.5, max: 4, step: 0.25 },
    ],
    build({ period = 20, mult = 1.5 } = {}) {
      return (ctx) => {
        const prices = cachedCloses(ctx.candles);
        const e = cached(ctx.candles, `ema:${period}`, () => ind.ema(prices, period));
        const a = cached(ctx.candles, `atr:${period}`, () => ind.atr(ctx.candles, period));
        const mid = e[ctx.index], atrNow = a[ctx.index];
        if (mid == null || atrNow == null) return "flat";
        if (ctx.position === "flat") {
          return ctx.close > mid + mult * atrNow ? "long" : "flat"; // upper-band breakout
        }
        return ctx.close < mid ? "flat" : "long"; // fall back to the mid-line → exit
      };
    },
  },

  {
    id: "connors-rsi2",
    name: "Connors RSI-2 Pullback",
    description:
      "Larry Connors' short-term mean-reversion: in a confirmed uptrend (price above a long SMA) it buys deep 2-period-RSI oversold dips and sells the bounce (price back above a short SMA, or RSI recovered). Trades the 'buy the dip in an uptrend' edge — high win-rate, short holding period.",
    params: [
      { key: "rsiPeriod", label: "RSI period", default: 2, min: 2, max: 10, step: 1 },
      { key: "oversold", label: "Oversold threshold", default: 10, min: 2, max: 30, step: 1 },
      { key: "trend", label: "Trend filter SMA", default: 200, min: 20, max: 400, step: 5 },
      { key: "exitSma", label: "Exit SMA", default: 5, min: 2, max: 50, step: 1 },
    ],
    build({ rsiPeriod = 2, oversold = 10, trend = 200, exitSma = 5 } = {}) {
      return (ctx) => {
        const prices = cachedCloses(ctx.candles);
        const r = cached(ctx.candles, `rsi:${rsiPeriod}`, () => ind.rsi(prices, rsiPeriod));
        const st = cached(ctx.candles, `sma:${trend}`, () => ind.sma(prices, trend));
        const se = cached(ctx.candles, `sma:${exitSma}`, () => ind.sma(prices, exitSma));
        const rv = r[ctx.index], maT = st[ctx.index], maE = se[ctx.index];
        if (rv == null || maT == null || maE == null) return "flat";
        if (ctx.position === "flat") {
          return ctx.close > maT && rv < oversold ? "long" : "flat"; // dip in an uptrend
        }
        return ctx.close > maE ? "flat" : "long"; // sell the bounce back above the short SMA
      };
    },
  },

  {
    id: "macd-trend",
    name: "MACD Trend Follow",
    description:
      "Trend-following on the MACD: long while the MACD line is above its signal line and the histogram is positive (momentum confirmed up), flat otherwise. A smoothed dual-EMA momentum filter that stays out of choppy, momentum-less phases.",
    params: [
      { key: "fast", label: "Fast EMA", default: 12, min: 3, max: 100, step: 1 },
      { key: "slow", label: "Slow EMA", default: 26, min: 5, max: 200, step: 1 },
      { key: "signal", label: "Signal EMA", default: 9, min: 2, max: 50, step: 1 },
    ],
    build({ fast = 12, slow = 26, signal = 9 } = {}) {
      return (ctx) => {
        const prices = cachedCloses(ctx.candles);
        const m = cached(ctx.candles, `macd:${fast}:${slow}:${signal}`, () => ind.macd(prices, fast, slow, signal));
        const v = m[ctx.index];
        if (v == null || v.macd == null || v.signal == null) return "flat";
        return v.macd > v.signal && v.hist > 0 ? "long" : "flat";
      };
    },
  },
];
