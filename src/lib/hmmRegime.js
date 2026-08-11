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

import { fit, viterbi, posterior, filtered } from "./hmm.js";

const LABELS_3 = ["Bear", "Neutral", "Bull"];
const LABELS_2 = ["Bear", "Bull"];
const labelsFor = (K) => (K === 2 ? LABELS_2 : K === 3 ? LABELS_3 : Array.from({ length: K }, (_, i) => `Regime ${i + 1}`));

/** Build the feature matrix, z-scored, plus the raw log returns.
 *
 * FIVE features, not two. Return + volatility alone cannot tell a calm bull
 * from a choppy range — both look like "small moves, low vol" bar by bar, so
 * the fit flip-flops between them and the regime ribbon shreds. The three
 * added columns are the ones that actually separate those cases:
 *   trend   — where price sits relative to its own recent mean (drift)
 *   drawdown— distance below the running high (a bull that stops making highs
 *             is no longer a bull, even before volatility rises)
 *   volOfVol— whether volatility itself is stable or erratic (the signature of
 *             a transition, and what makes a range distinguishable from a trend)
 */
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

  // trend: mean return over the window (drift), aligned to rets
  const trend = new Array(rets.length).fill(null);
  for (let i = volWindow - 1; i < rets.length; i++) {
    let m = 0;
    for (let j = i - volWindow + 1; j <= i; j++) m += rets[j];
    trend[i] = m / volWindow;
  }
  // drawdown: log distance below the running max close (0 = at the high)
  const dd = new Array(rets.length).fill(0);
  let peak = closes[0];
  for (let i = 0; i < rets.length; i++) {
    const c = closes[i + 1];
    if (c > peak) peak = c;
    dd[i] = Math.log(c / peak); // ≤ 0
  }
  // vol-of-vol: dispersion of the volatility series itself
  const vov = new Array(rets.length).fill(null);
  for (let i = 2 * volWindow - 2; i < rets.length; i++) {
    let m = 0, cnt = 0;
    for (let j = i - volWindow + 1; j <= i; j++) { if (vol[j] != null) { m += vol[j]; cnt++; } }
    if (!cnt) continue;
    m /= cnt;
    let v = 0;
    for (let j = i - volWindow + 1; j <= i; j++) { if (vol[j] != null) { const d2 = vol[j] - m; v += d2 * d2; } }
    vov[i] = Math.sqrt(v / cnt);
  }

  // feature rows exist where every column exists; candleIndex maps a feature row
  // back to the candle it describes (rets[i] is between candle i and i+1).
  const start = Math.max(volWindow - 1, 2 * volWindow - 2);
  const rows = [], candleIndex = [], rawRet = [];
  for (let i = start; i < rets.length; i++) {
    if (vol[i] == null || trend[i] == null || vov[i] == null) continue;
    rows.push([rets[i], vol[i], trend[i], dd[i], vov[i]]);
    candleIndex.push(i + 1);
    rawRet.push(rets[i]);
  }

  // z-score each column
  const D = 5, n = rows.length;
  const mean = new Array(D).fill(0), sd = new Array(D).fill(0);
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
export function detectRegimes(candles, {
  K = 3, volWindow = 20, iters = 40, seed = 1, interval = "1d",
  // EM is a LOCAL optimiser: where it lands depends on where it starts, and a
  // bad start produces exactly the shredded ribbon this page used to show.
  // Fit it several times from different seeds and keep the best likelihood.
  restarts = 6,
  // Sticky prior on the transition diagonal — see hmm.js. Scaled to the sample
  // so it stays a nudge on long histories rather than a straitjacket.
  stickiness = null,
} = {}) {
  if (!Array.isArray(candles) || candles.length < volWindow + K * 20) return { ok: false, reason: "not enough data" };

  const { X, candleIndex, rawRet } = buildFeatures(candles, volWindow);
  if (X.length < K * 15) return { ok: false, reason: "not enough feature rows" };

  // Tuned, not guessed: swept on 10y of SPY daily. Live (filtered) regime flips
  // fall 106 → 92 at 0.15·T and → 84 at 0.4·T, while the live-vs-hindsight lag
  // only moves 1.1 → 1.2 → 1.4 bars. 0.15 buys most of the noise reduction for
  // almost none of the lag; beyond that you start paying real responsiveness for
  // diminishing returns.
  const kappa = stickiness ?? Math.max(8, X.length * 0.15);
  let model = null;
  for (let r = 0; r < Math.max(1, restarts); r++) {
    const cand = fit(X, { K, iters, seed: seed + r * 7919, stickiness: kappa });
    if (!model || (Number.isFinite(cand.logLik) && cand.logLik > model.logLik)) model = cand;
  }
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

  // ── LIVE view (filtered, forward-only) vs the smoothed hindsight above ────
  // perCandle/gamma use the full series (they've "seen the future"). A live
  // system only has the forward pass. Surfacing both — plus how much later
  // and noisier the live view is — is the honest part of this page.
  const flt = filtered(X, model);
  const liveArg = flt.probs.map((p) => {
    let best = 0;
    for (let k = 1; k < K; k++) if (p[k] > p[best]) best = k;
    return best;
  });
  const perCandleLive = new Array(candles.length).fill(null);
  const perCandleBearProb = new Array(candles.length).fill(null); // filtered P(bear-most state)
  const bearRaw = order[0];
  for (let t = 0; t < flt.probs.length; t++) {
    const ci = candleIndex[t];
    perCandleLive[ci] = stateLabel[liveArg[t]];
    perCandleBearProb[ci] = +flt.probs[t][bearRaw].toFixed(3);
  }

  // Honesty metrics: how much does live flicker vs hindsight, and how late
  // does it confirm a regime change?
  let liveFlips = 0, smoothFlips = 0;
  for (let t = 1; t < path.length; t++) {
    if (liveArg[t] !== liveArg[t - 1]) liveFlips++;
    if (path[t] !== path[t - 1]) smoothFlips++;
  }
  const lags = [];
  for (let t = 1; t < path.length; ) {
    if (path[t] === path[t - 1]) { t++; continue; }
    const target = path[t];
    let end = t;
    while (end < path.length && path[end] === target) end++;
    // first bar within the run where the LIVE view agrees with hindsight
    let hit = -1;
    for (let u = t; u < end; u++) if (liveArg[u] === target) { hit = u; break; }
    if (hit >= 0) lags.push(hit - t);
    t = end;
  }
  const honesty = {
    liveFlips, smoothFlips,
    avgLagBars: lags.length ? +(lags.reduce((a, b) => a + b, 0) / lags.length).toFixed(1) : null,
    changesMeasured: lags.length,
  };

  // Current-bar belief decomposition (in LABEL rank order, bear→…→bull):
  // one-step prior × emission likelihood = filtered posterior.
  const belief = {
    prior: labels.map((_, rank) => +flt.priors[lastT][order[rank]].toFixed(3)),
    likelihood: labels.map((_, rank) => +flt.likes[lastT][order[rank]].toFixed(3)),
    posterior: labels.map((_, rank) => +flt.probs[lastT][order[rank]].toFixed(3)),
  };

  return {
    ok: true, K, volWindow, interval,
    labels, states, transition, current,
    perCandle, perCandleProb,
    perCandleLive, perCandleBearProb,
    honesty, belief,
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
