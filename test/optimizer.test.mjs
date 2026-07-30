// Tests for the parameter optimizer. Use a known objective (a paraboloid with a
// single maximum) so we can assert each search method lands near the true peak,
// and that walk-forward reports a coherent verdict.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gridSearch, bayesianSearch, geneticSearch, candidateValues, walkForward } from "../src/lib/optimizer.js";

const params = [
  { key: "a", default: 10, min: 0, max: 60, step: 2 },
  { key: "b", default: 10, min: 0, max: 100, step: 2 },
];
// Peak (+100) at a=30, b=50 — positive-valued like a real Sharpe/return objective.
const evaluate = ({ a, b }) => 100 - ((a - 30) ** 2 + (b - 50) ** 2) / 20;
const near = (best, ta, tb, tol) => Math.abs(best.params.a - ta) <= tol && Math.abs(best.params.b - tb) <= tol;

test("candidateValues respects min/max/step and the cap", () => {
  assert.deepEqual(candidateValues({ min: 0, max: 6, step: 2 }, 6), [0, 2, 4, 6]);
  assert.equal(candidateValues({ min: 0, max: 100, step: 1 }, 5).length, 5); // capped
});

test("grid search finds the neighbourhood of the true peak", () => {
  const r = gridSearch({ params, evaluate, cap: 8 });
  assert.ok(r.best, "has a best");
  assert.ok(near(r.best, 30, 50, 12), `grid near peak (got a=${r.best.params.a}, b=${r.best.params.b})`);
});

test("bayesian-lite improves over its random init and nears the peak", () => {
  const r = bayesianSearch({ params, evaluate, iterations: 150, seed: 42 });
  assert.equal(r.method, "bayesian");
  assert.ok(near(r.best, 30, 50, 8), `bayesian near peak (a=${r.best.params.a}, b=${r.best.params.b})`);
});

test("genetic search converges toward the peak", () => {
  const r = geneticSearch({ params, evaluate, popSize: 24, generations: 14, seed: 7 });
  assert.ok(near(r.best, 30, 50, 8), `genetic near peak (a=${r.best.params.a}, b=${r.best.params.b})`);
});

test("results are deduped and sorted best-first", () => {
  const r = gridSearch({ params, evaluate, cap: 6 });
  for (let i = 1; i < r.results.length; i++) assert.ok(r.results[i - 1].score >= r.results[i].score, "sorted desc");
});

test("walk-forward returns a coherent verdict on a stable objective", () => {
  // A stationary objective (best params are the same in every slice) → robust.
  const scoreSlice = (pp) => evaluate(pp); // ignores the slice → perfectly stable
  const wf = walkForward({ params, scoreSlice, n: 2000, method: "bayesian", folds: 4, budget: 40 });
  assert.ok(["robust", "fragile", "overfit", "n/a"].includes(wf.verdict));
  assert.equal(wf.verdict, "robust", "a stationary edge should read robust");
  assert.ok(wf.folds.length >= 1, "produced folds");
});

// ── parameter-stability heatmap ─────────────────────────────────────────────
import { parameterHeatmap } from "../src/lib/optimizer.js";

const HM_PARAMS = [
  { key: "a", min: 0, max: 8, step: 1 },
  { key: "b", min: 0, max: 8, step: 1 },
];

test("parameterHeatmap flags a broad plateau as robust", () => {
  // Smooth dome peaking mid-grid → best cell's neighbours are nearly as good.
  const evaluate = ({ a, b }) => 100 - (a - 4) ** 2 - (b - 4) ** 2;
  const hm = parameterHeatmap({ params: HM_PARAMS, xKey: "a", yKey: "b", evaluate, cap: 9 });
  assert.ok(hm.best, "found a best cell");
  assert.equal(hm.xs.length, 9);
  assert.equal(hm.verdict, "robust", `dome should be robust, got ${hm.verdict}`);
  assert.ok(hm.robustness > 0.8, `plateau robustness high, got ${hm.robustness}`);
});

test("parameterHeatmap flags a lone spike as overfit", () => {
  // One cell is spectacular, everything else is flat and mediocre.
  const evaluate = ({ a, b }) => (a === 3 && b === 5 ? 100 : 1);
  const hm = parameterHeatmap({ params: HM_PARAMS, xKey: "a", yKey: "b", evaluate, cap: 9 });
  assert.equal(hm.verdict, "overfit", `isolated spike should be overfit, got ${hm.verdict}`);
  assert.ok(hm.robustness < 0.2, `spike robustness low, got ${hm.robustness}`);
});

