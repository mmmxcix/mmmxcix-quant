// pairsScreen — the universe-wide pairs screener, and the guard rails that stop
// it from being a data-mining machine.
import test from "node:test";
import assert from "node:assert/strict";
import {
  alignCloses, olsFit, adfTStat, egPValue, benjaminiHochberg, screenPairs,
} from "../src/lib/pairsScreen.js";

// Deterministic noise — a screener test that passes only on a lucky seed is
// exactly the failure mode the screener itself exists to prevent.
function rng(seed = 42) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const gauss = (r) => {
  const u = Math.max(1e-12, r()), v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const dates = (n) => Array.from({ length: n }, (_, i) => new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10));
const toMap = (vals, ds) => new Map(vals.map((v, i) => [ds[i], v]));

/** A random walk, and a partner tied to it by a spread that reverts at a
 *  realistic speed — AR(1) with φ=0.9, i.e. a half-life of ~6.6 bars. (A white-
 *  noise spread would revert instantly, which no real pair does.) */
function cointegrated(n, seed, phi = 0.9) {
  const r = rng(seed);
  const B = [100], A = [];
  let s = 0;
  for (let i = 1; i < n; i++) B.push(Math.max(1, B[i - 1] + gauss(r)));
  for (let i = 0; i < n; i++) { s = phi * s + 1.5 * gauss(r); A.push(2 * B[i] + 5 + s); }
  return { A, B };
}
function independentWalks(n, seed) {
  const r = rng(seed);
  const A = [100], B = [80];
  for (let i = 1; i < n; i++) { A.push(Math.max(1, A[i - 1] + gauss(r))); B.push(Math.max(1, B[i - 1] + gauss(r))); }
  return { A, B };
}

test("alignCloses keeps only the shared dates, in order", () => {
  const a = new Map([["2024-01-02", 2], ["2024-01-01", 1], ["2024-01-03", 3]]);
  const b = new Map([["2024-01-01", 10], ["2024-01-03", 30]]);
  const { A, B, dates: d } = alignCloses(a, b);
  assert.deepEqual(d, ["2024-01-01", "2024-01-03"]);
  assert.deepEqual(A, [1, 3]);
  assert.deepEqual(B, [10, 30]);
});

test("OLS recovers a known line with sane standard errors", () => {
  const X = [], y = [];
  const r = rng(7);
  for (let i = 0; i < 200; i++) { const x = i / 10; X.push([1, x]); y.push(3 + 2 * x + 0.01 * gauss(r)); }
  const f = olsFit(X, y);
  assert.ok(Math.abs(f.beta[0] - 3) < 0.01, `intercept ${f.beta[0]}`);
  assert.ok(Math.abs(f.beta[1] - 2) < 0.01, `slope ${f.beta[1]}`);
  assert.ok(f.se[1] > 0 && f.se[1] < 0.01);
  assert.equal(f.dof, 198);
});

test("ADF separates a mean-reverting spread from a random walk", () => {
  const r = rng(11);
  const stationary = [];
  let s = 0;
  for (let i = 0; i < 400; i++) { s = 0.9 * s + gauss(r); stationary.push(s); } // AR(1), reverts
  const walk = [0];
  for (let i = 1; i < 400; i++) walk.push(walk[i - 1] + gauss(r));
  const tS = adfTStat(stationary), tW = adfTStat(walk);
  assert.ok(tS < -3.34, `stationary t should clear the 5% EG value, got ${tS.toFixed(2)}`);
  assert.ok(tW > -3.04, `a random walk must not look stationary, got ${tW.toFixed(2)}`);
  assert.ok(egPValue(tS) < 0.05 && egPValue(tW) > 0.1);
  assert.equal(adfTStat([1, 2, 3]), null, "too short to test");
});

test("egPValue is monotone and clamped", () => {
  assert.ok(egPValue(-6) <= egPValue(-3.9));
  assert.ok(egPValue(-3.9) < egPValue(-3.34));
  assert.ok(egPValue(-3.34) < egPValue(-2));
  assert.ok(egPValue(10) <= 1 && egPValue(-99) > 0);
  assert.equal(egPValue(NaN), 1);
});

