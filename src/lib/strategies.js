// strategies.js — built-in parameterized strategies for the backtester.
//
// Each entry in BUILT_IN_STRATEGIES is:
//   { id, name, description /* German */, params: [{ key, label, default, min, max, step }],
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
      "Kauft, wenn der schnelle gleitende Durchschnitt über den langsamen steigt, und verkauft beim Kreuzen nach unten.",
    params: [
      { key: "fast", label: "Schnelle Periode", default: 20, min: 2, max: 200, step: 1 },
      { key: "slow", label: "Langsame Periode", default: 50, min: 5, max: 400, step: 1 },
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
      "Wie das SMA-Crossover, nutzt aber exponentielle Durchschnitte, die schneller auf neue Kurse reagieren.",
    params: [
      { key: "fast", label: "Schnelle Periode", default: 12, min: 2, max: 200, step: 1 },
      { key: "slow", label: "Langsame Periode", default: 26, min: 5, max: 400, step: 1 },
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
      "Kauft in überverkaufte Märkte (RSI unter dem Schwellwert) und verkauft, sobald sich der RSI wieder erholt hat.",
    params: [
      { key: "period", label: "RSI-Periode", default: 14, min: 2, max: 100, step: 1 },
      { key: "oversold", label: "Überverkauft-Schwelle", default: 30, min: 5, max: 50, step: 1 },
      { key: "exitLevel", label: "Ausstiegs-Level", default: 55, min: 30, max: 90, step: 1 },
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
      "Ist investiert, solange die prozentuale Kursänderung über dem Schwellwert liegt, und geht sonst in Cash.",
    params: [
      { key: "period", label: "ROC-Periode", default: 20, min: 2, max: 200, step: 1 },
      { key: "threshold", label: "Schwellwert (%)", default: 0, min: -20, max: 20, step: 0.5 },
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
      "Kauft, wenn der Kurs unter das untere Bollinger-Band fällt, und verkauft bei Rückkehr zur Mittellinie.",
    params: [
      { key: "period", label: "Periode", default: 20, min: 5, max: 200, step: 1 },
      { key: "mult", label: "Standardabweichungen", default: 2, min: 0.5, max: 4, step: 0.1 },
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
      "Bildet aus den ersten N Balken jedes UTC-Tages eine Eröffnungs-Range und handelt den Ausbruch: Stop auf der Gegenseite der Range, Take-Profit als Vielfaches (R) der Range-Breite. Long und Short, ein Trade pro Tag. Für Intraday-Intervalle (z. B. 5m).",
    params: [
      { key: "rangeBars", label: "Range-Balken", default: 6, min: 1, max: 120, step: 1 },
      { key: "targetR", label: "Take-Profit (R)", default: 1, min: 0.25, max: 10, step: 0.25 },
      { key: "stopBufferPct", label: "Stop-Puffer (%)", default: 0, min: 0, max: 2, step: 0.05 },
      { key: "longOnly", label: "Nur Long (1/0)", default: 0, min: 0, max: 1, step: 1 },
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
      "Kauft beim Ausbruch über das Hoch der letzten N Kerzen und verkauft beim Bruch des Tiefs des Ausstiegskanals.",
    params: [
      { key: "period", label: "Eintritts-Periode", default: 20, min: 5, max: 200, step: 1 },
      { key: "exitPeriod", label: "Ausstiegs-Periode", default: 10, min: 2, max: 200, step: 1 },
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
];
