// optimizer.js — parameter optimization for the built-in strategies. Three
// search methods (Grid · Bayesian-lite · Genetic) over a strategy's param space,
// plus WALK-FORWARD validation as the overfit guard (optimize in-sample, score
// out-of-sample, report the degradation). Pure and dependency-free: the caller
// supplies `evaluate(paramsObj) → score` (higher = better), so the module knows
// nothing about backtests — it just searches. Deterministic RNG so a run is
// reproducible. See docs (Video-5 optimization stack: Grid/Bayesian/Genetic,
// selectable objective, walk-forward over-fit check).

// ── deterministic RNG (mulberry32) ──────────────────────────────────────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clampStep = (v, p) => {
  const min = p.min ?? 1, max = p.max ?? min, step = p.step || 1;
  const snapped = Math.round((v - min) / step) * step + min;
  return +Math.min(max, Math.max(min, snapped)).toFixed(6);
};

/** Discrete candidate values for a param, capped so the grid stays tractable. */
export function candidateValues(p, cap = 6) {
  const min = p.min ?? 1, max = p.max ?? min, step = p.step || 1;
  if (max <= min) return [min];
  const n = Math.floor((max - min) / step) + 1;
  if (n <= cap) return Array.from({ length: n }, (_, i) => +(min + i * step).toFixed(6));
  return Array.from({ length: cap }, (_, i) => clampStep(min + ((max - min) * i) / (cap - 1), p));
}

function randomParams(params, rng) {
  const out = {};
  for (const p of params) {
    const min = p.min ?? 1, max = p.max ?? min, step = p.step || 1;
    const n = Math.max(1, Math.floor((max - min) / step) + 1);
    out[p.key] = +(min + Math.floor(rng() * n) * step).toFixed(6);
  }
  return out;
}

// Nudge each param by a few steps around a good point (local exploitation).
function jitter(base, params, rng, spread = 2) {
  const out = {};
  for (const p of params) {
    const step = p.step || 1;
    const delta = (Math.floor(rng() * (2 * spread + 1)) - spread) * step;
    out[p.key] = clampStep((base[p.key] ?? p.default ?? p.min ?? 0) + delta, p);
  }
  return out;
}

// ── 1. Grid search — exhaustive over the discretised space (sampled if huge) ─
export function gridSearch({ params, evaluate, maxEvals = 500, cap = 6 }) {
  let combos = [{}];
  for (const p of params) {
    const vals = candidateValues(p, cap);
    const next = [];
    for (const c of combos) for (const v of vals) next.push({ ...c, [p.key]: v });
    combos = next;
  }
  if (combos.length > maxEvals) { // too many → even stride sample
    const stride = combos.length / maxEvals;
    combos = Array.from({ length: maxEvals }, (_, i) => combos[Math.floor(i * stride)]);
  }
  return finalize("grid", combos.map((pp) => ({ params: pp, score: safe(evaluate, pp) })));
}

// ── 2. Bayesian-lite (TPE-style) — random init, then exploit near the best ───
export function bayesianSearch({ params, evaluate, iterations = 120, initN = 20, seed = 1234 }) {
  const rng = mulberry32(seed);
  const results = [];
  const n = Math.max(4, Math.min(initN, iterations));
  for (let i = 0; i < n; i++) { const pp = randomParams(params, rng); results.push({ params: pp, score: safe(evaluate, pp) }); }
  for (let i = n; i < iterations; i++) {
    const sorted = [...results].sort((a, b) => b.score - a.score);
    const eliteCount = Math.max(1, Math.ceil(sorted.length * 0.25));
    const seedPt = sorted[Math.floor(rng() * eliteCount)];      // pick from the top quartile
    const pp = jitter(seedPt.params, params, rng);              // sample nearby
    results.push({ params: pp, score: safe(evaluate, pp) });
  }
  return finalize("bayesian", results);
}

