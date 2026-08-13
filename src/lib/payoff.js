// payoff.js — what SHAPE does a strategy's profit have, and does the library
// hold more than one shape?
//
// The three classical families are not three ideas, they are three payoff
// shapes, and a book is built out of shapes rather than out of winners:
//
//   mean reversion   wins often, and small
//   momentum         loses often, and wins big
//   carry            wins nearly every day, until the one day it does not
//
// Firms hold all three BECAUSE the shapes differ — the drawdowns do not arrive
// together. A library ranked on a single score converges on whatever shape has
// been working lately, and then fails all at once.
//
// The family is INFERRED from the record, never declared. Two numbers already
// stored on every entry are enough, because the profit factor contains the
// average win/loss ratio:
//
//   PF = (w·avgWin) / ((1−w)·avgLoss)   ⟹   avgWin/avgLoss = PF·(1−w)/w
//
// The same arithmetic gives the break-even payoff ratio (1−w)/w — the ratio a
// strategy MUST clear to make money at its win rate. That is the calculation
// that quietly bankrupted Argus (a 0.8 R:R floor needs 55.6% wins), so every
// card gets to show it.

/** Below this many trades a payoff shape is a rumour, not a measurement. */
export const MIN_TRADES_FOR_FAMILY = 20;

export const FAMILY_META = {
  reversion: {
    label: "Mean reversion",
    shape: "Wins often, wins small",
    risk: "Dies when the range breaks and the small wins meet one large loss.",
  },
  momentum: {
    label: "Momentum",
    shape: "Loses often, wins big",
    risk: "Bleeds through every quiet market waiting for the move that pays.",
  },
  carry: {
    label: "Carry",
    shape: "Wins almost daily, until it doesn't",
    risk: "You are selling insurance. It pays until the disaster — and it will arrive.",
  },
  mixed: {
    label: "Mixed",
    shape: "No clear shape",
    risk: "Either genuinely balanced, or two behaviours averaged into one card.",
  },
  unknown: {
    label: "Unclassified",
    shape: "Too few trades to read a shape",
    risk: `Needs ${MIN_TRADES_FOR_FAMILY} trades before the shape means anything.`,
  },
};

export const FAMILIES = ["reversion", "momentum", "carry", "mixed"];

/**
 * Read the payoff shape off a stored metrics object.
 * @param {{winRatePct?:number, profitFactor?:number, tradeCount?:number}} metrics
 * @returns {{family, winRate, payoffRatio, breakEvenRatio, edge, trades, sure}}
 *   `payoffRatio` = average win ÷ average loss. `breakEvenRatio` is what it has
 *   to beat. `edge` is the gap between them: negative means the strategy needs a
 *   win rate it does not have.
 */
export function payoffProfile(metrics) {
  const trades = Number(metrics?.tradeCount) || 0;
  const w = Number.isFinite(metrics?.winRatePct) ? metrics.winRatePct / 100 : null;
  const pf = Number(metrics?.profitFactor);
  if (w == null || trades <= 0) {
    return { family: "unknown", winRate: null, payoffRatio: null, breakEvenRatio: null, edge: null, trades, sure: false };
  }
  // A perfect or hopeless record has no ratio to speak of — say so rather than
  // dividing by zero and printing a confident number.
  const payoffRatio = w >= 1 ? Infinity : w <= 0 ? 0 : (Number.isFinite(pf) ? (pf * (1 - w)) / w : Infinity);
  const breakEvenRatio = w > 0 ? (1 - w) / w : Infinity;
  const edge = Number.isFinite(payoffRatio) && Number.isFinite(breakEvenRatio) ? payoffRatio - breakEvenRatio : null;
  const sure = trades >= MIN_TRADES_FOR_FAMILY;

  let family = "mixed";
  if (!sure) family = "unknown";
  else if (w >= 0.75 && payoffRatio <= 0.5) family = "carry";
  else if (w >= 0.55 && payoffRatio < 1.2) family = "reversion";
  else if (w <= 0.45 && payoffRatio >= 1.5) family = "momentum";

  return {
    family,
    winRate: w,
    payoffRatio: Number.isFinite(payoffRatio) ? +payoffRatio.toFixed(2) : payoffRatio,
    breakEvenRatio: Number.isFinite(breakEvenRatio) ? +breakEvenRatio.toFixed(2) : breakEvenRatio,
    edge: Number.isFinite(edge) ? +edge.toFixed(2) : null,
    trades, sure,
  };
}

