// optimizer-code.test.mjs — detect + substitute tunable constants in ANY strategy
// code (the foundation for optimizing hand-written strategies, not just presets).
import { test } from "node:test";
import assert from "node:assert/strict";
import { codeParamSpace, substituteConstants } from "../src/lib/optimizer.js";

const PY = `import numpy as np
import pandas as pd

LOOKBACK, TREND, MIN_ROC = 95, 325, -4

def signals(df):
    return pd.Series(0, index=df.index)`;

const JS = `// NAME: ORB
const RANGE_BARS = 6;
const TARGET_R = 1.5;
function strategy(ctx){ return "flat"; }`;

test("detects tuple + single UPPER_CASE numeric constants", () => {
  const py = codeParamSpace(PY);
  assert.deepEqual(py.map((p) => p.key).sort(), ["LOOKBACK", "MIN_ROC", "TREND"]);
  assert.equal(py.find((p) => p.key === "LOOKBACK").default, 95);
  const js = codeParamSpace(JS);
  assert.deepEqual(js.map((p) => p.key).sort(), ["RANGE_BARS", "TARGET_R"]);
});

test("ranges are sensible and positive integers never go <= 0", () => {
  for (const p of codeParamSpace(PY)) {
    assert.ok(p.max > p.min && p.step > 0);
    if (p.default > 0 && p.integer) assert.ok(p.min > 0);
  }
});

test("substitutes the tuple assignment in order, leaving code otherwise intact", () => {
  const out = substituteConstants(PY, { LOOKBACK: 50, TREND: 200, MIN_ROC: 0 });
  assert.match(out, /LOOKBACK, TREND, MIN_ROC = 50, 200, 0/);
  assert.match(out, /def signals\(df\):/); // rest untouched
});

test("substitutes single assignments", () => {
  const out = substituteConstants(JS, { RANGE_BARS: 12, TARGET_R: 2 });
  assert.match(out, /const RANGE_BARS = 12;/);
  assert.match(out, /const TARGET_R = 2;/);
});

test("no constants → empty space, substitution is a no-op", () => {
  const code = `def signals(df):\n    return df["close"] * 0`;
  assert.equal(codeParamSpace(code).length, 0);
  assert.equal(substituteConstants(code, {}), code);
});

test("detects INDENTED constants with trailing comments (real Cortex/user code)", () => {
  // This shape used to report "no tunable constants": params live inside the
  // def and carry inline comments.
  const py = `def signals(df):
    ema_period = 20  # EMA Periode
    atr_mult = 1.5   # Stop-Abstand
    return None`;
  const space = codeParamSpace(py);
  assert.deepEqual(space.map((p) => p.key).sort(), ["atr_mult", "ema_period"]);
  const out = substituteConstants(py, { ema_period: 50, atr_mult: 2 });
  assert.match(out, /ema_period = 50  # EMA Periode/);
  assert.match(out, /atr_mult = 2   # Stop-Abstand/);
});

test("detects JS constants with trailing // comments", () => {
  const js = `const lookback = 50; // bars\nfunction strategy(ctx){ return "flat"; }`;
  assert.deepEqual(codeParamSpace(js).map((p) => p.key), ["lookback"]);
  assert.match(substituteConstants(js, { lookback: 80 }), /const lookback = 80; \/\/ bars/);
});
