// optimizer.mjs — parameter plateau gate + walk-forward neighbor search
// (Cortex phase-4 upgrade). Deliberately NOT a Bayesian tuner:
//
// 1. PLATEAU GATE (the real value): perturb the strategy's numeric constants
//    ±25% one at a time. If most neighbors lose money, the original pass was
//    a parameter knife-edge — statistically indistinguishable from luck —
//    and the candidate is rejected. Robust edges live on plateaus.
// 2. NEIGHBOR SEARCH (the cautious upside): if a neighbor beats the original
//    on the K-FOLD out-of-sample criterion by a clear margin, the caller may
//    re-run the FULL gauntlet on it (with the trial window already charged
//    for every probe). Selection is never done on the full-sample return —
//    that would be textbook overfitting.
//
// Every probe is charged to the DSR trial window by the caller. No free looks.

/**
 * Distinct integer constants that look like tunable parameters (lookbacks,
 * thresholds): 3..300, not part of a longer number, first `maxParams` by
 * order of appearance. Comments are stripped so thesis headers don't count.
 */
export function findTunables(code, maxParams = 4) {
  const body = code.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const seen = new Set();
  const out = [];
  for (const m of body.matchAll(/(?<![\w.])(\d{1,3})(?![\w.])/g)) {
    const n = +m[1];
    if (n < 3 || n > 300 || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    if (out.length >= maxParams) break;
  }
  return out;
}

/** All ±25% single-constant variants of `code` (whole-token replacement). */
export function paramVariants(code, maxParams = 4) {
  const variants = [];
  for (const n of findTunables(code, maxParams)) {
    for (const factor of [0.75, 1.25]) {
      const v = Math.max(2, Math.round(n * factor));
      if (v === n) continue;
      // Replace ONLY standalone occurrences of this integer.
      const re = new RegExp(`(?<![\\w.])${n}(?![\\w.])`, "g");
      variants.push({ code: code.replace(re, String(v)), changed: `${n}→${v}` });
    }
  }
  return variants;
}

/**
 * Probe the parameter neighborhood on the candidate's best market.
 * Returns { ok, probes, profitable, summary, better } where `better` is the
 * strongest neighbor by k-fold profitable-fold count (only set when it beats
 * the original by ≥1 fold AND is profitable after costs) — the caller decides
 * whether to re-gauntlet it. Charges nothing itself; the caller charges
 * `probes` trials.
 */
export function plateauProbe({ code, language, dataset, compileFor, runBacktest, kFoldCode }) {
  const variants = paramVariants(code);
  if (!variants.length) return { ok: true, probes: 0, profitable: 0, summary: "no tunable constants", better: null };

  const kfScore = (c) => {
    try {
      const kf = kFoldCode({ candles: dataset.candles, makeSignalFn: () => compileFor(c, language), feeBps: dataset.feeBps });
      return kf ? kf.profitableFolds : 0;
    } catch { return -1; }
  };
  const baseKf = kfScore(code);

  let profitable = 0;
  let better = null;
  for (const v of variants) {
    try {
      const fn = compileFor(v.code, language);
      const res = runBacktest({ candles: dataset.candles, signalFn: fn, initialCapital: 10000, feeBps: dataset.feeBps });
      const isProfit = res.metrics.totalReturnPct > 0;
      if (isProfit) profitable++;
      // Neighbor selection strictly by the OOS criterion (k-fold), never by
      // the full-sample return.
      if (isProfit) {
        const kf = kfScore(v.code);
        if (kf > baseKf && (!better || kf > better.kf)) better = { code: v.code, changed: v.changed, kf };
      }
    } catch { /* broken variant = not profitable */ }
  }

  // Plateau rule: at least half the neighborhood must survive costs. A lone
  // spike is luck wearing a parameter as a disguise.
  const ok = profitable >= Math.ceil(variants.length / 2);
  return {
    ok, probes: variants.length, profitable,
    summary: `${profitable}/${variants.length} neighbors profitable on ${dataset.market.label}${better ? ` · better neighbor ${better.changed} (kfold ${better.kf}>${baseKf})` : ""}`,
    better,
  };
}
