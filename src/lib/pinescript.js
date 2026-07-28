// pinescript.js — export a builder strategy as a TradingView Pine Script v5
// `strategy(...)`.
//
// This is the THIRD copyable target for a strategy entry, alongside the
// standalone JS and Python sources in strategyCode.js. It follows the exact
// same rule: NEVER emit misleading code. A strategy that cannot be translated
// faithfully (raw user code, or a builder id with no verified template) yields
// a clear commented note — never a look-alike script that would drift from the
// logic the user actually backtested.
//
// EXECUTION-MODEL FIDELITY (why the copied Pine reproduces the site backtest):
//   • Next-bar-open fills — Pine market orders (strategy.entry / strategy.close)
//     fill at the next bar's open when process_orders_on_close=false and
//     calc_on_every_tick=false. That matches runBacktest, which decides on the
//     bar close and executes at the next open.
//   • Fees — commission_type=strategy.commission.percent, value = feeBps/100
//     (10 bps -> 0.1), charged per side, matching feeBps per side.
//   • Sizing — default_qty_type=strategy.percent_of_equity, value = positionPct;
//     pyramiding=0 keeps a single position (the engine's all-in / fractional
//     model on current equity).
//   • Bracket exits (approximate strategies) — strategy.exit stop/limit are live
//     intrabar orders; when both sit inside one bar Pine assumes the STOP fills
//     first, matching the engine's conservative tie-break.
//
// Known, documented divergences are called out in each script's header comment
// (EMA seeding, Donchian current-bar exclusion, session/timezone effects).

import { BUILT_IN_STRATEGIES } from "./strategies.js";

// ── sanitisation helpers ────────────────────────────────────────────────────
// Every value interpolated into the generated Pine is forced to a numeric
// literal (or an escaped string) so a hostile params object can never inject
// Pine code.

/** A finite Number, or the fallback. Guards every numeric interpolation. */
const num = (v, fallback) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
};

/** Render a sanitised number as a clean Pine numeric literal. */
const fmt = (n) => String(Number(n));

/** Clamp a position percentage into the engine's [1, 100] band. */
const clampPct = (x) => Math.min(100, Math.max(1, x));

/** Escape a JS string into a safe Pine double-quoted string literal. */
function pineStr(s) {
  return `"${String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, " ")}"`;
}

// Param definitions per built-in id (label / min / max / step), for pineInputs.
const DEFS = Object.fromEntries(BUILT_IN_STRATEGIES.map((s) => [s.id, s.params]));
const NAMES = Object.fromEntries(BUILT_IN_STRATEGIES.map((s) => [s.id, s.name]));

/**
 * Build the `//@version=5` header + strategy() declaration with the execution
 * flags that reproduce the backtester (see the module header for the mapping).
 * @param {{positionPct:number, feeBps:number, name:string}} meta
 * @param {{overlay:boolean}} opts
 * @returns {string}
 */
export function pineHeader(meta, { overlay } = {}) {
  const positionPct = clampPct(num(meta?.positionPct, 100));
  const feeBps = num(meta?.feeBps, 10);
  return `//@version=5
strategy(${pineStr(meta?.name || "Strategy")}, overlay=${overlay ? "true" : "false"}, default_qty_type=strategy.percent_of_equity, default_qty_value=${fmt(positionPct)}, commission_type=strategy.commission.percent, commission_value=${fmt(feeBps / 100)}, pyramiding=0, process_orders_on_close=false, calc_on_every_tick=false)`;
}

/**
 * Emit `key = input.int/float(...)` lines from a built-in's param defs, using
 * the entry's resolved param values as the input defaults so the exported
 * script starts on exactly what the user backtested.
 * @param {string} id       built-in strategy id
 * @param {object} params   resolved params
 * @returns {string}
 */
export function pineInputs(id, params) {
  const defs = DEFS[id] || [];
  return defs
    .map((d) => {
      const val = num(params?.[d.key], d.default);
      const isInt = Number.isInteger(d.step) && Number.isInteger(val);
      const fn = isInt ? "input.int" : "input.float";
      const parts = [fmt(val), pineStr(d.label)];
      if (d.min != null) parts.push(`minval=${fmt(d.min)}`);
      if (d.max != null) parts.push(`maxval=${fmt(d.max)}`);
      if (d.step != null) parts.push(`step=${fmt(d.step)}`);
      return `${d.key} = ${fn}(${parts.join(", ")})`;
    })
    .join("\n");
}

