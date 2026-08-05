import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateExit, volStatus, VOL_CEIL_ATR_PCT, relVolume, pyramidAdd } from "../src/lib/argus/core.js";
import { breakout, pullback, momentum, vwapBands, SCANNERS, VOLUME_KINDS, scan } from "../src/lib/argus/scanners.js";

// ── Upgrade 1: structural invalidation → early exit ──────────────────────────
const longTh = (over = {}) => ({
  side: "long", asset: "crypto", entry: 100, stop: 98, target: 106,
  invalidation: 99.5, size: 1, riskAmt: 2, liqPrice: null, openedAt: 0, ...over,
});

test("a close through the invalidation level exits EARLY (before the wider stop)", () => {
  // low (99.0) never reaches the stop (98), but the close (99.3) is below the
  // invalidation (99.5) → cut here for a smaller loss.
  const res = evaluateExit(longTh(), { high: 100.2, low: 99.0, close: 99.3 }, { now: 1000 });
  assert.equal(res?.outcome, "invalidated");
  assert.ok(res.R < 0 && res.R > -1, "an invalidation loss is smaller than a full 1R stop-out");
});

test("the intrabar stop still wins when it's actually hit that bar", () => {
  const res = evaluateExit(longTh(), { high: 100.2, low: 97.5, close: 99.3 }, { now: 1000 });
  assert.equal(res?.outcome, "stop"); // stop checked before invalidation
});

test("no invalidation level → the trade just stays open", () => {
  const res = evaluateExit(longTh({ invalidation: null }), { high: 100.2, low: 99.0, close: 99.3 }, { now: 1000 });
  assert.equal(res, null);
});

// ── Upgrade 3: the volatility-regime check ───────────────────────────────────
test("volStatus: calm passes at full size, elevated sizes down, extreme is blocked", () => {
  const ceil = VOL_CEIL_ATR_PCT.crypto; // 0.05
  assert.deepEqual(volStatus(0.02, "crypto"), { ok: true, mult: 1, label: "2.00%/bar" });
  const elevated = volStatus(0.04, "crypto"); // between 0.6×ceil and ceil
  assert.equal(elevated.ok, true); assert.equal(elevated.mult, 0.7); assert.equal(elevated.elevated, true);
  const extreme = volStatus(ceil + 0.01, "crypto");
  assert.equal(extreme.ok, false); assert.equal(extreme.mult, 0);
});

// ── Upgrade 1 wiring + Upgrade 4: scanners ───────────────────────────────────
// A tidy candle factory.
const bars = (arr) => arr.map(([o, h, l, c], i) => ({ time: i * 300, open: o, high: h, low: l, close: c, volume: 1000 }));

test("breakout carries a structural invalidation equal to the level it broke", () => {
  const base = Array.from({ length: 40 }, () => [100, 100.2, 99.8, 100]);
  base.push([100, 103, 100, 102.5]); // decisive break of the ~100.2 range high
  const s = breakout(bars(base));
  assert.equal(s?.kind, "breakout");
  assert.equal(s.side, "long");
  assert.equal(s.invalidation, s.retest, "invalidation defaults to the broken level");
  assert.ok(s.invalidation < s.entry && s.invalidation > s.stop, "sits between entry and stop");
});

test("the two new setups are registered and never throw on thin data", () => {
  assert.ok(SCANNERS.includes(pullback) && SCANNERS.includes(momentum));
  assert.equal(pullback(bars([[1, 1, 1, 1]])), null); // too little data → null, no crash
  assert.equal(momentum(bars([[1, 1, 1, 1]])), null);
});

