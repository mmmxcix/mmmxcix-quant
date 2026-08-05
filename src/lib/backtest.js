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
 * @param {number}  [options.positionPct=100]  Percent of current equity deployed
 *                  per trade (fractional sizing; the rest sits in cash). 100 =
 *                  the classic all-in model.
 * @returns {{ equity:Array, buyHold:Array, trades:Array, metrics:Object, warnings:string[] }}
 */
export function runBacktest({ candles, signalFn, initialCapital = 10000, feeBps = 10, positionPct = 100, leverage = 1, fundingRates = null }) {
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
      sortino: 0,
      calmar: 0,
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
  // Leverage multiplies the deployed notional: 3x turns a 100% position into 300%
  // exposure, amplifying both returns AND drawdowns (and enabling liquidation).
  const lev = Math.min(10, Math.max(1, Number(leverage) || 1));
  const posFrac = (Math.min(100, Math.max(1, positionPct)) / 100) * lev;
  const n = candles.length;
  let liquidated = false; // set once leverage drives equity to zero

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
  // Per-bar desired position (+1 long / 0 flat / −1 short) the strategy signalled
  // AFTER that bar closed — index-aligned to candles. Lets callers measure the
  // Information Coefficient (does the signal actually predict the next bar?).
  const signals = new Array(candles.length).fill(0);
  let barsInMarket = 0;
  let firstErrorLogged = false;

  // Equity if the open position were marked at `price` (realised if flat).
  const markToMarket = (price) =>
    position === "flat" ? equityVal : equityAfterEntry + dir * units * (price - entryPrice);

  const openPosition = (sig, price, i, stop, target) => {
    dir = sig === "long" ? 1 : -1;
    entryEquity = equityVal;
    // Deploy only posFrac of equity; the remainder stays in cash. The entry
    // fee is charged on the deployed notional only.
    const committed = equityVal * posFrac;
    equityAfterEntry = equityVal - committed * fee;
    units = price > 0 ? (committed * (1 - fee)) / price : 0;
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

  // Perpetual funding: crypto perps pay/receive funding at each funding time
  // (~every 8h). Ignoring it is where most crypto backtests quietly lie — a
  // long in a persistently positive-funding market bleeds it continuously. Fed
  // as [{ time, rate }] (rate = fraction, e.g. 0.0001 = 0.01%); applied to the
  // OPEN position's notional as the funding stamp is crossed.
  const funding = Array.isArray(fundingRates) && fundingRates.length
    ? [...fundingRates].filter((f) => Number.isFinite(f?.time) && Number.isFinite(f?.rate)).sort((a, b) => a.time - b.time)
    : null;
  let fIdx = 0;
  let fundingPaid = 0;

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

    // 2b) Charge/credit funding for every funding stamp at or before this bar's
    // time while a position is held. A long pays when the rate is positive; a
    // short receives it. Deducted from the position's realised base so it
    // compounds into the mark and carries to the exit.
    if (funding) {
      while (fIdx < funding.length && funding[fIdx].time <= bar.time) {
        if (position !== "flat") {
          const notional = units * bar.close;
          const pay = dir * notional * funding[fIdx].rate; // long+posRate → positive → cost
          equityAfterEntry -= pay;
          fundingPaid += pay;
        }
        fIdx++;
      }
    }

    // 3) Mark to market at this bar's close. Under leverage, a mark ≤ 0 means the
    // account was wiped out — liquidate once, then the curve stays at zero.
    const mv = markToMarket(bar.close);
    if (!liquidated && mv <= 0) {
      liquidated = true;
      warnings.unshift(`⚠ Liquidated at ${lev}x leverage — equity hit zero on ${new Date(bar.time * 1000).toISOString().slice(0, 10)}. The result past this point is void; lower the leverage.`);
      equityVal = 0; position = "flat"; dir = 0; units = 0; stopLevel = null; targetLevel = null;
    }
    equity.push({ time: bar.time, value: liquidated ? 0 : mv });
    if (liquidated) { prevDayIndex = Math.floor(bar.time / 86400); continue; }

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
    signals[i] = pending.signal === "long" ? 1 : pending.signal === "short" ? -1 : 0;
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

  // Annualised Sharpe of any equity curve. Buy & hold gets one too, so a
  // strategy can be judged on whether it actually beats HOLDING risk-adjusted —
  // a strategy with a real statistical edge can still be worse than just sitting
  // in the asset during a bull market, and that must be visible.
  const sharpeOf = (curve) => {
    const r = [];
    for (let i = 1; i < curve.length; i++) {
      const prev = curve[i - 1].value;
      if (prev > 0) r.push(curve[i].value / prev - 1);
    }
    if (r.length < 2 || periodsPerYear <= 0) return 0;
    const mean = r.reduce((a, b) => a + b, 0) / r.length;
    const variance = r.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (r.length - 1);
    const std = Math.sqrt(variance);
    return std > 0 ? (mean / std) * Math.sqrt(periodsPerYear) : 0;
  };
  const sharpe = sharpeOf(equity);
  const buyHoldSharpe = sharpeOf(buyHold);

  // Sortino — like Sharpe but only DOWNSIDE deviation is penalised (upside
  // volatility isn't risk). Same annualisation as Sharpe.
  const sortinoOf = (curve) => {
    const r = [];
    for (let i = 1; i < curve.length; i++) {
      const prev = curve[i - 1].value;
      if (prev > 0) r.push(curve[i].value / prev - 1);
    }
    if (r.length < 2 || periodsPerYear <= 0) return 0;
    const mean = r.reduce((a, b) => a + b, 0) / r.length;
    const downside = r.filter((x) => x < 0);
    if (!downside.length) return mean > 0 ? Infinity : 0;
    const dd = Math.sqrt(downside.reduce((a, b) => a + b * b, 0) / downside.length);
    return dd > 0 ? (mean / dd) * Math.sqrt(periodsPerYear) : 0;
  };
  const sortino = sortinoOf(equity);

  // Max drawdown on the equity curve (and on buy & hold, for a fair
  // risk-adjusted comparison — B&H's pain is otherwise invisible).
  const maxDD = (curve) => {
    let peak = -Infinity, dd = 0;
    for (const point of curve) {
      if (point.value > peak) peak = point.value;
      if (peak > 0) dd = Math.max(dd, ((peak - point.value) / peak) * 100);
    }
    return dd;
  };
  const maxDrawdownPct = maxDD(equity);
  const buyHoldMaxDrawdownPct = maxDD(buyHold);

  // Calmar — CAGR per unit of max drawdown. The return-vs-worst-pain ratio.
  const calmar = maxDrawdownPct > 0 ? cagrPct / maxDrawdownPct : cagrPct > 0 ? Infinity : 0;

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
    signals,
    metrics: {
      totalReturnPct,
      buyHoldReturnPct,
      cagrPct,
      sharpe,
      buyHoldSharpe,
      sortino,
      calmar,
      maxDrawdownPct,
      buyHoldMaxDrawdownPct,
      winRatePct,
      profitFactor,
      tradeCount: trades.length,
      exposurePct: (barsInMarket / n) * 100,
      // Total funding paid (positive) or received (negative) over the run, as a
      // % of starting capital. Only meaningful when fundingRates were supplied.
      fundingPaidPct: funding ? (fundingPaid / initialCapital) * 100 : null,
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
 * The Charts page's rule-based bias check as a backtestable strategy: six of
 * its nine rules re-implemented causally (no look-ahead). Trendlines, S/R-room
 * and double patterns are omitted — they need bilateral context that is too
 * unstable to evaluate bar-by-bar.
 */
export const BIAS_STRATEGY_CODE = `// Bias Score strategy — the Charts "bias check" as testable code.
//
// Six fixed rules vote +1 (bullish) / -1 (bearish) / 0 each bar:
//   1. close vs SMA50          2. SMA20 vs SMA50
//   3. RSI(14) >55 / <45       4. MACD line vs signal line
//   5. swing structure (HH+HL / LH+LL, pivots confirmed with 5-bar delay)
//   6. last unfilled fair value gap within 80 bars (close-through = filled)
// Score >= +2 -> long, <= -2 -> short, else flat. Exits via ATR bracket
// (stop 1.5 ATR, target 2R) or when the score leaves the zone.
//
// Note: the Charts panel uses 9 rules (incl. trendlines, S/R room, patterns);
// this code implements the 6 that can be computed causally per bar, so
// results will differ from the live panel readout.

const L = 5;          // pivot lookback (confirmation delay = L bars)
const FVG_WINDOW = 80;
const ENTER = 2;      // |score| needed to enter

// Heavy arrays are computed once per candle array and reused every bar.
let cachedFor = null;
let A = null;

function precompute(candles, ind) {
  const closes = ind.closes(candles);
  const n = candles.length;

  // Confirmed swing pivots: pivot at p is usable from bar p + L onward.
  const pivHi = [], pivLo = [];
  for (let p = L; p < n - L; p++) {
    let isH = true, isL = true;
    for (let j = p - L; j <= p + L; j++) {
      if (j === p) continue;
      if (candles[j].high > candles[p].high) isH = false;
      if (candles[j].low < candles[p].low) isL = false;
      if (!isH && !isL) break;
    }
    if (isH) pivHi.push({ i: p, price: candles[p].high });
    if (isL) pivLo.push({ i: p, price: candles[p].low });
  }

  // Fair value gaps with their (causal) close-through fill index.
  const fvgs = [];
  for (let g = 2; g < n; g++) {
    const a = candles[g - 2], c = candles[g];
    let kind = null, top = 0, bottom = 0;
    if (c.low > a.high) { kind = 1; top = c.low; bottom = a.high; }
    else if (a.low > c.high) { kind = -1; top = a.low; bottom = c.high; }
    if (!kind) continue;
    let fill = Infinity;
    for (let j = g + 1; j < n; j++) {
      if (kind === 1 && candles[j].close <= bottom) { fill = j; break; }
      if (kind === -1 && candles[j].close >= top) { fill = j; break; }
    }
    fvgs.push({ i: g, kind, fill });
  }

  return {
    sma20: ind.sma(closes, 20),
    sma50: ind.sma(closes, 50),
    rsi14: ind.rsi(closes, 14),
    macd: ind.macd(closes),
    atr14: ind.atr(candles, 14),
    pivHi, pivLo, fvgs,
  };
}

// Last two confirmed pivots strictly before bar i (array is index-sorted).
function lastTwo(pivots, i) {
  let a = null, b = null;
  for (let k = pivots.length - 1; k >= 0; k--) {
    if (pivots[k].i <= i - L) { if (!b) b = pivots[k]; else { a = pivots[k]; break; } }
  }
  return a && b ? [a, b] : null;
}

let stop = 0, target = 0, side = 0;

function strategy(ctx) {
  const { candles, index: i, close } = ctx;
  if (cachedFor !== candles) { cachedFor = candles; A = precompute(candles, ctx.indicators); }
  if (i < 60 || A.sma50[i] === null || A.rsi14[i] === null || A.atr14[i] === null) return "flat";

  let score = 0;
  // 1) price vs SMA50   2) SMA alignment
  score += close > A.sma50[i] ? 1 : -1;
  if (A.sma20[i] !== null) score += A.sma20[i] > A.sma50[i] ? 1 : -1;
  // 3) RSI momentum
  score += A.rsi14[i] > 55 ? 1 : A.rsi14[i] < 45 ? -1 : 0;
  // 4) MACD vs signal
  if (A.macd[i]) score += A.macd[i].macd > A.macd[i].signal ? 1 : -1;
  // 5) swing structure
  const hs = lastTwo(A.pivHi, i), ls = lastTwo(A.pivLo, i);
  if (hs && ls) {
    const hh = hs[1].price > hs[0].price, hl = ls[1].price > ls[0].price;
    score += hh && hl ? 1 : !hh && !hl ? -1 : 0;
  }
  // 6) last unfilled FVG in the recent window (as of THIS bar)
  for (let k = A.fvgs.length - 1; k >= 0; k--) {
    const g = A.fvgs[k];
    if (g.i > i) continue;
    if (g.i < i - FVG_WINDOW) break;
    if (g.fill <= i) continue; // already filled by now
    score += g.kind;
    break;
  }

  const atr = A.atr14[i];

  // Holding: keep riding while the score stays on our side; brackets do exits.
  if (ctx.position === "long" && side === 1) {
    if (score >= 0) return { signal: "long", stop, target };
    side = 0; return "flat";
  }
  if (ctx.position === "short" && side === -1) {
    if (score <= 0) return { signal: "short", stop, target };
    side = 0; return "flat";
  }

  // Flat: enter only on a clear score.
  if (score >= ENTER) {
    side = 1; stop = close - atr * 1.5; target = close + atr * 3;
    return { signal: "long", stop, target };
  }
  if (score <= -ENTER) {
    side = -1; stop = close + atr * 1.5; target = close - atr * 3;
    return { signal: "short", stop, target };
  }
  side = 0;
  return "flat";
}
`;

/**
 * Research result (July 2026): the bias score evolved into a symmetric,
 * bias-gated trend breakout. Tuned in-sample on 2023-25 bull data, the
 * long-only version FAILED out-of-sample in the 2026 bear (PF 0.30) — the
 * symmetric version below survived a never-touched validation set including
 * the full 2022 bear. Pooled over 783 cost-loaded trades (4 majors, 4h,
 * 2021-2026): EV +1.48%/trade, 95% CI [0.33%, 2.89%], P(EV<=0) = 0.0038.
 * Per symbol the edge is thin (PF 1.05-1.20) and all-in sizing produces
 * 46-72% drawdowns — real edge, hard path. See the code header for the story.
 */
export const BIAS_TREND_CODE = `// Bias Trend Breakout (researched) — long/short, 4h-tested
//
// HOW THIS WAS BUILT (and why you should care):
//   1. The raw bias score (see the other example) LOSES money as a signal.
//   2. Gating a 30-bar Donchian breakout with the score + EMA200 regime was
//      profitable in-sample (2023-25 bull, 4 crypto majors, PF 1.4-2.1).
//   3. The long-only version then FAILED the out-of-sample 2026 bear
//      (PF 0.30 on all four symbols). Lesson: bull-tuned long-only dies.
//   4. This symmetric version (identical frozen parameters, mirrored short
//      side) was validated on 2021-2026 INCLUDING the untouched 2022 bear:
//      positive in 2022 on all four symbols, pooled EV +1.48%/trade after
//      10 bps/side costs, P(EV<=0) = 0.0038 over 783 trades.
// Honest limits: per-symbol profit factor is only 1.05-1.20, returns are
// carried unevenly, and all-in compounding produces 45-70% drawdowns —
// with fractional sizing (not available in this engine) risk would scale
// down proportionally. Educational, not investment advice.
//
// Rules:
//   LONG  entry: close breaks above the prior 30-bar high, bias score >= +2,
//                close > EMA200. Initial stop 3 ATR below.
//   SHORT entry: mirror image (30-bar low, score <= -2, close < EMA200).
//   Exit: close crossing the opposite 15-bar Donchian band, the ATR stop,
//         or use the score flip — whichever comes first.

let cachedFor = null, A = null;
let stop = 0;

function precompute(candles, ind) {
  const closes = ind.closes(candles);
  return {
    sma20: ind.sma(closes, 20),
    sma50: ind.sma(closes, 50),
    ema200: ind.ema(closes, 200),
    rsi14: ind.rsi(closes, 14),
    macd: ind.macd(closes),
    atr14: ind.atr(candles, 14),
    donE: ind.donchian(candles, 30),
    donX: ind.donchian(candles, 15),
  };
}

function biasScore(A, candles, i) {
  if (A.sma50[i] === null || A.rsi14[i] === null) return null;
  let s = 0;
  s += candles[i].close > A.sma50[i] ? 1 : -1;
  if (A.sma20[i] !== null) s += A.sma20[i] > A.sma50[i] ? 1 : -1;
  s += A.rsi14[i] > 55 ? 1 : A.rsi14[i] < 45 ? -1 : 0;
  if (A.macd[i]) s += A.macd[i].macd > A.macd[i].signal ? 1 : -1;
  return s;
}

function strategy(ctx) {
  const { candles, index: i, close } = ctx;
  if (cachedFor !== candles) { cachedFor = candles; A = precompute(candles, ctx.indicators); }
  if (i < 210 || A.donE[i] === null || A.ema200[i] === null || A.atr14[i] === null) return "flat";
  const s = biasScore(A, candles, i);
  if (s === null) return "flat";
  const atr = A.atr14[i];

  // Manage open positions: opposite Donchian band ends the trend ride.
  if (ctx.position === "long") {
    const x = A.donX[i];
    if (x !== null && close < x.lower) return "flat";
    return { signal: "long", stop };
  }
  if (ctx.position === "short") {
    const x = A.donX[i];
    if (x !== null && close > x.upper) return "flat";
    return { signal: "short", stop };
  }

  // Entries: breakout + bias confluence + regime, both directions.
  if (close > A.donE[i].upper && s >= 2 && close > A.ema200[i]) {
    stop = close - atr * 3;
    return { signal: "long", stop };
  }
  if (close < A.donE[i].lower && s <= -2 && close < A.ema200[i]) {
    stop = close + atr * 3;
    return { signal: "short", stop };
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
