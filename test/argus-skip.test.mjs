import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveLessons, adjustment } from "../src/lib/argus/learn.js";
import { ledgerStats } from "../src/lib/argus/core.js";

// The evidence-based skip (Aug 2026). The old rule was sample-blind: it needed
// expectancy ≤ −0.8R AND a ≥2-dimension bucket, so Argus's `breakout` setup ran
// 50 trades at a 10% win rate and −0.50R — a quarter of the account — without
// ever being switched off, while a 6-trade bucket at −0.85R would have been.
// A bucket now also skips when its mean R is negative with real confidence.

const trade = (kind, R, i, symbol = "BTCUSDT", side = "long") => ({
  kind, symbol, side, state: "closed",
  // ledgerStats derives R from pnl/riskAmt — give it a consistent pair.
  pnl: R * 100, riskAmt: 100, R,
  outcome: R > 0 ? "target" : "stop",
  openedAt: 1_700_000_000_000 + i * 3_600_000,
});

// 50 trades, 10% wins, mean ≈ −0.5R — the real breakout profile.
const bleeder = Array.from({ length: 50 }, (_, i) => trade("breakout", i % 10 === 0 ? 2.5 : -0.83, i));
// 60 clearly good trades, so the loser is 50/110 = 45% of the book and stays
// under the anti-freeze share (a bucket that IS the book may never skip).
const winner = Array.from({ length: 60 }, (_, i) => trade("liquidity-sweep", i % 3 === 0 ? -1 : 1.2, i));

test("a steadily bleeding setup is skipped on evidence, not on a fixed threshold", () => {
  const closed = [...bleeder, ...winner];
  const lessons = deriveLessons(closed, { minSample: 20 });
  const a = adjustment(lessons, { kind: "breakout", symbol: "BTCUSDT", side: "long" });
  assert.equal(a.skip, true, "50 trades at −0.5R must switch the setup off");
  // …and it is NOT because the old threshold fired: −0.5 never reaches −0.8.
  const les = lessons.find((l) => JSON.stringify(l.dims) === '{"kind":"breakout"}');
  assert.ok(les.expectancy > -0.8, `expectancy ${les.expectancy} should be above the old cut-off`);
  assert.ok(les.tStat <= -2, `t-stat ${les.tStat} should carry the decision`);
});

test("the profitable setup is untouched", () => {
  const lessons = deriveLessons([...bleeder, ...winner], { minSample: 20 });
  const a = adjustment(lessons, { kind: "liquidity-sweep", symbol: "BTCUSDT", side: "long" });
  assert.equal(a.skip, false);
});

test("a run of straight losses IS enough to switch a setup off", () => {
  // This test used to assert the opposite — that 8 losing trades were too few to
  // judge — and the live ledger showed what that cost: `orb` lost 9 out of 9 and
  // `vwap-band` 4 out of 4, together 67% of the account's entire loss out of 13
  // trades, and neither could ever be stopped because neither would reach the old
  // 25-trade bar. Sizing still needs a big sample; deciding a thing is broken
  // does not.
  const straight = Array.from({ length: 9 }, (_, i) => trade("orb", -1, i));
  const lessons = deriveLessons([...straight, ...winner]);
  const les = lessons.find((l) => JSON.stringify(l.dims) === '{"kind":"orb"}');
  assert.ok(les, "a 9-trade bucket must now produce a lesson");
  assert.ok(les.tStat <= -2, `t=${les.tStat?.toFixed(2)} should be decisive, and finite`);
  assert.ok(Number.isFinite(les.tStat), "…not the infinity a zero-variance bucket used to give");
  const a = adjustment(lessons, { kind: "orb", symbol: "BTCUSDT", side: "long" });
  assert.equal(a.skip, true, "9 straight full-stop losses must switch the setup off");
});

test("a handful of trades still cannot switch anything off", () => {
  // The other side of the same bar: 4 trades is genuinely too few, however ugly.
  const few = Array.from({ length: 4 }, (_, i) => trade("vwap-band", -1, i));
  const lessons = deriveLessons([...few, ...winner]);
  const a = adjustment(lessons, { kind: "vwap-band", symbol: "BTCUSDT", side: "long" });
  assert.equal(a.skip, false, "4 trades must not be enough to kill a setup");
});

test("a thin losing bucket does not move SIZE, only the skip decision", () => {
  // Sizing asks "how much smaller", which deserves a solid sample; skip asks "is
  // this broken at all", which is answerable sooner. A 9-trade bucket that is not
  // decisive enough to skip must leave the multiplier alone rather than nudging it
  // on nine trades' worth of noise.
  const mild = Array.from({ length: 9 }, (_, i) => trade("ifvg", i % 3 === 0 ? 1.0 : -0.5, i));
  const lessons = deriveLessons([...mild, ...winner]);
  const a = adjustment(lessons, { kind: "ifvg", symbol: "BTCUSDT", side: "long" });
  assert.equal(a.skip, false);
  const own = lessons.find((l) => JSON.stringify(l.dims) === '{"kind":"ifvg"}');
  assert.ok(own && own.n < 20, "the bucket is below the sizing sample");
  // Broad lessons on {symbol}/{side} may still move mult — what must not happen is
  // this 9-trade bucket doing it.
  const withoutThin = adjustment(lessons.filter((l) => l !== own), { kind: "ifvg", symbol: "BTCUSDT", side: "long" });
  assert.equal(a.mult, withoutThin.mult, "the thin bucket contributed nothing to sizing");
});

test("ANTI-FREEZE: a bucket covering most of the book can never skip", () => {
  // The failure the old ≥2-dimension rule was guarding against: learning its
  // way to trading nothing at all.
  const closed = Array.from({ length: 60 }, (_, i) => trade("breakout", i % 10 === 0 ? 2.5 : -0.83, i));
  const lessons = deriveLessons(closed, { minSample: 20 });
  const a = adjustment(lessons, { kind: "breakout", symbol: "BTCUSDT", side: "long" });
  assert.equal(a.skip, false, "a setup that IS the whole book must stay tradeable");
});

test("ledgerStats reports the dispersion the decision rests on", () => {
  const s = ledgerStats(bleeder);
  assert.ok(s.sdR > 0, "needs an R standard deviation");
  assert.ok(s.tStat < 0, "a losing bucket must have a negative t-stat");
  // A single trade cannot produce a t-statistic — must not be Infinity/NaN.
  const one = ledgerStats([trade("x", -1, 0)]);
  assert.equal(Number.isFinite(one.tStat), true);
  assert.equal(one.tStat, 0);
});
