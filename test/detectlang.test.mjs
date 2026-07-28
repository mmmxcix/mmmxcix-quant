// The unified editor has no language toggle — it DETECTS the language from the
// code. A wrong guess sends the source to the wrong compiler, so the detector is
// pinned here against real samples of all three languages.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILT_IN_STRATEGIES } from "../src/lib/strategies.js";
import { strategyToCode } from "../src/lib/strategyCode.js";

// Mirror of detectLang in src/pages/Backtest.jsx (kept in sync deliberately —
// importing the page would pull in React and the whole component tree).
function detectLang(src) {
  const c = String(src || "");
  if (/\bdef\s+signals\s*\(/.test(c)) return "python";
  if (/function\s+strategy\s*\(|=>\s*\{?\s*(?:"long"|"short"|"flat")|ctx\.(candles|indicators|position)/.test(c)) return "js";
  if (/\/\/@version\s*=|\bta\.\w+|strategy\.(entry|close|exit)\s*\(|\bplot(shape)?\s*\(/.test(c)) return "pine";
  return "js";
}

test("detects each language from real generated sources", () => {
  const entry = (id) => ({ mode: "builder", strategyId: id, params: {}, positionPct: 100, feeBps: 10, name: id });
  for (const id of ["sma-crossover", "rsi-mean-reversion", "donchian-breakout"]) {
    const py = strategyToCode(entry(id), "python");
    const js = strategyToCode(entry(id));
    assert.equal(detectLang(py), "python", `${id}: python twin detected as python`);
    assert.equal(detectLang(js), "js", `${id}: js source detected as js`);
    const pine = strategyToCode(entry(id), "pine");
    if (pine && pine.includes("//@version=5")) {
      assert.equal(detectLang(pine), "pine", `${id}: pine export detected as pine`);
    }
  }
});

test("every preset's Python twin is detected as Python (the editor's default form)", () => {
  for (const s of BUILT_IN_STRATEGIES) {
    const py = strategyToCode({ mode: "builder", strategyId: s.id, params: {} }, "python");
    if (!py || !py.trim()) continue; // not every preset has a twin yet
    assert.equal(detectLang(py), "python", `${s.id}`);
  }
});

test("hand-written snippets and edge cases", () => {
  assert.equal(detectLang("def signals(df):\n    return df['close'] * 0"), "python");
  assert.equal(detectLang('function strategy(ctx) { return "long"; }'), "js");
  assert.equal(detectLang("//@version=5\nstrategy('x')\nplot(ta.sma(close, 20))"), "pine");
  assert.equal(detectLang("const x = ctx.indicators.sma(ctx.candles, 20)"), "js");
  assert.equal(detectLang(""), "js", "empty falls back to JS, never crashes");
});
