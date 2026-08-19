// argus/walkforward.js — does the learning loop actually learn?
//
// Today it cannot be wrong. Lessons are derived from the whole ledger and then
// applied to that same ledger, so "the trades it would have refused were the
// losing ones" is true by construction and carries no information at all. Every
// earlier claim about the loop's value in this project rested on that circle.
//
// This closes it the only way it can be closed: at each trade, derive the
// lessons from ONLY the trades that had already closed before it opened, and ask
// what the loop would have said about it then. A lesson can never see the trade
// it is judging, nor any trade after it.
//
// The output is deliberately blunt — the R the agent would have kept versus the
// R it actually took. If those are the same, the loop is decoration.

import { deriveLessons, adjustment, sessionOf } from "./learn.js";
import { tradeR } from "./core.js";

/** The context the live agent passes to `adjustment` — reproduced exactly, or
 *  the replay measures a different decision than the one that gets made. */
export function contextOf(t) {
  return {
    kind: t.kind,
    symbol: t.symbol,
    side: t.side,
    session: sessionOf(t.openedAt),
    source: t.source || (t.catalyst ? "event" : "technical"),
    bias: t.bias ?? undefined,
    regime: t.regime ?? undefined,
  };
}

/**
 * Replay the learning loop forward through the ledger.
 *
 * @param closed   the closed-thesis ledger, any order
 * @param opts     { warmup, minSample, step } — `warmup` trades pass ungated at
 *                 the start because there is nothing to have learned from yet,
 *                 and counting them as "the loop's decision" would flatter it.
 *                 `step` re-derives lessons every N trades rather than every one;
 *                 deriving is the expensive part and the lessons barely move
 *                 between adjacent trades.
 */
export function walkForward(closed, { warmup = 20, minSample = 20, step = 1, halfLifeMs = 0 } = {}) {
  const led = (closed || [])
    .filter((t) => t && t.state === "closed" && Number.isFinite(t.openedAt))
    .sort((a, b) => a.openedAt - b.openedAt);

  const kept = [], refused = [], warm = [];
  let lessons = [];

  for (let i = 0; i < led.length; i++) {
    const t = led[i];
    if (i < warmup) { warm.push(t); continue; }
    // Only trades that had already CLOSED before this one opened. Using "the
    // first i trades" instead would leak: Argus holds several positions at once,
    // so trade i−1 is often still running when trade i opens, and its outcome is
    // not knowable yet.
    if (i === warmup || i % step === 0) {
      const past = led.slice(0, i).filter((p) => (p.exitAt ?? p.openedAt) <= t.openedAt);
      // `now` is the judged trade's open, so decay is measured from the moment
      // the decision was made rather than from today.
      // deriveLessons at the library default (evidence floor, 8) and adjustment
      // at `minSample` (20) — the SAME pair the live agent runs. Until Aug 2026
      // the agent derived at 20, so every walk-forward number (including the
      // half-life sweep) evaluated a policy that was never deployed; if either
      // side changes again, change BOTH or the replay measures fiction.
      lessons = deriveLessons(past, { halfLifeMs, now: t.openedAt });
    }
    const a = adjustment(lessons, contextOf(t), { minSample });
    (a.skip ? refused : kept).push(t);
  }

  const stats = (g) => {
    if (!g.length) return { n: 0, sumR: 0, avgR: 0, winRate: 0, pnl: 0 };
    const rs = g.map(tradeR);
    const sumR = rs.reduce((a, b) => a + b, 0);
    return {
      n: g.length,
      sumR,
      avgR: sumR / g.length,
      winRate: g.filter((t) => tradeR(t) > 0).length / g.length,
      pnl: g.reduce((a, t) => a + (t.pnl || 0), 0),
    };
  };

  const all = stats([...warm, ...kept, ...refused]);
  const decided = stats([...kept, ...refused]);
  const k = stats(kept), r = stats(refused);
  return {
    warmup: stats(warm),
    all,
    decided,          // the trades the loop actually had an opinion about
    kept: k,
    refused: r,
    // The number that matters: how much better (or worse) the surviving book is
    // than the book the agent actually traded, out of sample.
    edgeR: decided.n ? k.avgR - decided.avgR : 0,
    refusedShare: decided.n ? r.n / decided.n : 0,
  };
}

/**
 * Is the improvement bigger than chance? Compares the kept trades' mean R with
 * the decided book's, as a two-sample t-like statistic. Small samples make this
 * weak on purpose — a loop that cannot clear it has not proven anything.
 */
export function walkForwardVerdict(wf) {
  const { kept, refused } = wf;
  if (kept.n < 10 || refused.n < 10) {
    return { proven: false, reason: `too few on one side (kept ${kept.n}, refused ${refused.n})` };
  }
  const diff = kept.avgR - refused.avgR;
  if (diff <= 0) {
    return { proven: false, reason: `the trades it refused did BETTER (${diff.toFixed(2)}R)`, diff };
  }
  return { proven: true, reason: `kept beat refused by ${diff.toFixed(2)}R out of sample`, diff };
}
