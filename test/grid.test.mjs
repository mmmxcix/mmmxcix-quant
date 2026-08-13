import { test } from "node:test";
import assert from "node:assert/strict";
import { suggestGrid, collectTransitions, fitMicroprice } from "../src/lib/microprice.js";

// This exists because a FIXED grid silently disabled the estimator in
// production. The arena ran 8 imbalance buckets x 3 spread levels on a market
// that quotes a one-tick spread 99% of the time: two thirds of the states could
// never fill, coverage sat at 33%, and every refit was declined for hours. The
// model was never wrong — it was never built.

const book = (spreadTicks, bidSize = 5, askSize = 5, tick = 0.01) =>
  ({ bid: 100, ask: 100 + spreadTicks * tick, bidSize, askSize });

test("a market that only ever quotes one tick gets a one-deep grid", () => {
  const obs = Array.from({ length: 8000 }, () => book(1));
  const g = suggestGrid(obs, 0.01);
  assert.equal(g.maxSpreadTicks, 1, "a constant spread carries no information");
  assert.equal(g.spreadShares.length, 1);
});

test("a market with two common spreads gets two levels", () => {
  const obs = Array.from({ length: 9000 }, (_, i) => book(i % 3 === 0 ? 2 : 1));
  const g = suggestGrid(obs, 0.01);
  assert.equal(g.maxSpreadTicks, 2);
  assert.ok(g.spreadShares[1] > 0.3);
});

test("a rare wide spread does not earn a level of its own", () => {
  // 1% of observations at 2 ticks would add a whole row of states that can never
  // be estimated — which is exactly the failure this prevents.
  const obs = Array.from({ length: 10000 }, (_, i) => book(i % 100 === 0 ? 2 : 1));
  assert.equal(suggestGrid(obs, 0.01).maxSpreadTicks, 1);
});

test("the spread levels stay contiguous from one", () => {
  // Levels are indexed 1..N, so a gap in the middle reintroduces dead states.
  const obs = Array.from({ length: 9000 }, (_, i) => book(i % 3 === 0 ? 3 : 1));
  const g = suggestGrid(obs, 0.01);
  assert.equal(g.maxSpreadTicks, 1, "3 ticks is common but 2 is not — stop at 1");
});

test("imbalance resolution shrinks when there is little data", () => {
  const few = Array.from({ length: 400 }, () => book(1));
  const many = Array.from({ length: 40000 }, () => book(1));
  assert.ok(suggestGrid(few, 0.01).imbBuckets < suggestGrid(many, 0.01).imbBuckets);
  assert.ok(suggestGrid(few, 0.01).imbBuckets >= 3, "…but never below a usable minimum");
});

test("THE REGRESSION: the suggested grid fits where the fixed one never could", () => {
  // A realistic one-tick book with a spread of imbalances.
  let seed = 5;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const obs = [];
  let p = 10000;
  for (let i = 0; i < 30000; i++) {
    const I = rnd();
    obs.push({ bid: p * 0.01, ask: (p + 1) * 0.01, bidSize: Math.max(1, Math.round(I * 100)), askSize: Math.max(1, Math.round((1 - I) * 100)) });
    if (rnd() < 0.2) p += rnd() < I ? 1 : -1;
  }
  const fixed = fitMicroprice(collectTransitions(obs, 0.01, { imbBuckets: 8, maxSpreadTicks: 3 }));
  assert.equal(fixed, null, "the fixed 8x3 grid must fail, as it did in production");
  const g = suggestGrid(obs, 0.01);
  const adaptive = fitMicroprice(collectTransitions(obs, 0.01, g));
  assert.ok(adaptive, "the suggested grid must produce a model");
  assert.ok(adaptive.coverage > 0.9);
});

test("no usable observations returns a safe minimum rather than throwing", () => {
  for (const bad of [[], null, [{ bid: 100, ask: 100 }]]) {
    const g = suggestGrid(bad, 0.01);
    assert.ok(g.imbBuckets >= 3 && g.maxSpreadTicks >= 1);
  }
});
