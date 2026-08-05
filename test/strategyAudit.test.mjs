import { test } from "node:test";
import assert from "node:assert/strict";
import { auditStrategy } from "../src/lib/strategyAudit.js";

test("catches the Bellman-Ford single-asset arbitrage illusion (critical)", () => {
  const code = `
    function strategy(ctx){
      const C0 = ctx.close, C1 = ctx.closes[ctx.i-1];
      // fake triangular arbitrage on one asset
      const w = -Math.log(C0/C1) - Math.log(C1) + Math.log(C0); // negative cycle via Bellman-Ford
      return w < 0 ? "long" : "flat";
    }`;
  const a = auditStrategy(code, "js");
  assert.ok(a.blocked, "blocked");
  assert.ok(a.findings.some((f) => f.id === "arbitrage-illusion" && f.severity === "critical"));
});

test("catches look-ahead (reading a future bar)", () => {
  assert.ok(auditStrategy("const nextHi = candles[i+1].high; return close > nextHi ? 'long':'flat';", "js").blocked);
  assert.ok(auditStrategy("df['sig'] = df['close'].shift(-1) > df['close']", "python").blocked);
});

test("flags a strategy with NO risk exit (warn, not blocked)", () => {
  const code = `function strategy(ctx){ return ctx.rsi < 30 ? "long" : ctx.rsi > 70 ? "short" : "flat"; }`;
  const a = auditStrategy(code, "js");
  assert.equal(a.blocked, false, "a missing stop is a warning, not a hard block");
  assert.ok(a.findings.some((f) => f.id === "no-risk-exit" && f.severity === "warn"));
});

test("catches a constant, price-independent signal (critical)", () => {
  const a = auditStrategy(`function strategy(){ return "long"; }`, "js");
  assert.ok(a.blocked && a.findings.some((f) => f.id === "constant-signal"));
});

test("a healthy strategy (real logic + ATR stop, no look-ahead) passes clean", () => {
  const code = `
    function strategy(ctx){
      const atr = ctx.indicators.atr(14);
      const trend = ctx.sma(50);
      if (ctx.close > trend && ctx.rsi(2) < 10) return { signal: "long", stop: ctx.close - 2*atr, target: ctx.close + 3*atr };
      if (ctx.close < trend && ctx.rsi(2) > 90) return { signal: "short", stop: ctx.close + 2*atr, target: ctx.close - 3*atr };
      return "flat";
    }`;
  const a = auditStrategy(code, "js");
  assert.equal(a.blocked, false);
  assert.equal(a.critical, 0);
  assert.equal(a.warnings, 0, "clean code raises no warnings");
});

test("legit integer comparisons don't trip the float-equality warning", () => {
  // These used to warn because the file contained a `*`/`/` somewhere — a false
  // positive the AI-applied fixes kept hitting (i===0, count===0, .length===0).
  const code = `
    function strategy(ctx){
      const atr = ctx.indicators.atr(14);
      let count = 0;
      for (let i = 0; i < ctx.i; i++) { if (i === 0) continue; count = count + 1; }
      const signal = ctx.rsi(2) < 10 ? 1 : 0;
      if (signal === 1 && ctx.closes.length % 2 === 0) return { signal: "long", stop: ctx.close - 2*atr, target: ctx.close + 3*atr };
      return "flat";
    }`;
  const a = auditStrategy(code, "js");
  assert.equal(a.findings.some((f) => f.id === "float-equality"), false, "integer idioms must not warn");
});

test("a genuine computed-float equality still warns", () => {
  assert.ok(auditStrategy(`function strategy(ctx){ return Math.abs(ctx.close - ctx.sma(50)) === 0 ? "long" : "flat"; }`, "js")
    .findings.some((f) => f.id === "float-equality"), "Math.* === 0 warns");
  assert.ok(auditStrategy(`function strategy(ctx){ return ctx.rsi(2) === 1.5 ? "long" : "flat"; }`, "js")
    .findings.some((f) => f.id === "float-equality"), "=== decimal literal warns");
});

test("catches a side-inverted short bracket (critical), leaves a correct dual-side clean", () => {
  // The real Square-Root/RSI-ATR bug: short reuses the long's close−ATR stop.
  const inverted = `function strategy(ctx){
    const atr = ctx.indicators.atr(ctx.candles,14);
    const stop = ctx.close - atr*1.5;
    const target = ctx.close + atr*1.5;
    if (ctx.rsi < 30) return { signal: "long", stop, target };
    if (ctx.rsi > 70) return { signal: "short", stop, target };
    return "flat";
  }`;
  const a = auditStrategy(inverted, "js");
  assert.ok(a.findings.some((f) => f.id === "inverted-short-bracket" && f.severity === "critical"));

  // A correct dual-side strategy computes a close+ATR stop for the short → no flag.
  const correct = `function strategy(ctx){
    const atr = ctx.indicators.atr(ctx.candles,14);
    if (ctx.rsi < 30) return { signal: "long", stop: ctx.close - atr*1.5, target: ctx.close + atr*3 };
    if (ctx.rsi > 70) return { signal: "short", stop: ctx.close + atr*1.5, target: ctx.close - atr*3 };
    return "flat";
  }`;
  assert.equal(auditStrategy(correct, "js").findings.some((f) => f.id === "inverted-short-bracket"), false);
});

test("empty / missing code is a no-op, not a crash", () => {
  const a = auditStrategy("", "js");
  assert.deepEqual(a, { findings: [], blocked: false, critical: 0, warnings: 0 });
});
