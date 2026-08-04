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

import { toPineScript } from "./pinescript.js";
import { toCpp, toQ, toRust, toPyRef, toJsRef } from "./exportLangs.js";

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

  "linreg-channel": (p) => {
    const length = P(p, "length", 100), minSlopePct = P(p, "minSlopePct", 3), entryZ = P(p, "entryZ", 1), exitZ = P(p, "exitZ", 0.25), allowShort = P(p, "allowShort", 1);
    return `// Linear-Regression Channel — trade WITH the regression slope, enter on a pullback INTO the line.
const LENGTH = ${length}, MIN_SLOPE_PCT = ${minSlopePct}, ENTRY_Z = ${entryZ}, EXIT_Z = ${exitZ}, ALLOW_SHORT = ${allowShort};
let _c = null, _lr = null;
// Least-squares line through the last LENGTH closes: slope (trend) + z (stretch).
function _linreg(vals, period) {
  const out = new Array(vals.length).fill(null);
  if (period < 2 || vals.length < period) return out;
  const n = period, sumX = n * (n - 1) / 2, sumXX = (n - 1) * n * (2 * n - 1) / 6, denom = n * sumXX - sumX * sumX;
  for (let i = period - 1; i < vals.length; i++) {
    let sumY = 0, sumXY = 0;
    for (let k = 0; k < n; k++) { const y = vals[i - (n - 1) + k]; sumY += y; sumXY += k * y; }
    const b = (n * sumXY - sumX * sumY) / denom, a = (sumY - b * sumX) / n;
    let ss = 0; for (let k = 0; k < n; k++) { const r = vals[i - (n - 1) + k] - (a + b * k); ss += r * r; }
    const resStd = Math.sqrt(ss / n), value = a + b * (n - 1), price = vals[i];
    out[i] = { value, slopePct: value !== 0 ? (b * n) / value : 0, z: resStd > 0 ? (price - value) / resStd : 0 };
  }
  return out;
}
function strategy(ctx) {
  if (_c !== ctx.candles) { _c = ctx.candles; _lr = _linreg(ctx.indicators.closes(ctx.candles), LENGTH); }
  const r = _lr[ctx.index];
  if (r == null) return "flat";
  const up = r.slopePct >= MIN_SLOPE_PCT / 100, down = r.slopePct <= -MIN_SLOPE_PCT / 100;
  if (ctx.position === "long") return (r.z >= EXIT_Z || down) ? "flat" : "long";
  if (ctx.position === "short") return (r.z <= -EXIT_Z || up) ? "flat" : "short";
  if (up && r.z <= -ENTRY_Z) return "long";
  if (ALLOW_SHORT && down && r.z >= ENTRY_Z) return "short";
  return "flat";
}`;
  },

  "rsi-divergence": (p) => {
    const rsiPeriod = P(p, "rsiPeriod", 14), pivot = P(p, "pivot", 5), maxGap = P(p, "maxGap", 60), atrPeriod = P(p, "atrPeriod", 14), targetR = P(p, "targetR", 2), allowShort = P(p, "allowShort", 1);
    return `// Momentum Divergence Reversal (RSI) — price lower-low + RSI higher-low = bullish (mirror for tops).
const RSI_PERIOD = ${rsiPeriod}, PIVOT = ${pivot}, MAX_GAP = ${maxGap}, ATR_PERIOD = ${atrPeriod}, TARGET_R = ${targetR}, ALLOW_SHORT = ${allowShort};
let _c = null, _rsi = null, _atr = null, lastLow = null, lastHigh = null;
function strategy(ctx) {
  if (_c !== ctx.candles) { _c = ctx.candles; const px = ctx.indicators.closes(ctx.candles);
    _rsi = ctx.indicators.rsi(px, RSI_PERIOD); _atr = ctx.indicators.atr(ctx.candles, ATR_PERIOD);
    lastLow = null; lastHigh = null; }
  if (ctx.position !== "flat") return ctx.position; // brackets handle exits
  const i = ctx.index, atrNow = _atr[i], k = i - PIVOT; // pivot confirmed PIVOT bars later
  if (k - PIVOT < 0 || atrNow == null || !(atrNow > 0)) return "flat";
  const c = ctx.candles;
  let isLow = true, isHigh = true;
  for (let j = 1; j <= PIVOT; j++) {
    if (!(c[k].low <= c[k - j].low && c[k].low <= c[k + j].low)) isLow = false;
    if (!(c[k].high >= c[k - j].high && c[k].high >= c[k + j].high)) isHigh = false;
  }
  const rp = _rsi[k]; if (rp == null) return "flat";
  let signal = "flat";
  if (isLow) {
    if (lastLow && (k - lastLow.idx) <= MAX_GAP && c[k].low < lastLow.px && rp > lastLow.rsi) signal = "long";
    lastLow = { idx: k, px: c[k].low, rsi: rp };
  }
  if (isHigh) {
    if (ALLOW_SHORT && lastHigh && (k - lastHigh.idx) <= MAX_GAP && c[k].high > lastHigh.px && rp < lastHigh.rsi) signal = "short";
    lastHigh = { idx: k, px: c[k].high, rsi: rp };
  }
  if (signal === "long") return { signal: "long", stop: ctx.close - atrNow, target: ctx.close + atrNow * TARGET_R };
  if (signal === "short") return { signal: "short", stop: ctx.close + atrNow, target: ctx.close - atrNow * TARGET_R };
  return "flat";
}`;
  },
  "supertrend": (p) => {
    const atrPeriod = P(p, "atrPeriod", 10), mult = P(p, "mult", 3), allowShort = P(p, "allowShort", 0);
    return `// Supertrend (ATR Trend) — a volatility band flips a trend direction on a close through it.
const ATR_PERIOD = ${atrPeriod}, MULT = ${mult}, ALLOW_SHORT = ${allowShort};
let _c = null, _st = null;
function _supertrend(candles, period, mult, atrFn) {
  const a = atrFn(candles, period), out = new Array(candles.length).fill(null);
  let fU = null, fL = null, pfU = null, pfL = null, st = null;
  for (let i = 0; i < candles.length; i++) {
    if (a[i] == null) continue;
    const c = candles[i], hl2 = (c.high + c.low) / 2;
    const bU = hl2 + mult * a[i], bL = hl2 - mult * a[i], pc = candles[i - 1].close;
    fU = (pfU == null || bU < pfU || pc > pfU) ? bU : pfU;
    fL = (pfL == null || bL > pfL || pc < pfL) ? bL : pfL;
    if (st == null) st = fU; else if (st === pfU) st = c.close <= fU ? fU : fL; else st = c.close >= fL ? fL : fU;
    out[i] = { dir: st === fU ? -1 : 1 };
    pfU = fU; pfL = fL;
  }
  return out;
}
function strategy(ctx) {
  if (_c !== ctx.candles) { _c = ctx.candles; _st = _supertrend(ctx.candles, ATR_PERIOD, MULT, ctx.indicators.atr); }
  const s = _st[ctx.index];
  if (s == null) return "flat";
  return s.dir > 0 ? "long" : ALLOW_SHORT ? "short" : "flat";
}`;
  },
};

