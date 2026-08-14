// The cross-sectional harness — rank a universe, hold the extremes, rebalance.
//
// This exists to settle a question the handoff left open ("can the engine
// represent cross-sectional strategies at all?"). The answer turned out to be
// that runBAB already was one, with the ranking hard-wired. These tests hold the
// three properties that make the extracted version trustworthy: it does not peek
// ahead, it finds a signal that is really there, and it finds nothing in noise.

import { test } from "node:test";
import assert from "node:assert/strict";

import { RANKERS, curveStats, runCrossSectional, toReturns } from "../src/lib/crossSection.js";

const DAY = 86400;

/** Deterministic PRNG so a failure is reproducible. */
function rng(seed = 7) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** A universe of pure random walks — the null the harness must return nothing on. */
function noiseUniverse({ n = 40, days = 800, seed = 3 } = {}) {
  const rand = rng(seed);
  const times = Array.from({ length: days + 1 }, (_, i) => 1_700_000_000 + i * DAY);
  const symbols = Array.from({ length: n }, (_, i) => `S${i}`);
  const returns = {};
  for (const s of symbols) returns[s] = Array.from({ length: days }, () => (rand() - 0.5) * 0.04);
  const market = Array.from({ length: days }, (_, i) =>
    symbols.reduce((a, s) => a + returns[s][i], 0) / symbols.length);
  return { times, symbols, returns, market };
}

test("a universe of random walks produces no edge — the harness does not manufacture one", () => {
  const u = noiseUniverse();
  const out = runCrossSectional({ ...u, rankFn: RANKERS.momentum, window: 120, rebalance: 21 });
  assert.ok(out.meta.rebalances > 20, "the run actually happened");
  // Long-short on noise: a small Sharpe either way is expected, a large one
  // would mean the harness is reading the future.
  assert.ok(Math.abs(out.stats.strategy.sharpe) < 1.0, `noise Sharpe was ${out.stats.strategy.sharpe.toFixed(2)}`);
});

test("a planted cross-sectional signal is found", () => {
  // Half the names drift up, half drift down, with noise on top. Momentum ranks
  // winners low (negative cumulative return), so winners are held long.
  const rand = rng(11);
  const days = 600, n = 30;
  const times = Array.from({ length: days + 1 }, (_, i) => 1_700_000_000 + i * DAY);
  const symbols = Array.from({ length: n }, (_, i) => `S${i}`);
  const returns = {};
  symbols.forEach((s, i) => {
    const drift = i < n / 2 ? 0.0012 : -0.0012;
    returns[s] = Array.from({ length: days }, () => drift + (rand() - 0.5) * 0.02);
  });
  const market = Array.from({ length: days }, (_, i) =>
    symbols.reduce((a, s) => a + returns[s][i], 0) / symbols.length);

  const out = runCrossSectional({ times, symbols, returns, market, rankFn: RANKERS.momentum, window: 120, rebalance: 21 });
  assert.ok(out.stats.strategy.annRetPct > 10, `planted drift gave ${out.stats.strategy.annRetPct.toFixed(1)}%/yr`);
  assert.ok(out.stats.strategy.sharpe > 1, "and it should be a strong Sharpe on a planted signal");
});

test("the ranking never sees the holding period — the whole boundary in one test", () => {
  const u = noiseUniverse({ n: 20, days: 400, seed: 5 });
  const window = 60, rebalance = 20;
  const seen = [];
  runCrossSectional({
    ...u, window, rebalance,
    rankFn: ({ returns, from, to }) => {
      seen.push({ from, to });
      // Touching an index at or after `to` would be look-ahead; assert the
      // window handed in is strictly the past.
      assert.ok(to - from === window, "the window is exactly as configured");
      let sum = 0;
      for (let i = from; i < to; i++) sum += returns[i];
      return sum;
    },
  });
  assert.ok(seen.length > 0);
  // rankFn is called once per SYMBOL per rebalance, so collapse to the distinct
  // windows before checking the stride.
  const cuts = [...new Set(seen.map((s) => s.to))].sort((a, b) => a - b);
  assert.equal(cuts[0], window, "the first ranking happens exactly one window in");
  for (let i = 1; i < cuts.length; i++) {
    assert.equal(cuts[i] - cuts[i - 1], rebalance, "rebalances step by exactly `rebalance`");
  }
});

test("a rebalance thinner than minNames is skipped and counted, not quietly shrunk", () => {
  const u = noiseUniverse({ n: 12, days: 400, seed: 9 });
  const out = runCrossSectional({
    ...u, window: 60, rebalance: 20, minNames: 30,
    rankFn: RANKERS.momentum,
  });
  assert.equal(out.meta.rebalances, 0);
  assert.ok(out.meta.skippedRebalances > 0, "the skips are visible in the metadata");
  assert.equal(out.stats.strategy.n, 0);
});

test("the rank function owns the sign — momentum and reversal are opposites", () => {
  const rand = rng(21);
  const days = 500, n = 24;
  const times = Array.from({ length: days + 1 }, (_, i) => 1_700_000_000 + i * DAY);
  const symbols = Array.from({ length: n }, (_, i) => `S${i}`);
  const returns = {};
  symbols.forEach((s, i) => {
    const drift = i < n / 2 ? 0.001 : -0.001;
    returns[s] = Array.from({ length: days }, () => drift + (rand() - 0.5) * 0.015);
  });
  const market = Array.from({ length: days }, (_, i) =>
    symbols.reduce((a, s) => a + returns[s][i], 0) / symbols.length);
  const base = { times, symbols, returns, market, window: 100, rebalance: 20 };
  const mom = runCrossSectional({ ...base, rankFn: RANKERS.momentum });
  const rev = runCrossSectional({ ...base, rankFn: RANKERS.reversal });
  assert.ok(mom.stats.strategy.annRetPct > 0);
  assert.ok(rev.stats.strategy.annRetPct < 0, "the same data, the opposite side of the same trade");
});

test("a weight function can scale the legs, as betting-against-beta needs", () => {
  const u = noiseUniverse({ n: 30, days: 400, seed: 13 });
  const out = runCrossSectional({
    ...u, window: 100, rebalance: 20,
    rankFn: RANKERS.beta,
    weightFn: ({ low, high }) => {
      const mean = (xs) => xs.reduce((a, x) => a + x.score, 0) / xs.length;
      return { wLong: Math.min(3, 1 / Math.max(mean(low), 0.33)), wShort: Math.min(3, 1 / Math.max(mean(high), 0.33)) };
    },
  });
  assert.ok(out.weights.wLong > 0 && out.weights.wLong <= 3);
  assert.ok(out.meta.rebalances > 0);
});

test("toReturns and curveStats agree with the arithmetic they claim", () => {
  assert.deepEqual(toReturns([100, 110, 99]).map((r) => +r.toFixed(4)), [0.1, -0.1]);
  const flat = curveStats([0, 0, 0, 0]);
  assert.equal(flat.annRetPct, 0);
  assert.equal(flat.sharpe, 0);
  const up = curveStats(Array.from({ length: 252 }, () => 0.001));
  assert.ok(up.annRetPct > 25 && up.annRetPct < 30, `252 × 0.1% compounds to ${up.annRetPct.toFixed(1)}%`);
  assert.equal(up.maxDDPct, 0, "a monotone curve has no drawdown");
});
