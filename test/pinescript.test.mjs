// Tests for the Pine Script v5 exporter (src/lib/pinescript.js) and its wiring
// into the strategyToCode dispatcher. Run: `node --test test/pinescript.test.mjs`.
//
// The exporter's contract, mirrored from the JS/Python twins:
//   • builder + verified id → a full Pine v5 strategy() with the params baked in
//   • code mode / unknown id → an honest commented note, NEVER a fake strategy
//   • every interpolated param is a sanitised numeric literal
import { test } from "node:test";
import assert from "node:assert/strict";
import { toPineScript, hasPineSource, pineHeader } from "../src/lib/pinescript.js";
import { strategyToCode } from "../src/lib/strategyCode.js";

// Distinctive param values per supported id — unlikely to collide with the
// fixed literals (100, 0.1, 0, 5, ...) that always appear in a script, so
// "value is interpolated" is a meaningful assertion.
const SUPPORTED = {
  "sma-crossover": { fast: 17, slow: 43 },
  "ema-crossover": { fast: 9, slow: 33 },
  "rsi-mean-reversion": { period: 11, oversold: 27, exitLevel: 58 },
  "momentum-roc": { period: 23, threshold: 2.5 },
  "bollinger-mean-reversion": { period: 18, mult: 2.7 },
  "donchian-breakout": { period: 22, exitPeriod: 13 },
  "opening-range-breakout": { rangeBars: 8, targetR: 1.75, stopBufferPct: 0.35, longOnly: 0 },
};

test("every supported builder id emits a real Pine v5 strategy", () => {
  for (const [strategyId, params] of Object.entries(SUPPORTED)) {
    const entry = { mode: "builder", strategyId, params, name: `${strategyId} test`, positionPct: 100, feeBps: 10 };
    const src = toPineScript(entry);

    assert.ok(hasPineSource(entry), `${strategyId}: hasPineSource is true`);
    assert.ok(src.includes("//@version=5"), `${strategyId}: has version pragma`);
    assert.ok(src.includes("strategy("), `${strategyId}: has strategy() call`);

    // Every param value must be interpolated as a numeric literal.
    for (const [key, val] of Object.entries(params)) {
      assert.ok(
        src.includes(String(val)),
        `${strategyId}: param ${key}=${val} is interpolated`
      );
    }
  }
});

test("header carries the exact execution-model flags", () => {
  const src = toPineScript({
    mode: "builder", strategyId: "sma-crossover", params: { fast: 20, slow: 50 },
    name: "SMA", positionPct: 100, feeBps: 10,
  });
  assert.ok(src.includes("default_qty_type=strategy.percent_of_equity"), "percent_of_equity sizing");
  assert.ok(src.includes("default_qty_value=100"), "positionPct baked in");
  assert.ok(src.includes("commission_type=strategy.commission.percent"), "percent commission");
  assert.ok(src.includes("commission_value=0.1"), "10 bps -> 0.1");
  assert.ok(src.includes("pyramiding=0"), "single position");
  assert.ok(src.includes("process_orders_on_close=false"), "next-open fills");
  assert.ok(src.includes("calc_on_every_tick=false"), "bar-close evaluation");
});

test("feeBps and positionPct flow through to commission and sizing", () => {
  const src = toPineScript({
    mode: "builder", strategyId: "sma-crossover", params: { fast: 20, slow: 50 },
    name: "SMA", positionPct: 50, feeBps: 25,
  });
  assert.ok(src.includes("default_qty_value=50"), "positionPct=50");
  assert.ok(src.includes("commission_value=0.25"), "25 bps -> 0.25");
});

test("worked reference: SMA crossover matches the target output shape", () => {
  const src = toPineScript({
    mode: "builder", strategyId: "sma-crossover", params: { fast: 20, slow: 50 },
    name: "SMA Crossover", positionPct: 100, feeBps: 10,
  });
  assert.ok(src.includes("ta.sma(close, fast)"), "fast SMA calc");
  assert.ok(src.includes("ta.sma(close, slow)"), "slow SMA calc");
  assert.ok(src.includes('strategy.entry("Long", strategy.long)'), "long entry");
  assert.ok(src.includes('strategy.close("Long")'), "flatten via close");
  assert.ok(src.includes("fast = input.int(20"), "fast input");
  assert.ok(src.includes("slow = input.int(50"), "slow input");
});