export const hasBuiltinSource = (id) => id in BUILTIN_SOURCE;

// ── Python (signals(df)) twins of the vectorizable built-ins ────────────────
// Fidelity-verified against the real builders through the Pyodide harness
// (identical trades on the same candles). The four session/bracket built-ins
// (opening-range, asian-range, ict-silver-bullet, session-range-fade) are
// deliberately ABSENT: the vectorised signals(df) contract has no intrabar
// stop/target orders, and a "translation" that silently drops the brackets
// would be a different strategy — we don't ship misleading code.

// Shared Python helpers, injected only when a template needs them. They
// replicate indicators.js EXACTLY: EMA seeded with the SMA of the first
// `period` values, RSI with Wilder smoothing off a seeded average.
const PY_EMA = `
def _ema(s, period):
    v = s.to_numpy(dtype=float)
    out = np.full(len(v), np.nan)
    if period <= 0 or len(v) < period:
        return pd.Series(out, index=s.index)
    alpha = 2.0 / (period + 1)
    out[period - 1] = v[:period].mean()
    for i in range(period, len(v)):
        out[i] = v[i] * alpha + out[i - 1] * (1 - alpha)
    return pd.Series(out, index=s.index)
`;
// Wilder ATR, matching indicators.js exactly: TR series, seeded with the simple
// mean of the first `period` TRs, then Wilder-smoothed. (A plain rolling mean
// diverges — the twins must trade identically to the builder version.)
const PY_ATR = `
def _atr(df, period):
    h = df["high"].to_numpy(dtype=float); l = df["low"].to_numpy(dtype=float); c = df["close"].to_numpy(dtype=float)
    n = len(h)
    out = np.full(n, np.nan)
    if period <= 0 or n < period:
        return pd.Series(out, index=df.index)
    tr = np.empty(n)
    tr[0] = h[0] - l[0]
    for i in range(1, n):
        pc = c[i - 1]
        tr[i] = max(h[i] - l[i], abs(h[i] - pc), abs(l[i] - pc))
    out[period - 1] = tr[:period].mean()
    for i in range(period, n):
        out[i] = (out[i - 1] * (period - 1) + tr[i]) / period
    return pd.Series(out, index=df.index)
`;
const PY_RSI = `
def _rsi(s, period):
    v = s.to_numpy(dtype=float)
    n = len(v)
    out = np.full(n, np.nan)
    if period <= 0 or n <= period:
        return pd.Series(out, index=s.index)
    d = np.diff(v)
    seed = d[:period]
    ag = seed[seed >= 0].sum() / period
    al = -seed[seed < 0].sum() / period
    out[period] = 100.0 if al == 0 else 100.0 - 100.0 / (1.0 + ag / al)
    for i in range(period + 1, n):
        diff = v[i] - v[i - 1]
        g = diff if diff > 0 else 0.0
        l = -diff if diff < 0 else 0.0
        ag = (ag * (period - 1) + g) / period
        al = (al * (period - 1) + l) / period
        out[i] = 100.0 if al == 0 else 100.0 - 100.0 / (1.0 + ag / al)
    return pd.Series(out, index=s.index)
`;

