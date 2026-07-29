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