// ── per-built-in Pine v5 templates ──────────────────────────────────────────
// Each is (params, meta) => full Pine script. The input variable names match
// the strategies.js param keys, so pineInputs() wires them straight into the
// logic below.
const BUILTIN_SOURCE_PINE = {
  "sma-crossover": (p, meta) => `${pineHeader(meta, { overlay: true })}
// SMA Crossover — target long while the fast SMA is above the slow SMA, else flat.
${pineInputs("sma-crossover", p)}
fastMA = ta.sma(close, fast)
slowMA = ta.sma(close, slow)
if not na(fastMA) and not na(slowMA)
    if fastMA > slowMA
        strategy.entry("Long", strategy.long)
    else
        strategy.close("Long")
plot(fastMA, "Fast SMA", color=color.aqua)
plot(slowMA, "Slow SMA", color=color.orange)`,

  "ema-crossover": (p, meta) => `${pineHeader(meta, { overlay: true })}
// EMA Crossover — target long while the fast EMA is above the slow EMA, else flat.
// NOTE: the site seeds each EMA with the SMA of its first \`period\` values;
// Pine's ta.ema seeds recursively, so the earliest bars can differ slightly.
${pineInputs("ema-crossover", p)}
fastMA = ta.ema(close, fast)
slowMA = ta.ema(close, slow)
if not na(fastMA) and not na(slowMA)
    if fastMA > slowMA
        strategy.entry("Long", strategy.long)
    else
        strategy.close("Long")
plot(fastMA, "Fast EMA", color=color.aqua)
plot(slowMA, "Slow EMA", color=color.orange)`,

  "rsi-mean-reversion": (p, meta) => `${pineHeader(meta, { overlay: false })}
// RSI Mean Reversion — buy oversold, exit once RSI recovers past the exit level.
// ta.rsi uses Wilder smoothing, matching the site's RSI.
${pineInputs("rsi-mean-reversion", p)}
r = ta.rsi(close, period)
if not na(r)
    if strategy.position_size == 0
        if r < oversold
            strategy.entry("Long", strategy.long)
    else
        if r > exitLevel
            strategy.close("Long")
plot(r, "RSI", color=color.purple)
hline(oversold, "Oversold", color=color.gray)
hline(exitLevel, "Exit", color=color.gray)`,

  "momentum-roc": (p, meta) => `${pineHeader(meta, { overlay: false })}
// Momentum (ROC) — target long while rate-of-change is above the threshold.
// ta.roc = 100 * (close - close[period]) / close[period], matching the site.
${pineInputs("momentum-roc", p)}
r = ta.roc(close, period)
if not na(r)
    if r > threshold
        strategy.entry("Long", strategy.long)
    else
        strategy.close("Long")
plot(r, "ROC %", color=color.teal)
hline(threshold, "Threshold", color=color.gray)`,

  "bollinger-mean-reversion": (p, meta) => `${pineHeader(meta, { overlay: true })}
// Bollinger Mean Reversion — buy below the lower band, exit back at the mid.
// ta.stdev defaults to population std (biased=true), matching the site's bands.
${pineInputs("bollinger-mean-reversion", p)}
basis = ta.sma(close, period)
dev = ta.stdev(close, period) * mult
upper = basis + dev
lower = basis - dev
if not na(basis)
    if strategy.position_size == 0
        if close < lower
            strategy.entry("Long", strategy.long)
    else
        if close >= basis
            strategy.close("Long")
plot(basis, "Basis", color=color.orange)
plot(upper, "Upper", color=color.gray)
plot(lower, "Lower", color=color.gray)`,

  "donchian-breakout": (p, meta) => `${pineHeader(meta, { overlay: true })}
// Donchian Breakout — buy the prior N-bar high, exit on the prior M-bar low.
// Channels EXCLUDE the current bar (the [1] offset), matching the site — no
// look-ahead: the breakout is compared against bars strictly before this one.
${pineInputs("donchian-breakout", p)}
entryHigh = ta.highest(high, period)[1]
exitLow = ta.lowest(low, exitPeriod)[1]
if strategy.position_size == 0
    if not na(entryHigh) and close > entryHigh
        strategy.entry("Long", strategy.long)
else
    if not na(exitLow) and close < exitLow
        strategy.close("Long")
plot(entryHigh, "Entry high", color=color.aqua)
plot(exitLow, "Exit low", color=color.orange)`,

  // ── APPROXIMATE ───────────────────────────────────────────────────────────
  "opening-range-breakout": (p, meta) => `${pineHeader(meta, { overlay: true })}
// Opening Range Breakout (Intraday) — APPROXIMATE. VERIFY ON TRADINGVIEW.
// The site builds the range from the first N bars of each *UTC* day, so:
//   • \`rangeBars\` is a BAR COUNT — results depend on the chart interval.
//   • The new-day reset below uses the UTC calendar day. TradingView's chart
//     timezone, exchange sessions and DST can still shift the range vs the site.
// Bracket exits: stop on the far side of the range, take-profit at R x width.
// One trade per day, long & short. If longOnly=1, only the upside break trades.
${pineInputs("opening-range-breakout", p)}
var float rHi = na
var float rLo = na
var int rCount = 0
var bool rTraded = false
newDay = ta.change(dayofmonth(time, "UTC")) != 0
if newDay
    rHi := na
    rLo := na
    rCount := 0
    rTraded := false
    strategy.close_all()
if rCount < rangeBars
    rHi := na(rHi) ? high : math.max(rHi, high)
    rLo := na(rLo) ? low : math.min(rLo, low)
    rCount := rCount + 1
else if strategy.position_size == 0 and not rTraded
    width = rHi - rLo
    buf = width * stopBufferPct / 100
    if width > 0 and close > rHi
        rTraded := true
        strategy.entry("Long", strategy.long)
        strategy.exit("Long exit", "Long", stop=rLo - buf, limit=rHi + width * targetR)
    else if width > 0 and longOnly == 0 and close < rLo
        rTraded := true
        strategy.entry("Short", strategy.short)
        strategy.exit("Short exit", "Short", stop=rHi + buf, limit=rLo - width * targetR)
plot(rHi, "Range high", color=color.aqua)
plot(rLo, "Range low", color=color.orange)`,
};

