// argus/pace.js — how often the agent is allowed to act.
//
// The live ledger ran 95 trades in 1.6 days — about sixty a day — with up to
// nine positions open at once, across 8 setups × 10 symbols × 2 sides. That is
// 160 combinations sampled by a 95-trade book: enough to find patterns in noise
// and nowhere near enough to establish one.
//
// Risk sizing does NOT limit this. Heat caps how much is at stake, so a run of
// tight-stop trades can open many small positions and never touch the cap. Two
// things are therefore capped directly:
//
//   • CONCURRENCY — how many bets are live at once. Nine correlated crypto
//     positions are one bet in nine pieces, and each piece pays its own spread.
//   • PACE — how many NEW trades may be opened per day. Sixty a day is not an
//     advantage over the market; it is sixty chances a day to pay the spread.
//
// Neither is a view on whether a particular trade is good. They are the
// admission that with no proven edge, acting less often is the only free
// improvement available.

export const DEFAULT_MAX_CONCURRENT = 4;
export const DEFAULT_MAX_PER_DAY = 12;

/** UTC day key, so the budget resets on a fixed boundary rather than on a
 *  rolling window the agent could drift around. */
export const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10);

/**
 * May a new trade be opened right now?
 *
 * @param openCount   positions currently open
 * @param openedToday how many were opened in the current UTC day
 * @returns {{ ok:boolean, reason?:string }}
 */
export function canOpen(openCount, openedToday, {
  maxConcurrent = DEFAULT_MAX_CONCURRENT,
  maxPerDay = DEFAULT_MAX_PER_DAY,
} = {}) {
  if (maxConcurrent > 0 && openCount >= maxConcurrent) {
    return { ok: false, reason: `${openCount} positions already open (cap ${maxConcurrent})` };
  }
  if (maxPerDay > 0 && openedToday >= maxPerDay) {
    return { ok: false, reason: `${openedToday} trades opened today (cap ${maxPerDay})` };
  }
  return { ok: true };
}

/**
 * Count today's openings from the ledger plus whatever is still open — a cap
 * that only counted CLOSED trades would reset itself every time a position
 * stayed open, which is exactly when the agent is most active.
 */
export function openedToday(ledger, openPositions, now = Date.now()) {
  const key = dayKey(now);
  const count = (arr) => (arr || []).filter((t) => t?.openedAt && dayKey(t.openedAt) === key).length;
  return count(ledger) + count(openPositions);
}

/**
 * A pace report for the UI: what the budget is and how much of it is spent.
 */
export function paceStatus(ledger, openPositions, opts = {}, now = Date.now()) {
  const maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const maxPerDay = opts.maxPerDay ?? DEFAULT_MAX_PER_DAY;
  const today = openedToday(ledger, openPositions, now);
  const open = (openPositions || []).length;
  return {
    open, maxConcurrent,
    openedToday: today, maxPerDay,
    concurrencyLeft: Math.max(0, maxConcurrent - open),
    dayLeft: Math.max(0, maxPerDay - today),
    blocked: !canOpen(open, today, { maxConcurrent, maxPerDay }).ok,
  };
}
