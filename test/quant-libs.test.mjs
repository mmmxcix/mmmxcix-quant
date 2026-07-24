// Regression tests for the pure-JS quant libraries (ML4T upgrades). Run with
// `npm test` (Node's built-in runner — no extra dependency). These lock in the
// behaviour that was verified by hand when each feature shipped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { hrpWeights } from "../src/lib/hrp.js";
import { garchFit } from "../src/lib/garch.js";
import { analyzePair, ouFit } from "../src/lib/pairs.js";
import { benjaminiHochberg } from "../scripts/mining.mjs";

// Deterministic standard-normal generator (Box–Muller on a tiny LCG).
function gauss(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff; const u = s / 0x7fffffff;
    s = (s * 1103515245 + 12345) & 0x7fffffff; const v = s / 0x7fffffff;
    return Math.sqrt(-2 * Math.log(u + 1e-12)) * Math.cos(2 * Math.PI * v);
  };
}

test("HRP: weights sum to 1, correlated pairs share weight, calm block dominates", () => {
  const g = gauss(42), N = 500;
  const A = [], B = [], C = [], D = [];
  for (let i = 0; i < N; i++) {
    const f1 = g() * 0.01, f2 = g() * 0.03;
    A.push(f1 + g() * 0.002); B.push(f1 + g() * 0.002); // low-vol correlated
    C.push(f2 + g() * 0.006); D.push(f2 + g() * 0.006); // high-vol correlated
  }
  const { weights } = hrpWeights({ A, B, C, D });
  const sum = Object.values(weights).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, "weights sum to 1");
  assert.ok(Math.abs(weights.A - weights.B) < 0.03, "A≈B");
  assert.ok(Math.abs(weights.C - weights.D) < 0.03, "C≈D");
  assert.ok(weights.A + weights.B > weights.C + weights.D, "calmer block gets more");
});

test("HRP: single asset gets full weight; empty is safe", () => {
  assert.deepEqual(hrpWeights({ X: [0.01, -0.02, 0.03] }).weights, { X: 1 });
  assert.deepEqual(hrpWeights({}).weights, {});
});

test("GARCH: recovers persistence and stays positive", () => {
  const g = gauss(7), N = 3000, alpha = 0.08, beta = 0.9, uv = 4e-4;
  const omega = (1 - alpha - beta) * uv;
  let s2 = uv, prevEps2 = uv; const rets = [];
  for (let i = 0; i < N; i++) { s2 = omega + alpha * prevEps2 + beta * s2; const e = Math.sqrt(s2) * g(); rets.push(e); prevEps2 = e * e; }
  const f = garchFit(rets);
  assert.ok(f, "fit returned");
  assert.ok(f.persistence > 0.9 && f.persistence < 1, "high persistence recovered");
  assert.ok(f.alpha > 0.02 && f.alpha < 0.2, "alpha in a sane band");
  assert.ok(f.currentVol > 0 && f.fwd1 > 0 && f.fwd10 > 0, "vols positive");
  assert.equal(garchFit([0.01, 0.02]), null, "too little data → null");
});

test("Pairs: cointegrated → tradeable with sane β; independent walks → rejected", () => {
  const g = gauss(3), N = 600;
  const B = [100]; for (let i = 1; i < N; i++) B.push(B[i - 1] * (1 + 0.0004 * g()));
  let S = 0; const sp = []; for (let i = 0; i < N; i++) { S = 0.933 * S + 0.5 * g(); sp.push(S); } // half-life ~10
  const A = B.map((b, i) => 2 * b + 50 + sp[i]);
  const r = analyzePair(A, B);
  assert.ok(r.tradeable, "cointegrated pair is tradeable");
  assert.ok(Math.abs(r.beta - 2) < 0.4, "hedge ratio near the true 2.0");
  assert.ok(r.halfLife > 3 && r.halfLife < 40, "finite, short half-life");

  const C = [100], D = [100];
  for (let i = 1; i < N; i++) { C.push(C[i - 1] * (1 + 0.01 * g())); D.push(D[i - 1] * (1 + 0.01 * g())); }
  const r2 = analyzePair(C, D);
  assert.ok(!r2.tradeable, "two independent random walks are NOT tradeable");
});

test("Pairs OU: a pure random walk is not mean-reverting", () => {
  const g = gauss(9); let x = 0; const rw = [];
  for (let i = 0; i < 400; i++) { x += g(); rw.push(x); }
  const ou = ouFit(rw);
  assert.ok(ou.halfLife > 60 || ou.halfLife === Infinity, "random walk half-life is long/infinite");
});

test("FDR (Benjamini–Hochberg): keeps the right discoveries", () => {
  // Sorted p = [.001,.008,.02,.2,.6], m=20, q=0.1 → thresholds k/m·q =
  // [.005,.01,.015,.02,.025]; largest k with p(k)≤thresh is k=2 → keep indices 0,1.
  const pass = benjaminiHochberg([0.001, 0.008, 0.02, 0.2, 0.6], 20, 0.1);
  assert.deepEqual([...pass].sort((a, b) => a - b), [0, 1]);
  // Nothing passes when all p-values are large.
  assert.equal(benjaminiHochberg([0.5, 0.6, 0.7], 20, 0.1).size, 0);
});
