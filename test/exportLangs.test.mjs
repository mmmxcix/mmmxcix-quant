import { test } from "node:test";
import assert from "node:assert/strict";
import { toRust, toCpp, toQ } from "../src/lib/exportLangs.js";

const src = "const SMA_FAST = 10;\nfunction strategy(ctx){ return ctx.sma(SMA_FAST) > ctx.sma(50) ? 'long' : 'flat'; }";

test("toRust: HFT-ready scaffold with typed constants + embedded validated source", () => {
  const out = toRust({ name: "Trend", source: src, sourceLang: "js" });
  assert.match(out, /pub fn signals\(bars: &\[Bar\]\) -> Vec<i8>/, "correct Rust signature");
  assert.match(out, /const SMA_FAST: f64 = 10/, "tunable constant typed as f64");
  assert.match(out, /pub struct Bar/, "Bar struct");
  assert.ok(out.includes("SMA_FAST = 10"), "embeds the exact validated source as the spec");
  assert.match(out, /not runnable in this tool/, "honest: labelled reference-only");
});

test("all three reference exports share the +1/0/-1 contract and never claim to run here", () => {
  for (const fn of [toRust, toCpp, toQ]) {
    const out = fn({ name: "X", source: src, sourceLang: "js" });
    assert.match(out, /1 long, 0 flat, -1 short/);
    assert.match(out, /REFERENCE|reference/);
  }
});