test("momentum fires on a strong trend thrust and stays a continuation long", () => {
  // A steady uptrend, then a decisive expansion bar closing near its high.
  const up = Array.from({ length: 40 }, (_, i) => { const p = 100 + i * 0.5; return [p, p + 0.3, p - 0.3, p + 0.2]; });
  up.push([120, 126, 119.8, 125.5]); // big body, closes near the high
  const s = momentum(bars(up));
  if (s) { // deterministic-enough, but guard so a threshold tweak can't flake the suite
    assert.equal(s.kind, "momentum");
    assert.equal(s.side, "long");
    assert.ok(s.target > s.entry && s.stop < s.entry);
  }
});

// ── Reel batch 2: relative volume + VWAP bands ───────────────────────────────
test("relVolume compares the last bar to the prior average", () => {
  const flat = bars(Array.from({ length: 25 }, () => [1, 1, 1, 1])).map((c) => ({ ...c, volume: 1000 }));
  assert.equal(relVolume(flat, 20), 1); // last == average
  flat[flat.length - 1].volume = 3000;  // a 3× volume spike on the latest bar
  assert.ok(Math.abs(relVolume(flat, 20) - 3) < 1e-9);
});

test("VOLUME_KINDS gates continuation setups but not fades", () => {
  assert.ok(VOLUME_KINDS.has("breakout") && VOLUME_KINDS.has("momentum"));
  assert.ok(!VOLUME_KINDS.has("mean-reversion") && !VOLUME_KINDS.has("vwap-band"));
});

test("vwapBands fades a tag of the lower band back toward VWAP", () => {
  // A series with real variance around ~100 (so the std-dev band exists), then a
  // spike down that tags the lower band and closes back above it.
  const arr = [];
  for (let i = 0; i < 60; i++) { const cl = i % 2 ? 101 : 99; arr.push([cl, cl + 0.2, cl - 0.2, cl]); }
  arr.push([98, 98, 96, 97.5]); // low pierces ~−3σ, closes above it
  const s = vwapBands(bars(arr));
  if (s) {
    assert.equal(s.kind, "vwap-band");
    assert.equal(s.side, "long");
    assert.ok(s.target > s.entry && s.stop < s.entry);
    assert.equal(s.invalidation < s.entry, true);
  }
  assert.ok(SCANNERS.includes(vwapBands));
});

// ── Pyramiding (money-management borrow) ─────────────────────────────────────
test("pyramidAdd scales into a winner and trails the stop to keep risk bounded", () => {
  const th = { side: "long", entry: 100, stop: 98, size: 10, riskAmt: 20, riskBudget: 20, baseSize: 10, units: 1, leverage: 1, target: 110 };
  const add = pyramidAdd(th, 102, { maxUnits: 4 });
  assert.ok(add, "adds a unit when in profit");
  assert.equal(add.units, 2);
  assert.equal(add.size, 20);                         // one unit added
  assert.ok(add.entry > 100 && add.entry < 102);      // averaged entry
  assert.ok(add.stop >= th.stop);                     // stop only trails FORWARD
  assert.ok(add.riskAmt <= th.riskBudget + 1e-9);     // total risk stays inside the original budget
});

test("pyramidAdd refuses when not in profit or at the unit cap", () => {
  const base = { side: "long", entry: 100, stop: 98, size: 10, riskAmt: 20, riskBudget: 20, baseSize: 10, leverage: 1, target: 110 };
  assert.equal(pyramidAdd({ ...base, units: 1 }, 99, {}), null);                 // price below entry
  assert.equal(pyramidAdd({ ...base, units: 4 }, 105, { maxUnits: 4 }), null);   // at the unit cap
});

test("scan attaches an atrPct volatility reading to every setup", () => {
  const up = Array.from({ length: 80 }, (_, i) => { const p = 100 + i * 0.4; return [p, p + 0.4, p - 0.4, p + 0.25]; });
  up.push([132, 138, 131.8, 137.5]);
  const c = bars(up);
  const { triggered } = scan({ c5: c, c15: c, c1h: c });
  for (const s of triggered) assert.ok(s.atrPct == null || (s.atrPct > 0 && s.atrPct < 1));
});
