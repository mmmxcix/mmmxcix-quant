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

  // Classify the shape. "Good" = the window made money; the threshold is a small
  // positive buffer so flat windows don't read as wins.
  const EPS = 0.02; // 2% over the window to count as genuinely positive
  const good = segs.map((s) => s.ret > EPS);
  const bad = segs.map((s) => s.ret < -EPS);
  const rets = segs.map((s) => s.ret);
  const best = rets.indexOf(Math.max(...rets));
  const worst = rets.indexOf(Math.min(...rets));
  const allGood = good.every(Boolean);
  const allBad = bad.every(Boolean);
  const firstHalfGood = good.slice(0, Math.ceil(segments / 2)).every(Boolean);
  const secondHalfGood = good.slice(Math.floor(segments / 2)).every(Boolean);
  const firstHalfBad = bad.slice(0, Math.ceil(segments / 2)).some(Boolean);
  const secondHalfBad = bad.slice(Math.floor(segments / 2)).some(Boolean);

  let profile;
  if (allGood) profile = "consistent";
  else if (allBad) profile = "unprofitable";
  else if (firstHalfGood && secondHalfBad) profile = "good-early"; // decayed
  else if (firstHalfBad && secondHalfGood) profile = "good-late";  // improving
  else profile = "erratic";

  const pct = (r) => `${r >= 0 ? "+" : ""}${(r * 100).toFixed(0)}%`;
  const half = segments <= 2 ? "half" : "period";
  const summary = {
    consistent: `Made money across the whole window (${segs.map((s) => pct(s.ret)).join(" · ")}) — the edge held throughout.`,
    unprofitable: `Lost across the whole window (${segs.map((s) => pct(s.ret)).join(" · ")}) — no edge to fix.`,
    "good-early": `Profitable early (${pct(rets[0])}) then decayed to ${pct(rets[rets.length - 1])} in the last ${half} — the edge may have been arbitraged away; good candidate to combine with a "good-late" strategy.`,
    "good-late": `Weak early (${pct(rets[0])}) but strong recently (${pct(rets[rets.length - 1])}) — may suit the current regime; good candidate to combine with a "good-early" strategy.`,
    erratic: `Uneven across time (${segs.map((s) => pct(s.ret)).join(" · ")}) — no stable regime, hard to trust.`,
  }[profile];

  return { segments: segs, profile, summary, best, worst };
}

/** A pair is COMPLEMENTARY when one is strong exactly where the other is weak —
 *  the raw material for Cortex to try combining them into a robust whole. */
export function areComplementary(a, b) {
  if (!a || !b) return false;
  return (a.profile === "good-early" && b.profile === "good-late") ||
         (a.profile === "good-late" && b.profile === "good-early");
}
