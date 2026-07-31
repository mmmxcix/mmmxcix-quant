// strategyname.test.mjs — Cortex names strategies by mechanism, not by source.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanStrategyName, describeStrategy } from "../functions/_lib/strategyName.js";

const emaCode = "// NAME: x\nfunction strategy(ctx){ const ema=EMA(50); const rsi=RSI(14); if(ema>0 && rsi<30) return 1; return -1; }";
const adxCode = "// ADX trend filter breakout\nfunction strategy(ctx){ const adx=ADX(14); if(adx>25) return -1; }";
const orbCode = "// opening range breakout ORB\nfunction strategy(ctx){ return 1; }";

test("clickbait / source-title names are replaced with a mechanism name", () => {
  for (const raw of [
    "Bitcoin looks like Google did in its early days",
    "DAX30 -LONG SET UP",
    "[research] Claude Opus 5 + MCP = New King of Algo Trading!",
    "Natural Gas: Bullish recovery faces the $3.00 test",
  ]) {
    const out = cleanStrategyName(raw, emaCode);
    assert.notEqual(out, raw);
    assert.ok(!out.toLowerCase().includes("looks like"));
    assert.ok(!out.includes("[research]"));
    assert.ok(out.length > 0 && out.length <= 70);
  }
});

test("a good mechanism name is preserved verbatim", () => {
  assert.equal(cleanStrategyName("Volatility-filtered EMA pullback", emaCode), "Volatility-filtered EMA pullback");
  assert.equal(cleanStrategyName("RSI-2 dip buy in uptrend", ""), "RSI-2 dip buy in uptrend");
});

test("[research] and emoji decoration is stripped", () => {
  assert.ok(!cleanStrategyName("[research] EMA/RSI momentum", emaCode).includes("["));
  assert.ok(!cleanStrategyName("🤖 EMA/RSI momentum", emaCode).includes("🤖"));
});

test("describeStrategy names by indicators + behaviour + side", () => {
  assert.match(describeStrategy(adxCode), /ADX/);
  assert.match(describeStrategy(orbCode), /Opening-Range Breakout/i);
  // long-only code should not be labelled long/short
  assert.ok(!/long\/short/.test(describeStrategy(orbCode)));
});

test("empty name falls back to a derived mechanism name", () => {
  assert.match(cleanStrategyName("", adxCode), /ADX/);
});
