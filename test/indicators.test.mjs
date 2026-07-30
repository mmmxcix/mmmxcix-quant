// Unit tests for the raw indicators.
import { test } from "node:test";
import assert from "node:assert/strict";

// ── linear-regression channel ───────────────────────────────────────────────
import { linreg as _linreg } from "../src/lib/indicators.js";

test("linreg fits a perfect line: zero residual, exact slope, z≈0", () => {
  const vals = Array.from({ length: 20 }, (_, i) => 10 + 2 * i); // slope 2, intercept 10
  const r = _linreg(vals, 10);
  assert.equal(r[8], null, "warm-up before period-1 is null");
  const last = r[19];
  assert.ok(Math.abs(last.slope - 2) < 1e-9, "recovers slope 2");
  assert.ok(Math.abs(last.resStd) < 1e-9, "no residual on a perfect line");
  assert.ok(Math.abs(last.z) < 1e-9, "price sits on its own line → z≈0");
  assert.ok(Math.abs(last.value - vals[19]) < 1e-9, "line meets the current price");
});

test("linreg z is negative when price dips below its uptrend line", () => {
  const vals = Array.from({ length: 12 }, (_, i) => 100 + i); // steady uptrend
  vals[11] = 100 + 11 - 3; // last bar dips 3 below the line
  const r = _linreg(vals, 12);
  assert.ok(r[11].slope > 0, "still an uptrend");
  assert.ok(r[11].z < 0, "a dip below the line reads as negative z");
});

// ── supertrend ──────────────────────────────────────────────────────────────
import { supertrend as _supertrend } from "../src/lib/indicators.js";

test("supertrend flips direction and sits below price in an uptrend", () => {
  const c = Array.from({ length: 60 }, (_, i) => {
    const p = 100 + i; // steady uptrend
    return { time: i * 3600, open: p, high: p + 1, low: p - 1, close: p, volume: 1 };
  });
  const st = _supertrend(c, 10, 3);
  const last = st[59];
  assert.ok(last, "has a value after warm-up");
  assert.equal(last.dir, 1, "uptrend → dir +1");
  assert.ok(last.value < c[59].close, "the band trails BELOW price in an uptrend");
});

test("supertrend turns down after a sharp drop", () => {
  const up = Array.from({ length: 40 }, (_, i) => ({ time: i * 3600, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 1 }));
  const down = Array.from({ length: 20 }, (_, i) => { const p = 140 - i * 4; return { time: (40 + i) * 3600, open: p, high: p + 1, low: p - 1, close: p, volume: 1 }; });
  const st = _supertrend([...up, ...down], 10, 3);
  assert.equal(st[st.length - 1].dir, -1, "a sharp decline flips it to a downtrend");
});
