import { test } from "node:test";
import assert from "node:assert/strict";
import { computeDataBias, biasNorm, horizonWeight, combineBias, verdictNorm } from "../src/lib/dataBias.js";

const bull = {
  recommendation: "buy", analysts: 30, targetMean: 120, price: 100,
  quarters: [{ est: 1, actual: 1.1 }, { est: 1, actual: 1.2 }, { est: 1, actual: 0.9 }, { est: 1, actual: 1.3 }],
  revenueGrowth: 0.09, profitMargin: 0.22, forwardPE: 20,
};
const bear = {
  recommendation: "sell", analysts: 20, targetMean: 85, price: 100,
  quarters: [{ est: 1, actual: 0.8 }, { est: 1, actual: 0.7 }, { est: 1, actual: 0.9 }],
  revenueGrowth: -0.08, profitMargin: 0.04, forwardPE: 55,
};

test("computeDataBias: bullish fundamentals → long, bearish → short", () => {
  const a = computeDataBias(bull, "stock");
  assert.equal(a.verdict, "long");
  assert.ok(a.score >= 2 && a.hasData && a.factors.length >= 4);
  const b = computeDataBias(bear, "stock");
  assert.equal(b.verdict, "short");
  assert.ok(b.score <= -2);
});

test("computeDataBias: crypto has no company fundamentals → empty score", () => {
  const c = computeDataBias({ summary: "BTC" }, "crypto");
  assert.equal(c.hasData, false);
  assert.equal(c.maxScore, 0);
  assert.equal(c.verdict, "neutral");
});

test("horizonWeight rises with the timeframe and stays in [0.1, 0.8]", () => {
  const m5 = horizonWeight(300), h1 = horizonWeight(3600), d1 = horizonWeight(86400), M1 = horizonWeight(2592000);
  assert.ok(m5 >= 0.1 && M1 <= 0.8, "clamped");
  assert.ok(m5 < h1 && h1 < d1 && d1 < M1, "monotonically more fundamental on longer TFs");
  assert.ok(m5 <= 0.15, "intraday is mostly technical");
  assert.ok(d1 >= 0.4, "daily leans meaningfully on fundamentals");
});

test("combineBias: short TF follows technical, long TF follows fundamentals (the a↔b dial)", () => {
  // technical = long (+0.8), fundamentals = short (-0.8): the winner flips with horizon.
  const short = combineBias(0.8, -0.8, 300);   // 5m
  const long = combineBias(0.8, -0.8, 2592000); // 1M
  assert.equal(short.verdict, "long", "intraday: technical wins");
  assert.equal(long.verdict, "short", "monthly: fundamentals win");
  assert.ok(short.wTech > short.wData && long.wData > long.wTech);
});

test("biasNorm / verdictNorm map to [-1,1]", () => {
  assert.ok(Math.abs(biasNorm({ score: 3, maxScore: 5 }) - 0.6) < 1e-9);
  assert.equal(biasNorm({ score: 1, maxScore: 0 }), 0, "no votes → 0");
  assert.equal(verdictNorm("long", 0.7), 0.7);
  assert.equal(verdictNorm("short", 0.7), -0.7);
  assert.equal(verdictNorm("neutral", 0.7), 0);
});
