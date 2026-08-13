import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveLessons, adjustment } from "../src/lib/argus/learn.js";

// The one durable edge in the live ledger was the LONDON SESSION — a clock-hour
// proxy for a market state the agent could not see. With the regime recorded on
// each thesis, "mean reversion works in a range and not in a trend" stops being
// an untestable hypothesis and becomes a bucket.

const mk = (regime, kind, R, i, side = "long") => ({
  state: "closed", kind, regime, symbol: "BTCUSDT", side,
  pnl: R * 100, riskAmt: 100, R, outcome: R > 0 ? "target" : "stop",
  openedAt: 1_700_000_000_000 + i * 3600e3,
});

// The same setup, profitable in a range and losing in a trend.
const book = [
  ...Array.from({ length: 20 }, (_, i) => mk("Range", "mean-reversion", i % 3 === 0 ? -1 : 1.1, i)),
  ...Array.from({ length: 20 }, (_, i) => mk("Bull", "mean-reversion", i % 5 === 0 ? 1.2 : -1, i + 20)),
];

test("the same setup is judged separately per regime", () => {
  const lessons = deriveLessons(book);
  const range = lessons.find((l) => JSON.stringify(l.dims) === '{"kind":"mean-reversion","regime":"Range"}');
  const bull = lessons.find((l) => JSON.stringify(l.dims) === '{"kind":"mean-reversion","regime":"Bull"}');
  assert.ok(range && bull, "both regime buckets must exist");
  assert.ok(range.expectancy > 0 && bull.expectancy < 0);
  assert.equal(range.action, "boost");
  assert.equal(bull.action, "suppress");
});

test("…and the agent acts differently in each", () => {
  const lessons = deriveLessons(book);
  const inRange = adjustment(lessons, { kind: "mean-reversion", regime: "Range" });
  const inBull = adjustment(lessons, { kind: "mean-reversion", regime: "Bull" });
  assert.equal(inRange.skip, false);
  assert.ok(inRange.mult > 1, "a regime where it works earns size");
  assert.equal(inBull.skip, true, "a regime where it is proven to lose is switched off");
});

test("pooling the regimes together hides the effect entirely", () => {
  // Why this dimension was worth adding: the combined book is roughly flat, so
  // without the regime the agent sees a mediocre setup and keeps trading it in
  // both states rather than one.
  const pooled = book.map(({ regime, ...t }) => t);
  const lessons = deriveLessons(pooled);
  const kindOnly = lessons.find((l) => JSON.stringify(l.dims) === '{"kind":"mean-reversion"}');
  assert.ok(Math.abs(kindOnly.expectancy) < 0.2, `pooled expectancy ${kindOnly.expectancy} looks unremarkable`);
  assert.equal(adjustment(lessons, { kind: "mean-reversion" }).skip, false);
});

test("theses recorded before regimes existed create no regime bucket", () => {
  // Backwards compatibility: the ledger is full of trades with no regime, and
  // they must not collapse into a single bogus "undefined regime" lesson.
  const old = Array.from({ length: 30 }, (_, i) => {
    const t = mk("Range", "breakout", -1, i);
    delete t.regime;
    return t;
  });
  const lessons = deriveLessons(old);
  assert.equal(lessons.some((l) => l.dims && "regime" in l.dims), false);
});

test("a setup with no regime is not matched by a regime lesson", () => {
  // If the regime cannot be determined (too little history), the trade must be
  // judged on its other dimensions rather than inheriting some regime's verdict.
  const lessons = deriveLessons(book);
  const noRegime = adjustment(lessons, { kind: "mean-reversion" });
  const inBull = adjustment(lessons, { kind: "mean-reversion", regime: "Bull" });
  assert.equal(noRegime.skip, false, "unknown regime must not inherit the Bull verdict");
  assert.equal(inBull.skip, true);
});
