// crossSection.js — rank a universe, hold the extremes, rebalance.
//
// WHY THIS EXISTS. The handoff records an assumption worth checking before
// building anything on top of it: "most academic equity strategies are
// CROSS-SECTIONAL — rank a universe, long the top decile, short the bottom —
// and runBacktest({candles, signalFn}) is single-instrument time-series, so a
// momentum paper's result cannot be reproduced here and failing the gauntlet is
// the expected outcome, not a discovery."
//
// Half of that is right and the half that matters is wrong. runBacktest is
// indeed single-instrument. But src/lib/factors.js ALREADY contains a working
// cross-sectional backtest — runBAB: aligned multi-symbol history, a trailing
// ranking window, buckets at both ends, periodic rebalancing, a benchmark and
// curve statistics. It was simply written for one factor, with the ranking
// hard-wired into the loop, so nothing else could reach it.
//
// This module is that loop with the ranking passed IN. runBAB now calls it and
// is unchanged in behaviour (a test pins that). What was missing was never the
// engine — it was one parameter.
//
// CONVENTION, stated once because a sign error here is invisible: symbols are
// ranked ASCENDING by score, the LOW bucket is held long and the HIGH bucket
// short. Betting-against-beta wants low beta long, so it ranks by beta directly;
// momentum wants recent winners long, so it ranks by NEGATIVE past return. The
// rank function owns the sign.

/** Simple returns from a close series. */
export function toReturns(closes) {
  const out = new Array(closes.length - 1);
  for (let i = 1; i < closes.length; i++) out[i - 1] = closes[i] / closes[i - 1] - 1;
  return out;
}

export function curveStats(returns, periodsPerYear = 252) {
  const n = returns.length;
  if (!n) return { annRetPct: 0, annVolPct: 0, sharpe: 0, maxDDPct: 0, n: 0 };
  let eq = 1, peak = 1, maxDD = 0, sum = 0, sum2 = 0;
  for (const r of returns) {
    eq *= 1 + r;
    if (eq > peak) peak = eq;
    const dd = (peak - eq) / peak;
    if (dd > maxDD) maxDD = dd;
    sum += r; sum2 += r * r;
  }
  const mean = sum / n;
  const sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  const annVol = sd * Math.sqrt(periodsPerYear);
  return {
    annRetPct: (Math.pow(eq, periodsPerYear / n) - 1) * 100,
    annVolPct: annVol * 100,
    sharpe: annVol > 0 ? (mean * periodsPerYear) / annVol : 0,
    maxDDPct: maxDD * 100,
    n,
  };
}

/**
 * @param {object} o
 * @param {number[]} o.times          unix seconds, length = closes length
 * @param {Record<string, number[]>} o.returns  symbol → return series (aligned)
 * @param {number[]} o.market         benchmark return series (same length)
 * @param {string[]} o.symbols        the universe
 * @param {(ctx: {symbol, returns, market, from, to}) => number|null} o.rankFn
 *        Score for ONE symbol over the trailing window [from, to). Return null
 *        to exclude it from this rebalance. It is handed only data BEFORE the
 *        holding period — that boundary is the whole point and a test pins it.
 * @param {(o: {low, high, scores}) => {wLong, wShort}} [o.weightFn]
 *        Leg weights, e.g. BAB's beta-neutral scaling. Defaults to 1/1.
 * @param {number} [o.window]     trailing observations used to rank
 * @param {number} [o.rebalance]  observations held before re-ranking
 * @param {number} [o.bucketPct]  share of the universe in each leg
 * @param {number} [o.minNames]   refuse a rebalance thinner than this
 */
