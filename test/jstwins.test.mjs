// The JS source twins (BUILTIN_SOURCE) are what the editor shows and the user
// copies — they must trade IDENTICALLY to the native builder they represent, or
// "copy as JavaScript" hands out a subtly different strategy. The Python twins
// have their own harness (twins.test.mjs); this pins the JS ones, including the
// bracket strategies that (correctly) have no Python twin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILT_IN_STRATEGIES } from "../src/lib/strategies.js";
import { strategyToCode } from "../src/lib/strategyCode.js";
import { runBacktest, compileStrategy } from "../src/lib/backtest.js";

// A long, structured synthetic series: trend up with regular pullbacks + noise,
// so trend, pullback-entry, divergence and reversion logic all get exercised.
function series(n = 900) {
  const c = [];
  let px = 100;
  for (let i = 0; i < n; i++) {
    const trend = i * 0.04;
    const swing = Math.sin(i / 25) * 6 + Math.sin(i / 6) * 2;
    px = 100 + trend + swing;
    const o = px, cl = px + Math.sin(i / 3) * 0.8;
    const h = Math.max(o, cl) + 1.1, l = Math.min(o, cl) - 1.1;
    c.push({ time: i * 3600, open: o, high: h, low: l, close: cl, volume: 1000 + (i % 50) * 10 });
  }
  return c;
}

// Every strategy that HAS a JS twin must reproduce its builder exactly.
const IDS = ["linreg-channel", "rsi-divergence", "supertrend"];

for (const id of IDS) {
  test(`JS twin of "${id}" trades identically to its builder`, () => {
    const s = BUILT_IN_STRATEGIES.find((x) => x.id === id);
    assert.ok(s, `strategy ${id} exists`);
    const params = Object.fromEntries((s.params || []).map((p) => [p.key, p.default]));
    const candles = series();

    const native = runBacktest({ candles, signalFn: s.build(params), feeBps: 10, positionPct: 100 });

    const src = strategyToCode({ mode: "builder", strategyId: id, params }, "js");
    assert.ok(src && src.includes("function strategy"), `${id} has a JS twin`);
    const twin = runBacktest({ candles, signalFn: compileStrategy(src), feeBps: 10, positionPct: 100 });

    assert.equal(twin.metrics.tradeCount, native.metrics.tradeCount, `${id}: same trade count`);
    assert.ok(
      Math.abs(twin.metrics.totalReturnPct - native.metrics.totalReturnPct) < 1e-6,
      `${id}: return ${twin.metrics.totalReturnPct} vs ${native.metrics.totalReturnPct}`
    );
    // The strategy must actually do something on this data, or the test is vacuous.
    assert.ok(native.metrics.tradeCount >= 2, `${id}: builder trades on the test series`);
  });
}