test("Benjamini–Hochberg keeps the real ones and drops the noise", () => {
  // 5 genuine effects among 100 tests, at a 10% false-discovery rate. The fifth
  // sits just under its (5/100)·α = 0.005 step — the step-up is exact, not lenient.
  const ps = [0.0001, 0.0002, 0.001, 0.002, 0.004, ...Array.from({ length: 95 }, (_, i) => 0.2 + i * 0.008)];
  const { survives, q, expectedFalse } = benjaminiHochberg(ps, 0.1);
  assert.equal(survives.filter(Boolean).length, 5);
  assert.ok(survives.slice(0, 5).every(Boolean));
  assert.ok(q.every((v, i) => v >= ps[i] - 1e-12), "adjusted p is never smaller than raw p");
  assert.ok(q.every((v, i, arr) => i === 0 || ps[i] < ps[i - 1] || v >= arr[i - 1] - 1e-9), "monotone in p");
  assert.equal(expectedFalse, 0.5);
  // A field of pure noise yields nothing — the whole point of the correction.
  const noise = Array.from({ length: 45 }, (_, i) => 0.05 + i * 0.02);
  assert.equal(benjaminiHochberg(noise, 0.1).survives.filter(Boolean).length, 0);
  assert.deepEqual(benjaminiHochberg([], 0.1).survives, []);
});

test("the screener finds the planted pair and rejects the unrelated ones", () => {
  const ds = dates(400);
  const { A, B } = cointegrated(400, 3);
  const w1 = independentWalks(400, 99), w2 = independentWalks(400, 1234);
  const closes = {
    AAA: toMap(A, ds), BBB: toMap(B, ds),
    CCC: toMap(w1.A, ds), DDD: toMap(w1.B, ds), EEE: toMap(w2.A, ds),
  };
  const res = screenPairs(closes, { costPct: 0.2 });
  assert.equal(res.tested, 10, "5 symbols → 10 pairs");
  const top = res.rows[0];
  assert.deepEqual([top.a, top.b].sort(), ["AAA", "BBB"]);
  assert.ok(top.stationary, "the planted pair must survive the correction");
  assert.ok(Number.isFinite(top.halfLife) && top.halfLife < 60, `half-life ${top.halfLife}`);
  assert.ok(Math.abs(Math.abs(top.beta) - 2) < 0.3 || Math.abs(Math.abs(top.beta) - 0.5) < 0.1, `hedge ratio ${top.beta}`);
  // Everything else is two unrelated random walks — none of it may pass.
  for (const r of res.rows.slice(1)) assert.equal(r.stationary, false, `${r.a}/${r.b} should not survive`);
  assert.equal(res.survivors, 1);
});

test("a universe of pure random walks yields no survivors at all", () => {
  const ds = dates(300);
  const closes = {};
  for (let k = 0; k < 6; k++) closes[`S${k}`] = toMap(independentWalks(300, 500 + k * 17).A, ds);
  const res = screenPairs(closes);
  assert.equal(res.tested, 15);
  assert.equal(res.survivors, 0, "15 draws from the null must not produce a discovery");
});

test("a spread that cannot pay its costs is not tradeable, however clean", () => {
  const ds = dates(400);
  const { A, B } = cointegrated(400, 3);
  const closes = { AAA: toMap(A, ds), BBB: toMap(B, ds) };
  const cheap = screenPairs(closes, { costPct: 0.2 }).rows[0];
  const dear = screenPairs(closes, { costPct: 50 }).rows[0];
  assert.equal(cheap.stationary, dear.stationary, "the statistics do not change with the fee");
  assert.ok(cheap.costOk && cheap.tradeable);
  assert.ok(!dear.costOk && !dear.tradeable, "at 50% round-trip nothing is worth trading");
});

test("pairs without enough shared history are skipped, not guessed at", () => {
  const ds = dates(400);
  const { A, B } = cointegrated(400, 3);
  const closes = { AAA: toMap(A, ds), BBB: toMap(B, ds), SHORT: toMap(A.slice(0, 40), ds.slice(0, 40)) };
  const res = screenPairs(closes, { minOverlap: 120 });
  assert.equal(res.tested, 1);
  assert.equal(res.skipped.length, 2);
  assert.ok(res.skipped.every((s) => s.why === "not enough shared history"));
});
