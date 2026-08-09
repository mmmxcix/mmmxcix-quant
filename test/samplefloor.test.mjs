import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeMetrics } from "../src/lib/profiles.js";
import { progressEntry } from "../src/lib/progression.js";

// Aug 2026 sample-size calibration: per-market floors 100 (prop) / 80
// (private), a 300-trade POOLED floor across markets, and a Sharpe bar that
// tiers up on thin samples (t-stat ≈ SR·√n — few trades must convince harder).

// A per-market metrics row that clears every private structural bar on its own.
const m = (n) => ({
  tradeCount: n, spanYears: 10, tradesPerYear: n / 10,
  totalReturnPct: 100, profitFactor: 1.5, maxDrawdownPct: 20,
});

test("pooled floor: three clean markets at 90 trades each (270 total) fail private", () => {
  const perSet = [1, 2, 3].map((i) => ({ name: `mkt${i}`, m: m(90) }));
  const r = judgeMetrics({ profileId: "private", perSet });
  assert.equal(r.pass, false);
  assert.match(r.reason, /pooled/);
});

test("pooled floor: four markets at 90 trades (360 total) pass private", () => {
  const perSet = [1, 2, 3, 4].map((i) => ({ name: `mkt${i}`, m: m(90) }));
  assert.equal(judgeMetrics({ profileId: "private", perSet }).pass, true);
});

test("a SINGLE market set is never tripped by the pooled floor (per-market callers)", () => {
  assert.equal(judgeMetrics({ profileId: "private", perSet: [{ name: "solo", m: m(120) }] }).pass, true);
});

test("per-market floors: 90 trades clears private (80) but fails prop (100)", () => {
  const solo = [{ name: "solo", m: m(90) }];
  assert.equal(judgeMetrics({ profileId: "private", perSet: solo }).pass, true);
  const prop = judgeMetrics({ profileId: "prop", perSet: solo });
  assert.equal(prop.pass, false);
  assert.match(prop.reason, /90 trades/);
});

// ── Sharpe tiers in the library progression ─────────────────────────────────

const retest = (tradeCount, sharpe) => ({
  metrics: { sharpe, profitFactor: 1.6, totalReturnPct: 80, tradeCount, buyHoldSharpe: 0.4 },
  windowProfile: { profile: "consistent", summary: "held" },
});

test("thin sample (under 150 trades) needs Sharpe 1.2 to advance", () => {
  assert.equal(progressEntry({ status: "factory" }, retest(120, 1.1)).changed, false, "1.1 is not enough at 120 trades");
  assert.equal(progressEntry({ status: "factory" }, retest(120, 1.25)).status, "validated");
});

test("medium sample (150-299 trades) needs Sharpe 1.0", () => {
  assert.equal(progressEntry({ status: "factory" }, retest(200, 0.9)).changed, false);
  assert.equal(progressEntry({ status: "factory" }, retest(200, 1.05)).status, "validated");
});

test("full sample (300+ trades) advances at the base 0.8 bar", () => {
  assert.equal(progressEntry({ status: "factory" }, retest(320, 0.85)).status, "validated");
});

test("below the 100-trade advancement floor a profitable strategy holds, is not buried", () => {
  const r = progressEntry({ status: "factory" }, retest(60, 1.5));
  assert.equal(r.status, "factory", "held in place, not advanced");
  assert.equal(r.changed, false);
});
