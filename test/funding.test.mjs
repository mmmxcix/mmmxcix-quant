// Perpetual funding in the backtest — a long in a persistently positive-funding
// market must bleed funding; a short must earn it. The known-lie Govind warns of.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runBacktest } from "../src/lib/backtest.js";

// Flat price (no price P&L), so the ONLY difference is funding.
const flat = Array.from({ length: 30 }, (_, i) => ({ time: i * 8 * 3600, open: 100, high: 100.5, low: 99.5, close: 100, volume: 1 }));
const alwaysLong = () => "long";
const alwaysShort = () => "short";
// Funding every 8h at +0.01% (0.0001).
const funding = Array.from({ length: 30 }, (_, i) => ({ time: i * 8 * 3600, rate: 0.0001 }));

test("no funding rates → funding is neutral / null", () => {
  const r = runBacktest({ candles: flat, signalFn: alwaysLong, feeBps: 0 });
  assert.equal(r.metrics.fundingPaidPct, null);
});

test("a long bleeds positive funding; a short earns it", () => {
  const long = runBacktest({ candles: flat, signalFn: alwaysLong, feeBps: 0, fundingRates: funding });
  const short = runBacktest({ candles: flat, signalFn: alwaysShort, feeBps: 0, fundingRates: funding });
  assert.ok(long.metrics.fundingPaidPct > 0, "long pays funding");
  assert.ok(long.metrics.totalReturnPct < 0, "and it drags the return below zero on flat price");
  assert.ok(short.metrics.fundingPaidPct < 0, "short receives funding");
  assert.ok(short.metrics.totalReturnPct > 0, "which lifts its return on flat price");
});

test("funding scales with the number of stamps held", () => {
  const few = runBacktest({ candles: flat, signalFn: alwaysLong, feeBps: 0, fundingRates: funding.slice(0, 5) });
  const many = runBacktest({ candles: flat, signalFn: alwaysLong, feeBps: 0, fundingRates: funding });
  assert.ok(many.metrics.fundingPaidPct > few.metrics.fundingPaidPct, "more funding stamps → more paid");
});
