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
