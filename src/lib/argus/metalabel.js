// argus/metalabel.js — the second opinion.
//
// The scanners decide DIRECTION. This decides whether to act on what they found.
// That split is López de Prado's meta-labelling, and Argus is an unusually clean
// case for it: ML Studio has to manufacture labels with a triple-barrier rule
// because it only has candles, whereas every closed thesis here already hit a
// real barrier — its own target, its own stop, or a time limit. The labels are
// not a construction, they are what happened.
//
// Everything here is pure and dependency-free: the agent runs in Node, and
// dragging Pyodide + scikit-learn into a 24/7 process to fit a model on a
// three-figure sample would cost far more than a logistic regression is worth.
//
// TWO THINGS THIS MODULE REFUSES TO DO, and they matter more than the model:
//
//  1. It will not use anything that was not known BEFORE the trade opened. Every
//     feature below is read off the entry decision. R, exit price and outcome
//     are the label, never an input.
//  2. It will not hand back a model it does not have the data to justify. A
//     logistic regression needs roughly ten outcomes of the rarer class per
//     feature; on 95 trades with 27 winners, anything fitted is memorising.
//     `ready:false` plus how many more trades are needed is the honest answer,
//     and it is the one this returns today.

/** Feature names, in the order `featuresOf` emits them. */
export const FEATURES = [
  "plannedR",        // reward:risk as planned at entry
  "stopFrac",        // stop distance as a fraction of entry price
  "atrPct",          // volatility of the trading timeframe at entry
  "rvol",            // relative volume on the trigger bar
  "leverage",        // what the sizer chose
  "heatUsedPct",     // how full the risk book already was
  "isLong",          // side
  "sessionAsia", "sessionLondon", "sessionNy",
];

const SESSION_OF = (ts) => {
  if (!Number.isFinite(ts)) return "off";
  const h = new Date(ts).getUTCHours();
  if (h < 7) return "asia";
  if (h < 12) return "london";
  if (h < 20) return "ny";
  return "off";
};

const num = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);

/**
 * The feature row for one closed thesis — strictly things known at entry.
 * Returns null when the trade is too incomplete to describe honestly, because
 * quietly substituting zeros teaches the model that missing means small.
 */
export function featuresOf(t) {
  if (!t || !(t.entry > 0) || !(t.stop > 0)) return null;
  const rc = t.riskChecks || {};
  const label = rc.volatility?.label || "";
  const atrPct = /^([\d.]+)%/.test(label) ? parseFloat(label) / 100 : null;
  const rvol = rc.volume?.rvol;
  if (atrPct == null || !Number.isFinite(rvol)) return null;

  const session = SESSION_OF(t.openedAt);
  return [
    num(t.plannedR),
    Math.abs(t.entry - t.stop) / t.entry,
    atrPct,
    rvol,
    num(t.leverage, 1),
    num(rc.heatUsedPct) / 100,
    t.side === "long" ? 1 : 0,
    session === "asia" ? 1 : 0,
    session === "london" ? 1 : 0,
    session === "ny" ? 1 : 0,
  ];
}

/** 1 when the trade reached its target, 0 otherwise. Stops, invalidations and
 *  time-outs are all "should not have been taken" from the gate's point of view. */
export const labelOf = (t) => (t?.outcome === "target" ? 1 : 0);

/**
 * Build the design matrix, dropping trades we cannot describe.
 * @returns {{ X:number[][], y:number[], rows:object[] }}
 */
export function buildDataset(closed) {
  const X = [], y = [], rows = [];
  for (const t of closed || []) {
    if (t.state !== "closed") continue;
    const f = featuresOf(t);
    if (!f) continue;
    X.push(f); y.push(labelOf(t)); rows.push(t);
  }
  return { X, y, rows };
}

/**
 * Purged, embargoed forward-chaining folds.
 *
 * Argus holds several positions at once, so a trade in the training set can
 * still be OPEN while a test trade is opening — they share the same market move
 * and the label leaks. Purging drops any training trade whose holding period
 * overlaps the test window; the embargo drops a further slice after it, because
 * the market state that produced one outcome persists a little past its exit.
 *
 * Forward-chaining (train only on the past) rather than shuffled k-fold, since
 * the alternative is training on the future to predict the past.
 */
export function purgedFolds(rows, { k = 4, embargoMs = 60 * 60 * 1000 } = {}) {
  const idx = rows.map((t, i) => ({ i, open: t.openedAt ?? 0, close: t.exitAt ?? t.openedAt ?? 0 }))
    .sort((a, b) => a.open - b.open);
  const n = idx.length;
  const folds = [];
  const size = Math.floor(n / (k + 1));
  if (size < 2) return folds;
  for (let f = 1; f <= k; f++) {
    const testFrom = f * size;
    const testTo = f === k ? n : (f + 1) * size;
    const test = idx.slice(testFrom, testTo);
    if (!test.length) continue;
    const testStart = Math.min(...test.map((t) => t.open));
    const train = idx.slice(0, testFrom).filter((t) => t.close + embargoMs < testStart);
    if (train.length < 8) continue;
    folds.push({ train: train.map((t) => t.i), test: test.map((t) => t.i) });
  }
  return folds;
}

