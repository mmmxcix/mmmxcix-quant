// The event channel as a TRADE source, not a bias. Everything here pins the gap
// the live ledger exposed: 47 closed trades, all of them source "technical",
// none "event" — the differentiator in the design had never once been measured.
import test from "node:test";
import assert from "node:assert/strict";

import { eventSetup, DEFAULT_MAX_AGE_MS } from "../src/lib/argus/eventTrade.js";
import { openThesis, plannedRR } from "../src/lib/argus/core.js";
import { summarizeLedger } from "../src/lib/argus/learn.js";

const bar = (o, h, l, c, v = 1000, t = 0) => ({ time: t, open: o, high: h, low: l, close: c, volume: v });
// A series with real range, so ATR is non-degenerate.
const series = (n = 60, mid = 100, range = 1) =>
  Array.from({ length: n }, (_, i) => bar(mid, mid + range, mid - range, mid, 1000, i * 900));

const NOW = Date.parse("2026-08-26T13:00:00Z");
const catalystBias = (over = {}) => ({
  side: "long", thesis: "Refinery fire removes 4% of regional capacity",
  invalidation: "Operator confirms restart within 48h",
  confidence: 0.82, horizon: "2d", evidence: ["Reuters", "NASA FIRMS hotspot"],
  at: NOW, model: "test/model", ...over,
});

test("a confident, fresh catalyst becomes a risk-defined setup", () => {
  const s = eventSetup(catalystBias(), series(), { now: NOW });
  assert.ok(s, "the setup exists");
  assert.equal(s.kind, "event");
  assert.equal(s.side, "long");
  assert.ok(s.stop < s.entry && s.target > s.entry, "coherent levels");
  // The target is a fixed multiple of the risk, not a level pulled from a chart
  // the catalyst never referenced.
  assert.ok(Math.abs(plannedRR("long", s.entry, s.stop, s.target) - 2.5) < 1e-6);
  assert.ok(s.catalyst && s.catalyst.thesis.startsWith("Refinery fire"));
  assert.equal(s.invalidation, null, "a catalyst's invalidation is a sentence, never an invented price");
});

test("the confidence bar and the freshness bar both refuse", () => {
  assert.equal(eventSetup(catalystBias({ confidence: 0.6 }), series(), { now: NOW }), null, "low confidence");
  assert.equal(eventSetup(catalystBias({ at: NOW - DEFAULT_MAX_AGE_MS - 1 }), series(), { now: NOW }), null, "stale catalyst");
  assert.equal(eventSetup(catalystBias({ side: "sideways" }), series(), { now: NOW }), null, "no tradable side");
  assert.equal(eventSetup(null, series(), { now: NOW }), null, "no catalyst at all");
});

test("a degenerate series never reaches sizing", () => {
  // A frozen or gapped feed produces an ATR of zero: the resulting "stop" would
  // sit inside the spread and the position size would explode.
  const frozen = Array.from({ length: 60 }, (_, i) => bar(100, 100, 100, 100, 1000, i * 900));
  assert.equal(eventSetup(catalystBias(), frozen, { now: NOW }), null);
  assert.equal(eventSetup(catalystBias(), series(5), { now: NOW }), null, "too little history");
});

test("a short catalyst mirrors the levels", () => {
  const s = eventSetup(catalystBias({ side: "short" }), series(), { now: NOW });
  assert.ok(s.stop > s.entry && s.target < s.entry);
  assert.ok(Math.abs(plannedRR("short", s.entry, s.stop, s.target) - 2.5) < 1e-6);
});

test("the stamp lets the staleness gate judge a catalyst like any other setup", () => {
  const c = series();
  const s = eventSetup(catalystBias(), c, { now: NOW, timeframe: "15m" });
  assert.equal(s.barMs, 900_000);
  assert.equal(s.signalBarMs, (c[c.length - 1].time + 900) * 1000);
});

test("the trade reaches the ledger tagged as an EVENT, not as technical", () => {
  const s = eventSetup(catalystBias(), series(), { now: NOW });
  const th = openThesis({ ...s, symbol: "USO", market: "stock", conviction: 0.8 }, {
    equity: 10_000, openRisk: 0, asset: "stock", heatCap: 0.1,
    baseRiskPct: 0.0035, maxTradeLev: 25, portfolioLevCap: 50, now: NOW,
  });
  assert.ok(th, "the thesis opens");
  // The whitelist in openThesis is what killed `explore` and `regime` before —
  // a field that is not named there dies silently at open.
  assert.ok(th.catalyst, "catalyst survived openThesis's whitelist");
  assert.equal(th.catalyst.model, "test/model");

  const closed = { ...th, state: "closed", pnl: 42, R: 1.2, exitAt: NOW + 3600_000, outcome: "target" };
  const buckets = summarizeLedger([closed]);
  assert.equal(buckets.source.event?.n, 1,
    "the learning loop can now grade the catalyst channel on its own record");
  assert.equal(buckets.source.technical, undefined);
});

test("a technical setup is still technical — the tag is not accidentally universal", () => {
  const th = openThesis(
    { symbol: "SPY", market: "etf", side: "long", kind: "breakout", timeframe: "15m",
      entry: 100, stop: 99, target: 103, reason: "broke the range" },
    { equity: 10_000, openRisk: 0, asset: "etf", heatCap: 0.1, baseRiskPct: 0.0035,
      maxTradeLev: 25, portfolioLevCap: 50, conviction: 0.6, now: NOW });
  assert.ok(th);
  assert.equal(th.catalyst, null);
  const closed = { ...th, state: "closed", pnl: -10, R: -1, exitAt: NOW + 1000, outcome: "stop" };
  assert.equal(summarizeLedger([closed]).source.technical?.n, 1);
  assert.equal(summarizeLedger([closed]).source.event, undefined);
});