const PY_HEAD = "import numpy as np\nimport pandas as pd\n";

const BUILTIN_SOURCE_PY = {
  "sma-crossover": (p) => {
    const fast = P(p, "fast", 20), slow = P(p, "slow", 50);
    return `# SMA Crossover — long while the fast SMA is above the slow SMA.
${PY_HEAD}
FAST, SLOW = ${fast}, ${slow}

def signals(df):
    close = df["close"]
    fast = close.rolling(FAST).mean()
    slow = close.rolling(SLOW).mean()
    return pd.Series(np.where(fast > slow, 1, 0), index=df.index)
`;
  },
  "ema-crossover": (p) => {
    const fast = P(p, "fast", 12), slow = P(p, "slow", 26);
    return `# EMA Crossover — long while the fast EMA is above the slow EMA.
# EMA seeded with the SMA of the first \`period\` values (classic convention).
${PY_HEAD}${PY_EMA}
FAST, SLOW = ${fast}, ${slow}

def signals(df):
    close = df["close"]
    fast = _ema(close, FAST)
    slow = _ema(close, SLOW)
    return pd.Series(np.where(fast > slow, 1, 0), index=df.index)
`;
  },
  "rsi-mean-reversion": (p) => {
    const period = P(p, "period", 14), oversold = P(p, "oversold", 30), exitLevel = P(p, "exitLevel", 55);
    return `# RSI Mean Reversion — buy oversold, exit once RSI recovers.
# Wilder-smoothed RSI. Enter/hold/exit is expressed via forward-fill:
# +1 marks entries, 0 marks exits, NaN carries the previous state.
${PY_HEAD}${PY_RSI}
PERIOD, OVERSOLD, EXIT = ${period}, ${oversold}, ${exitLevel}

def signals(df):
    r = _rsi(df["close"], PERIOD)
    raw = np.where(r < OVERSOLD, 1.0, np.where(r >= EXIT, 0.0, np.nan))
    return pd.Series(raw, index=df.index).ffill().fillna(0)
`;
  },
  "momentum-roc": (p) => {
    const period = P(p, "period", 20), threshold = P(p, "threshold", 0);
    return `# Momentum (ROC) — invested while rate-of-change is above the threshold.
${PY_HEAD}
PERIOD, THRESHOLD = ${period}, ${threshold}

def signals(df):
    close = df["close"]
    roc = (close / close.shift(PERIOD) - 1.0) * 100.0
    return pd.Series(np.where(roc > THRESHOLD, 1, 0), index=df.index)
`;
  },
  "bollinger-mean-reversion": (p) => {
    const period = P(p, "period", 20), mult = P(p, "mult", 2);
    return `# Bollinger Mean Reversion — buy below the lower band, exit at the mid.
# Population std (ddof=0) matches the site's band math exactly.
${PY_HEAD}
PERIOD, MULT = ${period}, ${mult}

def signals(df):
    close = df["close"]
    mid = close.rolling(PERIOD).mean()
    sd = close.rolling(PERIOD).std(ddof=0)
    lower = mid - MULT * sd
    raw = np.where(close < lower, 1.0, np.where(close >= mid, 0.0, np.nan))
    return pd.Series(raw, index=df.index).ffill().fillna(0)
`;
  },
  "donchian-breakout": (p) => {
    const period = P(p, "period", 20), exitPeriod = P(p, "exitPeriod", 10);
    return `# Donchian Breakout — buy the N-bar high, exit on the M-bar low.
# Channels use the PRIOR N bars (shift(1)) — the current bar never sees itself.
${PY_HEAD}
PERIOD, EXIT_PERIOD = ${period}, ${exitPeriod}

def signals(df):
    close = df["close"]
    entry_hi = df["high"].rolling(PERIOD).max().shift(1)
    exit_lo = df["low"].rolling(EXIT_PERIOD).min().shift(1)
    raw = np.where(close > entry_hi, 1.0, np.where(close < exit_lo, 0.0, np.nan))
    return pd.Series(raw, index=df.index).ffill().fillna(0)
`;
  },
  "bollinger-squeeze-breakout": (p) => {
    const period = P(p, "period", 20), mult = P(p, "mult", 2), lookback = P(p, "lookback", 60), pctile = P(p, "pctile", 25), longOnly = P(p, "longOnly", 0);
    return `# Bollinger Squeeze Breakout — trade the break out of a low-volatility squeeze.
# The position logic is direction-dependent (long exits below mid, short above),
# so the state machine runs as an explicit loop — identical to the site's rules.
${PY_HEAD}
PERIOD, MULT, LOOKBACK, PCTILE, LONG_ONLY = ${period}, ${mult}, ${lookback}, ${pctile}, ${longOnly}

def signals(df):
    close = df["close"].to_numpy(dtype=float)
    mid = df["close"].rolling(PERIOD).mean()
    sd = df["close"].rolling(PERIOD).std(ddof=0)
    upper = (mid + MULT * sd).to_numpy(dtype=float)
    lower = (mid - MULT * sd).to_numpy(dtype=float)
    m = mid.to_numpy(dtype=float)
    with np.errstate(invalid="ignore", divide="ignore"):
        w = (upper - lower) / np.where(m == 0, 1.0, m)

    n = len(close)
    out = np.zeros(n)
    pos = 0
    for i in range(n):
        if np.isnan(m[i]):
            out[i] = pos = 0
            continue
        if pos == 1:
            pos = 0 if close[i] < m[i] else 1
            out[i] = pos
            continue
        if pos == -1:
            pos = 0 if close[i] > m[i] else -1
            out[i] = pos
            continue
        if i < PERIOD + LOOKBACK or i == 0 or np.isnan(w[i - 1]):
            out[i] = 0
            continue
        window = w[i - LOOKBACK:i]
        window = np.sort(window[~np.isnan(window)])
        if len(window) < LOOKBACK * 0.6:
            out[i] = 0
            continue
        thresh = window[int(np.floor((PCTILE / 100.0) * (len(window) - 1)))]
        if w[i - 1] > thresh:
            out[i] = 0
            continue
        if close[i] > upper[i]:
            pos = 1
        elif not LONG_ONLY and close[i] < lower[i]:
            pos = -1
        out[i] = pos
    return pd.Series(out, index=df.index)
`;
  },

  // ── twins for the newer templates (factor / VWAP / breakout / trend) ───────
  "absolute-momentum": (p) => {
    const lookback = P(p, "lookback", 120), trend = P(p, "trend", 200), minRoc = P(p, "minRoc", 0);
    return `# Absolute Momentum — hold only while trailing return > threshold AND price > trend SMA.
${PY_HEAD}
LOOKBACK, TREND, MIN_ROC = ${lookback}, ${trend}, ${minRoc}

def signals(df):
    close = df["close"]
    mom = close.pct_change(LOOKBACK) * 100.0
    ma = close.rolling(TREND).mean()
    long = (mom > MIN_ROC) & (close > ma)
    return pd.Series(np.where(long.fillna(False), 1, 0), index=df.index)
`;
  },

  "low-vol-timing": (p) => {
    const atrPeriod = P(p, "atrPeriod", 14), volAvg = P(p, "volAvg", 100), trend = P(p, "trend", 200);
    return `# Low-Volatility Timing — invested only in calm regimes (ATR below its own average) in an uptrend.
${PY_HEAD}${PY_ATR}
ATR_PERIOD, VOL_AVG, TREND = ${atrPeriod}, ${volAvg}, ${trend}

def signals(df):
    atr = _atr(df, ATR_PERIOD)
    base = atr.rolling(VOL_AVG).mean()
    ma = df["close"].rolling(TREND).mean()
    calm = (atr < base) & (df["close"] > ma)
    return pd.Series(np.where(calm.fillna(False), 1, 0), index=df.index)
`;
  },

  "rolling-vwap-reversion": (p) => {
    const period = P(p, "period", 50), atrPeriod = P(p, "atrPeriod", 14), stretch = P(p, "stretch", 2);
    return `# Rolling VWAP Reversion — buy an N-ATR stretch below the rolling VWAP, exit back at VWAP.
${PY_HEAD}${PY_ATR}
PERIOD, ATR_PERIOD, STRETCH = ${period}, ${atrPeriod}, ${stretch}

def signals(df):
    typ = (df["high"] + df["low"] + df["close"]) / 3.0
    vol = df["volume"].fillna(0)
    pv = (typ * vol).rolling(PERIOD).sum()
    vv = vol.rolling(PERIOD).sum()
    vwap = pv / vv.replace(0, np.nan)
    atr = _atr(df, ATR_PERIOD)
    close = df["close"]
    enter = close < (vwap - STRETCH * atr)
    exit_ = close >= vwap
    out = np.zeros(len(df))
    pos = 0
    e, x = enter.fillna(False).to_numpy(), exit_.fillna(False).to_numpy()
    for i in range(len(df)):
        if pos == 0 and e[i]:
            pos = 1
        elif pos == 1 and x[i]:
            pos = 0
        out[i] = pos
    return pd.Series(out, index=df.index)
`;
  },

  "turtle-breakout": (p) => {
    const entryN = P(p, "entryN", 20), exitN = P(p, "exitN", 10), trend = P(p, "trend", 100);
    return `# Turtle Breakout — enter above the N-bar high in an uptrend, exit below the M-bar low.
${PY_HEAD}
ENTRY_N, EXIT_N, TREND = ${entryN}, ${exitN}, ${trend}

def signals(df):
    close = df["close"]
    upper = df["high"].rolling(ENTRY_N).max().shift(1)   # prior channel, excludes this bar
    lower = df["low"].rolling(EXIT_N).min().shift(1)
    ma = close.rolling(TREND).mean()
    enter = (close > upper) & (close > ma)
    exit_ = close < lower
    out = np.zeros(len(df))
    pos = 0
    e, x = enter.fillna(False).to_numpy(), exit_.fillna(False).to_numpy()
    for i in range(len(df)):
        if pos == 0 and e[i]:
            pos = 1
        elif pos == 1 and x[i]:
            pos = 0
        out[i] = pos
    return pd.Series(out, index=df.index)
`;
  },

  "keltner-breakout": (p) => {
    const period = P(p, "period", 20), mult = P(p, "mult", 1.5);
    return `# Keltner Breakout — long above EMA + mult*ATR, exit back at the EMA mid-line.
${PY_HEAD}${PY_EMA}${PY_ATR}
PERIOD, MULT = ${period}, ${mult}

def signals(df):
    close = df["close"]
    mid = _ema(close, PERIOD)
    atr = _atr(df, PERIOD)
    enter = close > (mid + MULT * atr)
    exit_ = close < mid
    out = np.zeros(len(df))
    pos = 0
    e, x = enter.fillna(False).to_numpy(), exit_.fillna(False).to_numpy()
    for i in range(len(df)):
        if pos == 0 and e[i]:
            pos = 1
        elif pos == 1 and x[i]:
            pos = 0
        out[i] = pos
    return pd.Series(out, index=df.index)
`;
  },

  "connors-rsi2": (p) => {
    const rsiPeriod = P(p, "rsiPeriod", 2), oversold = P(p, "oversold", 10), trend = P(p, "trend", 200), exitSma = P(p, "exitSma", 5);
    return `# Connors RSI-2 — buy deep short-term oversold dips in an uptrend, sell the bounce.
${PY_HEAD}${PY_RSI}
RSI_PERIOD, OVERSOLD, TREND, EXIT_SMA = ${rsiPeriod}, ${oversold}, ${trend}, ${exitSma}

def signals(df):
    close = df["close"]
    r = _rsi(close, RSI_PERIOD)
    ma_t = close.rolling(TREND).mean()
    ma_e = close.rolling(EXIT_SMA).mean()
    enter = (close > ma_t) & (r < OVERSOLD)
    exit_ = close > ma_e
    out = np.zeros(len(df))
    pos = 0
    e, x = enter.fillna(False).to_numpy(), exit_.fillna(False).to_numpy()
    for i in range(len(df)):
        if pos == 0 and e[i]:
            pos = 1
        elif pos == 1 and x[i]:
            pos = 0
        out[i] = pos
    return pd.Series(out, index=df.index)
`;
  },

  "macd-trend": (p) => {
    const fast = P(p, "fast", 12), slow = P(p, "slow", 26), signal = P(p, "signal", 9);
    return `# MACD Trend Follow — long while MACD > signal and the histogram is positive.
${PY_HEAD}${PY_EMA}
FAST, SLOW, SIGNAL = ${fast}, ${slow}, ${signal}

def signals(df):
    close = df["close"]
    macd = _ema(close, FAST) - _ema(close, SLOW)
    sig = _ema(macd.dropna(), SIGNAL).reindex(macd.index)
    hist = macd - sig
    long = (macd > sig) & (hist > 0)
    return pd.Series(np.where(long.fillna(False), 1, 0), index=df.index)
`;
  },

  "linreg-channel": (p) => {
    const length = P(p, "length", 100), minSlopePct = P(p, "minSlopePct", 3), entryZ = P(p, "entryZ", 1), exitZ = P(p, "exitZ", 0.25), allowShort = P(p, "allowShort", 1);
    // Stateful hysteresis (entry threshold != exit threshold), so it's a bar loop
    // rather than a vectorised mask — mirrors the builder's state machine exactly.
    return `# Linear-Regression Channel — trade WITH the regression slope, enter on a pullback INTO the line.
${PY_HEAD}
LENGTH, MIN_SLOPE_PCT, ENTRY_Z, EXIT_Z, ALLOW_SHORT = ${length}, ${minSlopePct}, ${entryZ}, ${exitZ}, ${allowShort}

def signals(df):
    close = df["close"].to_numpy(dtype=float)
    n = len(close)
    out = np.zeros(n)
    L = LENGTH
    if L >= 2 and n >= L:
        x = np.arange(L, dtype=float)
        sx = x.sum(); sxx = (x * x).sum(); denom = L * sxx - sx * sx
        pos = 0
        for i in range(L - 1, n):
            y = close[i - L + 1:i + 1]
            sy = y.sum(); sxy = (x * y).sum()
            b = (L * sxy - sx * sy) / denom
            a = (sy - b * sx) / L
            resid = y - (a + b * x)
            res_std = np.sqrt((resid * resid).sum() / L)
            value = a + b * (L - 1)
            z = (close[i] - value) / res_std if res_std > 0 else 0.0
            slope_pct = (b * L) / value if value != 0 else 0.0
            up = slope_pct >= MIN_SLOPE_PCT / 100.0
            down = slope_pct <= -MIN_SLOPE_PCT / 100.0
            if pos == 1:
                pos = 0 if (z >= EXIT_Z or down) else 1
            elif pos == -1:
                pos = 0 if (z <= -EXIT_Z or up) else -1
            else:
                if up and z <= -ENTRY_Z:
                    pos = 1
                elif ALLOW_SHORT and down and z >= ENTRY_Z:
                    pos = -1
            out[i] = pos
    return pd.Series(out, index=df.index)
`;
  },
  "supertrend": (p) => {
    const atrPeriod = P(p, "atrPeriod", 10), mult = P(p, "mult", 3), allowShort = P(p, "allowShort", 0);
    // Stateful carry-forward recursion — a bar loop, not a vectorised mask.
    return `# Supertrend (ATR Trend) — a volatility band flips a trend direction on a close through it.
${PY_HEAD}${PY_ATR}
ATR_PERIOD, MULT, ALLOW_SHORT = ${atrPeriod}, ${mult}, ${allowShort}

def signals(df):
    atr = _atr(df, ATR_PERIOD).to_numpy()
    high = df["high"].to_numpy(dtype=float); low = df["low"].to_numpy(dtype=float); close = df["close"].to_numpy(dtype=float)
    n = len(df); out = np.zeros(n)
    fU = None; fL = None; pfU = None; pfL = None; st = None
    for i in range(n):
        if np.isnan(atr[i]):
            continue
        hl2 = (high[i] + low[i]) / 2.0
        bU = hl2 + MULT * atr[i]; bL = hl2 - MULT * atr[i]; pc = close[i - 1]
        fU = bU if (pfU is None or bU < pfU or pc > pfU) else pfU
        fL = bL if (pfL is None or bL > pfL or pc < pfL) else pfL
        if st is None:
            st = fU
        elif st == pfU:
            st = fU if close[i] <= fU else fL
        else:
            st = fL if close[i] >= fL else fU
        out[i] = 1 if st != fU else (-1 if ALLOW_SHORT else 0)
        pfU = fU; pfL = fL
    return pd.Series(out, index=df.index)
`;
  },
};

