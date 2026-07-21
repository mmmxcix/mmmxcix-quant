// strategyCode.js — turn any strategy that lands in the agent into copyable,
// standalone `strategy(ctx)` source.
//
// Two kinds of program run in the paper agent:
//   • code mode    — AI-generated from a paper/video (already a code string)
//   • builder mode — a parameterised built-in (only an id + params, no text)
//
// For builder strategies we synthesise a self-contained source with the params
// baked in. That source is VERIFIED to reproduce the built-in exactly (see the
// fidelity test), so what you copy is what the agent actually trades — never a
// look-alike that drifts from the real logic.
//
// Every generated source is dependency-free: it uses only ctx and ctx.indicators
// and defines `strategy(ctx)`, so it drops straight into the backtester, the AI
// generator's repair channel, or your own tooling.

const P = (params, key, dflt) => {
  const v = params?.[key];
  return v === undefined || v === null || v === "" ? dflt : v;
};

// ── per-built-in standalone source templates ────────────────────────────────
// Each returns a complete `strategy(ctx)` matching src/lib/strategies.js.
const BUILTIN_SOURCE = {
  "sma-crossover": (p) => {
    const fast = P(p, "fast", 20), slow = P(p, "slow", 50);
    return `// SMA Crossover — long while the fast SMA is above the slow SMA.
const FAST = ${fast}, SLOW = ${slow};
let _c = null, _f = null, _s = null;
function strategy(ctx) {
  if (_c !== ctx.candles) { _c = ctx.candles; const px = ctx.indicators.closes(ctx.candles);
    _f = ctx.indicators.sma(px, FAST); _s = ctx.indicators.sma(px, SLOW); }
  const i = ctx.index;
  if (_f[i] == null || _s[i] == null) return "flat";
  return _f[i] > _s[i] ? "long" : "flat";
}`;
  },
  "ema-crossover": (p) => {
    const fast = P(p, "fast", 12), slow = P(p, "slow", 26);
    return `// EMA Crossover — long while the fast EMA is above the slow EMA.
const FAST = ${fast}, SLOW = ${slow};
let _c = null, _f = null, _s = null;
function strategy(ctx) {
  if (_c !== ctx.candles) { _c = ctx.candles; const px = ctx.indicators.closes(ctx.candles);
    _f = ctx.indicators.ema(px, FAST); _s = ctx.indicators.ema(px, SLOW); }
  const i = ctx.index;
  if (_f[i] == null || _s[i] == null) return "flat";
  return _f[i] > _s[i] ? "long" : "flat";
}`;
  },
  "rsi-mean-reversion": (p) => {
    const period = P(p, "period", 14), oversold = P(p, "oversold", 30), exitLevel = P(p, "exitLevel", 55);
    return `// RSI Mean Reversion — buy oversold, exit once RSI recovers.
const PERIOD = ${period}, OVERSOLD = ${oversold}, EXIT = ${exitLevel};
let _c = null, _r = null;
function strategy(ctx) {
  if (_c !== ctx.candles) { _c = ctx.candles; _r = ctx.indicators.rsi(ctx.indicators.closes(ctx.candles), PERIOD); }
  const v = _r[ctx.index];
  if (v == null) return "flat";
  if (ctx.position === "flat") return v < OVERSOLD ? "long" : "flat";
  return v > EXIT ? "flat" : "long";
}`;
  },
  "momentum-roc": (p) => {
    const period = P(p, "period", 20), threshold = P(p, "threshold", 0);
    return `// Momentum (ROC) — invested while rate-of-change is above the threshold.
const PERIOD = ${period}, THRESHOLD = ${threshold};
let _c = null, _r = null;
function strategy(ctx) {
  if (_c !== ctx.candles) { _c = ctx.candles; _r = ctx.indicators.roc(ctx.indicators.closes(ctx.candles), PERIOD); }
  if (_r[ctx.index] == null) return "flat";
  return _r[ctx.index] > THRESHOLD ? "long" : "flat";
}`;
  },
  "bollinger-mean-reversion": (p) => {
    const period = P(p, "period", 20), mult = P(p, "mult", 2);
    return `// Bollinger Mean Reversion — buy below the lower band, exit at the mid.
const PERIOD = ${period}, MULT = ${mult};
let _c = null, _b = null;
function strategy(ctx) {
  if (_c !== ctx.candles) { _c = ctx.candles; _b = ctx.indicators.bollinger(ctx.indicators.closes(ctx.candles), PERIOD, MULT); }
  const band = _b[ctx.index];
  if (band == null) return "flat";
  if (ctx.position === "flat") return ctx.close < band.lower ? "long" : "flat";
  return ctx.close >= band.mid ? "flat" : "long";
}`;
  },
  "opening-range-breakout": (p) => {
    const rangeBars = P(p, "rangeBars", 6), targetR = P(p, "targetR", 1), stopBufferPct = P(p, "stopBufferPct", 0), longOnly = P(p, "longOnly", 0);
    return `// Opening Range Breakout — first N bars set the range, trade the break.
const RANGE_BARS = ${rangeBars}, TARGET_R = ${targetR}, STOP_BUFFER_PCT = ${stopBufferPct}, LONG_ONLY = ${longOnly};
let hi = -Infinity, lo = Infinity, count = 0, traded = false, side = 0, stop = 0, target = 0;
function strategy(ctx) {
  if (ctx.session.isNewDay) { hi = -Infinity; lo = Infinity; count = 0; traded = false; side = 0; }
  if (count < RANGE_BARS) { if (ctx.high > hi) hi = ctx.high; if (ctx.low < lo) lo = ctx.low; count++; return "flat"; }
  if (ctx.position !== "flat") return side === 1 ? { signal: "long", stop, target } : { signal: "short", stop, target };
  if (traded) return "flat";
  const width = hi - lo; if (width <= 0) return "flat";
  const buf = width * (STOP_BUFFER_PCT / 100);
  if (ctx.close > hi) { side = 1; traded = true; stop = lo - buf; target = hi + width * TARGET_R; return { signal: "long", stop, target }; }
  if (!LONG_ONLY && ctx.close < lo) { side = -1; traded = true; stop = hi + buf; target = lo - width * TARGET_R; return { signal: "short", stop, target }; }
  return "flat";
}`;
  },
  "donchian-breakout": (p) => {
    const period = P(p, "period", 20), exitPeriod = P(p, "exitPeriod", 10);
    return `// Donchian Breakout — buy the N-bar high, exit on the M-bar low.
const PERIOD = ${period}, EXIT_PERIOD = ${exitPeriod};
let _c = null, _e = null, _x = null;
function strategy(ctx) {
  if (_c !== ctx.candles) { _c = ctx.candles; _e = ctx.indicators.donchian(ctx.candles, PERIOD); _x = ctx.indicators.donchian(ctx.candles, EXIT_PERIOD); }
  const e = _e[ctx.index], x = _x[ctx.index];
  if (ctx.position === "flat") { if (e == null) return "flat"; return ctx.close > e.upper ? "long" : "flat"; }
  if (x == null) return "long";
  return ctx.close < x.lower ? "flat" : "long";
}`;
  },
  "asian-range-london-breakout": (p) => {
    const asianStart = P(p, "asianStart", 0), londonOpen = P(p, "londonOpen", 8), londonEnd = P(p, "londonEnd", 13), targetR = P(p, "targetR", 1.5), longOnly = P(p, "longOnly", 0);
    return `// Asian Range -> London Breakout — build the overnight range, trade the London break.
const ASIAN_START = ${asianStart}, LONDON_OPEN = ${londonOpen}, LONDON_END = ${londonEnd}, TARGET_R = ${targetR}, LONG_ONLY = ${longOnly};
let hi = -Infinity, lo = Infinity, haveRange = false, traded = false, side = 0, stop = 0, target = 0;
function strategy(ctx) {
  if (ctx.session.isNewDay) { hi = -Infinity; lo = Infinity; haveRange = false; traded = false; side = 0; }
  const h = ctx.session.hour;
  const inAsian = ASIAN_START <= LONDON_OPEN ? (h >= ASIAN_START && h < LONDON_OPEN) : (h >= ASIAN_START || h < LONDON_OPEN);
  if (inAsian) { if (ctx.high > hi) hi = ctx.high; if (ctx.low < lo) lo = ctx.low; haveRange = hi > lo; return "flat"; }
  if (ctx.position !== "flat") return side === 1 ? { signal: "long", stop, target } : { signal: "short", stop, target };
  const inLondon = h >= LONDON_OPEN && h < LONDON_END;
  if (!inLondon || !haveRange || traded) return "flat";
  const width = hi - lo; if (width <= 0) return "flat";
  if (ctx.close > hi) { side = 1; traded = true; stop = lo; target = hi + width * TARGET_R; return { signal: "long", stop, target }; }
  if (!LONG_ONLY && ctx.close < lo) { side = -1; traded = true; stop = hi; target = lo - width * TARGET_R; return { signal: "short", stop, target }; }
  return "flat";
}`;
  },
  "bollinger-squeeze-breakout": (p) => {
    const period = P(p, "period", 20), mult = P(p, "mult", 2), lookback = P(p, "lookback", 60), pctile = P(p, "pctile", 25), longOnly = P(p, "longOnly", 0);
    return `// Bollinger Squeeze Breakout — trade the break out of a low-volatility squeeze.
const PERIOD = ${period}, MULT = ${mult}, LOOKBACK = ${lookback}, PCTILE = ${pctile}, LONG_ONLY = ${longOnly};
let _c = null, _b = null, _w = null;
function strategy(ctx) {
  if (_c !== ctx.candles) { _c = ctx.candles; const px = ctx.indicators.closes(ctx.candles);
    _b = ctx.indicators.bollinger(px, PERIOD, MULT);
    _w = _b.map((b) => (b ? (b.upper - b.lower) / (b.mid || 1) : null)); }
  const i = ctx.index, b = _b[i];
  if (b == null) return "flat";
  if (ctx.position === "long") return ctx.close < b.mid ? "flat" : "long";
  if (ctx.position === "short") return ctx.close > b.mid ? "flat" : "short";
  if (i < PERIOD + LOOKBACK) return "flat";
  const prevW = _w[i - 1]; if (prevW == null) return "flat";
  const window = [];
  for (let j = i - LOOKBACK; j < i; j++) if (_w[j] != null) window.push(_w[j]);
  if (window.length < LOOKBACK * 0.6) return "flat";
  window.sort((x, y) => x - y);
  const thresh = window[Math.floor((PCTILE / 100) * (window.length - 1))];
  if (prevW > thresh) return "flat";
  if (ctx.close > b.upper) return "long";
  if (!LONG_ONLY && ctx.close < b.lower) return "short";
  return "flat";
}`;
  },
  "session-range-fade": (p) => {
    const rangeStart = P(p, "rangeStart", 12), rangeEnd = P(p, "rangeEnd", 13), tradeEnd = P(p, "tradeEnd", 20), stopBufferPct = P(p, "stopBufferPct", 10), longOnly = P(p, "longOnly", 0);
    return `// Session Range Fade — mark a session range, then FADE its breakout.
const RANGE_START = ${rangeStart}, RANGE_END = ${rangeEnd}, TRADE_END = ${tradeEnd}, STOP_BUFFER_PCT = ${stopBufferPct}, LONG_ONLY = ${longOnly};
let hi = -Infinity, lo = Infinity, haveRange = false, traded = false, side = 0, stop = 0, target = 0;
function strategy(ctx) {
  if (ctx.session.isNewDay) { hi = -Infinity; lo = Infinity; haveRange = false; traded = false; side = 0; }
  const h = ctx.session.hour;
  const inRange = RANGE_START <= RANGE_END ? (h >= RANGE_START && h < RANGE_END) : (h >= RANGE_START || h < RANGE_END);
  if (inRange) { if (ctx.high > hi) hi = ctx.high; if (ctx.low < lo) lo = ctx.low; haveRange = hi > lo; return "flat"; }
  if (ctx.position !== "flat") return side === 1 ? { signal: "long", stop, target } : { signal: "short", stop, target };
  const inTrade = h >= RANGE_END && h < TRADE_END;
  if (!inTrade || !haveRange || traded) return "flat";
  const width = hi - lo; if (width <= 0) return "flat";
  const buf = width * (STOP_BUFFER_PCT / 100);
  if (ctx.close > hi && !LONG_ONLY) { side = -1; traded = true; stop = hi + buf; target = lo; return { signal: "short", stop, target }; }
  if (ctx.close < lo) { side = 1; traded = true; stop = lo - buf; target = hi; return { signal: "long", stop, target }; }
  return "flat";
}`;
  },
  "ict-silver-bullet": (p) => {
    const windowStart = P(p, "windowStart", 14), windowEnd = P(p, "windowEnd", 15), maxGapAge = P(p, "maxGapAge", 12), targetR = P(p, "targetR", 2), longOnly = P(p, "longOnly", 0);
    return `// ICT Silver Bullet — enter on a retrace into the most recent Fair Value Gap.
const WINDOW_START = ${windowStart}, WINDOW_END = ${windowEnd}, MAX_GAP_AGE = ${maxGapAge}, TARGET_R = ${targetR}, LONG_ONLY = ${longOnly};
let traded = false, side = 0, stop = 0, target = 0, intraday = null;
function strategy(ctx) {
  if (ctx.session.isNewDay) { traded = false; side = 0; }
  if (ctx.position !== "flat") return side === 1 ? { signal: "long", stop, target } : { signal: "short", stop, target };
  if (intraday === null) { const c = ctx.candles, gaps = [];
    for (let k = 1; k < Math.min(c.length, 30); k++) gaps.push(c[k].time - c[k - 1].time);
    gaps.sort((a, b) => a - b); intraday = (gaps[gaps.length >> 1] || 86400) < 23 * 3600; }
  const h = ctx.session.hour;
  const inWindow = !intraday ? true : WINDOW_START <= WINDOW_END ? (h >= WINDOW_START && h < WINDOW_END) : (h >= WINDOW_START || h < WINDOW_END);
  if (!inWindow || traded) return "flat";
  const c = ctx.candles, i = ctx.index;
  if (i < 3) return "flat";
  for (let k = i - 1; k >= Math.max(2, i - MAX_GAP_AGE); k--) {
    const bull = c[k].low - c[k - 2].high, bear = c[k - 2].low - c[k].high;
    if (bull <= 0 && bear <= 0) continue;
    if (bull > 0) { const zLow = c[k - 2].high, zHigh = c[k].low;
      if (ctx.low <= zHigh && ctx.close >= zLow) { const risk = ctx.close - zLow;
        if (risk > 0) { side = 1; traded = true; stop = zLow; target = ctx.close + risk * TARGET_R; return { signal: "long", stop, target }; } } }
    else if (!LONG_ONLY && bear > 0) { const zHigh = c[k - 2].low, zLow = c[k].high;
      if (ctx.high >= zLow && ctx.close <= zHigh) { const risk = zHigh - ctx.close;
        if (risk > 0) { side = -1; traded = true; stop = zHigh; target = ctx.close - risk * TARGET_R; return { signal: "short", stop, target }; } } }
    break;
  }
  return "flat";
}`;
  },
};

export const hasBuiltinSource = (id) => id in BUILTIN_SOURCE;

/**
 * Standalone, copyable `strategy(ctx)` source for a strategy entry that lands in
 * the agent. Never returns misleading code: an unknown builder id yields a clear
 * note rather than a wrong program.
 *
 * @param {object} entry  a lab strategy entry ({ mode, code, strategyId, params, name })
 * @returns {string}
 */
export function strategyToCode(entry) {
  if (!entry) return "";
  if (entry.mode === "code" || typeof entry.code === "string") {
    return entry.code || "// (no code on this entry)";
  }
  if (entry.mode === "builder" && entry.strategyId) {
    const gen = BUILTIN_SOURCE[entry.strategyId];
    if (gen) return gen(entry.params || {});
    return `// Built-in strategy "${entry.strategyId}" with params ${JSON.stringify(entry.params || {})}\n// Full source: src/lib/strategies.js`;
  }
  return "// (no copyable source for this strategy)";
}
