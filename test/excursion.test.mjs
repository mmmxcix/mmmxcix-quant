import { test } from "node:test";
import assert from "node:assert/strict";
import { excursionOrder, breakEvenOutcome, breakEvenStudy } from "../src/lib/argus/core.js";

// The whole reason these timestamps exist: without them a trade that RAN to
// +0.8R and reversed stores exactly the same pair of magnitudes as one that
// DIPPED to −0.8R and recovered. Every stop-management question — break-even
// stops, trailing, partial exits — is unanswerable until the order is known,
// and answering it wrongly is how a backtest flatters a stop rule.

const T = (o) => ({ riskAmt: 100, pnl: (o.R ?? 0) * 100, ...o });

test("the order of the extremes is read from the timestamps", () => {
  assert.equal(excursionOrder({ maxFavAt: 100, maxAdvAt: 200 }), "ran-first");
  assert.equal(excursionOrder({ maxFavAt: 300, maxAdvAt: 200 }), "dipped-first");
  assert.equal(excursionOrder({ maxFavAt: 200, maxAdvAt: 200 }), "same-bar");
  assert.equal(excursionOrder({}), "unknown", "trades from before the change stay unknown");
});

test("a loser that ran first would have been saved", () => {
  // Up 0.8R, then reversed through entry to a full stop.
  const t = T({ R: -1, maxFavR: 0.8, maxAdvR: 1.0, maxFavAt: 1000, maxAdvAt: 5000 });
  const o = breakEvenOutcome(t, { trigger: 0.5 });
  assert.equal(o.applies, true);
  assert.equal(o.before, -1);
  assert.equal(o.after, 0, "the stop was at entry by the time price came back");
  assert.equal(o.delta, 1);
});

test("a loser that dipped first is NOT credited to the rule", () => {
  // It reached +0.8R eventually, but its worst point came first — the stop was
  // still at its original level then, so break-even changes nothing. Counting
  // this one is the easy mistake that doubles the apparent benefit.
  const t = T({ R: -1, maxFavR: 0.8, maxAdvR: 1.0, maxFavAt: 5000, maxAdvAt: 1000 });
  const o = breakEvenOutcome(t, { trigger: 0.5 });
  assert.equal(o.applies, false);
  assert.match(o.why, /preceded/);
  assert.equal(o.delta, 0);
});

test("both extremes on one bar is excluded, not guessed", () => {
  // Intrabar we cannot know whether the high or the low came first. Assuming the
  // favourable one is exactly how a stop rule gets flattered.
  const t = T({ R: -1, maxFavR: 0.9, maxAdvR: 1.0, maxFavAt: 4000, maxAdvAt: 4000 });
  const o = breakEvenOutcome(t);
  assert.equal(o.applies, false);
  assert.match(o.why, /same-bar/);
});

test("a trade that never reached the trigger is untouched", () => {
  const t = T({ R: -1, maxFavR: 0.2, maxAdvR: 1.0, maxFavAt: 1000, maxAdvAt: 2000 });
  assert.equal(breakEvenOutcome(t, { trigger: 0.5 }).applies, false);
});

test("winners are not double-counted as saved", () => {
  const t = T({ R: 2.1, maxFavR: 2.3, maxAdvR: 0.3, maxFavAt: 9000, maxAdvAt: 1000 });
  const o = breakEvenOutcome(t);
  assert.equal(o.applies, false);
  assert.equal(o.after, 2.1, "a winner keeps its result");
});

test("the trigger level changes what qualifies", () => {
  const t = T({ R: -1, maxFavR: 0.6, maxAdvR: 1.0, maxFavAt: 1000, maxAdvAt: 5000 });
  assert.equal(breakEvenOutcome(t, { trigger: 0.5 }).applies, true);
  assert.equal(breakEvenOutcome(t, { trigger: 1.0 }).applies, false, "0.6R never armed a 1R trigger");
});

test("the study totals the effect and reports what it could not judge", () => {
  const ledger = [
    T({ R: -1, maxFavR: 0.8, maxAdvR: 1, maxFavAt: 1, maxAdvAt: 9 }),   // saved
    T({ R: -1, maxFavR: 0.8, maxAdvR: 1, maxFavAt: 9, maxAdvAt: 1 }),   // dipped first
    T({ R: -1, maxFavR: 0.9, maxAdvR: 1, maxFavAt: 5, maxAdvAt: 5 }),   // same bar
    T({ R: 2, maxFavR: 2.2, maxAdvR: 0.2, maxFavAt: 9, maxAdvAt: 1 }),  // winner
    T({ R: -1, maxFavR: 0.1, maxAdvR: 1 }),                             // never armed
  ];
  const s = breakEvenStudy(ledger, { trigger: 0.5 });
  assert.equal(s.n, 5);
  assert.equal(s.applied, 1, "only the run-then-reverse loser counts");
  assert.equal(s.undecidable, 1, "the same-bar trade is reported, not silently dropped");
  assert.equal(s.sumBefore, -2);
  assert.equal(s.sumAfter, -1);
  assert.equal(s.delta, 1);
});

test("a ledger with no timestamps yields no verdict at all", () => {
  // Every trade recorded before this instrumentation existed. The study must
  // report zero effect and flag them, not quietly imply the rule does nothing.
  const old = Array.from({ length: 20 }, () => T({ R: -1, maxFavR: 0.9, maxAdvR: 1 }));
  const s = breakEvenStudy(old);
  assert.equal(s.applied, 0);
  assert.equal(s.undecidable, 20, "all of them must be marked undecidable");
  assert.equal(s.delta, 0);
});
