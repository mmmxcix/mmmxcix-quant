import { test } from "node:test";
import assert from "node:assert/strict";
import { decayWeight, weightedLedgerStats, ledgerStats } from "../src/lib/argus/core.js";
import { deriveLessons } from "../src/lib/argus/learn.js";

// Recency weighting exists because the walk-forward harness caught the loop
// never forgetting: a setup that wins sixty trades and then loses sixty straight
// full-stops still reads +0.1R. The weighting is shipped OFF — see the last test
// for why the half-life could not be chosen from the data we have.

const H = 3600e3;
const T = (R, ageH) => ({
  state: "closed", kind: "breakout", symbol: "BTCUSDT", side: "long",
  R, pnl: R * 100, riskAmt: 100, outcome: R > 0 ? "target" : "stop",
  openedAt: -ageH * H, exitAt: -ageH * H,
});

test("a trade one half-life old counts half as much", () => {
  assert.equal(decayWeight({ exitAt: 0 }, 0, 24 * H), 1);
  assert.ok(Math.abs(decayWeight({ exitAt: 0 }, 24 * H, 24 * H) - 0.5) < 1e-12);
  assert.ok(Math.abs(decayWeight({ exitAt: 0 }, 48 * H, 24 * H) - 0.25) < 1e-12);
});

test("no half-life means no decay at all — the old behaviour, exactly", () => {
  const led = [T(1.2, 0), T(-1, 100), T(-1, 500)];
  for (const hl of [0, undefined, Infinity, -5]) {
    assert.equal(decayWeight(led[2], 0, hl), 1);
  }
  const plain = ledgerStats(led);
  const weighted = weightedLedgerStats(led, { halfLifeMs: 0, now: 0 });
  assert.deepEqual(weighted, plain, "it must return the identical object, not merely a close one");
});

test("THE BUG IT FIXES: sixty wins then sixty losses stops reading positive", () => {
  const led = [
    ...Array.from({ length: 60 }, (_, i) => T(1.2, 120 - i)),   // the distant past
    ...Array.from({ length: 60 }, (_, i) => T(-1, 60 - i)),     // the recent past
  ];
  const plain = ledgerStats(led);
  assert.ok(plain.avgR > 0, `unweighted still reads ${plain.avgR.toFixed(2)}R — the setup looks fine`);
  const recent = weightedLedgerStats(led, { halfLifeMs: 24 * H, now: 0 });
  assert.ok(recent.avgR < -0.5, `weighted reads ${recent.avgR.toFixed(2)}R — the setup is broken`);
});

test("effective sample size stops a stale history from posing as evidence", () => {
  // Kish's n_eff. A thousand heavily discounted trades are not a thousand
  // trades, and the skip gates are all expressed in n.
  const equal = Array.from({ length: 40 }, () => T(-1, 0));
  const eq = weightedLedgerStats(equal, { halfLifeMs: 24 * H, now: 0 });
  assert.ok(Math.abs(eq.n - 40) < 1e-9, "equal weights must give back exactly n");

  const stale = Array.from({ length: 200 }, (_, i) => T(-1, i * 24));  // one half-life apart
  const st = weightedLedgerStats(stale, { halfLifeMs: 24 * H, now: 0 });
  assert.ok(st.n < 5, `200 stale trades count as ${st.n.toFixed(1)} — not 200`);
  assert.equal(st.rawN, 200, "…and the raw count is still reported");
});

test("money is never discounted, only evidence is", () => {
  const led = [T(1.2, 0), T(-1, 500)];
  const w = weightedLedgerStats(led, { halfLifeMs: 24 * H, now: 0 });
  assert.equal(w.pnl, ledgerStats(led).pnl, "P&L is what happened, whenever it happened");
});

test("deriveLessons decays relative to the ledger, not to today", () => {
  // Replaying a historical ledger must not discount the whole thing to nothing
  // just because it is old.
  const led = Array.from({ length: 30 }, (_, i) => T(-1, 30 - i));
  const lessons = deriveLessons(led, { halfLifeMs: 24 * H });
  const l = lessons.find((x) => JSON.stringify(x.dims) === '{"kind":"breakout"}');
  assert.ok(l, "a lesson must still be produced");
  assert.ok(l.n > 5, `effective n ${l.n} — an old ledger must not vanish`);
});

test("WHY IT SHIPS OFF: the half-life cannot be chosen from a 1.6-day ledger", () => {
  // Swept against the live ledger, every half-life of 2 days or more gave an
  // identical result (edge 0.070R, 21% refused) because the whole book spans
  // 1.6 days and nothing decays. The only ones that changed anything were
  // SHORTER than the data, and both did worse: 12h → 0.022R, 1d → 0.055R.
  // So the default is no decay, and this test states the condition for revisiting.
  const spanDays = 1.6;
  const shortestUsefulHalfLife = 2;
  assert.ok(spanDays < shortestUsefulHalfLife,
    "once the ledger spans several half-lives, re-run the sweep and set LAB_ARGUS_HALFLIFE_H");
});
