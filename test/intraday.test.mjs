// intraday.test.mjs — every intraday template compiles, runs, and trades
// against the real engine with no strategy errors.
import { test } from "node:test";
import assert from "node:assert/strict";
import { intradayTemplates, ALL_INTRADAY_KEYS } from "../scripts/intraday.mjs";
import { compileStrategy, runBacktest } from "../src/lib/backtest.js";

// Deterministic synthetic intraday series (1h bars → many session resets).
function synthCandles(n = 800) {
  const candles = [];
  let px = 100, t = 1700000000, seed = 42;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i / 40) * 0.4;
    const o = px;
    px = Math.max(1, px * (1 + (rnd() - 0.5 + drift * 0.05) * 0.01));
    const hi = Math.max(o, px) * (1 + rnd() * 0.003);
    const lo = Math.min(o, px) * (1 - rnd() * 0.003);
    candles.push({ time: t, open: o, high: hi, low: lo, close: px, volume: 100 + rnd() * 900 });
    t += 3600;
  }
  return candles;
}

test("intradayTemplates returns a de-dupable keyed set", () => {
  const all = intradayTemplates();
  assert.ok(all.length >= 5);
  assert.equal(new Set(all.map((t) => t.key)).size, all.length); // unique keys
  assert.equal(intradayTemplates(new Set(ALL_INTRADAY_KEYS)).length, 0); // all tried → none
});

test("every template compiles, runs and trades without strategy errors", () => {
  const candles = synthCandles();
  for (const tpl of intradayTemplates()) {
    let fn;
    assert.doesNotThrow(() => { fn = compileStrategy(tpl.code); }, `compile ${tpl.key}`);
    const res = runBacktest({ candles, signalFn: fn, initialCapital: 10000, feeBps: 10 });
    assert.equal(res.warnings.length, 0, `${tpl.key} warnings: ${res.warnings[0] || ""}`);
    assert.ok(res.metrics.tradeCount > 0, `${tpl.key} should take at least one trade`);
  }
});

test("templates carry a NAME/EDGE thesis and a strategy() fn", () => {
  for (const tpl of intradayTemplates()) {
    assert.match(tpl.code, /function\s+strategy\s*\(/, `${tpl.key} defines strategy()`);
    assert.match(tpl.code, /\/\/ EDGE:/, `${tpl.key} has an EDGE line`);
    assert.ok(tpl.name && tpl.name.length <= 70);
  }
});
