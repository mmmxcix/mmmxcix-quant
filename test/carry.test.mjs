// The carry engine: the strategy can READ the funding it is paid, cannot read
// the funding that has not printed yet, and carries a stop because the payoff
// shape is short-volatility.
import test from "node:test";
import assert from "node:assert/strict";
import { runBacktest, compileStrategy } from "../src/lib/backtest.js";
import { BUILT_IN_STRATEGIES } from "../src/lib/strategies.js";
import { strategyToCode } from "../src/lib/strategyCode.js";

const carry = BUILT_IN_STRATEGIES.find((s) => s.id === "perp-funding-carry");
const H = 8 * 3600;
const flat = (n = 60, px = 100) =>
  Array.from({ length: n }, (_, i) => ({ time: i * H, open: px, high: px * 1.002, low: px * 0.998, close: px, volume: 1 }));
const stamps = (n, rate) => Array.from({ length: n }, (_, i) => ({ time: i * H, rate }));

test("the strategy exists and is a real built-in", () => {
  assert.ok(carry, "perp-funding-carry is registered");
  assert.equal(typeof carry.build, "function");
  assert.match(carry.description, /short-volatility|short volatility/i, "the payoff shape is stated up front");
});

test("without funding data it stays flat rather than inventing a signal", () => {
  const r = runBacktest({ candles: flat(), signalFn: carry.build({ trendSma: 0 }), feeBps: 0 });
  assert.equal(r.metrics.tradeCount, 0);
  assert.equal(r.metrics.fundingPaidPct, null);
});

test("persistently positive funding is collected from the short side", () => {
  const candles = flat();
  const r = runBacktest({
    candles, signalFn: carry.build({ stamps: 3, minRateBps: 0.5, trendSma: 0 }),
    feeBps: 0, fundingRates: stamps(60, 0.0003),
  });
  assert.ok(r.metrics.tradeCount > 0, "it takes the paid side");
  assert.ok(r.metrics.fundingPaidPct < 0, "funding is RECEIVED, not paid");
  assert.ok(r.metrics.totalReturnPct > 0, "on a flat price the carry is the whole return");
});

test("negative funding flips the side", () => {
  const candles = flat();
  const r = runBacktest({
    candles, signalFn: carry.build({ stamps: 3, minRateBps: 0.5, trendSma: 0 }),
    feeBps: 0, fundingRates: stamps(60, -0.0003),
  });
  assert.ok(r.metrics.fundingPaidPct < 0, "the long side now receives it");
  assert.ok(r.metrics.totalReturnPct > 0);
});

test("the DEFAULT threshold still trades in a realistic funding regime", () => {
  // Measured on Binance 8h stamps, Sep 2025 → Aug 2026: BTC averaged 0.27 bps
  // per stamp and ETH 0.19 — well under the 0.01% (1 bp) baseline the exchange
  // clamps toward. The first default here was 1 bp and fired 0–2 times in a
  // YEAR, which is a broken default rather than a careful one. This pins that
  // the shipped default acts on funding of the size the market actually pays.
  const params = Object.fromEntries(carry.params.map((p) => [p.key, p.default]));
  const realistic = stamps(120, 0.00005); // 0.5 bps — an ordinary stamp in that regime, half the old floor
  const now = runBacktest({ candles: flat(120), signalFn: carry.build({ ...params, trendSma: 0 }), feeBps: 0, fundingRates: realistic });
  assert.ok(now.metrics.tradeCount > 0, "the shipped default must act on a realistic carry");
  assert.ok(now.metrics.fundingPaidPct < 0, "and collect it");
  const old = runBacktest({ candles: flat(120), signalFn: carry.build({ ...params, minRateBps: 1, trendSma: 0 }), feeBps: 0, fundingRates: realistic });
  assert.equal(old.metrics.tradeCount, 0, "…which the old 1 bp floor did not");
});

test("funding below the threshold is not worth trading", () => {
  const r = runBacktest({
    candles: flat(), signalFn: carry.build({ stamps: 3, minRateBps: 5, trendSma: 0 }),
    feeBps: 0, fundingRates: stamps(60, 0.00001), // 0.1 bps — under a 5 bps floor
  });
  assert.equal(r.metrics.tradeCount, 0);
});

