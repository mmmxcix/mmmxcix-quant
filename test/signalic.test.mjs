import { test } from "node:test";
import assert from "node:assert/strict";
import { signalIC } from "../src/lib/validation.js";
import { runBacktest, compileStrategy } from "../src/lib/backtest.js";

const bars = (closes) => closes.map((c, i) => ({ time: i * 86400, open: c, high: c + 0.5, low: c - 0.5, close: c, volume: 1 }));

// Alternating up/down series: forward return is + on even bars, − on odd bars.
const zigzag = () => bars(Array.from({ length: 60 }, (_, i) => (i % 2 ? 101 : 100)));

test("signalIC ~ +1 when the signal perfectly predicts the next bar", () => {
  const cs = zigzag();
  const sig = cs.map((_, i) => (i % 2 === 0 ? 1 : -1)); // long before an up bar, short before a down bar
  const { ic, n } = signalIC(cs, sig);
  assert.ok(ic > 0.9, `expected strong positive IC, got ${ic}`);
  assert.ok(n >= 40);
});

test("signalIC is strongly negative when the signal anti-predicts", () => {
  const cs = zigzag();
  const sig = cs.map((_, i) => (i % 2 === 0 ? -1 : 1)); // inverted
  assert.ok(signalIC(cs, sig).ic < -0.9);
});

test("signalIC returns null on too few active bars", () => {
  assert.equal(signalIC(bars([100, 101, 100]), [1, 0, 0]).ic, null);
});

test("runBacktest exposes an index-aligned per-bar signal series", () => {
  const cs = bars(Array.from({ length: 80 }, (_, i) => 100 + i));
  const r = runBacktest({
    candles: cs,
    signalFn: compileStrategy('function strategy(ctx){ const s=ctx.indicators.sma(ctx.indicators.closes(ctx.candles),10)[ctx.index]; return s!=null && ctx.close>s ? "long":"flat"; }'),
    initialCapital: 10000, feeBps: 5,
  });
  assert.equal(r.signals.length, cs.length);
  assert.ok(r.signals.every((s) => s === 1 || s === 0 || s === -1));
  assert.ok(r.signals.some((s) => s === 1), "a rising series should signal long at least once");
});
