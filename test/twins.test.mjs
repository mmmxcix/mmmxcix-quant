// Python-twin fidelity: every built-in that advertises a Python twin must trade
// IDENTICALLY to its builder implementation. The unified editor loads presets as
// Python source, so a twin that drifts would silently show the user code that is
// not the strategy they backtested. Runs the real Pyodide runtime (a few seconds).
import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILT_IN_STRATEGIES } from "../src/lib/strategies.js";
import { strategyToCode, hasBuiltinPySource } from "../src/lib/strategyCode.js";
import { initPy, compilePyStrategy } from "../scripts/pyRunnerNode.mjs";
import { runBacktest } from "../src/lib/backtest.js";

// Deterministic trending + oscillating series with volume (so VWAP twins work).
function synth(n = 900) {
  const out = [];
  let p = 100, t = 1_600_000_000;
  for (let i = 0; i < n; i++) {
    p *= 1 + Math.sin(i / 19) * 0.02 + Math.sin(i / 5) * 0.008 + (((i * 2654435761) % 1000) / 1000 - 0.5) * 0.018 + 0.0008;
    const o = p * (1 - 0.003), c = p, hi = Math.max(o, c) * 1.005, lo = Math.min(o, c) * 0.995;
    out.push({ time: t + i * 86400, open: o, high: hi, low: lo, close: c, volume: 1000 + (i % 40) * 30 });
  }
  return out;
}

test("every Python twin trades identically to its builder strategy", async () => {
  await initPy();
  const candles = synth();
  const checked = [];
  for (const s of BUILT_IN_STRATEGIES) {
    if (!hasBuiltinPySource(s.id)) continue;
    const params = Object.fromEntries((s.params || []).map((p) => [p.key, p.default]));
    const py = strategyToCode({ mode: "builder", strategyId: s.id, params }, "python");
    assert.ok(py && py.includes("def signals"), `${s.id}: twin defines signals(df)`);

    const js = runBacktest({ candles, signalFn: s.build(params), initialCapital: 10000, feeBps: 5 });
    const pyRes = runBacktest({ candles, signalFn: compilePyStrategy(py), initialCapital: 10000, feeBps: 5 });

    // Same trade count, and returns within a rounding-level tolerance.
    assert.equal(pyRes.metrics.tradeCount, js.metrics.tradeCount, `${s.id}: same trade count`);
    assert.ok(
      Math.abs(pyRes.metrics.totalReturnPct - js.metrics.totalReturnPct) < 0.5,
      `${s.id}: return matches (js ${js.metrics.totalReturnPct.toFixed(2)}% vs py ${pyRes.metrics.totalReturnPct.toFixed(2)}%)`,
    );
    checked.push(s.id);
  }
  assert.ok(checked.length >= 12, `checked a meaningful set of twins (got ${checked.length})`);
});