test("Donchian excludes the current bar with the [1] offset", () => {
  const src = toPineScript({
    mode: "builder", strategyId: "donchian-breakout", params: { period: 20, exitPeriod: 10 },
    name: "Donchian", positionPct: 100, feeBps: 10,
  });
  assert.ok(src.includes("ta.highest(high, period)[1]"), "entry channel excludes current bar");
  assert.ok(src.includes("ta.lowest(low, exitPeriod)[1]"), "exit channel excludes current bar");
});

test("oscillator strategies render in a separate pane (overlay=false)", () => {
  for (const id of ["rsi-mean-reversion", "momentum-roc"]) {
    const src = toPineScript({ mode: "builder", strategyId: id, params: {}, name: id, positionPct: 100, feeBps: 10 });
    assert.ok(src.includes("overlay=false"), `${id}: overlay=false`);
  }
  for (const id of ["sma-crossover", "ema-crossover", "bollinger-mean-reversion", "donchian-breakout"]) {
    const src = toPineScript({ mode: "builder", strategyId: id, params: {}, name: id, positionPct: 100, feeBps: 10 });
    assert.ok(src.includes("overlay=true"), `${id}: overlay=true`);
  }
});

test("opening-range-breakout is flagged APPROXIMATE", () => {
  const src = toPineScript({
    mode: "builder", strategyId: "opening-range-breakout", params: {}, name: "ORB", positionPct: 100, feeBps: 10,
  });
  assert.ok(/APPROXIMATE/i.test(src), "carries an approximate warning");
  assert.ok(src.includes("strategy.exit("), "uses bracket exit orders");
});

const isNote = (s) =>
  s.includes("unavailable") && !s.includes("strategy(") && !s.includes("//@version=5");

test("code-mode entries return an honest note, not a fake strategy", () => {
  const jsEntry = { mode: "code", code: "function strategy(ctx){return 'flat'}", language: "js" };
  const pyEntry = { mode: "code", code: "def signals(df): pass", language: "python" };
  for (const e of [jsEntry, pyEntry]) {
    const src = toPineScript(e);
    assert.ok(isNote(src), "returns the honest note");
    assert.equal(hasPineSource(e), false, "hasPineSource is false");
  }
});

test("unknown builder ids return an honest note, not a fake strategy", () => {
  const entry = { mode: "builder", strategyId: "asian-range-london-breakout", params: {}, name: "x" };
  const src = toPineScript(entry);
  assert.ok(isNote(src), "returns the honest note");
  assert.ok(src.includes("asian-range-london-breakout"), "names the offending id");
  assert.equal(hasPineSource(entry), false, "hasPineSource is false");
});

test("null / empty entries never throw and never fake a strategy", () => {
  for (const e of [null, undefined, {}, { mode: "builder" }]) {
    const src = toPineScript(e);
    assert.ok(!src.includes("//@version=5"), "no fake header");
    assert.equal(hasPineSource(e), false, "hasPineSource is false");
  }
});

test("strategyToCode dispatches lang='pine' to the exporter", () => {
  const entry = {
    mode: "builder", strategyId: "sma-crossover", params: { fast: 20, slow: 50 },
    name: "SMA", positionPct: 100, feeBps: 10,
  };
  assert.equal(strategyToCode(entry, "pine"), toPineScript(entry), "delegates to toPineScript");
  // The other targets are unchanged and distinct from the Pine output.
  assert.notEqual(strategyToCode(entry, "js"), strategyToCode(entry, "pine"), "js != pine");
});

test("params are sanitised to numeric literals (no injection)", () => {
  const evil = {
    mode: "builder", strategyId: "sma-crossover",
    params: { fast: "20) \nstrategy.entry('x', strategy.long) //", slow: 50 },
    name: 'Evil "quote" \n newline', positionPct: 100, feeBps: 10,
  };
  const src = toPineScript(evil);
  // The hostile fast value is not a finite number → falls back to the default (20).
  assert.ok(src.includes("fast = input.int(20"), "hostile param replaced by default");
  assert.ok(!src.includes("strategy.entry('x'"), "no injected entry call");
  // The title is escaped and newline-flattened into a single string literal.
  assert.ok(!/strategy\([^\n]*\n[^\n]*newline/.test(src), "title newline neutralised");
});

test("pineHeader defaults are sane when meta is missing", () => {
  const h = pineHeader({}, { overlay: true });
  assert.ok(h.includes("default_qty_value=100"), "defaults positionPct to 100");
  assert.ok(h.includes("commission_value=0.1"), "defaults feeBps to 10 -> 0.1");
});
