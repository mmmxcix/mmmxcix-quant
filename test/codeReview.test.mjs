import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCodeReview } from "../functions/_lib/codegen.mjs";

test("parseCodeReview extracts fenced JSON, normalises severities, flags buggy", () => {
  const r = parseCodeReview('```json\n{"verdict":"buggy","bugs":[{"severity":"critical","issue":"single-asset arbitrage cancels to 0","fix":"use 3 real pairs"},{"severity":"warning","issue":"no stop","fix":"add ATR stop"}],"confidence":20,"summary":"degenerate"}\n```');
  assert.equal(r.verdict, "buggy");
  assert.equal(r.bugs.length, 2);
  assert.equal(r.bugs.filter((b) => b.severity === "critical").length, 1);
  assert.equal(r.confidence, 20);
});

test("a clean review has no bugs and a high confidence", () => {
  const r = parseCodeReview('{"verdict":"clean","bugs":[],"confidence":85,"summary":"looks correct"}');
  assert.equal(r.verdict, "clean");
  assert.equal(r.bugs.length, 0);
  assert.equal(r.confidence, 85);
});

test("any critical bug forces verdict=buggy even if the model said clean", () => {
  const r = parseCodeReview('{"verdict":"clean","bugs":[{"severity":"critical","issue":"look-ahead","fix":"shift"}],"confidence":90}');
  assert.equal(r.verdict, "buggy");
});

test("unparseable / prose reply degrades to verdict=unknown, not a throw", () => {
  const r = parseCodeReview("I think the code looks mostly fine honestly");
  assert.equal(r.verdict, "unknown");
  assert.equal(r.bugs.length, 0);
  assert.equal(r.confidence, 0);
});

test("confidence is clamped to [0,100]", () => {
  assert.equal(parseCodeReview('{"bugs":[],"confidence":250}').confidence, 100);
  assert.equal(parseCodeReview('{"bugs":[],"confidence":-9}').confidence, 0);
});