/**
 * True only for builder entries with a verified Pine template.
 * @param {object} entry
 * @returns {boolean}
 */
export function hasPineSource(entry) {
  if (!entry) return false;
  if (entry.mode === "code" || typeof entry.code === "string") return false;
  return entry.mode === "builder" && entry.strategyId in BUILTIN_SOURCE_PINE;
}

/** An honest, comment-only note — deliberately NOT a runnable strategy(). */
function unsupportedNote(reason) {
  return `// Pine Script export unavailable for this strategy.
// ${String(reason).replace(/[\r\n]+/g, " ")}
// Custom code / unsupported — cannot be auto-translated to Pine faithfully.
// Rebuild the logic manually in TradingView's Pine editor.`;
}

/**
 * Export a strategy entry as a Pine Script v5 strategy(). Dispatches on
 * entry.mode; a builder with a known id yields a full script, anything else an
 * honest note. Never returns a fake strategy for code / unsupported entries.
 *
 * @param {object} entry  a lab strategy entry ({ mode, code, strategyId, params, name, positionPct, feeBps })
 * @returns {string}
 */
export function toPineScript(entry) {
  if (!entry) return unsupportedNote("No strategy entry provided.");

  if (entry.mode === "code" || typeof entry.code === "string") {
    return unsupportedNote(
      `This entry is raw ${entry.language === "python" ? "Python" : "JavaScript"} code (mode: "code").`
    );
  }

  if (entry.mode === "builder" && entry.strategyId) {
    const gen = BUILTIN_SOURCE_PINE[entry.strategyId];
    if (!gen) {
      return unsupportedNote(
        `Builder id ${JSON.stringify(String(entry.strategyId))} has no verified Pine template.`
      );
    }
    const meta = {
      positionPct: entry.positionPct,
      feeBps: entry.feeBps,
      name: entry.name || NAMES[entry.strategyId] || entry.strategyId,
    };
    return gen(entry.params || {}, meta);
  }

  return unsupportedNote("This entry has no builder id or code to translate.");
}
