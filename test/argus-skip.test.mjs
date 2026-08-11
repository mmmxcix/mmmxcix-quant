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

test("a small sample yields no verdict at all", () => {
  // 8 trades, every one a loser — uglier than the bleeder on the surface, but
  // far too few to judge. Below minSample no lesson is even created, so the
  // setup is neither skipped nor resized. This is what stops the agent from
  // reacting to a bad afternoon.
  const tiny = Array.from({ length: 8 }, (_, i) => trade("orb", -1, i));
  const lessons = deriveLessons([...tiny, ...winner]); // default minSample = 20
  assert.equal(lessons.some((l) => l.dims?.kind === "orb"), false, "no lesson below minSample");
  const a = adjustment(lessons, { kind: "orb", symbol: "BTCUSDT", side: "long" });
  assert.equal(a.skip, false, "8 trades must not be enough to kill a setup");
  // NOTE: a.mult may still move — broad lessons on {symbol} / {side} legitimately
  // apply to this setup. What must never happen is the SETUP ITSELF being judged
  // on 8 trades.
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
