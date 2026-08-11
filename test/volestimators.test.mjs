import { test } from "node:test";
import assert from "node:assert/strict";
import {
  closeToClose, parkinson, garmanKlass, rogersSatchell, yangZhang, hodgesTompkins, allEstimators,
} from "../src/lib/volEstimators.js";

// Range-based volatility estimators (Parkinson / Garman-Klass / Rogers-Satchell
// / Yang-Zhang), implemented from the papers. These tests pin the properties
// each estimator is CHOSEN for — that is what makes them worth having over a
// plain standard deviation of closes.

// A synthetic series with a known shape: every bar swings ±2% intraday but
// closes exactly where it opened. Close-to-close sees nothing; the rest see it.
const flatCloseWildRange = Array.from({ length: 80 }, (_, i) => ({
  time: i * 86400, open: 100, high: 102, low: 98, close: 100, volume: 1,
}));

test("close-to-close is blind to intraday range; the range estimators are not", () => {
  const ctc = closeToClose(flatCloseWildRange, 30);
  assert.ok(ctc != null && ctc < 1e-9, `close-to-close should read ~0, got ${ctc}`);
  for (const [name, fn] of [["parkinson", parkinson], ["garmanKlass", garmanKlass], ["rogersSatchell", rogersSatchell]]) {
    const v = fn(flatCloseWildRange, 30);
    assert.ok(v > 0.1, `${name} must see the 4% daily range, got ${v}`);
  }
});

test("Yang-Zhang sees an overnight gap that the gap-blind estimators miss", () => {
  // Bars with NO intraday range at all, but a 1% gap every night. Parkinson and
  // Garman-Klass assume continuous trading and should read ~0; Yang-Zhang has
  // an overnight term and must not.
  const gapOnly = [];
  let p = 100;
  for (let i = 0; i < 80; i++) {
    const open = p * (i % 2 === 0 ? 1.01 : 0.99);
    gapOnly.push({ time: i * 86400, open, high: open, low: open, close: open, volume: 1 });
    p = open;
  }
  assert.ok(parkinson(gapOnly, 30) < 1e-9, "Parkinson cannot see gaps");
  assert.ok(yangZhang(gapOnly, 30) > 0.1, "Yang-Zhang must see them");
});

test("Rogers-Satchell stays put under a strong drift where Parkinson inflates", () => {
  // Same relative range every bar, but a steady 1%/bar uptrend. A drift-blind
  // estimator reads the trend as volatility.
  const drifting = [];
  let p = 100;
  for (let i = 0; i < 120; i++) {
    const open = p, close = p * 1.01;
    drifting.push({ time: i * 86400, open, high: close * 1.002, low: open * 0.998, close, volume: 1 });
    p = close;
  }
  const rs = rogersSatchell(drifting, 60);
  const pk = parkinson(drifting, 60);
  assert.ok(rs < pk, `Rogers-Satchell (${rs}) should be below Parkinson (${pk}) under drift`);
});

test("annualisation scales with the declared bar frequency", () => {
  const daily = parkinson(flatCloseWildRange, 30, 252);
  const hourly = parkinson(flatCloseWildRange, 30, 8760);
  assert.ok(Math.abs(hourly / daily - Math.sqrt(8760 / 252)) < 1e-6);
});

test("too little data returns null rather than a confident wrong number", () => {
  const few = flatCloseWildRange.slice(0, 5);
  for (const fn of [closeToClose, parkinson, garmanKlass, rogersSatchell, yangZhang]) {
    assert.equal(fn(few, 30), null);
  }
  assert.equal(yangZhang(null, 30), null);
});

test("Hodges-Tompkins inflates an overlapping-window estimate, never shrinks it", () => {
  const raw = 0.2;
  const adj = hodgesTompkins(raw, 500, 30);
  assert.ok(adj > raw, "overlapping windows understate dispersion, so the fix must raise it");
  assert.ok(adj < raw * 1.2, "…but only slightly");
  assert.equal(hodgesTompkins(0, 500, 30), 0, "degenerate input passes through");
});

test("allEstimators returns every estimator on one series", () => {
  const all = allEstimators(flatCloseWildRange, 30);
  assert.deepEqual(Object.keys(all).sort(),
    ["closeToClose", "garmanKlass", "parkinson", "rogersSatchell", "yangZhang"]);
});
