// argus/pace.js — how often the agent is allowed to act, and WHEN.
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
//
// ── The session split (Aug 26 2026) ─────────────────────────────────────────
// A flat daily cap turned out to have a defect that cost more than the churn it
// was built to stop. It resets at 00:00 UTC — the start of the DEADEST window
// of the trading day — and the agent, running 24/7, spent the whole budget
// before dawn. Measured on the entire post-overhaul book: all 47 trades opened
// between 21:00 and 06:00 UTC, 12 of 12 slots used by 06:00 on every single
// day, and therefore ZERO trades in London or New York, ever. The agent was not
// choosing the overnight tape; it was simply awake first and broke on the cap
// before the liquid sessions arrived.
//
// So the budget is now split per session instead of pooled. The split is
// a-priori by liquidity — New York > London > Asia > off-hours — deliberately
// NOT fitted to that book's P&L, which is 47 trades and cannot support a fitted
// anything. It merely corroborates: Asia −9.09R over 36 trades, everything else
// +1.93R over 11.
//
// A session's unused slots do NOT roll over. Rolling them forward would rebuild
// exactly the failure being fixed, one day later.

import { sessionOf } from "./learn.js";

export const DEFAULT_MAX_CONCURRENT = 4;
export const DEFAULT_MAX_PER_DAY = 12;

/** Slots per UTC session. Keys match learn.sessionOf: asia 00–07, london 07–12,
 *  ny 12–20, off 20–24. Sums to DEFAULT_MAX_PER_DAY on purpose — this
 *  redistributes the day's activity, it does not increase it. */
export const DEFAULT_SESSION_BUDGET = Object.freeze({ ny: 5, london: 4, asia: 2, off: 1 });

/** UTC day key, so the budget resets on a fixed boundary rather than on a
 *  rolling window the agent could drift around. */
export const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10);

/** Parse "ny:5,london:4,asia:2,off:1" (env override) into a budget object.
 *  Anything unparseable falls back to the default, and every value is clamped to
 *  `cap`, because a typo in an env var must not silently uncap a 24/7 agent —
 *  the session caps are now the ONLY pace control (see canOpen), so this is
 *  where that backstop has to live. */
export function parseSessionBudget(spec, fallback = DEFAULT_SESSION_BUDGET, cap = DEFAULT_MAX_PER_DAY) {
  if (typeof spec !== "string" || !spec.trim()) return { ...fallback };
  const out = { ...fallback };
  let touched = false;
  for (const part of spec.split(",")) {
    const [k, v] = part.split(":").map((s) => String(s || "").trim());
    const n = Number(v);
    if (k && k in fallback && Number.isFinite(n) && n >= 0) { out[k] = Math.min(cap, Math.floor(n)); touched = true; }
  }
  return touched ? out : { ...fallback };
}

/**
 * May a new trade be opened right now?
 *
 * @param openCount   positions currently open
 * @param openedToday how many were opened in the current UTC day
 * @param opts.session        current session key; omit to skip the session cap
 * @param opts.sessionOpened  how many were opened in THIS session today
 * @returns {{ ok:boolean, reason?:string }}
 */
export function canOpen(openCount, openedToday, {
  maxConcurrent = DEFAULT_MAX_CONCURRENT,
  maxPerDay = DEFAULT_MAX_PER_DAY,
  session = null,
  sessionOpened = 0,
  sessionBudget = DEFAULT_SESSION_BUDGET,
} = {}) {
  if (maxConcurrent > 0 && openCount >= maxConcurrent) {
    return { ok: false, reason: `${openCount} positions already open (cap ${maxConcurrent})` };
  }
  // Once a session cap is in force it REPLACES the daily total rather than
  // sitting under it, and that is the fix, not a shortcut. The session caps
  // already bound the day — they sum to the daily budget by construction — so a
  // second global counter adds nothing except the power to wedge a session that
  // has room, which is precisely the failure being repaired: twelve overnight
  // trades would still have spent London's slots through the daily total even
  // after the split. (The backstop against a mistyped budget lives in
  // parseSessionBudget, which clamps each session.) Callers that pass no
  // session — tests, and any consumer that does not track the clock — keep the
  // old flat behaviour unchanged.
  const cap = session ? sessionBudget?.[session] : null;
  if (Number.isFinite(cap) && cap >= 0) {
    if (sessionOpened >= cap) {
      return { ok: false, reason: `${sessionOpened} trades opened this ${session} session (cap ${cap})` };
    }
    return { ok: true };
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

/** Same count, narrowed to the session that `now` falls in. Both boundaries
 *  matter: a trade from yesterday's Asia session must not spend today's. */
export function openedInSession(ledger, openPositions, now = Date.now()) {
  const key = dayKey(now);
  const sess = sessionOf(now);
  const count = (arr) => (arr || []).filter((t) =>
    t?.openedAt && dayKey(t.openedAt) === key && sessionOf(t.openedAt) === sess).length;
  return count(ledger) + count(openPositions);
}

/**
 * A pace report for the UI: what the budget is and how much of it is spent,
 * for the day AND for the session the clock is currently in.
 */
export function paceStatus(ledger, openPositions, opts = {}, now = Date.now()) {
  const maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const maxPerDay = opts.maxPerDay ?? DEFAULT_MAX_PER_DAY;
  const sessionBudget = opts.sessionBudget ?? DEFAULT_SESSION_BUDGET;
  const today = openedToday(ledger, openPositions, now);
  const session = sessionOf(now);
  const sessionOpened = openedInSession(ledger, openPositions, now);
  const sessionCap = sessionBudget?.[session] ?? null;
  const open = (openPositions || []).length;
  return {
    open, maxConcurrent,
    openedToday: today, maxPerDay,
    session, sessionOpened, sessionCap,
    sessionLeft: Number.isFinite(sessionCap) ? Math.max(0, sessionCap - sessionOpened) : null,
    sessionBudget,
    concurrencyLeft: Math.max(0, maxConcurrent - open),
    dayLeft: Math.max(0, maxPerDay - today),
    blocked: !canOpen(open, today, { maxConcurrent, maxPerDay, session, sessionOpened, sessionBudget }).ok,
  };
}