// ── logistic regression (L2, batch gradient descent) ────────────────────────
function standardise(X) {
  const d = X[0].length;
  const mean = new Array(d).fill(0), sd = new Array(d).fill(0);
  for (const r of X) for (let j = 0; j < d; j++) mean[j] += r[j] / X.length;
  for (const r of X) for (let j = 0; j < d; j++) sd[j] += (r[j] - mean[j]) ** 2 / X.length;
  for (let j = 0; j < d; j++) sd[j] = Math.sqrt(sd[j]) || 1;
  return { mean, sd };
}
const apply = (r, { mean, sd }) => r.map((v, j) => (v - mean[j]) / sd[j]);
const sigmoid = (z) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

export function fitLogistic(X, y, { iters = 800, lr = 0.15, l2 = 1.0 } = {}) {
  const scaler = standardise(X);
  const Z = X.map((r) => apply(r, scaler));
  const d = Z[0].length;
  let w = new Array(d).fill(0), b = 0;
  for (let it = 0; it < iters; it++) {
    const gw = new Array(d).fill(0);
    let gb = 0;
    for (let i = 0; i < Z.length; i++) {
      const p = sigmoid(Z[i].reduce((a, v, j) => a + v * w[j], b));
      const e = p - y[i];
      for (let j = 0; j < d; j++) gw[j] += e * Z[i][j];
      gb += e;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / Z.length + l2 * w[j] / Z.length);
    b -= lr * (gb / Z.length);
  }
  return {
    w, b, scaler,
    predict: (row) => sigmoid(apply(row, scaler).reduce((a, v, j) => a + v * w[j], b)),
  };
}

/** Area under the ROC curve. 0.5 is a coin flip; below it the model is inverted. */
export function auc(scores, labels) {
  const pairs = scores.map((s, i) => [s, labels[i]]).sort((a, b) => a[0] - b[0]);
  const pos = labels.filter((v) => v === 1).length;
  const neg = labels.length - pos;
  if (!pos || !neg) return null;      // one class only — AUC is undefined, not 0.5
  let rank = 0, sumRanks = 0;
  for (let i = 0; i < pairs.length; i++) {
    rank = i + 1;
    if (pairs[i][1] === 1) sumRanks += rank;
  }
  return (sumRanks - (pos * (pos + 1)) / 2) / (pos * neg);
}

// A logistic regression needs roughly this many outcomes OF THE RARER CLASS per
// feature before its coefficients mean anything. The usual rule of thumb is 10;
// this is not a number to negotiate down because the sample is disappointing.
export const EVENTS_PER_FEATURE = 10;

/**
 * Fit and honestly evaluate a meta-label gate on the ledger.
 *
 * @returns {{ ready, reason, n, positives, needPositives, folds?, auc?, model? }}
 * `ready:false` is the expected answer for a long time yet, and `needPositives`
 * says how much further the ledger has to run before this is worth revisiting.
 */
export function metaLabelStudy(closed, opts = {}) {
  const { X, y, rows } = buildDataset(closed);
  const positives = y.filter((v) => v === 1).length;
  const negatives = y.length - positives;
  const rarer = Math.min(positives, negatives);
  const need = FEATURES.length * (opts.eventsPerFeature ?? EVENTS_PER_FEATURE);

  if (rarer < need) {
    return {
      ready: false,
      reason: `${rarer} outcomes of the rarer class; ${need} needed for ${FEATURES.length} features`,
      n: y.length, positives, negatives, needPositives: need - rarer,
    };
  }

  const folds = purgedFolds(rows, opts);
  if (!folds.length) {
    return { ready: false, reason: "not enough history for a purged split", n: y.length, positives, negatives };
  }

  const scores = [], truth = [];
  for (const f of folds) {
    const m = fitLogistic(f.train.map((i) => X[i]), f.train.map((i) => y[i]), opts);
    for (const i of f.test) { scores.push(m.predict(X[i])); truth.push(y[i]); }
  }
  const a = auc(scores, truth);
  return {
    ready: true,
    reason: a == null ? "one class in the test folds" : `out-of-sample AUC ${a.toFixed(3)} over ${folds.length} purged folds`,
    n: y.length, positives, negatives, folds: folds.length, auc: a,
    model: fitLogistic(X, y, opts),
  };
}
