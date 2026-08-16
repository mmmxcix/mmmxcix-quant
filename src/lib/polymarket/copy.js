// copy.js — what a copier actually gets, and whether an edge survives it.
//
// TWO QUESTIONS, IN THIS ORDER, and the second one only matters if the first
// answers yes.
//
//   1. Does a wallet's edge PERSIST? Rank wallets on everything up to T, then
//      look at what they did after T. A leaderboard is the most
//      survivorship-biased object in finance — the top of it is, by
//      construction, whoever got luckiest — so the only test that means anything
//      is out of sample, and it has to be corrected for having tested hundreds
//      of wallets at once. That correction is Benjamini–Hochberg, the same one
//      src/lib/pairsScreen.js uses on pair screening, and for the same reason.
//
//   2. Does it survive OUR fill? You never get the leader's price. You see the
//      trade after it has settled and been indexed, you send your own order into
//      the book they just moved, and on a binary market with a thin book that
//      difference is most of the margin. So the copier's return is never
//      computed at the leader's price — it is computed at the next price the
//      tape actually printed after our delay.
//
// The fill model is data-driven rather than a slippage guess: `nextPrice` is the
// real next trade in that token at least `delaySec` after the leader's, taken
// from the same event stream. When the tape prints nothing in the window, the
// copy simply does not happen — which is itself a finding, because a market too
// thin to fill is a market you cannot copy in.

import { benjaminiHochberg } from "../pairsScreen.js";

export { benjaminiHochberg };

/**
 * The price a copier would have got.
 *
 * @param {object} leaderTrade  {ts, tokenId, side, usdc, tokens, price}
 * @param {Array<{ts, price}>} tape   fills in that token, ascending, from the
 *        leader's timestamp onward
 * @param {number} delaySec  how long until we could act — indexing lag plus a
 *        poll interval. Not a guess to be tuned: it is swept, and every value
 *        swept counts as a trial in the correction.
 * @param {number} windowSec how long we keep trying before giving up
 * @returns {null|{price, ts, lagSec, slipPct}}  null = the tape never printed,
 *          so there was nothing to fill against
 */
export function copyFill(leaderTrade, tape, { delaySec = 60, windowSec = 3600 } = {}) {
  const from = leaderTrade.ts + delaySec;
  const until = leaderTrade.ts + delaySec + windowSec;
  for (const f of tape) {
    if (f.ts < from) continue;
    if (f.ts > until) break;
    if (!(f.price > 0) || !(f.price < 1)) continue;
    // Slippage is signed against US: buying higher than the leader is bad,
    // selling lower than the leader is bad. One sign convention, stated once.
    const slip = leaderTrade.side === "buy"
      ? (f.price - leaderTrade.price) / leaderTrade.price
      : (leaderTrade.price - f.price) / leaderTrade.price;
    return { price: f.price, ts: f.ts, lagSec: f.ts - leaderTrade.ts, slipPct: slip * 100 };
  }
  return null;
}

/**
 * Replay one wallet's out-of-sample trades as a copier would have lived them.
 *
 * The copier holds the same shares the leader does, but at its own entry and its
 * own exit — both delayed. P&L is FIFO on the copier's own fills, so a copy that
 * could not be entered is also never exited, which is the honest treatment: you
 * cannot sell what you never managed to buy.
 *
 * @param {Array} trades   the leader's OOS trades, ascending
 * @param {(tokenId, fromTs) => Array} tapeFor  the token's fills from a time on
 * @returns {{realized, closedCost, filled, missed, medianSlipPct, medianLagSec}}
 */
export function replayCopy(trades, tapeFor, opts = {}) {
  const lots = new Map();
  let realized = 0, closedCost = 0, filled = 0, missed = 0;
  const slips = [], lags = [];

  for (const t of trades) {
    const fill = copyFill(t, tapeFor(t.tokenId, t.ts), opts);
    if (!fill) { missed++; continue; }
    filled++;
    slips.push(fill.slipPct);
    lags.push(fill.lagSec);

    if (t.side === "buy") {
      if (!lots.has(t.tokenId)) lots.set(t.tokenId, []);
      // Same cash committed as the leader, so a worse price buys FEWER shares —
      // which is exactly how slippage actually hurts and would be invisible if
      // the copier were assumed to buy the same share count.
      lots.get(t.tokenId).push({ tokens: t.usdc / fill.price, price: fill.price });
      continue;
    }
    let left = t.tokens;
    const queue = lots.get(t.tokenId) || [];
    while (left > 1e-9 && queue.length) {
      const lot = queue[0];
      const take = Math.min(left, lot.tokens);
      realized += take * (fill.price - lot.price);
      closedCost += take * lot.price;
      lot.tokens -= take;
      left -= take;
      if (lot.tokens <= 1e-9) queue.shift();
    }
  }
  const med = (xs) => {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    return s[s.length >> 1];
  };
  return {
    realized, closedCost, filled, missed,
    fillRate: filled + missed ? filled / (filled + missed) : 0,
    medianSlipPct: med(slips), medianLagSec: med(lags),
  };
}

