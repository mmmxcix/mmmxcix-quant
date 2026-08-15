// pollPace.js — how fast a local agent should ask the site whether there is work.
//
// The executor asked every 4 seconds, around the clock, and the answer was
// almost always "nothing". Measured over seven days: 145,602 of those questions,
// 0 rows read on essentially every one — 54% of ALL our D1 queries and roughly
// 70% of the site's entire Worker traffic, spent on an empty queue.
//
// A fixed interval has to choose once between two things it cannot have at the
// same time: reacting quickly when a job arrives, and staying quiet when none
// does. This picks per-moment instead. Right after a job the queue is warm —
// people submit backtests in bursts — so it stays fast. When nothing has come
// for a while it doubles its way out to a ceiling.
//
// The ceiling is deliberately low (12s, not 60): this queue has a human waiting
// at the other end of it, and the worst case is what they feel.

export const PACE_DEFAULTS = {
  minMs: 4_000,     // while work is flowing
  maxMs: 12_000,    // the quiet ceiling — a human's patience bounds this
  warmMs: 90_000,   // stay fast this long after the last job
};

/**
 * How long to wait before asking again.
 *
 * @param {object} s
 * @param {number} s.idleRounds  consecutive empty answers (0 right after a job)
 * @param {number} s.sinceJobMs  ms since the last job was claimed (Infinity if never)
 * @param {number} [s.minMs] [s.maxMs] [s.warmMs]  see PACE_DEFAULTS
 * @returns {number} delay in ms, always between minMs and maxMs
 */
export function nextDelay({ idleRounds = 0, sinceJobMs = Infinity, ...opts } = {}) {
  const { minMs, maxMs, warmMs } = { ...PACE_DEFAULTS, ...opts };
  if (maxMs <= minMs) return minMs;                 // escape hatch: equal values = old behaviour
  if (sinceJobMs < warmMs) return minMs;            // the queue is warm, stay quick
  const rounds = Math.max(0, Math.floor(idleRounds));
  // Double from the floor, but never past the ceiling. 4 → 8 → 12 → 12 …
  const grown = minMs * 2 ** Math.min(rounds, 30);
  return Math.min(maxMs, Math.max(minMs, grown));
}

/**
 * Requests per day at a given pace, assuming an idle queue — the number this
 * whole module exists to bring down. Used by the tests to state the saving as a
 * fact rather than a hope.
 */
export const dailyPollsIdle = (delayMs) => Math.round(86_400_000 / delayMs);