test("the stop caps the disaster the carry is underwriting", () => {
  // Flat, well-paid market — then a violent rally, exactly the day a funding
  // short is run over. The stop is what turns the ruin into a bad trade.
  const candles = flat(40);
  for (let i = 40; i < 50; i++) {
    const px = 100 * (1 + (i - 39) * 0.06);
    candles.push({ time: i * H, open: px, high: px * 1.03, low: px * 0.99, close: px, volume: 1 });
  }
  const withStop = runBacktest({
    candles, signalFn: carry.build({ stamps: 3, minRateBps: 0.5, stopPct: 4, trendSma: 0 }),
    feeBps: 0, fundingRates: stamps(50, 0.0003),
  });
  const noStop = runBacktest({
    candles, signalFn: carry.build({ stamps: 3, minRateBps: 0.5, stopPct: 90, trendSma: 0 }),
    feeBps: 0, fundingRates: stamps(50, 0.0003),
  });
  assert.ok(withStop.metrics.maxDrawdownPct < noStop.metrics.maxDrawdownPct,
    `a 4% stop must hurt less than none: ${withStop.metrics.maxDrawdownPct} vs ${noStop.metrics.maxDrawdownPct}`);
  assert.ok(withStop.metrics.totalReturnPct > noStop.metrics.totalReturnPct);
});

test("the trend filter refuses to short into a standing uptrend", () => {
  // Price grinding up the whole way: every bar is above its own SMA, so the
  // funding short — however well paid — is never taken.
  const candles = Array.from({ length: 260 }, (_, i) => {
    const px = 100 * (1 + i * 0.004);
    return { time: i * H, open: px, high: px * 1.002, low: px * 0.998, close: px, volume: 1 };
  });
  const filtered = runBacktest({
    candles, signalFn: carry.build({ stamps: 3, minRateBps: 0.5, trendSma: 200 }),
    feeBps: 0, fundingRates: stamps(260, 0.0003),
  });
  const unfiltered = runBacktest({
    candles, signalFn: carry.build({ stamps: 3, minRateBps: 0.5, trendSma: 0 }),
    feeBps: 0, fundingRates: stamps(260, 0.0003),
  });
  assert.equal(filtered.metrics.tradeCount, 0, "no short is taken above the trend");
  assert.ok(unfiltered.metrics.tradeCount > 0, "…while the unfiltered version walks straight into it");
  assert.ok(unfiltered.metrics.totalReturnPct < 0, "and loses money doing so");
});

test("ctx.funding cannot see a rate that has not printed yet", () => {
  const candles = flat(6);
  const seen = [];
  runBacktest({
    candles,
    signalFn: (ctx) => { seen.push(ctx.funding ? ctx.funding.count : 0); return "flat"; },
    feeBps: 0,
    fundingRates: stamps(6, 0.0002),
  });
  // Stamp i lands on bar i, so by bar i exactly i+1 stamps have printed — never more.
  seen.forEach((c, i) => assert.ok(c <= i + 1, `bar ${i} saw ${c} stamps`));
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6]);
});

test("the copyable JS twin trades identically to the builder", () => {
  // The shared twin harness (jstwins.test.mjs) runs without funding data, where
  // this strategy correctly does nothing — so it is pinned here instead, on a
  // series that actually pays a carry.
  const params = Object.fromEntries(carry.params.map((p) => [p.key, p.default]));
  const candles = flat(40);
  for (let i = 40; i < 90; i++) {
    const px = 100 * (1 - (i - 39) * 0.004); // drifting down: the short is allowed through
    candles.push({ time: i * H, open: px, high: px * 1.004, low: px * 0.996, close: px, volume: 1 });
  }
  const opts = { candles, feeBps: 10, positionPct: 100, fundingRates: stamps(90, 0.0004) };
  const native = runBacktest({ ...opts, signalFn: carry.build({ ...params, trendSma: 0 }) });
  const src = strategyToCode({ mode: "builder", strategyId: "perp-funding-carry", params: { ...params, trendSma: 0 } }, "js");
  assert.ok(src.includes("function strategy"), "a JS twin exists");
  const twin = runBacktest({ ...opts, signalFn: compileStrategy(src) });
  assert.ok(native.metrics.tradeCount >= 1, "the builder trades on this series");
  assert.equal(twin.metrics.tradeCount, native.metrics.tradeCount);
  assert.ok(Math.abs(twin.metrics.totalReturnPct - native.metrics.totalReturnPct) < 1e-6,
    `${twin.metrics.totalReturnPct} vs ${native.metrics.totalReturnPct}`);
});

test("ctx.funding.avg averages only the stamps behind it", () => {
  const candles = flat(4);
  const rates = [0.001, 0.002, 0.003, 0.004].map((rate, i) => ({ time: i * H, rate }));
  const avgs = [];
  runBacktest({
    candles, feeBps: 0, fundingRates: rates,
    signalFn: (ctx) => { avgs.push(+ctx.funding.avg(2).toFixed(6)); return "flat"; },
  });
  assert.deepEqual(avgs, [0.001, 0.0015, 0.0025, 0.0035]);
});