export function runCrossSectional({
  times, returns, market, symbols,
  rankFn, weightFn = null,
  window = 252, rebalance = 21, bucketPct = 0.2, minNames = 10,
}) {
  if (typeof rankFn !== "function") throw new Error("rankFn is required");
  const names = symbols.filter((s) => Array.isArray(returns[s]) && returns[s].length);
  const nT = market.length;

  const stratR = [], mktR = [], lowR = [], highR = [], outTimes = [];
  const rebalances = [];
  let lastRanked = [], lastWeights = { wLong: 1, wShort: 1 }, skipped = 0;

  for (let t = window; t < nT; t += rebalance) {
    const ranked = [];
    for (const s of names) {
      const score = rankFn({ symbol: s, returns: returns[s], market, from: t - window, to: t });
      if (Number.isFinite(score)) ranked.push({ symbol: s, score });
    }
    // A thin cross-section is not a cross-section. Skipping is recorded rather
    // than silently shrinking the buckets, which is how a "factor" ends up being
    // three names in a trench coat.
    if (ranked.length < minNames) { skipped++; continue; }

    ranked.sort((a, b) => a.score - b.score);
    const k = Math.max(3, Math.round(ranked.length * bucketPct));
    const low = ranked.slice(0, k);
    const high = ranked.slice(-k);
    const { wLong, wShort } = weightFn ? weightFn({ low, high, scores: ranked }) : { wLong: 1, wShort: 1 };
    lastRanked = ranked;
    lastWeights = { wLong, wShort };
    rebalances.push({ at: times[t] ?? null, names: ranked.length, k, wLong, wShort });

    const end = Math.min(t + rebalance, nT);
    for (let i = t; i < end; i++) {
      let rl = 0, rh = 0;
      for (const x of low) rl += returns[x.symbol][i];
      for (const x of high) rh += returns[x.symbol][i];
      rl /= k; rh /= k;
      stratR.push(wLong * rl - wShort * rh);
      lowR.push(rl);
      highR.push(rh);
      mktR.push(market[i]);
      // Return index i covers times[i] → times[i+1]; the curve is stamped at the
      // END of the period it earned, never at the start.
      outTimes.push(times[i + 1]);
    }
  }

  const toCurve = (rs) => {
    let v = 100;
    return rs.map((r, i) => ({ x: outTimes[i], y: (v *= 1 + r) }));
  };

  return {
    returns: { strategy: stratR, market: mktR, longLeg: lowR, shortLeg: highR },
    curves: {
      strategy: toCurve(stratR), market: toCurve(mktR),
      longLeg: toCurve(lowR), shortLeg: toCurve(highR),
    },
    stats: { strategy: curveStats(stratR), market: curveStats(mktR) },
    ranked: lastRanked,
    weights: lastWeights,
    meta: {
      nSymbols: names.length,
      rebalances: rebalances.length,
      skippedRebalances: skipped,
      from: outTimes[0] ?? null,
      to: outTimes[outTimes.length - 1] ?? null,
      window, rebalance, bucketPct,
    },
  };
}

/** Ranking functions a paper is most likely to ask for. Each owns its own sign. */
export const RANKERS = {
  /** OLS beta over the window. Low beta ends up long — betting against beta. */
  beta: ({ returns, market, from, to }) => {
    let n = 0, sx = 0, sy = 0;
    for (let i = from; i < to; i++) { sx += market[i]; sy += returns[i]; n++; }
    if (n < 2) return null;
    const mx = sx / n, my = sy / n;
    let cov = 0, varm = 0;
    for (let i = from; i < to; i++) {
      cov += (market[i] - mx) * (returns[i] - my);
      varm += (market[i] - mx) ** 2;
    }
    return varm > 0 ? cov / varm : null;
  },
  /** NEGATIVE cumulative return: winners score low, so winners are held long. */
  momentum: ({ returns, from, to }) => {
    let cum = 1;
    for (let i = from; i < to; i++) cum *= 1 + returns[i];
    return Number.isFinite(cum) ? -(cum - 1) : null;
  },
  /** Realised volatility. Low vol long — the low-volatility anomaly. */
  volatility: ({ returns, from, to }) => {
    let n = 0, sum = 0, sum2 = 0;
    for (let i = from; i < to; i++) { sum += returns[i]; sum2 += returns[i] ** 2; n++; }
    if (n < 2) return null;
    const mean = sum / n;
    return Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  },
  /** Cumulative return, unsigned: winners score high and are SHORTED — reversal. */
  reversal: ({ returns, from, to }) => {
    let cum = 1;
    for (let i = from; i < to; i++) cum *= 1 + returns[i];
    return Number.isFinite(cum) ? cum - 1 : null;
  },
};
