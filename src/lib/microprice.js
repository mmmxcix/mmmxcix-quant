// microprice.js — Stoikov's micro-price, an estimator of where the mid price is
// heading given the shape of the order book.
//
// WHY: the mid price ((bid+ask)/2) treats a book with 500 lots bid and 3 asked
// as if it were balanced. It is not — that book is about to trade up. The
// "weighted mid" is the usual first fix, but it is an ad-hoc interpolation with
// no claim to being a fair price. Stoikov's micro-price is defined instead as
//
//     P_micro = lim_{k→∞} E[ M_{t+k} | I_t, S_t ]
//
// the mid price you expect the market to settle at, conditional on the current
// imbalance I and spread S. It is a martingale by construction, which the
// weighted mid is not.
//
// PROVENANCE: implemented from the paper (Stoikov, "The Micro-Price: A High
// Frequency Estimator of Future Prices", 2018). The reference repository
// (sstoikov/microprice) carries NO licence, which means all rights reserved —
// its code cannot be copied or adapted. The method itself is published research
// and free to implement; everything here is written from the description.
//
// HOW the limit is computed without simulating forever: sample the book only at
// the moments the mid price moves. Between those moments the state (I,S) wanders
// among "no move yet" states — matrix Q. Eventually it hits a move — matrix R,
// with the size of the move in K and the state it lands in via T. Then
//
//     G1 = (Id - Q)^-1 R K     expected mid move up to the FIRST move
//     B  = (Id - Q)^-1 R T     where the state lands after that move
//     G* = G1 + B·G1 + B²·G1 + …  = (Id - B)^-1 G1
//
// G* is the full adjustment, and P_micro = mid + G*[state].

/** Order-book imbalance: the share of top-of-book size resting on the bid.
 *  0.5 is balanced, →1 means the bid is stacked (upward pressure). */
export function imbalance(bidSize, askSize) {
  const tot = bidSize + askSize;
  if (!(tot > 0)) return 0.5;
  return bidSize / tot;
}

/** The naive weighted mid — kept as the BASELINE the micro-price has to beat.
 *  Note it leans toward the side with LESS size: a stacked bid pushes the price
 *  up toward the ask, because that is the side about to be consumed. */
export function weightedMid(bid, ask, bidSize, askSize) {
  const tot = bidSize + askSize;
  if (!(tot > 0)) return (bid + ask) / 2;
  return (bid * askSize + ask * bidSize) / tot;
}

/** Solve A x = b by Gauss-Jordan with partial pivoting. A is n×n, b is n×m.
 *  Returns the n×m solution, or null if A is singular. */
