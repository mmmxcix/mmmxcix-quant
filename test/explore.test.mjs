import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldExplore, exploreBudget, exploredToday, DEFAULT_MAX_TSTAT } from "../src/lib/argus/explore.js";

// The deadlock this breaks: a refusal removes the only evidence that could
// overturn it. On the live ledger six lessons covered the Asia session, New
// York and every flat-bias setup between them — 69 candidates considered, 100%
// refused, nothing opened for hours, and no new data to ever change that.

const refusal = (tStat, n = 20) => ({ skip: true, weakestSkip: { tStat, n }, reasons: ["x"] });

test("a marginal refusal is probed; a settled one is not", () => {
  // session:ny sat at t=-2.24 on a market that changes — worth re-testing.
  const marginal = shouldExplore(refusal(-2.24), { used: 0, budget: 3 });
  assert.equal(marginal.explore, true);
  assert.ok(marginal.sizeMult < 1, "a probe is not a conviction bet");
  // orb lost 9 of 9 at t=-4.8. There is nothing left to learn there.
  const settled = shouldExplore(refusal(-4.78), { used: 0, budget: 3 });
  assert.equal(settled.explore, false);
  assert.match(settled.reason, /settled/);
});

test("it spends the budget on the WEAKEST refusal, which is what adjustment reports", () => {
  // Both lessons refuse; the reported one must be the easier to overturn, or the
  // probe budget goes on confirming what is already known.
  const adj = { skip: true, weakestSkip: { tStat: -2.1, n: 30 } };
  assert.equal(shouldExplore(adj, { used: 0, budget: 3 }).explore, true);
});

test("the budget is finite and is respected", () => {
  assert.equal(shouldExplore(refusal(-2.1), { used: 3, budget: 3 }).explore, false);
  assert.match(shouldExplore(refusal(-2.1), { used: 3, budget: 3 }).reason, /budget spent/);
});

test("a small daily cap still leaves room for one probe", () => {
  // Flooring 2 x 0.25 gives zero, which would disable exploration silently on a
  // conservative pace setting — exactly when it is needed most.
  assert.equal(exploreBudget(2), 1);
  assert.equal(exploreBudget(12), 3);
  assert.equal(exploreBudget(0), 0, "…but not trading at all means not probing");
});

test("a trade that was not refused is never a probe", () => {
  assert.equal(shouldExplore({ skip: false }, { used: 0, budget: 3 }).explore, false);
  assert.equal(shouldExplore(null, { used: 0, budget: 3 }).explore, false);
});

test("a refusal with no lesson behind it is not probed", () => {
  const r = shouldExplore({ skip: true, weakestSkip: null }, { used: 0, budget: 3 });
  assert.equal(r.explore, false);
});

test("probes are counted from BOTH the ledger and open positions", () => {
  const day = Date.parse("2026-08-13T12:00:00Z");
  const t = (iso, explore) => ({ openedAt: Date.parse(iso), explore });
  const ledger = [t("2026-08-13T01:00:00Z", true), t("2026-08-13T02:00:00Z", false), t("2026-08-12T23:00:00Z", true)];
  const open = [t("2026-08-13T11:00:00Z", true)];
  assert.equal(exploredToday(ledger, open, day), 2, "one from the ledger today, one still open");
});

test("the settled threshold sits where the evidence stops being worth re-testing", () => {
  assert.ok(DEFAULT_MAX_TSTAT > 2, "must be past the refusal bar itself, or nothing is ever probed");
  assert.ok(DEFAULT_MAX_TSTAT < 5, "…and not so high that hopeless buckets keep being paid for");
});
