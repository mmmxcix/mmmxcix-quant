// correlation.test.mjs — the diversification-aware heat cap for Argus.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classOf, pairCorr, avgPairwiseCorr, effectiveHeatCap } from "../src/lib/argus/correlation.js";

test("classOf maps symbols to asset classes", () => {
  assert.equal(classOf("BTCUSDT"), "crypto");
  assert.equal(classOf("ETHUSDC"), "crypto");
  assert.equal(classOf("TLT"), "bond");
  assert.equal(classOf("UUP"), "dollar");
  assert.equal(classOf("GLD"), "commodity");
  assert.equal(classOf("USO"), "commodity");
  assert.equal(classOf("SPY"), "equity");
  assert.equal(classOf("NVDA"), "equity");
});

test("pairCorr is 1 for the same symbol, symmetric otherwise", () => {
  assert.equal(pairCorr("BTCUSDT", "BTCUSDT"), 1);
  assert.equal(pairCorr("btcusdt", "BTCUSDT"), 1); // case-insensitive
  assert.equal(pairCorr("BTCUSDT", "ETHUSDT"), pairCorr("ETHUSDT", "BTCUSDT"));
  // gold vs a dollar ETF should read as negatively correlated
  assert.ok(pairCorr("GLD", "UUP") < 0);
});

test("avgPairwiseCorr: correlated cryptos > mixed classes", () => {
  const cryptoOnly = avgPairwiseCorr(["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
  const diversified = avgPairwiseCorr(["BTCUSDT", "GLD", "TLT"]);
  assert.ok(cryptoOnly > diversified, "three cryptos are more correlated than crypto+gold+bond");
  assert.equal(avgPairwiseCorr([]), 0);
  assert.equal(avgPairwiseCorr(["BTCUSDT"]), 0); // single symbol → no pairs
});

test("effectiveHeatCap: uncorrelated book earns a bigger budget", () => {
  const base = 0.10, max = 0.20;
  // three correlated crypto longs → stay near base
  const correlated = effectiveHeatCap(["BTCUSDT", "ETHUSDT"], "SOLUSDT", base, max);
  // crypto + gold + bond → diversified, budget rises
  const diversified = effectiveHeatCap(["GLD", "TLT"], "BTCUSDT", base, max);
  assert.ok(diversified > correlated, "uncorrelated portfolio gets a higher cap");
});

test("effectiveHeatCap clamps to [base, max]", () => {
  const base = 0.10, max = 0.20;
  for (const syms of [
    [[], "BTCUSDT"],
    [["BTCUSDT"], "BTCUSDT"],
    [["BTCUSDT", "ETHUSDT", "SOLUSDT"], "AAPL"],
    [["GLD", "TLT", "UUP"], "BTCUSDT"],
  ]) {
    const cap = effectiveHeatCap(syms[0], syms[1], base, max);
    assert.ok(cap >= base - 1e-9 && cap <= max + 1e-9, `cap ${cap} within [${base},${max}]`);
  }
  // a maximally-diversified (negatively correlated) book reaches the ceiling
  assert.equal(effectiveHeatCap(["GLD"], "UUP", base, max), max);
});
