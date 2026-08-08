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
 * The invalidation policy for a setup KIND, learned from its retrospection tally
 * `{ premature, justified, unnecessary }`. Setups whose cuts keep proving premature
 * get their invalidation eased (fires later) or disabled entirely — let the hard stop
 * do the work. A justified track record keeps the (already conservative) default.
 * @returns {{}|{disable:true}|{invalMinAdverse:number, invalConfirmBars:number}}
 */
export function invalPolicy(stat) {
  if (!stat) return {};
  const premature = stat.premature || 0;
  const justified = stat.justified || 0;
  const unnecessary = stat.unnecessary || 0;
  const notHelpful = premature + unnecessary; // cuts that hurt or did nothing
  // Strongly premature and clearly outweighing the cuts that helped → stop cutting
  // this setup early at all; the hard stop is the only exit.
  if (premature >= 3 && premature > justified) return { disable: true };
  // Mostly unhelpful → still invalidate, but only when almost certainly dead, and
  // demand a longer sustained break.
  if (notHelpful >= 3 && notHelpful > justified) return { invalMinAdverse: 0.92, invalConfirmBars: 3 };
  return {};
}