export const hasBuiltinPySource = (id) => id in BUILTIN_SOURCE_PY;

/**
 * True when a PYTHON source can be produced for this entry: a Cortex code
 * entry that already IS Python, or a builder with a verified Python twin.
 */
export function hasPythonSource(entry) {
  if (!entry) return false;
  if (entry.mode === "code" || typeof entry.code === "string") return entry.language === "python";
  return entry.mode === "builder" && hasBuiltinPySource(entry.strategyId);
}

/**
 * Standalone, copyable `strategy(ctx)` source for a strategy entry that lands in
 * the agent. Never returns misleading code: an unknown builder id yields a clear
 * note rather than a wrong program.
 *
 * @param {object} entry  a lab strategy entry ({ mode, code, strategyId, params, name })
 * @param {"js"|"python"|"pine"} [lang="js"]  target language for the export
 * @returns {string}
 */
export function strategyToCode(entry, lang = "js") {
  if (!entry) return "";
  // Pine Script is a third export target; the pinescript module owns dispatch
  // (builder+known id → full script, otherwise an honest commented note).
  if (lang === "pine") return toPineScript(entry);
  // C++, Rust and kdb+/q are REFERENCE-only exports (not runnable in this tool) — a
  // scaffold in the target language carrying the exact validated source to port
  // (C++/Rust for HFT/low-latency execution, q for tick databases).
  if (lang === "cpp" || lang === "q" || lang === "rust") {
    let source = "", sourceLang = "js";
    if (entry.mode === "code" || typeof entry.code === "string") {
      source = entry.code || ""; sourceLang = entry.language === "python" ? "python" : "js";
    } else if (entry.mode === "builder" && entry.strategyId) {
      const py = BUILTIN_SOURCE_PY[entry.strategyId];
      if (py) { source = py(entry.params || {}); sourceLang = "python"; }
      else { const gen = BUILTIN_SOURCE[entry.strategyId]; source = gen ? gen(entry.params || {}) : ""; sourceLang = "js"; }
    }
    if (!String(source).trim()) return "";
    const args = { name: entry.name || entry.strategyId || "Strategy", source, sourceLang };
    return lang === "cpp" ? toCpp(args) : lang === "rust" ? toRust(args) : toQ(args);
  }
  if (entry.mode === "code" || typeof entry.code === "string") {
    const isPy = entry.language === "python";
    const src = entry.code || "";
    const args = { name: entry.name || "Strategy", source: src, sourceLang: isPy ? "python" : "js" };
    // Ask for the OTHER runnable language → an honest REFERENCE scaffold embedding the
    // source to port (a deterministic 1:1 translation isn't possible), so every "Copy
    // as …" button produces something instead of failing.
    if (lang === "python") return isPy ? src : (src.trim() ? toPyRef(args) : "");
    if (lang === "js") return isPy ? (src.trim() ? toJsRef(args) : "") : (src || "// (no code on this entry)");
    return src || "// (no code on this entry)";
  }
  if (entry.mode === "builder" && entry.strategyId) {
    if (lang === "python") {
      const py = BUILTIN_SOURCE_PY[entry.strategyId];
      return py ? py(entry.params || {}) : ""; // session/bracket builders have no honest Python twin
    }
    const gen = BUILTIN_SOURCE[entry.strategyId];
    if (gen) return gen(entry.params || {});
    return `// Built-in strategy "${entry.strategyId}" with params ${JSON.stringify(entry.params || {})}\n// Full source: src/lib/strategies.js`;
  }
  return lang === "python" ? "" : "// (no copyable source for this strategy)";
}
