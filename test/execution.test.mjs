import { test } from "node:test";
import assert from "node:assert/strict";
import { runBacktest } from "../src/lib/backtest.js";

// The execution model (Aug 2026). The engine used to fill EVERY decision at the
// next bar's open, which on a 15m bar charges a 15-minute delay no real system
// has. Now: intraday fills at the signal bar's close (react in milliseconds,
// pay the spread), daily+ keeps next-open (the market is genuinely shut).

const bars = (n, stepSec, priceAt) =>
  Array.from({ length: n }, (_, i) => {
    const p = priceAt(i);
    return { time: 1_700_000_000 + i * stepSec, open: p, high: p * 1.01, low: p * 0.99, close: p, volume: 1 };
  });

// Enter long on bar 2 and hold. Deterministic, so fill prices are checkable.
const enterOnBar2 = (ctx) => (ctx.index >= 2 ? "long" : "flat");

test("auto picks close-fill for intraday bars and next-open for daily bars", () => {
  const intraday = runBacktest({ candles: bars(40, 900, (i) => 100 + i), signalFn: enterOnBar2, feeBps: 0 });
  assert.equal(intraday.metrics.execution, "close");

  const daily = runBacktest({ candles: bars(40, 86400, (i) => 100 + i), signalFn: enterOnBar2, feeBps: 0 });
  assert.equal(daily.metrics.execution, "next-open");
});

test("close model fills at the signal bar's own close; next-open at the following open", () => {
  // Price jumps at bar 3, so the two models must land on different entries.
  const candles = bars(20, 900, (i) => (i < 3 ? 100 : 120));
  const close = runBacktest({ candles, signalFn: enterOnBar2, feeBps: 0, execution: "close" });
  const open = runBacktest({ candles, signalFn: enterOnBar2, feeBps: 0, execution: "next-open" });
  // Bar 2 closes at 100 → the fast model is filled there…
  assert.equal(close.trades[0].entryPrice, 100);
  // …the next-open model only gets in on bar 3, after the jump.
  assert.equal(open.trades[0].entryPrice, 120);
});

test("a position opened on the close cannot be stopped out by that same bar", () => {
  // Bar 2's low (99) is below the stop (99.5), but the entry happens at that
  // bar's CLOSE — those prices printed before the position existed.
  const candles = bars(8, 900, () => 100);
  const signalFn = (ctx) => (ctx.index >= 2 ? { signal: "long", stop: 99.5 } : "flat");
  const r = runBacktest({ candles, signalFn, feeBps: 0, execution: "close" });
  assert.equal(r.trades[0].bars > 0, true, "the stop must not fire on the entry bar itself");
});

test("slippage is charged against you on market fills, in both directions", () => {
  const candles = bars(20, 900, () => 100);
  const long = runBacktest({ candles, signalFn: enterOnBar2, feeBps: 0, execution: "close", slippageBps: 50 });
  assert.equal(long.trades.length, 1);
  assert.equal(long.trades[0].entryPrice, 100 * 1.005, "a buy pays up");
  assert.equal(long.trades[0].exitPrice, 100 * 0.995, "the exit sells down");
  assert.ok(long.trades[0].pnl < 0, "a flat market with slippage must lose");

  const short = runBacktest({
    candles, feeBps: 0, execution: "close", slippageBps: 50,
    signalFn: (ctx) => (ctx.index >= 2 ? "short" : "flat"),
  });
  assert.equal(short.trades[0].entryPrice, 100 * 0.995, "a short sells down");
  assert.equal(short.trades[0].exitPrice, 100 * 1.005, "covering pays up");
});

test("a triggered stop pays the spread; a limit target does not", () => {
  // Bar 4 must TRAVERSE the level intrabar (open on one side, extreme on the
  // other). A bar that gaps straight past it is the separate clamp case.
  const flat = (i) => ({ time: 1_700_000_000 + i * 900, open: 100, high: 101, low: 99, close: 100, volume: 1 });
  const withRange = (i, low, high) => ({ time: 1_700_000_000 + i * 900, open: 100, high, low, close: 100, volume: 1 });

  const down = [flat(0), flat(1), flat(2), flat(3), withRange(4, 90, 101), flat(5), flat(6), flat(7)];
  const stopRun = runBacktest({
    candles: down, feeBps: 0, execution: "close", slippageBps: 100,
    signalFn: (ctx) => (ctx.index >= 2 ? { signal: "long", stop: 95 } : "flat"),
  });
  const stopTrade = stopRun.trades.find((t) => t.reason === "stop");
  assert.ok(stopTrade, "expected a stop exit");
  assert.equal(stopTrade.exitPrice, 95 * 0.99, "a stop becomes a market order and slips 100 bps");

  const up = [flat(0), flat(1), flat(2), flat(3), withRange(4, 99, 110), flat(5), flat(6), flat(7)];
  const tgtRun = runBacktest({
    candles: up, feeBps: 0, execution: "close", slippageBps: 100,
    signalFn: (ctx) => (ctx.index >= 2 ? { signal: "long", target: 105 } : "flat"),
  });
  const tgtTrade = tgtRun.trades.find((t) => t.reason === "target");
  assert.ok(tgtTrade, "expected a target exit");
  assert.equal(tgtTrade.exitPrice, 105, "a resting limit fills at your price, never worse");
});

test("equity is marked AFTER a close fill, so the entry cost is visible immediately", () => {
  const candles = bars(6, 900, () => 100);
  const r = runBacktest({ candles, signalFn: enterOnBar2, feeBps: 100, execution: "close", initialCapital: 10000 });
  // Bar 2 opens the position: equity at that bar must already carry the fee.
  assert.ok(r.equity[2].value < 10000, "the entry fee shows on the bar it was paid");
});
