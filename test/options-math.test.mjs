import { test } from "node:test";
import assert from "node:assert/strict";
import { blackScholesGreeks, impliedVol } from "../src/lib/options.js";
import { gbmCone, estimateGbmParams } from "../src/lib/montecarlo.js";

test("Black-Scholes obeys put-call parity, IV round-trips, Greeks have the right signs", () => {
  const S = 100, K = 100, T = 0.5, r = 0.043, sigma = 0.25;
  const call = blackScholesGreeks({ S, K, T, sigma, r, type: "call" });
  const put = blackScholesGreeks({ S, K, T, sigma, r, type: "put" });
  // C − P = S − K·e^{−rT}
  assert.ok(Math.abs((call.price - put.price) - (S - K * Math.exp(-r * T))) < 1e-6);
  // implied vol recovers the sigma that made the price
  const iv = impliedVol({ price: call.price, S, K, T, r, type: "call" });
  assert.ok(Math.abs(iv - sigma) < 1e-3, `iv ${iv} vs ${sigma}`);
  assert.ok(call.delta > 0 && call.delta < 1 && put.delta < 0 && put.delta > -1);
  assert.ok(call.rho > 0 && put.rho < 0 && call.gamma > 0 && call.vega > 0);
});

test("impliedVol returns null when the price is below intrinsic value", () => {
  assert.equal(impliedVol({ price: 0.01, S: 100, K: 80, T: 0.5, r: 0.043, type: "call" }), null);
});

test("gbmCone bands are ordered, start at S0, and widen over time", () => {
  const c = gbmCone({ S0: 100, mu: 0.0003, sigma: 0.02, steps: 40, paths: 1500, seed: 7 });
  assert.ok(c && c.bands.length === 5);
  const [p5, , med, , p95] = c.bands;
  for (let t = 0; t <= 40; t++) {
    assert.ok(p5.values[t] <= med.values[t] + 1e-9 && med.values[t] <= p95.values[t] + 1e-9);
  }
  const spread = (t) => p95.values[t] - p5.values[t];
  assert.ok(spread(40) > spread(2), "the cone widens with the horizon");
  assert.equal(c.bands[0].values[0], 100); // starts at S0
});

test("estimateGbmParams recovers a pure drift with ~zero vol", () => {
  const closes = []; let s = 100;
  for (let i = 0; i < 200; i++) { s *= Math.exp(0.0005); closes.push({ close: s }); }
  const p = estimateGbmParams(closes);
  assert.ok(p && Math.abs(p.mu - 0.0005) < 1e-6 && p.sigma < 1e-6);
});
