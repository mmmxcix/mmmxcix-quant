// The auto-progression brain — pins every decision the library engine makes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { progressEntry } from "../src/lib/progression.js";

const strong = { metrics: { sharpe: 1.4, profitFactor: 1.8, totalReturnPct: 120, tradeCount: 80, buyHoldSharpe: 0.6 }, windowProfile: { profile: "consistent", summary: "held throughout" } };
const dead = { metrics: { sharpe: -0.3, profitFactor: 0.7, totalReturnPct: -25, tradeCount: 40 } };
const decayed = { metrics: { sharpe: 1.0, profitFactor: 1.3, totalReturnPct: 60, tradeCount: 50, buyHoldSharpe: 0.5 }, windowProfile: { profile: "good-early", summary: "profitable early then decayed" } };
const marginal = { metrics: { sharpe: 0.4, profitFactor: 1.05, totalReturnPct: 15, tradeCount: 50, buyHoldSharpe: 0.3 }, windowProfile: { profile: "consistent", summary: "ok" } };

test("advances one rung when it clears the bar", () => {
  assert.equal(progressEntry({ status: "factory" }, strong).status, "validated");
  assert.equal(progressEntry({ status: "validated" }, strong).status, "paper");
  const top = progressEntry({ status: "paper" }, strong);
  assert.equal(top.status, "paper");
  assert.equal(top.changed, false, "paper + consistent stays put");
});

test("buries a dead strategy with a recorded reason", () => {
  const d = progressEntry({ status: "validated" }, dead);
  assert.equal(d.status, "graveyard");
  assert.equal(d.changed, true);
  assert.match(d.failureReason, /Buried on re-test/);
  assert.match(d.failureReason, /Sharpe -0\.30/);
});

test("degenerate trade count is buried even if 'profitable'", () => {
  const d = progressEntry({ status: "factory" }, { metrics: { sharpe: 2, profitFactor: 3, totalReturnPct: 50, tradeCount: 4 } });
  assert.equal(d.status, "graveyard");
});

test("a time-window flaw sidelines to improve and keeps the shape", () => {
  const r = progressEntry({ status: "factory" }, decayed);
  assert.equal(r.status, "improve");
  assert.match(r.failureReason, /decayed/);
  assert.equal(r.reason, "window:good-early");
});

test("a mild flaw does NOT demote a paper strategy", () => {
  const r = progressEntry({ status: "paper" }, decayed);
  assert.equal(r.status, "paper", "paper is not demoted for a window flaw");
});

test("a recovered improve strategy goes back into the pipeline", () => {
  const r = progressEntry({ status: "improve" }, strong);
  assert.equal(r.status, "factory");
  assert.equal(r.reason, "recovered");
  assert.equal(r.failureReason, null);
});

test("profitable-but-marginal holds where it is", () => {
  const r = progressEntry({ status: "validated" }, marginal);
  assert.equal(r.status, "validated");
  assert.equal(r.changed, false);
});

test("no result leaves the entry untouched", () => {
  const r = progressEntry({ status: "paper", failureReason: null }, {});
  assert.equal(r.status, "paper");
  assert.equal(r.changed, false);
});