test("parameterHeatmap treats non-finite scores as empty cells", () => {
  const evaluate = ({ a }) => (a < 3 ? -Infinity : a);
  const hm = parameterHeatmap({ params: HM_PARAMS, xKey: "a", yKey: "b", evaluate, cap: 9 });
  assert.equal(hm.cells[0][0], null, "penalised combo becomes a null cell");
  assert.ok(hm.best.score > 0, "best ignores the null cells");
});

test("parameterHeatmap returns null when the two axes are the same param", () => {
  assert.equal(parameterHeatmap({ params: HM_PARAMS, xKey: "a", yKey: "a", evaluate: () => 1 }), null);
});

// ── Monte-Carlo trade bootstrap ─────────────────────────────────────────────
import { bootstrapTrades, monteCarloParams } from "../src/lib/optimizer.js";

test("bootstrapTrades needs a real sample and orders its percentiles", () => {
  assert.equal(bootstrapTrades([0.01, 0.02]), null, "too few trades → null");
  // A strongly positive edge (mostly wins) → distribution sits above zero.
  const wins = Array.from({ length: 60 }, (_, i) => (i % 3 === 0 ? -0.01 : 0.02));
  const mc = bootstrapTrades(wins, { runs: 300, seed: 5 });
  assert.ok(mc.retP5 <= mc.retMed && mc.retMed <= mc.retP95, "percentiles ordered");
  assert.ok(mc.pProfit > 0.9, "a real edge is profitable in most resamples");
  assert.ok(mc.retP5 > 0, "even the 5th percentile is positive for a strong edge");
  assert.ok(mc.sharpeP5 <= mc.sharpeMed && mc.sharpeMed <= mc.sharpeP95, "Sharpe CI ordered");
  assert.ok(mc.sharpeP5 > 0, "a strong edge keeps a positive 5th-percentile Sharpe");
  assert.ok(mc.ddP95 >= mc.ddMed, "worst-case drawdown ≥ median");
});

test("bootstrapTrades marks a coin-flip edge as unreliable", () => {
  const flat = Array.from({ length: 80 }, (_, i) => (i % 2 === 0 ? 0.02 : -0.02));
  const mc = bootstrapTrades(flat, { runs: 300, seed: 7 });
  assert.ok(mc.retP5 < 0, "downside tail is negative for a no-edge strategy");
  assert.ok(mc.pProfit < 0.9, "not reliably profitable");
});

test("monteCarloParams separates a robust family from lucky points", () => {
  const good = Array.from({ length: 60 }, (_, i) => (i % 3 === 0 ? -0.01 : 0.02));
  const bad = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 0.02 : -0.021));
  // Two robust sets, one fragile → majority robust.
  const backtest = (p) => (p.k === 3 ? bad : good);
  const out = monteCarloParams({ paramSets: [{ k: 1 }, { k: 2 }, { k: 3 }], backtest, runs: 200 });
  assert.equal(out.valid, 3);
  assert.equal(out.robustCount, 2);
  assert.equal(out.verdict, "robust");
  assert.ok(out.representative, "picks a representative set");
});

// ── library mining: parameter variants ──────────────────────────────────────
import { paramVariants } from "../src/lib/optimizer.js";

test("paramVariants nudges one param at a time, clamped + de-duplicated", () => {
  const params = [{ key: "a", min: 0, max: 4, step: 1 }, { key: "b", min: 0, max: 4, step: 1 }];
  const v = paramVariants(params, { a: 2, b: 2 }, 1);
  // a±1 and b±1 = 4 neighbours, none equal to the base.
  assert.equal(v.length, 4);
  assert.ok(v.some((x) => x.a === 1 && x.b === 2) && v.some((x) => x.a === 3 && x.b === 2));
  assert.ok(v.every((x) => !(x.a === 2 && x.b === 2)), "base excluded");
  // At an edge, the clamped move collides with the base and is dropped.
  const edge = paramVariants(params, { a: 0, b: 0 }, 1);
  assert.equal(edge.length, 2, "a-1 and b-1 clamp to the base and drop out");
});