// ── the persistence test ────────────────────────────────────────────────────

/**
 * A p-value for one wallet's out-of-sample record.
 *
 * The null is "this wallet has no edge", so its per-trade returns are a sample
 * whose mean should be zero. A one-sample t against zero is crude on a skewed,
 * fat-tailed sample — which is why the value that matters is what comes out of
 * Benjamini–Hochberg across every wallet tested, not this number on its own.
 * Reported one-sided: the question is whether it made money, not whether it did
 * something unusual.
 */
export function walletPValue(returns) {
  const n = returns.length;
  if (n < 5) return 1;
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  let s2 = 0;
  for (const r of returns) s2 += (r - mean) ** 2;
  const sd = Math.sqrt(s2 / (n - 1));
  if (!(sd > 0)) return mean > 0 ? 0.5 : 1;
  const t = mean / (sd / Math.sqrt(n));
  // Normal tail — with n in the dozens the difference from Student's t is far
  // smaller than the error already introduced by treating trades as independent.
  return 1 - normCdf(t);
}

function normCdf(x) {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + Math.sign(x) * erf);
}

/**
 * Rank in sample, judge out of sample, correct for having looked at all of them.
 *
 * @param {Array} rows  per wallet: {address, inRoi, inTrades, outReturns[], outRoi, ...}
 * @param {object} o    {topK, alpha, minInTrades, minOutTrades}
 * @returns the ranked table, the top-K's out-of-sample aggregate, and the
 *          BH result across every wallet that had enough trades to test.
 */
export function persistence(rows, { topK = 20, alpha = 0.1, minInTrades = 20, minOutTrades = 10 } = {}) {
  const eligible = rows.filter((r) => r.inTrades >= minInTrades && r.outTrades >= minOutTrades);
  const ranked = [...eligible].sort((a, b) => b.inRoi - a.inRoi);
  const top = ranked.slice(0, Math.min(topK, ranked.length));
  const rest = ranked.slice(top.length);

  const agg = (list) => {
    const cost = list.reduce((s, r) => s + r.outCost, 0);
    const pnl = list.reduce((s, r) => s + r.outPnl, 0);
    return {
      wallets: list.length,
      roi: cost > 0 ? pnl / cost : 0,
      pnl, cost,
      positive: list.filter((r) => r.outRoi > 0).length,
    };
  };

  // The correlation between the in-sample ranking and the out-of-sample result
  // is the persistence question in one number. Spearman, because the ranking is
  // what is being tested and a couple of outliers should not carry it.
  const rho = spearman(eligible.map((r) => r.inRoi), eligible.map((r) => r.outRoi));

  const bh = benjaminiHochberg(eligible.map((r) => r.pValue ?? 1), alpha);
  const survivors = eligible.filter((_, i) => bh.survives[i]).map((r) => r.address);

  return {
    tested: eligible.length,
    skipped: rows.length - eligible.length,
    top: agg(top), rest: agg(rest), all: agg(eligible),
    topAddresses: top.map((r) => r.address),
    rankCorrelation: rho,
    bh: { alpha, survivors, expectedFalse: bh.expectedFalse, threshold: bh.threshold },
    ranked: ranked.map((r, i) => ({ ...r, inRank: i + 1, q: bh.q[eligible.indexOf(r)] ?? 1 })),
  };
}

/** Spearman rank correlation. */
export function spearman(xs, ys) {
  const n = xs.length;
  if (n < 3) return 0;
  const rank = (v) => {
    const idx = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(n);
    for (let i = 0; i < n; i++) r[idx[i][1]] = i + 1;
    return r;
  };
  const rx = rank(xs), ry = rank(ys);
  const mx = (n + 1) / 2, my = mx;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;
}