// ── 3. Genetic — population, tournament selection, crossover, mutation ───────
export function geneticSearch({ params, evaluate, popSize = 24, generations = 10, seed = 777 }) {
  const rng = mulberry32(seed);
  const tournament = (scored) => {
    const a = scored[Math.floor(rng() * scored.length)], b = scored[Math.floor(rng() * scored.length)];
    return a.score >= b.score ? a : b;
  };
  const crossover = (x, y) => { const c = {}; for (const p of params) c[p.key] = (rng() < 0.5 ? x : y)[p.key]; return c; };
  const mutate = (c, rate = 0.25) => { const o = { ...c }; for (const p of params) if (rng() < rate) o[p.key] = jitter(o, [p], rng)[p.key]; return o; };

  let scored = Array.from({ length: popSize }, () => randomParams(params, rng)).map((pp) => ({ params: pp, score: safe(evaluate, pp) }));
  const all = [...scored];
  for (let g = 0; g < generations; g++) {
    scored.sort((a, b) => b.score - a.score);
    const eliteCount = Math.max(2, Math.floor(popSize * 0.2));
    const next = scored.slice(0, eliteCount).map((e) => e.params);   // elitism
    while (next.length < popSize) next.push(mutate(crossover(tournament(scored).params, tournament(scored).params)));
    scored = next.map((pp) => ({ params: pp, score: safe(evaluate, pp) }));
    all.push(...scored);
  }
  return finalize("genetic", all);
}

export function optimize({ method = "bayesian", params, evaluate, budget }) {
  if (method === "grid") return gridSearch({ params, evaluate, maxEvals: budget ?? 500 });
  if (method === "genetic") return geneticSearch({ params, evaluate, generations: budget ? Math.max(4, Math.round(budget / 24)) : 10 });
  return bayesianSearch({ params, evaluate, iterations: budget ?? 120 });
}

// ── Walk-forward validation — the over-fit guard ─────────────────────────────
/**
 * Optimize IN-SAMPLE, score OUT-OF-SAMPLE across rolling windows over the back
 * half of the data, and report whether the edge survives unseen data.
 * @param {object} o
 * @param {Array} o.params           strategy param defs
 * @param {(paramsObj, from, to)=>number} o.scoreSlice  score a param set on candles[from:to]
 * @param {number} o.n               total candle count
 * @param {string} [o.method]        optimizer for the in-sample fit
 * @param {number} [o.folds]
 * @param {number} [o.budget]        per-fold optimizer budget (kept modest — it runs folds× times)
 */
export function walkForward({ params, scoreSlice, n, method = "bayesian", folds = 3, budget = 60 }) {
  const testStart = Math.floor(n * 0.5);
  const winLen = Math.floor((n - testStart) / folds);
  const fin = (x) => (Number.isFinite(x) ? x : 0);
  const out = [];
  for (let k = 0; k < folds; k++) {
    const oosA = testStart + k * winLen;
    const oosB = k === folds - 1 ? n : oosA + winLen;
    if (oosA < 100 || oosB - oosA < 20) continue;
    const opt = optimize({ method, params, evaluate: (pp) => scoreSlice(pp, 0, oosA), budget });
    const rawOOS = scoreSlice(opt.best?.params ?? {}, oosA, oosB);
    // A non-finite OOS score = the caller's "too few trades" penalty → this window
    // can't demonstrate anything either way. Mark it inconclusive rather than
    // scoring it a hard fail, so a quiet window isn't mistaken for over-fitting.
    out.push({
      fold: k + 1, isScore: round(fin(opt.best?.score)), oosScore: round(fin(rawOOS)),
      oosValid: Number.isFinite(rawOOS), params: opt.best?.params ?? {}, oosBars: oosB - oosA,
    });
  }
  const valid = out.filter((f) => f.oosValid);
  const avgIS = mean(valid.map((f) => f.isScore));
  const avgOOS = mean(valid.map((f) => f.oosScore));
  const degradation = avgIS > 0 ? avgOOS / avgIS : avgOOS >= 0 ? 1 : 0;
  let verdict;
  if (!out.length) verdict = "n/a";
  else if (valid.length < Math.ceil(out.length / 2)) verdict = "inconclusive"; // too few OOS trades to judge — use more data
  else if (avgOOS <= 0) verdict = "overfit";
  else verdict = degradation >= 0.5 ? "robust" : "fragile";
  return { folds: out, validFolds: valid.length, avgIS: round(avgIS), avgOOS: round(avgOOS), degradation: round(degradation), verdict };
}

// ── helpers ──────────────────────────────────────────────────────────────────
function safe(fn, pp) { const v = fn(pp); return Number.isFinite(v) ? v : -Infinity; }
function round(x) { return Number.isFinite(x) ? +x.toFixed(4) : x; }
function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }

// Dedupe by params, sort best-first, keep a compact top list + the winner.
function finalize(method, raw, top = 40) {
  const seen = new Set();
  const uniq = [];
  for (const r of raw) {
    const k = JSON.stringify(r.params);
    if (!seen.has(k)) { seen.add(k); uniq.push(r); }
  }
  uniq.sort((a, b) => b.score - a.score);
  return { method, evals: raw.length, unique: uniq.length, results: uniq.slice(0, top), best: uniq[0] || null };
}
