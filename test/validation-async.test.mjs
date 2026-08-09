import { test } from "node:test";
import assert from "node:assert/strict";
import { kFoldCode, kFoldCodeAsync, noiseTest, noiseTestAsync } from "../src/lib/validation.js";

// The async variants exist for browser Python (one Pyodide signal run per fold
// / noisy copy). With the same deterministic factory they MUST judge exactly
// like the sync originals — same folds, same noise, same verdicts.

const candles = Array.from({ length: 700 }, (_, i) => {
  const p = 100 + i * 0.1 + Math.sin(i / 9) * 3;
  return { time: i * 3600, open: p, high: p + 1.5, low: p - 1.5, close: p + Math.sin(i / 5), volume: 1 };
});

// Simple deterministic strategy: long above the 20-bar mean of closes.
const signalFn = (ctx) => {
  if (ctx.index < 20) return "flat";
  let s = 0;
  for (let k = ctx.index - 19; k <= ctx.index; k++) s += ctx.candles[k].close;
  return ctx.close > s / 20 ? "long" : "flat";
};

test("kFoldCodeAsync matches the sync kFoldCode verdict fold-for-fold", async () => {
  const sync = kFoldCode({ candles, makeSignalFn: () => signalFn, feeBps: 10 });
  const asy = await kFoldCodeAsync({ candles, makeSignalFnFor: async () => signalFn, feeBps: 10 });
  assert.ok(sync && asy);
  assert.equal(asy.verdict, sync.verdict);
  assert.deepEqual(asy.folds, sync.folds);
});

test("noiseTestAsync perturbs identically to the sync noiseTest (same seed)", async () => {
  const sync = noiseTest({ candles, makeSignalFn: () => signalFn, runs: 8, feeBps: 10, seed: 7 });
  const asy = await noiseTestAsync({ candles, makeSignalFnFor: async () => signalFn, runs: 8, feeBps: 10, seed: 7 });
  assert.ok(sync && asy);
  assert.equal(asy.verdict, sync.verdict);
  assert.equal(asy.medianReturnPct, sync.medianReturnPct);
  assert.equal(asy.baseReturnPct, sync.baseReturnPct);
});
