import { test } from "node:test";
import assert from "node:assert/strict";
import { volStatus, volCeiling, VOL_CEIL_ATR_PCT } from "../src/lib/argus/core.js";

// The bug these pin down: the ceilings are quoted for a DAILY bar and were being
// compared against a 5-MINUTE ATR. The crypto ceiling of 5%/bar sits 12x above
// the largest 5m reading in the live ledger (0.43%), so the gate never fired —
// and neither did the "elevated" band, meaning the 0.7 size cut it exists to
// apply had never once been applied.

test("the ceiling scales with the square root of time", () => {
  const daily = VOL_CEIL_ATR_PCT.crypto;
  assert.equal(volCeiling("crypto", "1d"), daily);
  // 288 five-minute bars in a day → the ceiling is daily / sqrt(288).
  assert.ok(Math.abs(volCeiling("crypto", "5m") - daily / Math.sqrt(288)) < 1e-12);
  assert.ok(volCeiling("crypto", "5m") < volCeiling("crypto", "1h"));
  assert.ok(volCeiling("crypto", "1h") < volCeiling("crypto", "4h"));
});

test("on 5m crypto the gate now bites where it never did before", () => {
  // Percentiles measured from the live ledger: median 0.17%/bar, p90 0.29%.
  assert.equal(volStatus(0.0017, "crypto", "5m").ok, true, "the median must still trade");
  assert.equal(volStatus(0.0025, "crypto", "5m").elevated, true, "the busy end sizes down");
  assert.equal(volStatus(0.0025, "crypto", "5m").mult, 0.7);
  assert.equal(volStatus(0.0043, "crypto", "5m").ok, false, "the loudest reading seen is refused");
});

test("without a timeframe nothing changes for daily callers", () => {
  const a = volStatus(0.06, "crypto");            // above the 5% daily ceiling
  assert.equal(a.ok, false);
  const b = volStatus(0.02, "crypto");            // comfortably below it
  assert.equal(b.ok, true);
  assert.equal(b.mult, 1);
});

test("the old behaviour is what the regression looked like", () => {
  // Judged against the DAILY ceiling, every reading the ledger ever produced
  // passed at full size. That is the dead gate, reproduced.
  for (const atr of [0.0006, 0.0017, 0.0029, 0.0043]) {
    const stale = volStatus(atr, "crypto");       // no timeframe = daily
    assert.equal(stale.ok, true);
    assert.equal(stale.mult, 1, `${atr} would have passed at full size`);
  }
});

test("a missing or nonsense ATR does not silently block trading", () => {
  for (const bad of [null, undefined, 0, -1, NaN]) {
    const v = volStatus(bad, "crypto", "5m");
    assert.equal(v.ok, true, "unknown volatility must not be treated as extreme");
    assert.equal(v.mult, 1);
  }
});

test("an unknown timeframe falls back to the daily ceiling rather than to zero", () => {
  const v = volCeiling("crypto", "not-a-timeframe");
  assert.equal(v, VOL_CEIL_ATR_PCT.crypto, "…which is permissive, not accidentally blocking everything");
});

test("each asset class keeps its own ceiling through the scaling", () => {
  assert.ok(volCeiling("forex", "5m") < volCeiling("crypto", "5m"), "forex is the calmest");
  assert.ok(volCeiling("stock", "5m") < volCeiling("crypto", "5m"));
});
