// hmmRegime.js — turn a candle series into labelled market regimes with an HMM.
//
// The HMM (hmm.js) finds hidden states; this layer decides what to FEED it and
// what the states MEAN. Features: log returns and rolling volatility — the two
// things that actually separate a calm bull from a violent bear. Both are
// z-scored so the Gaussian emissions are well-conditioned.
//
// Labelling: the raw states come out unordered, so we sort them by mean return
// and name them bear → … → bull. Each state also carries its real-unit stats
// (mean daily return, annualised vol, average duration) so the UI and any
// regime gate can reason about it.
//
// Pure module: no DOM, no fetch. Deterministic given a seed.

import { fit, viterbi, posterior } from "./hmm.js";

const LABELS_3 = ["Bear", "Neutral", "Bull"];
const LABELS_2 = ["Bear", "Bull"];
const labelsFor = (K) => (K === 2 ? LABELS_2 : K === 3 ? LABELS_3 : Array.from({ length: K }, (_, i) => `Regime ${i + 1}`));

/** Build [logReturn, rollingVol] features, z-scored, plus the raw log returns. */
function buildFeatures(candles, volWindow) {
  const closes = candles.map((c) => c.close);
  const rets = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));

  // rolling volatility (std of the last volWindow returns), aligned to rets
  const vol = new Array(rets.length).fill(null);
  for (let i = volWindow - 1; i < rets.length; i++) {
    let mean = 0;
    for (let j = i - volWindow + 1; j <= i; j++) mean += rets[j];
    mean /= volWindow;
    let v = 0;
    for (let j = i - volWindow + 1; j <= i; j++) { const d = rets[j] - mean; v += d * d; }
    vol[i] = Math.sqrt(v / volWindow);
  }

  // feature rows exist where vol exists; candleIndex maps a feature row back to
  // the candle it describes (rets[i] is between candle i and i+1, so candle i+1).
  const rows = [], candleIndex = [], rawRet = [];
  for (let i = volWindow - 1; i < rets.length; i++) {
    rows.push([rets[i], vol[i]]);
    candleIndex.push(i + 1);
    rawRet.push(rets[i]);
  }

  // z-score each column
  const D = 2, n = rows.length;
  const mean = [0, 0], sd = [0, 0];
  for (const r of rows) for (let d = 0; d < D; d++) mean[d] += r[d] / n;
  for (const r of rows) for (let d = 0; d < D; d++) { const df = r[d] - mean[d]; sd[d] += (df * df) / n; }
  for (let d = 0; d < D; d++) sd[d] = Math.sqrt(sd[d]) || 1;
  const X = rows.map((r) => r.map((v, d) => (v - mean[d]) / sd[d]));

  return { X, candleIndex, rawRet, rawVol: rows.map((r) => r[1]) };
}

/** Annualisation factor for volatility, by interval. */
const BARS_PER_YEAR = { "1m": 525600, "5m": 105120, "15m": 35040, "30m": 17520, "1h": 8760, "4h": 2190, "1d": 252, "1w": 52, "1M": 12 };

/**
 * Detect market regimes on a candle series.
 * @param {Array} candles
 * @param {object} opts { K=3, volWindow=20, iters=40, seed=1, interval="1d" }
 * @returns detailed regime object (see below), or { ok:false } if too little data
 */
export function detectRegimes(candles, { K = 3, volWindow = 20, iters = 40, seed = 1, interval = "1d" } = {}) {
  if (!Array.isArray(candles) || candles.length < volWindow + K * 20) return { ok: false, reason: "not enough data" };

  const { X, candleIndex, rawRet } = buildFeatures(candles, volWindow);
  if (X.length < K * 15) return { ok: false, reason: "not enough feature rows" };

  const model = fit(X, { K, iters, seed });
  const path = viterbi(X, model);
  const gamma = posterior(X, model);

  // Real-unit stats per raw state, then order states by mean return.
  const barsYr = BARS_PER_YEAR[interval] || 252;
  const raw = Array.from({ length: K }, () => ({ n: 0, retSum: 0, ret2: 0 }));
  for (let t = 0; t < path.length; t++) {
    const s = raw[path[t]];
    s.n++; s.retSum += rawRet[t]; s.ret2 += rawRet[t] * rawRet[t];
  }
  const order = [...Array(K).keys()].sort((a, b) => (raw[a].n ? raw[a].retSum / raw[a].n : 0) - (raw[b].n ? raw[b].retSum / raw[b].n : 0));
  const labels = labelsFor(K);
  const stateLabel = new Array(K); // rawStateIndex -> label
  order.forEach((rawIdx, rank) => { stateLabel[rawIdx] = labels[rank]; });

  // average run length per raw state (persistence)
  const runLen = Array.from({ length: K }, () => ({ runs: 0, total: 0 }));
  for (let t = 0; t < path.length; ) {
    const s = path[t]; let len = 0;
    while (t < path.length && path[t] === s) { len++; t++; }
    runLen[s].runs++; runLen[s].total += len;
  }

  const states = order.map((rawIdx, rank) => {
    const s = raw[rawIdx];
    const meanRet = s.n ? s.retSum / s.n : 0;
    const varRet = s.n ? Math.max(0, s.ret2 / s.n - meanRet * meanRet) : 0;
    return {
      index: rawIdx,
      rank,
      label: labels[rank],
      count: s.n,
      sharePct: +((s.n / path.length) * 100).toFixed(1),
      meanRetPct: +(meanRet * 100).toFixed(3),
      volPct: +(Math.sqrt(varRet) * Math.sqrt(barsYr) * 100).toFixed(1), // annualised
      avgDurationBars: runLen[rawIdx].runs ? +(runLen[rawIdx].total / runLen[rawIdx].runs).toFixed(1) : 0,
    };
  });

  // per-candle labels aligned to the candle array (null during warm-up)
  const perCandle = new Array(candles.length).fill(null);
  const perCandleProb = new Array(candles.length).fill(null);
  for (let t = 0; t < path.length; t++) {
    const ci = candleIndex[t];
    perCandle[ci] = stateLabel[path[t]];
    perCandleProb[ci] = +gamma[t][path[t]].toFixed(3);
  }

  // transition matrix in LABEL order (bear→…→bull)
  const transition = order.map((fromRaw) =>
    order.map((toRaw) => +Math.exp(model.transLog[fromRaw][toRaw]).toFixed(3))
  );

  // current regime = last feature row's Viterbi state + its posterior confidence
  const lastT = path.length - 1;
  const current = {
    label: stateLabel[path[lastT]],
    rank: order.indexOf(path[lastT]),
    prob: +gamma[lastT][path[lastT]].toFixed(3),
    // full posterior over labels, for a confidence bar
    probs: labels.map((lab, rank) => +gamma[lastT][order[rank]].toFixed(3)),
  };

  return {
    ok: true, K, volWindow, interval,
    labels, states, transition, current,
    perCandle, perCandleProb,
    logLik: +model.logLik.toFixed(1),
    iterations: model.iterations,
  };
}

// ── strategy-facing helper: current regime, cached per candle array ─────────
const _cache = new WeakMap();
/**
 * The regime label of the LAST candle — for gating a strategy ("only long in
 * Bull"). Cached per candle array so repeated per-bar calls in a backtest don't
 * refit. NOTE: refits when the array reference changes (new data), which is the
 * right cadence for a paper agent that reloads candles each run.
 */
export function currentRegime(candles, opts = {}) {
  let hit = _cache.get(candles);
  if (!hit) { hit = detectRegimes(candles, opts); _cache.set(candles, hit); }
  return hit.ok ? hit.current.label : null;
}
