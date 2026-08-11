import { test } from "node:test";
import assert from "node:assert/strict";
import {
  imbalance, weightedMid, imbBucket, collectTransitions, fitMicroprice, microprice,
} from "../src/lib/microprice.js";

// These tests run the estimator against a SIMULATED market whose rules we set,
// so the answer is known in advance. That matters more than usual here: the
// micro-price is an infinite sum solved through two matrix inversions, and a
// sign slip or a transposed index still produces plausible-looking numbers.

const TICK = 0.01;

// Deterministic RNG — a failure has to be reproducible.
function rng(seed = 42) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * A market where imbalance genuinely predicts the next move, by construction:
 * the mid ticks up with probability equal to the current bid share. Imbalance
 * is PERSISTENT (an AR(1) on logit) rather than redrawn each step, which is
 * both realistic and the case where the infinite sum actually does work — a
 * one-step-ahead estimator would systematically understate the adjustment.
 */
function normal(r) {
  let u = 0, v = 0;
  while (u === 0) u = r();
  while (v === 0) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function simulate(n, { seed = 1, moveProb = 0.25, persistence = 0.85, sd = 1.6 } = {}) {
  const r = rng(seed);
  const obs = [];
  let P = 10000;          // price in ticks
  let z = 0;              // logit of the imbalance
  for (let i = 0; i < n; i++) {
    // Scaled so the STATIONARY spread of z is `sd`, not the shock — otherwise
    // the book never gets lopsided enough to populate the outer buckets.
    z = persistence * z + Math.sqrt(1 - persistence ** 2) * sd * normal(r);
    const I = 1 / (1 + Math.exp(-z));
    const total = 200;
    obs.push({
      bid: P * TICK, ask: (P + 1) * TICK,
      bidSize: Math.max(1, Math.round(I * total)),
      askSize: Math.max(1, Math.round((1 - I) * total)),
    });
    if (r() < moveProb) P += r() < I ? 1 : -1;
  }
  return obs;
}

test("imbalance and the weighted mid behave as defined", () => {
  assert.equal(imbalance(50, 50), 0.5);
  assert.equal(imbalance(90, 10), 0.9);
  assert.equal(imbalance(0, 0), 0.5, "an empty book is not an opinion");
  // A stacked BID pushes the weighted mid UP toward the ask: that is the side
  // about to be consumed. Getting this backwards is the classic sign error.
  const wm = weightedMid(100, 101, 900, 100);
  assert.ok(wm > 100.5, `stacked bid should lift the weighted mid, got ${wm}`);
  assert.ok(wm < 101, "…but never past the ask");
  assert.equal(weightedMid(100, 101, 50, 50), 100.5, "a balanced book is the mid");
});

test("imbBucket covers [0,1] without falling off either end", () => {
  assert.equal(imbBucket(0, 6), 0);
  assert.equal(imbBucket(1, 6), 5, "I=1 must land in the last bucket, not out of range");
  assert.equal(imbBucket(0.5, 6), 3);
});

test("the adjustment is monotone in imbalance and centred at zero", () => {
  const obs = simulate(60000, { seed: 7 });
  const counts = collectTransitions(obs, TICK, { imbBuckets: 6, maxSpreadTicks: 1 });
  const model = fitMicroprice(counts);
  assert.ok(model, "the fit must converge on 60k observations");
  assert.ok(model.coverage > 0.9, `most of the grid should be estimated, got ${model.coverage}`);

  const adj = model.adj;
  // A stacked bid predicts a higher price; a stacked ask a lower one.
  assert.ok(adj[0] < 0, `lowest imbalance bucket should predict down, got ${adj[0]}`);
  assert.ok(adj[5] > 0, `highest imbalance bucket should predict up, got ${adj[5]}`);
  for (let i = 1; i < 6; i++) {
    assert.ok(adj[i] > adj[i - 1], `adjustment must rise with imbalance (bucket ${i})`);
  }
  // The simulated market is symmetric, so the adjustment should be too.
  for (let i = 0; i < 3; i++) {
    const asym = Math.abs(adj[i] + adj[5 - i]);
    assert.ok(asym < 0.6 * TICK, `buckets ${i}/${5 - i} should mirror, off by ${asym / TICK} ticks`);
  }
});

test("THE CLAIM: the micro-price predicts the future mid better than the mid does", () => {
  // The whole point of the estimator. Fit on the first half, measure on the
  // second — an in-sample win would prove nothing.
  const obs = simulate(80000, { seed: 11 });
  const split = obs.length / 2;
  const model = fitMicroprice(collectTransitions(obs.slice(0, split), TICK,
    { imbBuckets: 8, maxSpreadTicks: 1 }));
  assert.ok(model);

  const HORIZON = 20;
  let seMid = 0, seMicro = 0, seWeighted = 0, n = 0;
  for (let i = split; i < obs.length - HORIZON; i++) {
    const o = obs[i];
    const mid = (o.bid + o.ask) / 2;
    const future = (obs[i + HORIZON].bid + obs[i + HORIZON].ask) / 2;
    const mp = microprice(o, model).price;
    const wm = weightedMid(o.bid, o.ask, o.bidSize, o.askSize);
    seMid += (future - mid) ** 2;
    seMicro += (future - mp) ** 2;
    seWeighted += (future - wm) ** 2;
    n++;
  }
  const rmse = (s) => Math.sqrt(s / n) / TICK;   // in ticks
  const [rMid, rMicro, rWm] = [rmse(seMid), rmse(seMicro), rmse(seWeighted)];
  assert.ok(rMicro < rMid,
    `micro-price ${rMicro.toFixed(3)} should beat the mid ${rMid.toFixed(3)} (ticks RMSE)`);
  assert.ok(rMicro < rWm,
    `micro-price ${rMicro.toFixed(3)} should beat the weighted mid ${rWm.toFixed(3)}`);
});

test("a market where imbalance means NOTHING yields no adjustment", () => {
  // The guard against fooling ourselves: if the book carries no information,
  // the estimator must say so rather than inventing an edge from noise.
  const r = rng(3);
  const obs = [];
  let P = 10000;
  for (let i = 0; i < 40000; i++) {
    obs.push({
      bid: P * TICK, ask: (P + 1) * TICK,
      bidSize: Math.max(1, Math.round(r() * 200)), askSize: Math.max(1, Math.round(r() * 200)),
    });
    if (r() < 0.25) P += r() < 0.5 ? 1 : -1;      // direction independent of the book
  }
  const model = fitMicroprice(collectTransitions(obs, TICK, { imbBuckets: 6, maxSpreadTicks: 1 }));
  assert.ok(model);
  for (const a of model.adj) {
    assert.ok(Math.abs(a) < 0.35 * TICK, `expected ~no adjustment, got ${a / TICK} ticks`);
  }
});

test("off-grid books fall back to the weighted mid instead of guessing", () => {
  const model = fitMicroprice(collectTransitions(simulate(30000, { seed: 5 }), TICK,
    { imbBuckets: 6, maxSpreadTicks: 1 }));
  // A spread far wider than anything the model was fitted on.
  const wide = { bid: 100, ask: 100.25, bidSize: 100, askSize: 10 };
  const out = microprice(wide, model);
  assert.equal(out.source, "weighted-mid");
  assert.equal(out.price, weightedMid(100, 100.25, 100, 10));
  // No model at all is the same story, not a crash.
  assert.equal(microprice(wide, null).source, "weighted-mid");
});

test("too little data returns null rather than a confident wrong model", () => {
  const tiny = collectTransitions(simulate(30, { seed: 2 }), TICK,
    { imbBuckets: 6, maxSpreadTicks: 1 });
  assert.equal(fitMicroprice(tiny), null, "30 observations must not yield a model");

  // The subtler failure: enough data overall, but spread over a grid too fine
  // for it. Most rows fall below the per-state minimum and are left empty —
  // the remaining ones still invert perfectly well and would hand back a model
  // covering a fraction of its own state space.
  const sparse = collectTransitions(simulate(600, { seed: 4 }), TICK,
    { imbBuckets: 60, maxSpreadTicks: 1 });
  assert.equal(fitMicroprice(sparse), null, "an under-covered grid is not a model");
});