function solve(A, B) {
  const n = A.length, m = B[0]?.length ?? 0;
  // Work on copies — callers reuse their matrices.
  const a = A.map((r, i) => [...r, ...B[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    if (Math.abs(a[piv][col]) < 1e-12) return null; // singular
    [a[col], a[piv]] = [a[piv], a[col]];
    const d = a[col][col];
    for (let j = col; j < n + m; j++) a[col][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r][col];
      if (f === 0) continue;
      for (let j = col; j < n + m; j++) a[r][j] -= f * a[col][j];
    }
  }
  return a.map((r) => r.slice(n));
}

const matmul = (A, B) => {
  const n = A.length, k = B.length, m = B[0]?.length ?? 0;
  const out = Array.from({ length: n }, () => new Array(m).fill(0));
  for (let i = 0; i < n; i++) {
    for (let p = 0; p < k; p++) {
      const v = A[i][p];
      if (v === 0) continue;
      for (let j = 0; j < m; j++) out[i][j] += v * B[p][j];
    }
  }
  return out;
};
const identity = (n) => Array.from({ length: n }, (_, i) =>
  Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
const sub = (A, B) => A.map((r, i) => r.map((v, j) => v - B[i][j]));

/** Bucket an imbalance in [0,1] into `n` equal bins. */
export function imbBucket(I, n) {
  const b = Math.floor(I * n);
  return Math.max(0, Math.min(n - 1, b));
}

/**
 * Accumulate the transition counts the estimator needs.
 *
 * Feed it a sequence of book observations sampled at a FIXED interval; it finds
 * the moments the mid price moved by at least one tick and records what the
 * state was before, how far the mid moved, and where it landed.
 *
 * @param obs   [{ bid, ask, bidSize, askSize }] in time order
 * @param tick  the instrument's minimum price increment
 * @param opts  { imbBuckets = 6, maxSpreadTicks = 2, maxMoveTicks = 3 }
 */
export function collectTransitions(obs, tick, opts = {}) {
  const nImb = opts.imbBuckets ?? 6;
  const nSpread = opts.maxSpreadTicks ?? 2;
  const maxMove = opts.maxMoveTicks ?? 3;
  const nState = nImb * nSpread;

  const stateOf = (o) => {
    const spr = Math.round((o.ask - o.bid) / tick);
    if (!(spr >= 1) || spr > nSpread) return -1;         // outside the model's grid
    return (spr - 1) * nImb + imbBucket(imbalance(o.bidSize, o.askSize), nImb);
  };

  // Q: state → state, mid unchanged. R: state → (move, state) outcome.
  // Outcomes are indexed by (moveIdx, nextState); moves run −maxMove…+maxMove
  // excluding 0.
  const moves = [];
  for (let d = -maxMove; d <= maxMove; d++) if (d !== 0) moves.push(d);
  const nOut = moves.length * nState;
  const Qc = Array.from({ length: nState }, () => new Array(nState).fill(0));
  const Rc = Array.from({ length: nState }, () => new Array(nOut).fill(0));

  let used = 0, skipped = 0;
  for (let i = 1; i < obs.length; i++) {
    const a = obs[i - 1], b = obs[i];
    const sa = stateOf(a), sb = stateOf(b);
    if (sa < 0 || sb < 0) { skipped++; continue; }
    const midA = (a.bid + a.ask) / 2, midB = (b.bid + b.ask) / 2;
    const d = Math.round((midB - midA) / tick);
    if (d === 0) { Qc[sa][sb]++; used++; continue; }
    const mi = moves.indexOf(d);
    if (mi < 0) { skipped++; continue; }               // a jump larger than the grid
    Rc[sa][mi * nState + sb]++;
    used++;
  }
  return { Qc, Rc, moves, nImb, nSpread, nState, tick, used, skipped };
}

/**
 * Solve the collected counts for G* — the micro-price adjustment per state.
 * Returns null when the data is too thin or degenerate to invert.
 */
export function fitMicroprice(counts, opts = {}) {
  const minPerState = opts.minPerState ?? 20;
  const { Qc, Rc, moves, nState, nImb, nSpread, tick } = counts;

  // Row-normalise Q and R together: each row is one state's full distribution
  // over "stayed" and "moved" outcomes.
  const Q = Array.from({ length: nState }, () => new Array(nState).fill(0));
  const R = Array.from({ length: nState }, () => new Array(Rc[0].length).fill(0));
  let thin = 0;
  for (let s = 0; s < nState; s++) {
    const tot = Qc[s].reduce((a, v) => a + v, 0) + Rc[s].reduce((a, v) => a + v, 0);
    if (tot < minPerState) { thin++; continue; }        // leave the row at zero
    for (let j = 0; j < nState; j++) Q[s][j] = Qc[s][j] / tot;
    for (let j = 0; j < R[s].length; j++) R[s][j] = Rc[s][j] / tot;
  }
  if (thin === nState) return null;

  // K: the price change of each outcome. T: the state each outcome lands in.
  const K = moves.flatMap((d) => new Array(nState).fill(d * tick)).map((v) => [v]);
  const T = Array.from({ length: moves.length * nState }, (_, o) => {
    const row = new Array(nState).fill(0);
    row[o % nState] = 1;
    return row;
  });

  const IQ = sub(identity(nState), Q);
  const G1 = solve(IQ, matmul(R, K));                   // (Id−Q)^-1 R K
  const B = solve(IQ, matmul(R, T));                    // (Id−Q)^-1 R T
  if (!G1 || !B) return null;

  // G* = Σ_k B^k G1. Two things make this delicate, and both are easy to get
  // wrong in a way that still returns numbers.
  //
  // 1. NOT (Id−B)^-1 G1. B is stochastic — from any state the price does
  //    eventually move, and lands somewhere — so it has eigenvalue 1 and Id−B
  //    is singular. The sum has to be accumulated term by term.
  //
  // 2. The terms only decay to zero if G1 has no component along that
  //    eigenvector, i.e. if the average mid move per cycle is exactly zero.
  //    That is the martingale property, and it holds for the true process but
  //    never for counts estimated from a finite sample. Left alone, B^k G1
  //    converges to a small constant c and the sum grows without bound.
  //    So c is measured under B's stationary distribution and removed first,
  //    which enforces the martingale property the estimator assumes rather than
  //    letting sampling noise accumulate into an unbounded price offset.
  const g1 = G1.map((r) => r[0]);
  let pi = new Array(nState).fill(1 / nState);
  for (let k = 0; k < 5000; k++) {
    const next = new Array(nState).fill(0);
    for (let i = 0; i < nState; i++) {
      if (pi[i] === 0) continue;
      for (let j = 0; j < nState; j++) next[j] += pi[i] * B[i][j];
    }
    const s = next.reduce((a, v) => a + v, 0);
    if (!(s > 0)) return null;
    for (let j = 0; j < nState; j++) next[j] /= s;
    const delta = next.reduce((a, v, i) => Math.max(a, Math.abs(v - pi[i])), 0);
    pi = next;
    if (delta < 1e-12) break;
  }
  const drift = pi.reduce((a, p, i) => a + p * g1[i], 0);

  let term = g1.map((v) => v - drift);
  const adj = [...term];
  let converged = false;
  for (let k = 1; k <= (opts.maxTerms ?? 500); k++) {
    term = matmul(B, term.map((v) => [v])).map((r) => r[0]);
    let mx = 0;
    for (let i = 0; i < nState; i++) { adj[i] += term[i]; mx = Math.max(mx, Math.abs(term[i])); }
    if (!Number.isFinite(mx) || mx > 1e6 * tick) return null;   // diverging — refuse
    if (mx < 1e-9 * tick) { converged = true; break; }
  }
  if (!converged) return null;
  if (adj.some((v) => !Number.isFinite(v))) return null;

  const coverage = (nState - thin) / nState;
  // A grid that is mostly empty is not a model, however cleanly it inverted.
  if (coverage < (opts.minCoverage ?? 0.5)) return null;

  return { adj, nImb, nSpread, tick, coverage };
}

/**
 * The micro-price for a live book, given a fitted model.
 * Falls back to the weighted mid when the state is off the model's grid —
 * that is a real fallback, not a guess dressed up as a fit.
 */
export function microprice(book, model) {
  const { bid, ask, bidSize, askSize } = book;
  const mid = (bid + ask) / 2;
  if (!model) return { price: weightedMid(bid, ask, bidSize, askSize), source: "weighted-mid" };
  const spr = Math.round((ask - bid) / model.tick);
  if (!(spr >= 1) || spr > model.nSpread) {
    return { price: weightedMid(bid, ask, bidSize, askSize), source: "weighted-mid" };
  }
  const s = (spr - 1) * model.nImb + imbBucket(imbalance(bidSize, askSize), model.nImb);
  const adj = model.adj[s];
  if (!Number.isFinite(adj)) {
    return { price: weightedMid(bid, ask, bidSize, askSize), source: "weighted-mid" };
  }
  return { price: mid + adj, source: "microprice", adj, state: s };
}
