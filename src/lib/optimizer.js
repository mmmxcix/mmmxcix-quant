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

// ── Parameter-stability heatmap — the over-fit picture ───────────────────────
/**
 * Sweep TWO parameters across a grid and score every combination, so the shape
 * of the result surface is visible. A robust edge shows a broad PLATEAU of good
 * values — you could be off by a step and still be fine. An over-fit one shows a
 * lone SPIKE surrounded by mediocre cells: the "great" parameters are luck, and
 * live trading won't land exactly on them. This is the map bennnytrades' clip
 * calls step one of validation.
 * @param {object} o
 * @param {Array} o.params            all strategy param defs
 * @param {string} o.xKey             param on the x-axis
 * @param {string} o.yKey             param on the y-axis
 * @param {(paramsObj)=>number} o.evaluate
 * @param {object} [o.base]           values for the params NOT being swept
 * @param {number} [o.cap]            cells per axis
 * @returns {{xKey,yKey,xs,ys,cells,min,max,best,robustness,verdict}|null}
 */
export function parameterHeatmap({ params, xKey, yKey, evaluate, base = {}, cap = 9 }) {
  const px = params.find((p) => p.key === xKey);
  const py = params.find((p) => p.key === yKey);
  if (!px || !py || xKey === yKey) return null;
  const xs = candidateValues(px, cap);
  const ys = candidateValues(py, cap);
  const cells = [];
  let min = Infinity, max = -Infinity;
  let best = null;
  for (let j = 0; j < ys.length; j++) {
    const row = [];
    for (let i = 0; i < xs.length; i++) {
      const raw = safe(evaluate, { ...base, [xKey]: xs[i], [yKey]: ys[j] });
      const s = Number.isFinite(raw) ? raw : null; // null = degenerate (the caller's -Infinity penalty)
      if (s != null) {
        if (s < min) min = s;
        if (s > max) max = s;
        if (!best || s > best.score) best = { i, j, score: s };
      }
      row.push(s);
    }
    cells.push(row);
  }
  if (!best) return { xKey, yKey, xs, ys, cells, min, max, best: null, robustness: 0, verdict: "empty" };

  // Robustness = how the best cell's orthogonal neighbours hold up, relative to
  // the full spread. Neighbours nearly as good → a plateau; a sharp drop → a spike.
  const neigh = [];
  for (const [di, dj] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
    const ni = best.i + di, nj = best.j + dj;
    if (nj >= 0 && nj < ys.length && ni >= 0 && ni < xs.length && cells[nj][ni] != null) neigh.push(cells[nj][ni]);
  }
  const spread = max - min;
  const nMean = neigh.length ? neigh.reduce((a, b) => a + b, 0) / neigh.length : min;
  // 1 = neighbours equal the best (flat plateau), 0 = neighbours at the global worst.
  const robustness = spread > 0 ? Math.max(0, Math.min(1, (nMean - min) / spread)) : 1;
  const drop = spread > 0 ? (best.score - nMean) / spread : 0;
  const verdict = spread <= 0 ? "flat" : drop < 0.25 ? "robust" : drop > 0.6 ? "overfit" : "mixed";
  return { xKey, yKey, xs, ys, cells, min, max, best, robustness, verdict };
}

// ── Monte-Carlo trade bootstrap ──────────────────────────────────────────────
/**
 * Resample a strategy's own trade returns (with replacement) many times and
 * compound each draw into an equity path — so a single backtest becomes a
 * DISTRIBUTION of outcomes rather than one lucky (or unlucky) number. Reveals
 * sequence risk (how bad the drawdown could plausibly have been) and sampling
 * uncertainty (a 5th-percentile that's still positive is a real edge).
 * @param {number[]} tradeReturns  per-trade FRACTIONAL returns (pnlPct / 100)
 * @param {object} [o]
 * @param {number} [o.runs]
 * @param {number} [o.seed]
 * @returns {{runs,trades,retP5,retMed,retP95,ddMed,ddP95,pProfit}|null}
 */
export function bootstrapTrades(tradeReturns, { runs = 500, seed = 99 } = {}) {
  const n = tradeReturns?.length ?? 0;
  if (n < 5) return null; // too few trades to say anything honest
  const rng = mulberry32(seed);
  const finals = [], dds = [];
  for (let r = 0; r < runs; r++) {
    let eq = 1, peak = 1, maxDD = 0;
    for (let i = 0; i < n; i++) {
      const ret = tradeReturns[(rng() * n) | 0]; // draw a trade with replacement
      eq *= 1 + ret;
      if (eq > peak) peak = eq;
      const dd = peak > 0 ? (peak - eq) / peak : 0;
      if (dd > maxDD) maxDD = dd;
    }
    finals.push((eq - 1) * 100);
    dds.push(maxDD * 100);
  }
  finals.sort((a, b) => a - b); dds.sort((a, b) => a - b);
  const q = (arr, p) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(p * arr.length)))];
  return {
    runs, trades: n,
    retP5: q(finals, 0.05), retMed: q(finals, 0.5), retP95: q(finals, 0.95),
    ddMed: q(dds, 0.5), ddP95: q(dds, 0.95),
    pProfit: finals.filter((x) => x > 0).length / runs,
  };
}

/**
 * Monte-Carlo across MANY parameter sets, not one — bennnytrades' point: judging
 * a strategy from a Monte-Carlo of a single (optimised) parameter set is exactly
 * how you fool yourself. Bootstraps each set and reports how many stay profitable
 * at the 5th percentile, so a robust FAMILY is distinguished from a lucky point.
 * @param {object} o
 * @param {Array<object>} o.paramSets
 * @param {(paramsObj)=>number[]|null} o.backtest  → fractional trade returns
 * @param {number} [o.runs]
 * @param {number} [o.seed]
 */
export function monteCarloParams({ paramSets, backtest, runs = 400, seed = 99 }) {
  const results = [];
  for (const p of paramSets) {
    const tr = backtest(p);
    results.push({ params: p, mc: bootstrapTrades(tr, { runs, seed }) });
  }
  const valid = results.filter((r) => r.mc);
  const robust = valid.filter((r) => r.mc.retP5 > 0 && r.mc.pProfit >= 0.9);
  // Representative = the valid set whose median return is the MEDIAN of the group
  // (a typical outcome, not the cherry-picked best).
  const byMed = [...valid].sort((a, b) => a.mc.retMed - b.mc.retMed);
  const representative = byMed.length ? byMed[Math.floor(byMed.length / 2)] : null;
  const frac = valid.length ? robust.length / valid.length : 0;
  const verdict = valid.length === 0 ? "inconclusive" : frac >= 0.6 ? "robust" : frac >= 0.3 ? "mixed" : "fragile";
  return { results, tested: results.length, valid: valid.length, robustCount: robust.length, representative, verdict };
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
