// combine.js — the strategy-combination step of the failure-memory vision.
//
// A decayed strategy (good-early) and an improving one (good-late) can, blended
// as a portfolio, smooth into something consistent across the whole window — one
// carries the years the other bleeds. The clever part: this can be spotted from
// the STORED window profiles alone (per-window returns), no re-backtest needed,
// so Cortex can scan the whole library cheaply and surface the pairs worth
// actually building.
//
// Pure and dependency-free. Judged by the SAME classifier windowProfile uses, so
// a hypothetical blend is graded exactly like a real strategy.

import { classifyReturns, areComplementary } from "./windowProfile.js";

/**
 * Portfolio-blend the per-window returns of several strategies at given weights
 * (a weighted average per window), and classify the resulting time-shape.
 * @param {Array<{segments:{ret:number}[]}>} profiles  each strategy's windowProfile
 * @param {number[]} [weights]  portfolio weights (default equal); normalised
 * @returns {{returns:number[], profile:string, summary:string}|null}
 */
export function blendProfiles(profiles, weights) {
  const ps = (profiles || []).filter((p) => p?.segments?.length);
  if (ps.length < 2) return null;
  const k = ps[0].segments.length;
  if (!ps.every((p) => p.segments.length === k)) return null; // must share the window count
  const w = weights && weights.length === ps.length ? weights : ps.map(() => 1);
  const wsum = w.reduce((a, b) => a + b, 0) || 1;
  const returns = [];
  for (let i = 0; i < k; i++) {
    let acc = 0;
    for (let j = 0; j < ps.length; j++) acc += (w[j] / wsum) * (ps[j].segments[i].ret ?? 0);
    returns.push(acc);
  }
  const { profile, summary } = classifyReturns(returns);
  return { returns, profile, summary };
}

/**
 * Scan a set of library entries for COMPLEMENTARY pairs whose 50/50 blend becomes
 * consistent — the combinations worth actually building. Only entries carrying a
 * windowProfile are considered. Returns strongest first (highest worst-window
 * return in the blend = most robust).
 * @param {Array<object>} entries  library entries (need .id, .name, .windowProfile)
 * @returns {Array<{a,b,blend,minWindowRet:number}>}
 */
export function findComplementaryPairs(entries) {
  // Derive each shape from the segment returns rather than trusting a stored
  // `.profile` field — an older entry may not carry one.
  const cands = (entries || [])
    .filter((e) => e?.windowProfile?.segments?.length && e.status !== "graveyard")
    .map((e) => ({ e, cls: classifyReturns(e.windowProfile.segments.map((s) => s.ret ?? 0)) }));
  const out = [];
  for (let i = 0; i < cands.length; i++) {
    for (let j = i + 1; j < cands.length; j++) {
      const a = cands[i], b = cands[j];
      if (!areComplementary(a.cls, b.cls)) continue;
      const blend = blendProfiles([a.e.windowProfile, b.e.windowProfile]);
      if (!blend || blend.profile !== "consistent") continue; // only surface blends that actually smooth out
      out.push({ a: a.e, b: b.e, blend, minWindowRet: Math.min(...blend.returns) });
    }
  }
  return out.sort((x, y) => y.minWindowRet - x.minWindowRet);
}
