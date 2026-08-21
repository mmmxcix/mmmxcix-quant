import { test } from "node:test";
import assert from "node:assert/strict";
import { judgePooled, qualifyPooledAll, PROFILES } from "../src/lib/profiles.js";
import { progressEntry } from "../src/lib/progression.js";

// A pooled record that clears both profiles comfortably.
const good = {
  sharpe: 0.55, pf: 1.2, ddPct: 10, trades: 480, tradesPerYear: 48, obsDays: 2400,
};
const withOut = (over) => ({ ...good, ...over });

test("a realistic pooled rule (Sharpe 0.55) qualifies — the whole point of Tier 1", () => {
  const { qualified } = qualifyPooledAll({ pooled: good, dsrPct: 99 });
  assert.deepEqual(qualified.sort(), ["private", "prop"]);
});

test("the pooled Sharpe floor is 0.30, not 1.0 — the old wall is gone", () => {
  assert.equal(PROFILES.private.validation.pooled.minSharpe, 0.3);
  assert.equal(PROFILES.prop.validation.pooled.minSharpe, 0.3);
  const r = judgePooled({ profileId: "private", pooled: withOut({ sharpe: 0.29 }), dsrPct: 99 });
  assert.equal(r.pass, false);
  assert.match(r.reason, /pooled Sharpe 0\.29 < 0\.3/);
  assert.equal(judgePooled({ profileId: "private", pooled: withOut({ sharpe: 0.31 }), dsrPct: 99 }).pass, true);
});

test("each pooled bar names its own concrete failure", () => {
  const cases = [
    [{ obsDays: 100 }, /pooled daily observations/],
    [{ trades: 120 }, /trades pooled across all markets/],
    [{ tradesPerYear: 3 }, /pooled trades\/yr/],
    [{ pf: 1.0 }, /pooled PF/],
    [{ ddPct: 55 }, /pooled drawdown/],
  ];
  for (const [over, re] of cases) {
    const r = judgePooled({ profileId: "private", pooled: withOut(over), dsrPct: 99 });
    assert.equal(r.pass, false, `${JSON.stringify(over)} should fail`);
    assert.match(r.reason, re);
  }
});

test("prop's shallower pooled drawdown ceiling separates the two books", () => {
  const deep = withOut({ ddPct: 20 }); // > prop 12, < private 30
  assert.equal(judgePooled({ profileId: "prop", pooled: deep, dsrPct: 99 }).pass, false);
  assert.equal(judgePooled({ profileId: "private", pooled: deep, dsrPct: 99 }).pass, true);
});

test("DSR still gates the pooled verdict", () => {
  const r = judgePooled({ profileId: "prop", pooled: good, dsrPct: 40 }); // prop needs 70
  assert.equal(r.pass, false);
  assert.match(r.reason, /DSR .* \(pooled\)/);
});

test("the revalidator's softer floor comes through overrides, not a code fork", () => {
  const marginal = withOut({ sharpe: 0.27 });
  assert.equal(judgePooled({ profileId: "private", pooled: marginal, dsrPct: 99 }).pass, false);
  assert.equal(
    judgePooled({ profileId: "private", pooled: marginal, dsrPct: 99, overrides: { minSharpe: 0.25 } }).pass,
    true
  );
});

// ── the library police must not bury a pooled rule's leg ─────────────────────
const legRetest = (over = {}) => ({
  metrics: {
    sharpe: 0.45, profitFactor: 1.1, totalReturnPct: 30, tradeCount: 60,
    spanYears: 10, tradesPerYear: 6, buyHoldSharpe: 0.9, maxDrawdownPct: 20, ...over,
  },
});

test("an ensemble leg is judged on its RULE's pooled record, not its own Sharpe", () => {
  // This leg would fail the standalone bar on every count (Sharpe 0.45 < 1.2 at
  // 60 trades, 6 trades/yr, loses to buy&hold) — as a pooled leg it advances.
  const leg = { status: "validated", ensembleRule: "rc_1", pooled: { sharpe: 0.55, pf: 1.2, trades: 480 } };
  const r = progressEntry(leg, legRetest());
  assert.equal(r.status, "paper");
  assert.equal(r.reason, "pooled rule clears");

  const standalone = progressEntry({ status: "validated" }, legRetest());
  assert.notEqual(standalone.status, "paper"); // same numbers, no pooled record → not promoted
});

test("a leg that stopped trading is sidelined, not buried — the rule may be fine", () => {
  const leg = { status: "paper", ensembleRule: "rc_1", pooled: { sharpe: 0.55, pf: 1.2, trades: 480 } };
  const r = progressEntry(leg, legRetest({ tradeCount: 2 }));
  assert.equal(r.status, "improve");
  assert.match(r.failureReason, /went quiet/);
});

test("a leg whose POOLED record failed is buried", () => {
  const leg = { status: "paper", ensembleRule: "rc_1", pooled: { sharpe: -0.2, pf: 0.8, trades: 480 } };
  assert.equal(progressEntry(leg, legRetest()).status, "graveyard");
});

test("a pooled record below the floor holds the leg without burying it", () => {
  const leg = { status: "paper", ensembleRule: "rc_1", pooled: { sharpe: 0.15, pf: 1.05, trades: 480 } };
  const r = progressEntry(leg, legRetest());
  assert.equal(r.changed, false);
  assert.match(r.failureReason, /improve the RULE, not this leg/);
});

test("a losing leg of a healthy rule survives — diversification is allowed to hurt somewhere", () => {
  const leg = { status: "paper", ensembleRule: "rc_1", pooled: { sharpe: 0.55, pf: 1.2, trades: 480 } };
  const r = progressEntry(leg, legRetest({ totalReturnPct: -8, sharpe: -0.1 }));
  assert.notEqual(r.status, "graveyard");
  // …while the same leg WITHOUT a pooled record is buried by the standalone rule
  assert.equal(progressEntry({ status: "paper" }, legRetest({ totalReturnPct: -8, sharpe: -0.1 })).status, "graveyard");
});

test("non-ensemble entries keep the old standalone behaviour exactly", () => {
  const strong = { metrics: { sharpe: 1.4, profitFactor: 1.6, totalReturnPct: 120, tradeCount: 320, spanYears: 10, tradesPerYear: 32 } };
  assert.equal(progressEntry({ status: "factory" }, strong).status, "validated");
});
