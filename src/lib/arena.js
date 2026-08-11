// arena.js — the live paper-trading arena for order-book strategies.
//
// WHY this exists instead of a backtest: the micro-price (see microprice.js) is
// a function of the ORDER BOOK, and we have no historical book depth — only
// candles. Backtesting it would mean inventing the very data the signal reads,
// which produces a number that means nothing. So these strategies are not
// backtested at all. They trade live on paper against the real book, and are
// judged on trades that actually happened.
//
// The arena is crypto-only for the same reason: Binance publishes full depth
// over a public websocket, with no entitlement and no market hours.
//
// ENTRY into the arena is cheap; staying is not. A strategy is removed once the
// evidence says it loses — the same rule Argus uses on its own setups (see
// lib/argus/learn.js): a mean R that is negative with statistical confidence,
// not a bad afternoon and not an arbitrary threshold on the win rate.

import { ledgerStats } from "./argus/core.js";

/** Fees, as a fraction of notional, charged on entry AND exit. Binance spot
 *  taker is 0.1%; we assume taker on both legs because these strategies cross
 *  the spread by design. Understating this is the classic way an order-book
 *  strategy looks profitable on paper and is not. */
export const TAKER_FEE = 0.001;

export const ARENA_RULES = {
  // Below this many closed trades no verdict is possible — not "it is fine",
  // but "we do not know yet". The UI must show the difference.
  minTrades: 30,
  // Mean R must be this many standard errors below zero to evict. −2 is roughly
  // a 2.5% chance of firing a break-even strategy by luck.
  evictTStat: -2.0,
  // A strategy that has bled more than this fraction of its stake is removed
  // regardless of the t-statistic. Ruin is not a hypothesis to keep testing.
  maxDrawdownPct: 35,
  // Idle strategies are removed too: an arena slot that produces no evidence is
  // worse than an empty one, because it looks like a result.
  staleDays: 21,
};

/** One paper position. Sizes are notional in quote currency (USDT). */
export function openPosition({ strategy, symbol, side, price, stake, stop, target, now = Date.now() }) {
  if (!(price > 0) || !(stake > 0)) return null;
  if (side !== "long" && side !== "short") return null;
  // Risk per trade is the distance to the stop — that is what makes results
  // comparable across strategies with different stop widths (R-multiples).
  const riskFrac = stop > 0 ? Math.abs(price - stop) / price : 0;
  if (!(riskFrac > 0)) return null;
  return {
    id: `${strategy}-${symbol}-${now}-${Math.random().toString(36).slice(2, 8)}`,
    strategy, symbol, side, state: "open",
    entry: price, stop, target, stake,
    riskAmt: stake * riskFrac,
    fees: stake * TAKER_FEE,
    openedAt: now,
  };
}

/** Mark an open position against a live price. Pure — returns numbers only. */
export function markPosition(pos, price) {
  if (!pos || pos.state !== "open" || !(price > 0)) return { pnl: 0, R: 0 };
  const dir = pos.side === "long" ? 1 : -1;
  const gross = pos.stake * dir * (price - pos.entry) / pos.entry;
  const pnl = gross - pos.fees * 2;          // both legs, as if we closed now
  return { pnl, R: pos.riskAmt > 0 ? pnl / pos.riskAmt : 0 };
}

/**
 * Close a position at `price`. `reason` is recorded because an arena where
 * everything exits on "manual" teaches nothing.
 */
export function closePosition(pos, price, reason = "signal", now = Date.now()) {
  const { pnl, R } = markPosition(pos, price);
  return { ...pos, state: "closed", exit: price, closedAt: now, reason, pnl, R };
}

/**
 * Should this position be closed by its own bracket? Checked against a live
 * book, so both sides use the price that would actually fill: a long exits at
 * the BID (it sells into the book), a short at the ASK.
 */
export function bracketExit(pos, book) {
  if (!pos || pos.state !== "open" || !book) return null;
  const { bid, ask } = book;
  if (!(bid > 0) || !(ask > 0)) return null;
  if (pos.side === "long") {
    if (pos.stop > 0 && bid <= pos.stop) return { price: Math.min(bid, pos.stop), reason: "stop" };
    if (pos.target > 0 && bid >= pos.target) return { price: bid, reason: "target" };
  } else {
    if (pos.stop > 0 && ask >= pos.stop) return { price: Math.max(ask, pos.stop), reason: "stop" };
    if (pos.target > 0 && ask <= pos.target) return { price: ask, reason: "target" };
  }
  return null;
}

/** Equity curve and peak-to-trough drawdown over a closed-trade ledger. */
export function equityCurve(closed, startEquity = 1000) {
  let eq = startEquity, peak = startEquity, maxDD = 0;
  const curve = [{ t: closed[0]?.openedAt ?? Date.now(), eq }];
  for (const c of closed) {
    eq += c.pnl ?? 0;
    peak = Math.max(peak, eq);
    if (peak > 0) maxDD = Math.max(maxDD, (peak - eq) / peak * 100);
    curve.push({ t: c.closedAt, eq });
  }
  return { curve, equity: eq, maxDrawdownPct: maxDD };
}

/**
 * The verdict on one arena entrant.
 *
 * Returns { status, reason, stats } where status is:
 *   "learning" — too few trades to say anything. NOT a pass.
 *   "active"   — trading, no evidence against it.
 *   "evicted"  — removed, with the reason that fired.
 */
export function verdict(entry, { now = Date.now(), rules = ARENA_RULES, startEquity = 1000 } = {}) {
  const closed = (entry?.ledger || []).filter((c) => c.state === "closed");
  const stats = ledgerStats(closed);
  const { equity, maxDrawdownPct } = equityCurve(closed, startEquity);
  const base = { stats: { ...stats, equity, maxDrawdownPct } };

  // Ruin first: it does not wait for a sample size.
  if (maxDrawdownPct >= rules.maxDrawdownPct) {
    return { status: "evicted", reason: `drawdown ${maxDrawdownPct.toFixed(0)}% ≥ ${rules.maxDrawdownPct}%`, ...base };
  }

  const lastAt = closed.length ? Math.max(...closed.map((c) => c.closedAt || 0)) : (entry?.startedAt ?? now);
  const idleDays = (now - lastAt) / 864e5;
  if (idleDays >= rules.staleDays) {
    return { status: "evicted", reason: `no trade in ${Math.floor(idleDays)} days`, ...base };
  }

  if (stats.n < rules.minTrades) {
    return { status: "learning", reason: `${stats.n}/${rules.minTrades} trades`, ...base };
  }

  if ((stats.tStat ?? 0) <= rules.evictTStat) {
    return {
      status: "evicted",
      reason: `mean ${stats.avgR.toFixed(2)}R over ${stats.n} trades (t=${stats.tStat.toFixed(2)})`,
      ...base,
    };
  }

  return { status: "active", reason: `${stats.n} trades, ${stats.avgR.toFixed(2)}R avg`, ...base };
}

/** Apply the verdict across the whole arena, returning the updated entries. */
export function judgeArena(entries, opts = {}) {
  return (entries || []).map((e) => {
    if (e.status === "evicted") return e;          // eviction is final
    const v = verdict(e, opts);
    if (v.status === "evicted") {
      return { ...e, status: "evicted", evictedAt: opts.now ?? Date.now(), evictReason: v.reason, verdict: v };
    }
    return { ...e, status: v.status, verdict: v };
  });
}
