// Regression tests for the Argus day-trading core + scanners (Phase 0). Pure
// logic, run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sizePosition, fillPrice, openThesis, evaluateExit, ledgerStats } from "../src/lib/argus/core.js";
import { breakout, meanReversion, scan } from "../src/lib/argus/scanners.js";

const bar = (o, h, l, c, v = 1000, t = 0) => ({ time: t, open: o, high: h, low: l, close: c, volume: v });
// A flat range of `n` bars around `mid` with small wicks.
const flat = (n, mid, wick = 0.3) => Array.from({ length: n }, (_, i) => bar(mid, mid + wick, mid - wick, mid, 1000, i));

test("heat sizing: full base risk when empty, shrinks with open risk, null when full", () => {
  const eq = 10000;
  const a = sizePosition({ equity: eq, entry: 100, stop: 98, openRisk: 0 });      // 2% = $200 risk
  assert.ok(Math.abs(a.riskAmt - 200) < 1e-6, "first trade risks 2%");
  assert.ok(Math.abs(a.size - 100) < 1e-6, "size = 200/2");
  const b = sizePosition({ equity: eq, entry: 100, stop: 98, openRisk: 500 });    // heat 6%=600, room 100
  assert.ok(Math.abs(b.riskAmt - 100) < 1e-6, "late trade shrinks to remaining heat");
  const c = sizePosition({ equity: eq, entry: 100, stop: 98, openRisk: 600 });    // heat full
  assert.equal(c, null, "no room → null (park in watch-mode)");
});

test("fill price moves against the trader on entry and exit", () => {
  assert.ok(fillPrice(100, "long", "entry", "crypto") > 100, "long entry pays up");
  assert.ok(fillPrice(100, "long", "exit", "crypto") < 100, "long exit gets less");
  assert.ok(fillPrice(100, "short", "entry", "crypto") < 100, "short entry sells lower");
});

test("thesis: open, hit target → positive R; hit stop → −1R", () => {
  const setup = { symbol: "BTCUSDT", market: "crypto", side: "long", kind: "breakout", timeframe: "5m", entry: 100, stop: 98, target: 104, reason: "t" };
  const th = openThesis(setup, { equity: 10000, openRisk: 0, asset: "crypto", heatCap: 0.06, baseRiskPct: 0.02 });
  assert.equal(th.side, "long"); assert.ok(th.entry > 100 && th.entry < 101, "entry filled with slippage");
  const win = evaluateExit(th, bar(103, 105, 103, 104), { now: th.openedAt + 1000 });
  assert.equal(win.outcome, "target"); assert.ok(win.R > 1.5, "≈2R win after costs");
  const loss = evaluateExit(th, bar(99, 99.5, 97.5, 98), { now: th.openedAt + 1000 });
  assert.equal(loss.outcome, "stop"); assert.ok(loss.R < -0.9 && loss.R > -1.2, "≈−1R loss");
});

test("ledger stats aggregate win rate + R-expectancy", () => {
  const s = ledgerStats([{ pnl: 200, R: 2 }, { pnl: -100, R: -1 }, { pnl: -100, R: -1 }, { pnl: 300, R: 3 }]);
  assert.equal(s.n, 4); assert.equal(s.wins, 2); assert.equal(s.winRate, 0.5);
  assert.ok(Math.abs(s.avgR - 0.75) < 1e-9, "avg R = (2-1-1+3)/4");
});

test("breakout scanner triggers long above the range high, with stop<entry<target", () => {
  const candles = [...flat(40, 100), bar(100, 103.2, 100, 103)]; // close breaks the ~100.3 high
  const r = breakout(candles, { n: 20, atrPeriod: 14 });
  assert.ok(r && r.state === "triggered" && r.side === "long", "triggered long");
  assert.ok(r.stop < r.entry && r.entry < r.target, "coherent stop/entry/target");
});

test("mean-reversion fades a stretch far below VWAP", () => {
  const candles = [...flat(70, 100, 0.5), bar(100, 100, 96.5, 96.6)]; // ~7 ATR below VWAP
  const r = meanReversion(candles, { bars: 60, atrPeriod: 14, mult: 2.2 });
  assert.ok(r && r.side === "long" && r.kind === "mean-reversion", "long fade");
  assert.ok(r.target > r.entry && r.stop < r.entry, "target = mean, stop below");
});

