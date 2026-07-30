// windowProfile.js — the "why was it good/bad, and WHEN?" memory.
//
// A single 10-year return hides the most important thing about a strategy: WHERE
// in time the money was made. A rule that earned everything in the first five
// years and bled for the last five is very different from one that struggled
// early and works now — even at the same total return. Splitting the equity
// curve into time windows exposes that shape, which is what lets Cortex later
// spot COMPLEMENTARY strategies (good-early + good-late) and try to combine them.
//
// Pure and dependency-free: give it a backtest's equity curve, get back a
// per-window breakdown, a classification, and a one-line human summary.

/**
 * @param {{time:number, value:number}[]} equity  the backtest equity curve
 * @param {object} [o]
 * @param {number} [o.segments]  how many equal time-slices to cut it into (2 = halves)
 * @returns {{segments:{from:number,to:number,returnPct:number,ret:number}[], profile:string, summary:string, best:number, worst:number}|null}
 */
export function windowProfile(equity, { segments = 2 } = {}) {
  if (!Array.isArray(equity) || equity.length < segments * 4) return null; // too short to slice honestly
  const n = equity.length;
  const segs = [];
  for (let s = 0; s < segments; s++) {
    const a = Math.floor((s * n) / segments);
    const b = s === segments - 1 ? n - 1 : Math.floor(((s + 1) * n) / segments) - 1;
    const v0 = equity[a].value, v1 = equity[b].value;
    const ret = v0 > 0 ? (v1 - v0) / v0 : 0; // fractional return WITHIN this window
    segs.push({ from: equity[a].time, to: equity[b].time, returnPct: ret * 100, ret });
  }

  const { profile, summary, best, worst } = classifyReturns(segs.map((s) => s.ret));
  return { segments: segs, profile, summary, best, worst };
}

/**
 * Classify a sequence of per-window FRACTIONAL returns into a time-shape. Shared
 * by windowProfile (from an equity curve) and combine.js (from blended profiles),
 * so a real profile and a hypothetical blend are judged by exactly the same rule.
 * @param {number[]} rets  fractional return per window, in time order
 * @returns {{profile:string, summary:string, best:number, worst:number}}
 */
export function classifyReturns(rets) {
  const n = rets.length || 1;
  const EPS = 0.02; // 2% over the window to count as genuinely positive
  const good = rets.map((r) => r > EPS);
  const bad = rets.map((r) => r < -EPS);
  const best = rets.indexOf(Math.max(...rets));
  const worst = rets.indexOf(Math.min(...rets));
  const firstHalfGood = good.slice(0, Math.ceil(n / 2)).every(Boolean);
  const secondHalfGood = good.slice(Math.floor(n / 2)).every(Boolean);
  const firstHalfBad = bad.slice(0, Math.ceil(n / 2)).some(Boolean);
  const secondHalfBad = bad.slice(Math.floor(n / 2)).some(Boolean);

  let profile;
  if (good.every(Boolean)) profile = "consistent";
  else if (bad.every(Boolean)) profile = "unprofitable";
  else if (firstHalfGood && secondHalfBad) profile = "good-early"; // decayed
  else if (firstHalfBad && secondHalfGood) profile = "good-late";  // improving
  else profile = "erratic";

  const pct = (r) => `${r >= 0 ? "+" : ""}${(r * 100).toFixed(0)}%`;
  const half = n <= 2 ? "half" : "period";
  const summary = {
    consistent: `Made money across the whole window (${rets.map(pct).join(" · ")}) — the edge held throughout.`,
    unprofitable: `Lost across the whole window (${rets.map(pct).join(" · ")}) — no edge to fix.`,
    "good-early": `Profitable early (${pct(rets[0])}) then decayed to ${pct(rets[n - 1])} in the last ${half} — the edge may have been arbitraged away; good candidate to combine with a "good-late" strategy.`,
    "good-late": `Weak early (${pct(rets[0])}) but strong recently (${pct(rets[n - 1])}) — may suit the current regime; good candidate to combine with a "good-early" strategy.`,
    erratic: `Uneven across time (${rets.map(pct).join(" · ")}) — no stable regime, hard to trust.`,
  }[profile];

  return { profile, summary, best, worst };
}

/** A pair is COMPLEMENTARY when one is strong exactly where the other is weak —
 *  the raw material for Cortex to try combining them into a robust whole. */
export function areComplementary(a, b) {
  if (!a || !b) return false;
  return (a.profile === "good-early" && b.profile === "good-late") ||
         (a.profile === "good-late" && b.profile === "good-early");
}