/** Family counts across a set of entries, plus the honest warning when a whole
 *  library turns out to be one bet wearing several names. */
export function familyMix(entries) {
  const counts = { reversion: 0, momentum: 0, carry: 0, mixed: 0, unknown: 0 };
  for (const e of entries || []) counts[payoffProfile(e?.metrics).family]++;
  const classified = counts.reversion + counts.momentum + counts.carry;
  const shapes = FAMILIES.filter((f) => counts[f] > 0 && f !== "mixed").length;
  let warning = null;
  if (classified >= 3 && shapes === 1) {
    const only = FAMILIES.find((f) => counts[f] > 0 && f !== "mixed");
    warning = `Every classified strategy here is ${FAMILY_META[only].label.toLowerCase()}. ${FAMILY_META[only].risk} They will have that bad day together.`;
  }
  return { counts, classified, shapes, warning };
}

/** Pearson correlation of two day→return series (registry `returnSeries`). */
function corr(a, b) {
  if (!a?.length || !b?.length) return null;
  const mapB = new Map(b.map((p) => [p.d, p.r]));
  const xs = [], ys = [];
  for (const p of a) if (mapB.has(p.d)) { xs.push(p.r); ys.push(mapB.get(p.d)); }
  const n = xs.length;
  if (n < 8) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

const sharpeOf = (e) => (Number.isFinite(e?.metrics?.sharpe) ? e.metrics.sharpe : 0);

export const SELECT_DEFAULTS = {
  max: 5,
  corrPenalty: 1.5,   // Sharpe points charged per unit of correlation to the set
  familyBonus: 0.5,   // credit for bringing a shape the book does not have
};

/**
 * Greedily assemble a set that is complementary rather than merely good.
 *
 * The first pick is the best Sharpe. Every pick after that is judged on what it
 * ADDS: its own Sharpe, minus how much it moves with what is already in, plus a
 * credit for bringing a payoff shape the book is missing. That is the whole
 * argument of the three-families idea, made mechanical.
 *
 * Deliberately NOT an optimiser. Weights fitted to backtested correlations are
 * the most overfittable object in the whole tool; this only orders the picks and
 * says why, and leaves the sizing to a human.
 *
 * @returns {{picked:Array, considered:number, mix:object}}
 */
export function selectComplementary(entries, opts = {}) {
  const o = { ...SELECT_DEFAULTS, ...opts };
  const pool = (entries || [])
    .filter((e) => e && e.status !== "graveyard" && e.metrics)
    .map((e) => ({ e, profile: payoffProfile(e.metrics), sharpe: sharpeOf(e) }))
    .sort((a, b) => b.sharpe - a.sharpe);
  const picked = [];
  const families = new Set();

  while (pool.length && picked.length < o.max) {
    let best = null;
    for (const c of pool) {
      let maxCorr = 0, known = false;
      for (const p of picked) {
        const r = corr(c.e.returnSeries, p.entry.returnSeries);
        if (r == null) continue;
        known = true;
        maxCorr = Math.max(maxCorr, r);
      }
      const fresh = c.profile.family !== "unknown" && !families.has(c.profile.family);
      const value = c.sharpe - o.corrPenalty * Math.max(0, maxCorr) + (fresh ? o.familyBonus : 0);
      if (!best || value > best.value) best = { c, value, maxCorr, known, fresh };
    }
    if (!best) break;
    const { c, maxCorr, known, fresh } = best;
    picked.push({
      entry: c.e, family: c.profile.family, profile: c.profile,
      sharpe: +c.sharpe.toFixed(2),
      maxCorr: picked.length === 0 ? null : (known ? +maxCorr.toFixed(2) : null),
      reason: picked.length === 0
        ? "best risk-adjusted return in the library — the set starts here"
        : fresh
          ? `adds the ${FAMILY_META[c.profile.family].label.toLowerCase()} shape, which nothing else here has`
          : !known
            ? "no overlapping days with the set — correlation unknown, taken on its own merit"
            : maxCorr <= 0.3
              ? `moves independently of the set (max correlation ${maxCorr.toFixed(2)})`
              : `best remaining, but it moves with the set (max correlation ${maxCorr.toFixed(2)})`,
    });
    families.add(c.profile.family);
    pool.splice(pool.indexOf(c), 1);
  }

  return { picked, considered: pool.length + picked.length, mix: familyMix(picked.map((p) => p.entry)) };
}
