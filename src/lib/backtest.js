// backtest.js — event-driven, look-ahead-free long/flat backtesting engine.
//
// Execution model:
//   * signalFn(ctx) is called once per bar AFTER that bar closes.
//   * The returned target position ("long" | "flat") is executed at the
//     NEXT bar's open — never on the bar the signal was generated on.
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

/**
 * Run a long/flat backtest.
 *
 * @param {Object} options
 * @param {Array}    options.candles        Ascending candle array ({time /* unix seconds *\/, open, high, low, close, volume}).
 * @param {Function} options.signalFn       (ctx) => "long" | "flat". ctx = { candles, index, close, position, indicators }.
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
  let cash = initialCapital;
  let units = 0; // asset units held while long
  let position = "flat"; // "long" | "flat"
  let pendingTarget = null; // target position to execute at the next bar's open

  // Open-trade bookkeeping.
  let entryTime = 0;
  let entryPrice = 0;
  let entryIndex = 0;
  let entryCost = 0; // capital committed at entry (pre-fee cash), pnl base

  const equity = [];
  const trades = [];
  let barsInMarket = 0;
  let firstErrorLogged = false;

  const closeTrade = (exitTime, exitPrice, exitIndex) => {
    const proceeds = units * exitPrice * (1 - fee);
    trades.push({
      entryTime,
      exitTime,
      entryPrice,
      exitPrice,
      pnl: proceeds - entryCost,
      pnlPct: entryCost > 0 ? ((proceeds - entryCost) / entryCost) * 100 : 0,
      bars: exitIndex - entryIndex,
    });
    cash = proceeds;
    units = 0;
    position = "flat";
  };

  // --- Main loop -----------------------------------------------------------
  for (let i = 0; i < n; i++) {
    const bar = candles[i];

    // 1) Execute the order decided on the previous bar, at this bar's open.
    if (pendingTarget !== null && pendingTarget !== position) {
      if (pendingTarget === "long") {
        entryCost = cash;
        units = (cash * (1 - fee)) / bar.open; // entry fee reduces size
        cash = 0;
        position = "long";
        entryTime = bar.time;
        entryPrice = bar.open;
        entryIndex = i;
      } else {
        closeTrade(bar.time, bar.open, i);
      }
    }
    pendingTarget = null;

    if (position === "long") barsInMarket++;

    // 2) Mark to market at this bar's close.
    equity.push({
      time: bar.time,
      value: position === "long" ? units * bar.close : cash,
    });

    // 3) Evaluate the signal for this closed bar (executes next bar).
    try {
      const target = signalFn({
        candles,
        index: i,
        close: bar.close,
        position,
        indicators: ind,
      });
      pendingTarget = target === "long" ? "long" : "flat";
    } catch (err) {
      if (!firstErrorLogged) {
        warnings.push(`Strategy error at bar ${i} (${bar.time}): ${err && err.message ? err.message : String(err)}`);
        firstErrorLogged = true;
      }
      pendingTarget = "flat";
    }
  }

  // 4) Force-close any open position at the last bar's close.
  const last = candles[n - 1];
  if (position === "long") {
    closeTrade(last.time, last.close, n - 1);
    // The last mark-to-market did not include the exit fee — correct it so the
    // final equity value matches realized cash.
    equity[equity.length - 1] = { time: last.time, value: cash };
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
export const DEFAULT_STRATEGY_CODE = `// Strategie: SMA 20/50 Crossover
//
// Your code must define a function called \`strategy(ctx)\` that returns
// either "long" (be invested) or "flat" (hold cash). It is called once per
// bar AFTER the bar closes; orders execute at the NEXT bar's open.
//
// ctx contains:
//   ctx.candles    - the full candle array [{ time, open, high, low, close, volume }]
//   ctx.index      - index of the current (just closed) bar
//   ctx.close      - close price of the current bar
//   ctx.position   - your current position, "long" or "flat"
//   ctx.indicators - the indicators module (sma, ema, rsi, roc, atr,
//                    bollinger, donchian, closes)

function strategy(ctx) {
  const { indicators, candles, index } = ctx;

  // Compute both moving averages over the close prices.
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
 * Compile user JavaScript source into a signalFn usable by runBacktest.
 *
 * The source must define `function strategy(ctx) { ... }` returning
 * "long" or "flat". The indicators module is injected as `indicators`
 * (also reachable via ctx.indicators).
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

  let compiled;
  try {
    // The wrapper runs the user code, then calls their strategy per bar.
    const wrapped = code + "\n;return strategy(ctx);";
    compiled = new Function("ctx", "indicators", wrapped);
  } catch (err) {
    throw new Error(
      `Strategy code failed to compile: ${err && err.message ? err.message : String(err)}`
    );
  }

  // Inject the indicators module; runBacktest already puts it on ctx too.
  return (ctx) => compiled(ctx, ind);
}
