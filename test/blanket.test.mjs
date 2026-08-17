import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveLessons, adjustment } from "../src/lib/argus/learn.js";

// The failure this guards against, taken from the live book on 16 Aug 2026.
//
// `bookShare` already refuses a skip from any single bucket covering most of
// the closed book. But the single-dimension views PARTITION the book, and a
// partition can close itself off one legal piece at a time: `bias` had exactly
// three values — up (37%), down (18%) and flat (45%) — each comfortably under
// the 50% cap, each with a t-stat past the evidence threshold, and between them
// covering 100% of every trade the agent could ever take. Every refusal was
// individually defensible. Together they meant "open nothing", which is exactly
// what the cap exists to prevent — and the escape hatch that was supposed to
// reopen it (explore.js) had never once produced a trade.
//
// `kind` and `symbol` are genuine selectors: refusing one leaves the others, so
// they keep their veto. `bias`, `side`, `session` and `source` are properties
// EVERY trade has, so closing all of their values closes the agent.

// Spread the book over many kinds/symbols so no kind- or symbol-shaped bucket
// reaches the 8-trade evidence floor. Only the whole-book dimensions aggregate
// far enough to produce a lesson, which is what isolates the guard under test.
const KINDS = ["breakout", "orb", "ifvg", "vwap-band", "mean-reversion", "liquidity-sweep",
  "trend-pullback", "range-fade", "gap-fill", "squeeze", "flag", "reversal"];
const SYMS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "LINKUSDT", "ADAUSDT", "DOGEUSDT",
  "XRPUSDT", "LTCUSDT", "BNBUSDT", "AVAXUSDT", "DOTUSDT", "ATOMUSDT"];

const mk = (bias, R, i) => ({
  state: "closed", kind: KINDS[i % KINDS.length], symbol: SYMS[i % SYMS.length],
  side: i % 2 ? "long" : "short", bias, regime: null,
  pnl: R * 100, riskAmt: 100, R, outcome: R > 0 ? "target" : "stop",
  openedAt: Date.UTC(2026, 7, 10, 9) + i * 3600e3,
});

const build = (spec) => spec.flatMap(([bias, n, winEvery, winR = 0.9], k) =>
  Array.from({ length: n }, (_, i) => mk(bias, i % winEvery === 0 ? winR : -1, i + k * 100)));

// Every bias value loses; none is more than half the book.
const losingEverywhere = build([["up", 25, 5], ["down", 18, 5], ["flat", 30, 5]]);

test("no single bias bucket is broad enough for the bookShare cap to catch it", () => {
  const lessons = deriveLessons(losingEverywhere, { minSample: 8 });
  const biases = lessons.filter((l) => Object.keys(l.dims).length === 1 && l.dims.bias);
  assert.equal(biases.length, 3, "all three bias values produce a lesson");
  for (const l of biases) {
    assert.ok(l.bookShare <= 0.5, `${l.dims.bias} covers ${(l.bookShare * 100).toFixed(0)}% — under the cap`);
    assert.ok((l.tStat ?? 0) <= -2, `${l.dims.bias} is a proven loser on its own numbers`);
  }
});

test("a dimension whose every value loses is marked, so the reason is visible", () => {
  const lessons = deriveLessons(losingEverywhere, { minSample: 8 });
  const biases = lessons.filter((l) => Object.keys(l.dims).length === 1 && l.dims.bias);
  assert.ok(biases.every((l) => l.blanket === true), "each bias lesson covers its whole dimension");
});

test("…and it shrinks size instead of vetoing the entry", () => {
  const lessons = deriveLessons(losingEverywhere, { minSample: 8 });
  for (const bias of ["up", "down", "flat"]) {
    const a = adjustment(lessons, { kind: "breakout", symbol: "BTCUSDT", side: "long", bias }, { minSample: 20 });
    assert.equal(a.skip, false, `bias=${bias} must not veto — every bias value losing is a SIZE verdict`);
    assert.ok(a.mult < 1, `bias=${bias} still sizes down`);
  }
});

test("the agent is left with somewhere to trade rather than nothing at all", () => {
  const lessons = deriveLessons(losingEverywhere, { minSample: 8 });
  let open = 0, total = 0;
  for (const kind of KINDS) for (const side of ["long", "short"]) for (const bias of ["up", "down", "flat"]) {
    total++;
    if (!adjustment(lessons, { kind, symbol: "BTCUSDT", side, bias }, { minSample: 20 }).skip) open++;
  }
  assert.ok(open > 0, "a fully-suppressed book must still leave an entry the agent can take");
  assert.equal(open, total, "…and with nothing setup-specific proven, none of them is vetoed");
});

// The guard must not become a licence for a genuinely broken bucket to keep
// trading: when only PART of a dimension is bad, that part keeps its veto.
const onlyUpIsBroken = build([["up", 25, 5, 0.9], ["down", 25, 3, 2.5], ["flat", 25, 3, 2.5]]);

test("a losing value inside an otherwise-healthy dimension is still switched off", () => {
  const lessons = deriveLessons(onlyUpIsBroken, { minSample: 8 });
  const up = lessons.find((l) => Object.keys(l.dims).length === 1 && l.dims.bias === "up");
  assert.ok(up && !up.blanket, "only one value is broken — the dimension is not blanket");
  assert.equal(adjustment(lessons, { kind: "breakout", symbol: "BTCUSDT", side: "long", bias: "up" }, { minSample: 20 }).skip,
    true, "the broken bias value keeps its veto");
  assert.equal(adjustment(lessons, { kind: "breakout", symbol: "BTCUSDT", side: "long", bias: "down" }, { minSample: 20 }).skip,
    false, "a profitable value is untouched");
});

test("a dimension with one observed value is left to the bookShare cap", () => {
  // Every trade here is `source: technical`, so "all its values lose" says
  // nothing about coverage — that case is what bookShare is for.
  const lessons = deriveLessons(losingEverywhere, { minSample: 8 });
  const source = lessons.find((l) => Object.keys(l.dims).length === 1 && l.dims.source);
  if (source) assert.ok(!source.blanket, "one-value dimensions are not blanket-marked");
});
