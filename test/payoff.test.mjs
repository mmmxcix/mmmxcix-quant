// payoff.js — reading the payoff SHAPE off a strategy's record, and building a
// set out of shapes instead of out of scores.
import test from "node:test";
import assert from "node:assert/strict";
import {
  payoffProfile, familyMix, selectComplementary, FAMILY_META, MIN_TRADES_FOR_FAMILY,
} from "../src/lib/payoff.js";

// Build metrics with a KNOWN payoff ratio, the way a backtest would report them:
// PF = (w·avgWin)/((1−w)·avgLoss), so PF = k·w/(1−w).
const metricsFor = (winRatePct, k, tradeCount = 60) => {
  const w = winRatePct / 100;
  return { winRatePct, profitFactor: (k * w) / (1 - w), tradeCount, sharpe: 1 };
};

test("the payoff ratio is recovered from win rate and profit factor", () => {
  const p = payoffProfile(metricsFor(40, 2.5));
  assert.equal(p.payoffRatio, 2.5);
  // At 40% wins you need to make 1.5× your loss just to stand still.
  assert.equal(p.breakEvenRatio, 1.5);
  assert.equal(p.edge, 1);
});

test("the three shapes are recognised, and the corners stay apart", () => {
  assert.equal(payoffProfile(metricsFor(35, 2.2)).family, "momentum");
  assert.equal(payoffProfile(metricsFor(65, 0.8)).family, "reversion");
  assert.equal(payoffProfile(metricsFor(85, 0.35)).family, "carry");
  // Carry is the extreme corner of "wins often": a 60% winner is not carry.
  assert.equal(payoffProfile(metricsFor(60, 0.4)).family, "reversion");
  // Nothing distinctive → mixed, not forced into a box.
  assert.equal(payoffProfile(metricsFor(50, 1.3)).family, "mixed");
});

test("a shape is not read off a handful of trades", () => {
  const few = payoffProfile(metricsFor(85, 0.35, MIN_TRADES_FOR_FAMILY - 1));
  assert.equal(few.family, "unknown");
  assert.equal(few.sure, false);
  // The arithmetic is still reported — only the label is withheld.
  assert.equal(few.payoffRatio, 0.35);
  assert.equal(payoffProfile(metricsFor(85, 0.35, MIN_TRADES_FOR_FAMILY)).family, "carry");
  assert.equal(payoffProfile(null).family, "unknown");
  assert.equal(payoffProfile({ winRatePct: 60 }).trades, 0);
});

test("degenerate records do not produce confident numbers", () => {
  const perfect = payoffProfile({ winRatePct: 100, profitFactor: Infinity, tradeCount: 50 });
  assert.equal(perfect.payoffRatio, Infinity);
  assert.equal(perfect.edge, null, "no finite edge can be quoted from a perfect record");
  const hopeless = payoffProfile({ winRatePct: 0, profitFactor: 0, tradeCount: 50 });
  assert.equal(hopeless.payoffRatio, 0);
});

test("a library of one shape is called out", () => {
  const rev = (i) => ({ id: `r${i}`, metrics: metricsFor(65, 0.8) });
  const one = familyMix([rev(1), rev(2), rev(3)]);
  assert.equal(one.shapes, 1);
  assert.match(one.warning, /mean reversion/i);
  assert.match(one.warning, /bad day together/);
  const mixed = familyMix([rev(1), rev(2), { id: "m", metrics: metricsFor(35, 2.2) }]);
  assert.equal(mixed.shapes, 2);
  assert.equal(mixed.warning, null);
});

// ── selection ───────────────────────────────────────────────────────────────
/** A return series that is either a fixed pattern or its mirror image. */
const series = (pattern, days = 40) =>
  Array.from({ length: days }, (_, d) => ({ d, r: pattern[d % pattern.length] }));

test("the set starts with the best and then buys what it is missing", () => {
  const up = [0.01, -0.005, 0.008, -0.002];
  const entries = [
    // Best Sharpe, but the next-best is its near-twin: same shape, same days.
    { id: "a", name: "A", status: "validated", metrics: { ...metricsFor(65, 0.8), sharpe: 2.0 }, returnSeries: series(up) },
    { id: "b", name: "B", status: "validated", metrics: { ...metricsFor(65, 0.8), sharpe: 1.9 }, returnSeries: series(up) },
    // Weaker on its own, but a different shape moving the other way.
    { id: "c", name: "C", status: "validated", metrics: { ...metricsFor(35, 2.2), sharpe: 1.2 }, returnSeries: series(up.map((v) => -v)) },
  ];
  const { picked } = selectComplementary(entries, { max: 2 });
  assert.equal(picked[0].entry.id, "a", "highest Sharpe opens the set");
  assert.equal(picked[1].entry.id, "c", "the twin is passed over for the diversifier");
  assert.match(picked[1].reason, /momentum/i);
  assert.equal(picked[0].maxCorr, null, "nothing to correlate the first pick against");
});

test("selection respects the cap, skips the graveyard, and reports the mix", () => {
  const mk = (id, sharpe, wr, k) => ({
    id, name: id, status: "validated", metrics: { ...metricsFor(wr, k), sharpe },
    returnSeries: series([0.01 * sharpe, -0.004, 0.002, 0.001 * sharpe]),
  });
  const entries = [mk("a", 2, 65, 0.8), mk("b", 1.5, 35, 2.2), mk("c", 1.2, 85, 0.35),
    { ...mk("dead", 9, 65, 0.8), status: "graveyard" }];
  const res = selectComplementary(entries, { max: 3 });
  assert.equal(res.picked.length, 3);
  assert.ok(!res.picked.some((p) => p.entry.id === "dead"), "a buried strategy is never suggested");
  assert.equal(res.mix.shapes, 3, "one of each shape");
  assert.deepEqual(new Set(res.picked.map((p) => p.family)), new Set(["reversion", "momentum", "carry"]));
  assert.ok(Object.keys(FAMILY_META).every((f) => FAMILY_META[f].risk));
});

test("an empty library selects nothing rather than inventing something", () => {
  assert.deepEqual(selectComplementary([]).picked, []);
  assert.deepEqual(selectComplementary(null).picked, []);
});
