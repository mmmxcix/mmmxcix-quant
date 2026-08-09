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

test("detects INLINE indicator literals when a strategy declares no constants", () => {
  // The real Cortex shape: every number lives inside the call, so the panel used
  // to report "no tunable constants" and the optimizer was unusable.
  const py = `def signals(df):
    ema20 = df['close'].ewm(span=20, adjust=False).mean()
    ema50 = df['close'].ewm(span=50, adjust=False).mean()
    atr = df['high'].rolling(14).max()
    return ema20 > ema50`;
  const space = codeParamSpace(py);
  assert.deepEqual(space.map((p) => p.key), ["span_1", "span_2", "rolling_1"]);
  assert.deepEqual(space.map((p) => p.default), [20, 50, 14]);
});

test("substitutes each inline occurrence independently, by position", () => {
  const py = `def signals(df):
    a = df['close'].ewm(span=20).mean()
    b = df['close'].ewm(span=20).mean()
    return a > b`;
  const out = substituteConstants(py, { span_1: 12, span_2: 60 });
  assert.match(out, /a = df\['close'\]\.ewm\(span=12\)/);
  assert.match(out, /b = df\['close'\]\.ewm\(span=60\)/);
});

test("named constants and inline literals coexist without clobbering each other", () => {
  const py = `def signals(df):
    lookback = 30  # named
    ema = df['close'].ewm(span=20).mean()
    return ema`;
  const space = codeParamSpace(py);
  assert.deepEqual(space.map((p) => p.key), ["lookback", "span_1"]);
  const out = substituteConstants(py, { lookback: 45, span_1: 9 });
  assert.match(out, /lookback = 45  # named/);
  assert.match(out, /ewm\(span=9\)/);
});

test("detects JS constants with trailing // comments", () => {
  const js = `const lookback = 50; // bars\nfunction strategy(ctx){ return "flat"; }`;
  assert.deepEqual(codeParamSpace(js).map((p) => p.key), ["lookback"]);
  assert.match(substituteConstants(js, { lookback: 80 }), /const lookback = 80; \/\/ bars/);
});
