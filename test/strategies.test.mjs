// Smoke tests for the built-in strategy library. Every built-in must build and
// run without a strategy error, and each new template must actually TRADE on a
// trending + oscillating series (a strategy that never triggers is broken).
import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILT_IN_STRATEGIES } from "../src/lib/strategies.js";
import { runBacktest } from "../src/lib/backtest.js";

// Deterministic trending-with-oscillation series (daily), with volume so the
// volume-weighted strategies have something to weight by.
function synth(n = 700) {
  const out = [];
  let p = 100, t = 1_600_000_000;
  for (let i = 0; i < n; i++) {
    p *= 1 + Math.sin(i / 17) * 0.02 + Math.sin(i / 4) * 0.009 + (((i * 2654435761) % 1000) / 1000 - 0.5) * 0.02 + 0.0009;
    const o = p * (1 - 0.003), c = p, hi = Math.max(o, c) * 1.005, lo = Math.min(o, c) * 0.995;
    out.push({ time: t + i * 86400, open: o, high: hi, low: lo, close: c, volume: 1000 + (i % 50) * 25 });
  }
  return out;
}

const NEW = ["absolute-momentum", "low-vol-timing", "rolling-vwap-reversion", "turtle-breakout", "keltner-breakout", "connors-rsi2", "macd-trend"];

test("every built-in strategy builds and runs without a strategy error", () => {
  const candles = synth();
  for (const s of BUILT_IN_STRATEGIES) {
    const params = Object.fromEntries((s.params || []).map((p) => [p.key, p.default]));
    const r = runBacktest({ candles, signalFn: s.build(params), initialCapital: 10000, feeBps: 5 });
    assert.ok(r && r.metrics, `${s.id} produced a result`);
    assert.equal(r.warnings.filter((w) => /error/i.test(w)).length, 0, `${s.id} no strategy error`);
  }
});

test("new templates actually trade (entry AND exit trigger)", () => {
  const candles = synth();
  for (const id of NEW) {
    const s = BUILT_IN_STRATEGIES.find((x) => x.id === id);
    assert.ok(s, `${id} is registered`);
    const r = runBacktest({ candles, signalFn: s.build({}), initialCapital: 10000, feeBps: 5 });
    assert.ok(r.metrics.tradeCount > 0, `${id} makes at least one round-trip trade (n=${r.metrics.tradeCount})`);
  }
});
