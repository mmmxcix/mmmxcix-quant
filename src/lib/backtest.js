// backtest.js — event-driven, look-ahead-free backtesting engine.
//
// Position model: flat / long / short (all-in on current equity).
//
// Execution model:
//   * signalFn(ctx) is called once per bar AFTER that bar closes.
//   * The return decides the target position for the NEXT bar's open:
//       - "long" | "short" | "flat"  (a plain string), or
//       - { signal: "long"|"short"|"flat", stop, target }  (bracket order).
//     Direction changes and flattening execute at the next bar's open — never
//     on the bar the signal was generated on.
//   * Bracket exits (stop / target) are LIVE orders: once in a position they
//     are checked intrabar against each bar's high/low (including the entry
//     bar) and fill at the bracket price the moment it is touched. If both the
//     stop and target fall inside one bar, the stop is assumed to fill first
//     (conservative). Brackets can be updated while holding (e.g. trailing
//     stops) by returning the same direction with new stop/target levels.
//   * feeBps is charged per side (entry and exit) on the traded notional.
//   * Equity is marked to market at every bar close.

import * as ind from "./indicators.js";

/**
 * Compute the median of an array of numbers (non-mutating).
 * @param {number[]} arr
 * @returns {number}
 */
function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** A finite number, or null. Used to sanitise user-supplied bracket levels. */
function finiteOrNull(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Normalise a raw signal return into { signal, stop, target }.
 * Accepts the plain strings "long" | "short" | "flat" (back-compat with the
 * original long/flat engine) or an object carrying bracket levels. Anything
 * unrecognised becomes "flat".
 */
function normalizeSignal(raw) {
  if (raw === "long" || raw === "short" || raw === "flat") {
    return { signal: raw, stop: undefined, target: undefined };
  }
  if (raw && typeof raw === "object") {
    const s = raw.signal;
    if (s === "long" || s === "short" || s === "flat") {
      return { signal: s, stop: raw.stop, target: raw.target };
    }
  }
  return { signal: "flat", stop: undefined, target: undefined };
}

/**
 * Run a long / short / flat backtest.
 *
 * @param {Object} options
 * @param {Array}    options.candles        Ascending candle array ({time /* unix seconds *\/, open, high, low, close, volume}).
 * @param {Function} options.signalFn       (ctx) => "long"|"short"|"flat" | { signal, stop, target }.
 *                                          ctx = { candles, index, time, open, high, low, close,
 *                                                  position, session, indicators }.
 * @param {number}  [options.initialCapital=10000]
 * @param {number}  [options.feeBps=10]     Fee per side in basis points.
 * @returns {{ equity:Array, buyHold:Array, trades:Array, metrics:Object, warnings:string[] }}
 */
export function runBacktest({ candles, signalFn, initialCapital = 10000, feeBps = 10 }) {
  const warnings = [];

  const emptyResult = () => ({
    equity: [],
    buyHold: [],
    trades: [],
    metrics: {
      totalReturnPct: 0,
      buyHoldReturnPct: 0,
      cagrPct: 0,
      sharpe: 0,
      maxDrawdownPct: 0,
      winRatePct: 0,
      profitFactor: 0,
      tradeCount: 0,
      exposurePct: 0,
    },
    warnings,
  });

  if (!Array.isArray(candles) || candles.length === 0) {
    warnings.push("No candles provided — nothing to backtest.");
    return emptyResult();
  }
  if (typeof signalFn !== "function") {
    warnings.push("signalFn is not a function — nothing to backtest.");
    return emptyResult();
  }

  const fee = feeBps / 10000;
  const n = candles.length;

  // --- Portfolio state -----------------------------------------------------
  let equityVal = initialCapital; // realised equity; equals cash while flat
  let position = "flat"; // "long" | "short" | "flat"
  let dir = 0; // +1 long, -1 short, 0 flat
  let units = 0; // asset units in the open position
  let pending = null; // { signal, stop, target } to execute at the next open

  // Open-trade bookkeeping.
  let entryTime = 0;
  let entryPrice = 0;
  let entryIndex = 0;
  let entryEquity = 0; // equity just BEFORE the entry fee (pnl base)
  let equityAfterEntry = 0; // equity right after paying the entry fee
  let stopLevel = null;
  let targetLevel = null;

  const equity = [];
  const trades = [];
  let barsInMarket = 0;
  let firstErrorLogged = false;

  // Equity if the open position were marked at `price` (realised if flat).
  const markToMarket = (price) =>
    position === "flat" ? equityVal : equityAfterEntry + dir * units * (price - entryPrice);

  const openPosition = (sig, price, i, stop, target) => {
    dir = sig === "long" ? 1 : -1;
    entryEquity = equityVal;
    equityAfterEntry = equityVal * (1 - fee); // entry fee reduces working capital
    units = price > 0 ? equityAfterEntry / price : 0;
    entryPrice = price;
    entryTime = candles[i].time;
    entryIndex = i;
    position = sig;
    stopLevel = finiteOrNull(stop);
    targetLevel = finiteOrNull(target);
  };

  const closePosition = (price, i, reason) => {
    const gross = equityAfterEntry + dir * units * (price - entryPrice);
    const exitFee = units * price * fee;
    const finalEq = gross - exitFee;
    trades.push({
      entryTime,
      exitTime: candles[i].time,
      entryPrice,
      exitPrice: price,
      side: position, // "long" | "short"
      reason, // "signal" | "stop" | "target" | "eod"
      pnl: finalEq - entryEquity,
      pnlPct: entryEquity > 0 ? ((finalEq - entryEquity) / entryEquity) * 100 : 0,
      bars: i - entryIndex,
    });
    equityVal = finalEq;
    position = "flat";
    dir = 0;
    units = 0;
    stopLevel = null;
    targetLevel = null;
  };

  // Intrabar bracket exit for the position carried into / opened on bar i.
  // Stop is assumed to fill before the target when both sit inside the bar.
  const checkBrackets = (bar, i) => {
    if (position === "long") {
      if (stopLevel !== null && bar.low <= stopLevel) return closePosition(stopLevel, i, "stop");
      if (targetLevel !== null && bar.high >= targetLevel) return closePosition(targetLevel, i, "target");
    } else if (position === "short") {
      if (stopLevel !== null && bar.high >= stopLevel) return closePosition(stopLevel, i, "stop");
      if (targetLevel !== null && bar.low <= targetLevel) return closePosition(targetLevel, i, "target");
    }
  };

  // --- Main loop -----------------------------------------------------------
  let prevDayIndex = null;
  for (let i = 0; i < n; i++) {
    const bar = candles[i];

    // 1) Execute the order decided on the previous bar, at this bar's open.
    if (pending !== null) {
      const sig = pending.signal;
      // Close the current position if we're flattening or reversing.
      if (position !== "flat" && (sig === "flat" || sig !== position)) {
        closePosition(bar.open, i, "signal");
      }
      if (sig === "long" || sig === "short") {
        if (position === "flat") {
          openPosition(sig, bar.open, i, pending.stop, pending.target);
        } else if (sig === position) {
          // Same direction: allow bracket updates (e.g. trailing the stop).
          if (pending.stop !== undefined) stopLevel = finiteOrNull(pending.stop);
          if (pending.target !== undefined) targetLevel = finiteOrNull(pending.target);
        }
      }
      pending = null;
    }

    // 2) Intrabar bracket exit for whatever position we now hold this bar.
    const inPositionThisBar = position !== "flat";
    checkBrackets(bar, i);
    if (inPositionThisBar) barsInMarket++;

    // 3) Mark to market at this bar's close.
    equity.push({ time: bar.time, value: markToMarket(bar.close) });

    // 4) Evaluate the signal for this closed bar (executes next bar).
    const dayIndex = Math.floor(bar.time / 86400);
    const d = new Date(bar.time * 1000);
    const session = {
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
      minuteOfDay: d.getUTCHours() * 60 + d.getUTCMinutes(),
      dayIndex,
      isNewDay: prevDayIndex === null || dayIndex !== prevDayIndex,
    };
    prevDayIndex = dayIndex;

    try {
      const raw = signalFn({
        candles,
        index: i,
        time: bar.time,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        position,
        session,
        indicators: ind,
      });
      pending = normalizeSignal(raw);
    } catch (err) {
      if (!firstErrorLogged) {
        warnings.push(`Strategy error at bar ${i} (${bar.time}): ${err && err.message ? err.message : String(err)}`);
        firstErrorLogged = true;
      }
      pending = { signal: "flat" };
    }
  }

  // 5) Force-close any open position at the last bar's close.
  const last = candles[n - 1];
  if (position !== "flat") {
    closePosition(last.close, n - 1, "eod");
    // The last mark-to-market excluded the exit fee — correct it to realised.
    equity[equity.length - 1] = { time: last.time, value: equityVal };
  }

  // --- Buy & hold benchmark (close-to-close, same starting capital) --------
  const baseClose = candles[0].close;
  const buyHold = candles.map((c) => ({
    time: c.time,
    value: initialCapital * (c.close / baseClose),
  }));

  // --- Metrics ---------------------------------------------------------------
  const finalEquity = equity[equity.length - 1].value;
  const totalReturnPct = (finalEquity / initialCapital - 1) * 100;
  const buyHoldReturnPct = (last.close / baseClose - 1) * 100;

  // CAGR from elapsed calendar time (365-day year).
  const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;
  const spanYears = (last.time - candles[0].time) / SECONDS_PER_YEAR;
  let cagrPct = 0;
  if (spanYears > 0 && finalEquity > 0) {
    cagrPct = (Math.pow(finalEquity / initialCapital, 1 / spanYears) - 1) * 100;
  } else {
    cagrPct = totalReturnPct;
  }

  // Annualized Sharpe (rf = 0) from per-bar equity returns. Periods per year
  // are inferred from the median bar spacing in seconds.
  const spacings = [];
  for (let i = 1; i < n; i++) spacings.push(candles[i].time - candles[i - 1].time);
  const medianSpacing = median(spacings);
  const periodsPerYear = medianSpacing > 0 ? SECONDS_PER_YEAR / medianSpacing : 0;

  const returns = [];
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1].value;
    if (prev > 0) returns.push(equity[i].value / prev - 1);
  }
  let sharpe = 0;
  if (returns.length >= 2 && periodsPerYear > 0) {
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance =
      returns.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (returns.length - 1);
    const std = Math.sqrt(variance);
    sharpe = std > 0 ? (mean / std) * Math.sqrt(periodsPerYear) : 0;
  }

  // Max drawdown on the equity curve.
  let peak = -Infinity;
  let maxDrawdownPct = 0;
  for (const point of equity) {
    if (point.value > peak) peak = point.value;
    if (peak > 0) {
      const dd = ((peak - point.value) / peak) * 100;
      if (dd > maxDrawdownPct) maxDrawdownPct = dd;
    }
  }

  // Trade statistics.
  const wins = trades.filter((t) => t.pnl > 0);
  const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = trades.reduce((a, t) => a + (t.pnl < 0 ? -t.pnl : 0), 0);
  const winRatePct = trades.length > 0 ? (wins.length / trades.length) * 100 : 0;
  const profitFactor =
    grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  return {
    equity,
    buyHold,
    trades,
    metrics: {
      totalReturnPct,
      buyHoldReturnPct,
      cagrPct,
      sharpe,
      maxDrawdownPct,
      winRatePct,
      profitFactor,
      tradeCount: trades.length,
      exposurePct: (barsInMarket / n) * 100,
    },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// User-code strategy compilation
// ---------------------------------------------------------------------------

/** Example strategy source shown to the user in the code editor. */
export const DEFAULT_STRATEGY_CODE = `// Strategy: SMA 20/50 Crossover
//
// Your code must define a function called \`strategy(ctx)\` that returns a
// target position for the NEXT bar's open. Return either:
//   "long" | "short" | "flat"                         — a plain position, or
//   { signal: "long", stop: 95, target: 110 }         — with bracket exits.
//
// Bracket stop/target are live orders: once in the trade they are checked
// intrabar against each bar's high/low and fill at the touched price.
//
// ctx contains:
//   ctx.candles    - full candle array [{ time, open, high, low, close, volume }]
//   ctx.index      - index of the current (just closed) bar
//   ctx.open/high/low/close - this bar's OHLC
//   ctx.position   - current position: "long" | "short" | "flat"
//   ctx.session    - { hour, minute, minuteOfDay, isNewDay } in UTC
//   ctx.indicators - module (sma, ema, rsi, roc, atr, bollinger, donchian, macd, closes)

function strategy(ctx) {
  const { indicators, candles, index } = ctx;

  const prices = indicators.closes(candles);
  const fast = indicators.sma(prices, 20);
  const slow = indicators.sma(prices, 50);

  // During the warm-up window the indicators are null: stay in cash.
  if (fast[index] === null || slow[index] === null) return "flat";

  // Long while the fast average is above the slow average.
  return fast[index] > slow[index] ? "long" : "flat";
}
`;

/**
 * Opening Range Breakout — showcases the intraday features (session reset,
 * short side, stop/target brackets). Best on an intraday interval (e.g. 5m).
 */
export const ORB_STRATEGY_CODE = `// Opening Range Breakout (intraday)
//
// Builds a range from the first N bars of each UTC day, then trades a break
// of that range with the opposite side as the stop and a fixed R multiple as
// the target. One trade per day. Use an intraday interval (e.g. 5m).
//
// State is kept in closure vars — runBacktest calls strategy() once per bar
// in order, so this is safe.

const RANGE_BARS = 6;   // first 6 bars = opening range (6 x 5m = 30 min)
const TARGET_R = 1;     // take profit at 1x the range width
const LONG_ONLY = false;

let hi = -Infinity, lo = Infinity, count = 0, traded = false, side = 0, stop = 0, target = 0;

function strategy(ctx) {
  if (ctx.session.isNewDay) { hi = -Infinity; lo = Infinity; count = 0; traded = false; side = 0; }

  // Phase 1: build the opening range (flat — this also exits any leftover trade).
  if (count < RANGE_BARS) {
    hi = Math.max(hi, ctx.high);
    lo = Math.min(lo, ctx.low);
    count++;
    return "flat";
  }

  // Phase 2: hold an open trade; brackets do the exiting.
  if (ctx.position !== "flat") {
    return side === 1 ? { signal: "long", stop, target } : { signal: "short", stop, target };
  }

  // Phase 3: one breakout entry per day.
  if (traded) return "flat";
  const width = hi - lo;
  if (width <= 0) return "flat";

  if (ctx.close > hi) {
    side = 1; traded = true; stop = lo; target = hi + width * TARGET_R;
    return { signal: "long", stop, target };
  }
  if (!LONG_ONLY && ctx.close < lo) {
    side = -1; traded = true; stop = hi; target = lo - width * TARGET_R;
    return { signal: "short", stop, target };
  }
  return "flat";
}
`;

/**
 * Compile user JavaScript source into a signalFn usable by runBacktest.
 *
 * The source must define `function strategy(ctx) { ... }` returning a position
 * ("long"|"short"|"flat") or a bracket object. The indicators module is
 * injected as `indicators` (also reachable via ctx.indicators).
 *
 * @param {string} code
 * @returns {Function} signalFn(ctx)
 * @throws {Error} on syntax errors or if no `strategy` function is defined
 */
export function compileStrategy(code) {
  if (typeof code !== "string" || code.trim() === "") {
    throw new Error("Strategy code is empty — define a strategy(ctx) function.");
  }

  // Cheap static check so we can give a clear message before running anything.
  const definesStrategy =
    /\bfunction\s+strategy\s*\(/.test(code) ||
    /\b(?:const|let|var)\s+strategy\s*=/.test(code);
  if (!definesStrategy) {
    throw new Error(
      'Strategy code must define a function named "strategy", e.g. `function strategy(ctx) { return "flat"; }`.'
    );
  }

  let strat;
  try {
    // Evaluate the user source ONCE: it defines strategy() (and any top-level
    // state it keeps in closure) and hands the function back. Running once —
    // rather than re-running the whole source every bar — lets stateful
    // strategies (e.g. an opening-range that accumulates across bars) work.
    const factory = new Function("indicators", code + "\n;return strategy;");
    strat = factory(ind);
  } catch (err) {
    throw new Error(
      `Strategy code failed to compile: ${err && err.message ? err.message : String(err)}`
    );
  }
  if (typeof strat !== "function") {
    throw new Error('Strategy code must define a function named "strategy".');
  }

  // ctx.indicators is also set by runBacktest, so strategies can use either.
  return (ctx) => strat(ctx);
}
