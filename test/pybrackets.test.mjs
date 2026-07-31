// Python intrabar brackets: a signals(df) that returns a DataFrame with
// stop/target columns must actually exit at the stop/target inside a bar, exactly
// like the JS {signal,stop,target} contract. Runs the real Pyodide runtime.
import { test } from "node:test";
import assert from "node:assert/strict";
import { initPy, compilePyStrategy } from "../scripts/pyRunnerNode.mjs";
import { runBacktest } from "../src/lib/backtest.js";

// A series that ticks up, then a single bar dumps hard (low far below) — a long
// stop placed just under entry must fill THAT bar.
function candles() {
  const out = [];
  let t = 1_600_000_000, p = 100;
  for (let i = 0; i < 20; i++) {
    const o = p, c = p + 1, hi = c + 0.5, lo = o - 0.5;
    out.push({ time: t + i * 86400, open: o, high: hi, low: lo, close: c, volume: 1000 });
    p = c;
  }
  // Bar 20: gaps/dumps — low pierces well below the prior close.
  const o = p, c = p - 10, hi = o + 0.5, lo = c - 5;
  out.push({ time: t + 20 * 86400, open: o, high: hi, low: lo, close: c, volume: 1000 });
  for (let i = 21; i < 30; i++) { const oo = c, cc = c + 1; out.push({ time: t + i * 86400, open: oo, high: cc + 0.5, low: oo - 0.5, close: cc, volume: 1000 }); p = cc; }
  return out;
}

test("Python signals can return stop/target brackets that fill intrabar", async () => {
  await initPy();
  // Long from bar 1 onward, with a stop 2% below the close and no target.
  const code = `
import numpy as np
import pandas as pd
def signals(df):
    n = len(df)
    sig = np.zeros(n)
    sig[1:] = 1                      # long from bar 1
    stop = df['close'] * 0.98        # 2% stop
    target = pd.Series(np.nan, index=df.index)
    return pd.DataFrame({'signal': sig, 'stop': stop, 'target': target})
`;
  const fn = compilePyStrategy(code);
  const res = runBacktest({ candles: candles(), signalFn: fn, initialCapital: 10000, feeBps: 5 });
  assert.equal(res.warnings.length, 0, `no warnings: ${res.warnings[0] || ""}`);
  // The dump bar must have triggered a STOP exit — proof the bracket was honoured.
  assert.ok(res.trades.some((t) => t.reason === "stop"), "a stop-loss exit occurred");
});

test("a signal-only Python strategy still works (backward compatible)", async () => {
  await initPy();
  const code = `
import numpy as np, pandas as pd
def signals(df):
    return pd.Series(np.where(df['close'] > df['open'], 1, 0), index=df.index)
`;
  const fn = compilePyStrategy(code);
  const res = runBacktest({ candles: candles(), signalFn: fn, initialCapital: 10000, feeBps: 5 });
  assert.equal(res.warnings.length, 0);
  assert.ok(res.trades.length >= 1);
});
