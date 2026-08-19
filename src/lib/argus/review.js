// argus/review.js — retrospective judgement of an "invalidated" early exit. After
// Argus bails a trade because its thesis broke, was that the right call? Re-simulate
// the ORIGINAL trade (same stop + target) forward over the candles that followed the
// exit, and see what WOULD have happened had we held: did it reach the target, or
// would it have hit the stop? The agent runs this ~12h and ~24h after each early exit
// and LEARNS from the verdict — loosening the invalidation on setups where cutting
// kept proving premature. Pure + dependency-free so it unit-tests in isolation.

/**
 * Over `candles` (ascending, each {high, low}) that occurred AT/AFTER an early exit,
 * would the held trade have hit its target or its stop FIRST? Conservative: a single
 * bar that spans both levels counts as the STOP (matches core.evaluateExit), so the
 * review never flatters a cut it can't prove was wrong.
 * @param {"long"|"short"} side
 * @returns {"would-have-won"|"would-have-lost"|"undecided"}
 */
export function wouldHaveHit(side, stop, target, candles) {
  for (const c of candles || []) {
    if (!c) continue;
    const hi = c.high, lo = c.low;
    const hitStop = side === "long" ? lo <= stop : hi >= stop;
    const hitTarget = side === "long" ? hi >= target : lo <= target;
    if (hitStop) return "would-have-lost";   // stop-first on a spanning bar (conservative)
    if (hitTarget) return "would-have-won";
  }
  return "undecided";                        // neither level reached within the horizon
}

/**
 * Turn a would-have outcome into a verdict on the INVALIDATION decision itself:
 *   • premature   — it would have reached target; the cut was wrong.
 *   • justified   — it would have hit the stop; the cut saved the rest of the loss.
 *   • unnecessary — nothing happened; the trade was cut (a loss) for no benefit.
 * @returns {"premature"|"justified"|"unnecessary"}
 */
export function invalVerdict(would) {
  if (would === "would-have-won") return "premature";
  if (would === "would-have-lost") return "justified";
  return "unnecessary";
}

/** Whether a would-have outcome is TERMINAL (can't change with more time). A won/lost
 *  is settled; an undecided may still resolve, so it waits for the next horizon. */
export function isTerminal(would) {
  return would === "would-have-won" || would === "would-have-lost";
}

/**
 * The OLD confirm-rule exit, simulated over the candles AFTER a first-break exit —
 * so every firstbreak close carries its own A/B pair (`shadowConfirmExitR`) instead
 * of the two rules being compared across different trades.
 *
 * The first-break exit fired on the bar that ARMED the invalidation (count = 1).
 * The old rule would have needed a SECOND distinct qualifying close; until then the
 * trade stays live, so the stop and target keep competing (stop-first on a spanning
 * bar, matching core.evaluateExit). R is close-basis against the entry→stop
 * distance — an approximation (no slippage), and labeled as one.
 *
 * @param rec  {side, entry, stop, target, invalidation} of the closed trade
 * @param candles bars strictly AFTER the first-break exit bar (ascending)
 * @returns {null | {shadowR:number, how:"confirm"|"stop"|"target", bars:number}}
 */
export function confirmRuleShadow(rec, candles, { buffer = 0.15, minAdverse = 0.60 } = {}) {
  const { side, entry, stop, target, invalidation } = rec || {};
  if (![entry, stop, target].every(Number.isFinite) || invalidation == null) return null;
  const dir = side === "long" ? 1 : -1;
  const riskDist = Math.abs(entry - stop) || 1;
  const rOf = (price) => (dir * (price - entry)) / riskDist;
  let count = 1; // the arming bar already counted once
  let bars = 0;
  for (const c of candles || []) {
    if (!c) continue;
    bars++;
    const hitStop = side === "long" ? c.low <= stop : c.high >= stop;
    const hitTarget = side === "long" ? c.high >= target : c.low <= target;
    if (hitStop) return { shadowR: rOf(stop), how: "stop", bars };
    if (hitTarget) return { shadowR: rOf(target), how: "target", bars };
    const beyond = side === "long" ? invalidation - c.close : c.close - invalidation;
    const adverse = side === "long" ? entry - c.close : c.close - entry;
    if (beyond >= buffer * riskDist && adverse >= minAdverse * riskDist) {
      count++;
      if (count >= 2) return { shadowR: rOf(c.close), how: "confirm", bars };
    } else {
      count = 0; // reclaimed — the old rule would have reset and held on
    }
  }
  return null; // unresolved inside the window
}

/**
 * The invalidation policy for a setup KIND, learned BIDIRECTIONALLY from its
 * retrospection tally `{ premature, justified, unnecessary }`. The default cut fires
 * at 0.80R adverse over 2 bars; this moves it along a bounded band per kind:
 *   • cut-off    — premature-heavy → disable the early cut, let the hard stop work.
 *   • cut-later  — mostly unhelpful → cut only when almost certainly dead (0.92R, 3 bars).
 *   • default    — no clear signal → the conservative 0.80R / 2-bar default.
 *   • cut-sooner — justified > unhelpful → recover a little saved risk (0.70R).
 *   • cut-earlier— strongly justified (cuts kept saving real losses) → 0.60R.
 * The confirm-bar count stays ≥2 whenever the cut is active, so the sweep-and-reclaim
 * protection is never dropped; only the disabled case removes the early exit entirely.
 * Every tier is reversible: if a tightened kind starts cutting prematurely, those
 * premature counts accumulate and move it back toward default / loosen.
 *
 * In FIRSTBREAK mode (see core.evaluateExit) the tuning tiers are no-ops: there is
 * no confirm delay left to move, and the measured first-break exit must not be
 * quietly re-loosened by this tally. Only the escape hatch survives, at a raised
 * bar — if first-break cuts keep proving premature in the 12/24h reviews, the kind
 * loses its early exit entirely and the hard stop does the work.
 * @returns {{}|{label:string,disable?:true,invalMinAdverse?:number,invalConfirmBars?:number}}
 */
export function invalPolicy(stat, mode = "confirm") {
  if (!stat) return {};
  const premature = stat.premature || 0;
  const justified = stat.justified || 0;
  const unnecessary = stat.unnecessary || 0;
  const bad = premature + unnecessary; // cuts that hurt (premature) or did nothing (unnecessary)
  if (mode === "firstbreak") {
    if (premature >= 5 && premature > 2 * justified) return { label: "cut-off", disable: true };
    return {};
  }
  // ── LOOSEN: the cuts kept proving wrong ──
  if (premature >= 3 && premature > justified) return { label: "cut-off", disable: true };
  if (bad >= 3 && bad > justified) return { label: "cut-later", invalMinAdverse: 0.92, invalConfirmBars: 3 };
  // ── TIGHTEN: the cuts kept proving right (they saved real losses) → cut a touch earlier ──
  if (justified >= 4 && justified >= 3 * bad) return { label: "cut-earlier", invalMinAdverse: 0.60, invalConfirmBars: 2 };
  if (justified >= 3 && justified > bad) return { label: "cut-sooner", invalMinAdverse: 0.70, invalConfirmBars: 2 };
  return {};
}
