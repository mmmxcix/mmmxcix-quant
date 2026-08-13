// argus/explore.js — the way out of the deadlock.
//
// The learning loop refuses a bucket on evidence, and the refusal then removes
// the only source of evidence that could ever overturn it. No new trades in a
// bucket means its lesson never changes, which means it is refused forever. On
// the live ledger this closed almost completely: six lessons between them cover
// the Asia session (32% of the book), New York (38%) and every flat-bias setup
// (38%) — 69 candidates considered, 100% refused, nothing opened for hours.
//
// A pure exploit policy on a negative book self-terminates. The standard fix is
// to reserve a slice of the budget for taking bets the policy would decline —
// but NOT at random, which wastes the slice on refusals that are already
// settled. `orb` lost 9 of 9 at t=-4.8; there is nothing left to learn there.
// `session:ny` sits at t=-2.24, barely past the bar, on a market that changes.
//
// So exploration goes where the refusal is LEAST decisive, and it goes small:
// a probe is not a conviction bet, and it is marked so the track record can
// always separate "we chose this" from "we were checking".

export const DEFAULT_EXPLORE_SHARE = 0.25;   // of the daily trade budget
export const DEFAULT_EXPLORE_SIZE = 0.4;     // of normal risk
// Beyond this the refusal is settled and a probe is just paying to confirm it.
export const DEFAULT_MAX_TSTAT = 3.0;

/** How many probes the day's budget allows. Always at least one while trading
 *  at all, or a small daily cap would silently disable exploration entirely. */
export function exploreBudget(maxPerDay, share = DEFAULT_EXPLORE_SHARE) {
  if (!(maxPerDay > 0)) return 0;
  return Math.max(1, Math.floor(maxPerDay * share));
}

/** Probes opened in the current UTC day, from the ledger plus what is open. */
export function exploredToday(ledger, openPositions, now = Date.now()) {
  const key = new Date(now).toISOString().slice(0, 10);
  const count = (arr) => (arr || []).filter(
    (t) => t?.explore && t?.openedAt && new Date(t.openedAt).toISOString().slice(0, 10) === key
  ).length;
  return count(ledger) + count(openPositions);
}

/**
 * Should this refused setup be taken anyway, as a probe?
 *
 * @param adj    the `adjustment` result that refused it (carries `weakestSkip`)
 * @returns {{ explore:boolean, reason:string, sizeMult?:number }}
 */
export function shouldExplore(adj, { used = 0, budget = 0, maxTStat = DEFAULT_MAX_TSTAT, sizeMult = DEFAULT_EXPLORE_SIZE } = {}) {
  if (!adj?.skip) return { explore: false, reason: "not refused" };
  if (used >= budget) return { explore: false, reason: `probe budget spent (${used}/${budget})` };
  const l = adj.weakestSkip;
  if (!l) return { explore: false, reason: "refused for a reason that is not a lesson" };
  const t = Math.abs(l.tStat ?? 0);
  if (t > maxTStat) {
    return { explore: false, reason: `refusal is settled (t=${(l.tStat ?? 0).toFixed(1)}) — nothing left to learn` };
  }
  return {
    explore: true,
    sizeMult,
    reason: `probing the weakest refusal (t=${(l.tStat ?? 0).toFixed(1)}, n=${l.n}) at ${Math.round(sizeMult * 100)}% size`,
  };
}