test("scan gates trend setups by higher-timeframe bias", () => {
  // 1h uptrend, a fresh 5m breakout long → should pass the bias gate
  const up1h = Array.from({ length: 40 }, (_, i) => bar(100 + i, 100 + i + 0.5, 100 + i - 0.5, 100 + i, 1000, i));
  const c5 = [...flat(40, 130), bar(130, 133, 130, 132.8)];
  const out = scan({ c5, c15: c5, c1h: up1h });
  assert.equal(out.bias, "up");
  assert.ok(out.triggered.some((t) => t.side === "long"), "long breakout allowed in uptrend");
});

// ── Phase-1 foundation: alt-data briefing ───────────────────────────────────
import { decodeEntities, diffBrief, chokepointCongestion, summarizeConflicts } from "../src/lib/argus/brief.js";

test("decodeEntities cleans RSS headline entities", () => {
  assert.equal(decodeEntities("Tesla&#x2019;s Q2 &amp; the &#8212; drop"), "Tesla’s Q2 & the — drop");
});

test("diffBrief surfaces new headlines, hazards, conflict escalation", () => {
  const prev = { headlines: [{ title: "old" }], disasters: [{ name: "H1" }], conflicts: [{ country: "X", deaths: 100 }], chokepoints: {} };
  const cur = { headlines: [{ title: "old" }, { title: "NEW", source: "S" }], disasters: [{ name: "H1" }, { alert: "red", type: "flood", country: "Y", name: "H2" }], conflicts: [{ country: "X", deaths: 150 }], chokepoints: {} };
  const d = diffBrief(prev, cur);
  assert.ok(d.some((x) => x.kind === "news" && x.text.includes("NEW")), "new headline");
  assert.ok(d.some((x) => x.kind === "hazard" && x.text.includes("H2")), "new hazard");
  assert.ok(d.some((x) => x.kind === "conflict" && x.text.includes("X")), "conflict escalation +50");
});

test("chokepointCongestion counts vessels + anchored in the Hormuz box", () => {
  const ships = [[1, 26.0, 56.5, 0.2], [2, 26.5, 57.0, 8], [3, 0, 0, 5]]; // 2 in Hormuz, 1 anchored
  const cp = chokepointCongestion(ships);
  assert.equal(cp.hormuz.ships, 2); assert.equal(cp.hormuz.anchored, 1);
});

// ── Phase-1: event-channel LLM thesis parsing ───────────────────────────────
import { parseTheses } from "../src/lib/argus/llm.js";

test("parseTheses extracts a fenced JSON array, uppercases + clamps", () => {
  const reply = 'Here you go:\n```json\n[{"symbol":"uso","side":"long","thesis":"Refinery fire tightens gasoline supply","invalidation":"crack spreads roll over","confidence":1.7,"horizon":"2d","evidence":["fire at Gulf Coast refinery"]}]\n```';
  const t = parseTheses(reply);
  assert.equal(t.length, 1);
  assert.equal(t[0].symbol, "USO", "symbol uppercased");
  assert.equal(t[0].side, "long");
  assert.equal(t[0].confidence, 1, "confidence clamped to [0,1]");
  assert.equal(t[0].evidence.length, 1);
});

test("parseTheses tolerates prose around a bare array and drops malformed items", () => {
  const reply = 'I think:\n[{"symbol":"NVDA","side":"long","thesis":"x"},{"side":"short"},{"symbol":"SPY","side":"sideways"}]\nThat is all.';
  const t = parseTheses(reply);
  assert.equal(t.length, 1, "only the one well-formed thesis survives");
  assert.equal(t[0].symbol, "NVDA");
});

test("parseTheses caps at 3 and returns [] on non-JSON / empty", () => {
  const many = "[" + Array.from({ length: 6 }, (_, i) => `{"symbol":"T${i}","side":"long","thesis":"y"}`).join(",") + "]";
  assert.equal(parseTheses(many).length, 3, "capped at 3");
  assert.deepEqual(parseTheses("no trades today, market is quiet"), []);
  assert.deepEqual(parseTheses(""), []);
});
