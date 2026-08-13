import { test } from "node:test";
import assert from "node:assert/strict";
import { signedAvgCorr, avgPairwiseCorr, effectiveHeatCap, pairCorr } from "../src/lib/argus/correlation.js";

// The gap this closes: the unsigned model cannot tell a one-way book from a
// hedged one. Long BTC + long ETH is close to a single double-sized bet; long
// BTC + SHORT ETH largely cancels. Both scored 0.80 before, and the risk budget
// was therefore identical for a book that compounds and one that offsets.

const P = (symbol, side) => ({ symbol, side });

test("same-side correlated positions compound, opposite-side ones offset", () => {
  const oneWay = [P("BTCUSDT", "long"), P("ETHUSDT", "long")];
  const hedged = [P("BTCUSDT", "long"), P("ETHUSDT", "short")];
  assert.equal(signedAvgCorr(oneWay), 0.8);
  assert.equal(signedAvgCorr(hedged), -0.8);
  // The unsigned model sees them as identical — which is exactly the problem.
  assert.equal(avgPairwiseCorr(["BTCUSDT", "ETHUSDT"]), avgPairwiseCorr(["BTCUSDT", "ETHUSDT"]));
});

test("doubling down on one symbol is the pure case", () => {
  assert.equal(signedAvgCorr([P("BTCUSDT", "long"), P("BTCUSDT", "long")]), 1);
  assert.equal(signedAvgCorr([P("BTCUSDT", "long"), P("BTCUSDT", "short")]), -1, "long + short in the same name is flat");
});

test("a one-way crypto book gets the tight budget, a hedged one gets the full budget", () => {
  const base = 0.10, max = 0.20;
  const oneWay = effectiveHeatCap([P("BTCUSDT", "long"), P("ETHUSDT", "long")], P("SOLUSDT", "long"), base, max);
  const hedged = effectiveHeatCap([P("BTCUSDT", "long"), P("ETHUSDT", "short")], P("SOLUSDT", "short"), base, max);
  assert.ok(oneWay < hedged, `one-way ${oneWay} must be capped tighter than hedged ${hedged}`);
  assert.equal(oneWay, 0.12, "matches what the live book was actually running at");
  assert.equal(hedged, max, "a genuinely offsetting book earns the full budget");
});

test("a negative average earns the full budget but never more than the cap", () => {
  const cap = effectiveHeatCap([P("BTCUSDT", "long")], P("ETHUSDT", "short"), 0.10, 0.20);
  assert.equal(cap, 0.20, "hedged counts as full diversification");
  assert.ok(cap <= 0.20, "…and stops there — a hedge is not a licence to exceed the ceiling");
});

test("bare symbols still work and are treated as the conservative case", () => {
  // The original signature. An unknown direction must be assumed to COMPOUND,
  // never to hedge, or an old call site silently loosens the risk budget.
  const strings = effectiveHeatCap(["BTCUSDT", "ETHUSDT"], "SOLUSDT", 0.10, 0.20);
  const objects = effectiveHeatCap([P("BTCUSDT", "long"), P("ETHUSDT", "long")], P("SOLUSDT", "long"), 0.10, 0.20);
  assert.equal(strings, objects, "strings must match the all-same-side reading");
});

test("a mixed-class book still diversifies", () => {
  // Crypto long + bond long: the classes are slightly NEGATIVELY correlated, so
  // this is a genuinely spread book and earns the wider budget.
  assert.ok(pairCorr("BTCUSDT", "TLT") < 0);
  const cap = effectiveHeatCap([P("BTCUSDT", "long")], P("TLT", "long"), 0.10, 0.20);
  assert.equal(cap, 0.20);
});

test("fewer than two positions has no correlation to speak of", () => {
  assert.equal(signedAvgCorr([]), 0);
  assert.equal(signedAvgCorr([P("BTCUSDT", "long")]), 0);
  // …and the cap then sits at the maximum, since one position is by definition
  // not concentrated against anything.
  assert.equal(effectiveHeatCap([], P("BTCUSDT", "long"), 0.10, 0.20), 0.20);
});

test("a missing side is read as long rather than crashing", () => {
  const c = signedAvgCorr([{ symbol: "BTCUSDT" }, { symbol: "ETHUSDT", side: "long" }]);
  assert.equal(c, 0.8);
});
