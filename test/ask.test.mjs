// The chat over the board: planning, parsing, and the refusals.
//
// The parsing tests are the load-bearing ones. Every provider in the chain
// occasionally wraps JSON in a fence or a sentence, and a plan that silently
// parses to "no reads" would produce a confident answer with no data behind it.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ANSWER_SYSTEM, MAX_READS_PER_ROUND, PLANNER_SYSTEM,
  answerUser, catalogPrompt, parsePlan, plannerUser, screenPlan,
} from "../src/lib/board/ask.js";
import { listResources } from "../src/lib/board/catalog.js";

test("the catalog prompt carries ids, summaries and argument types", () => {
  const text = catalogPrompt(listResources({ visibility: "public" }));
  assert.match(text, /argus\.performance\(/);
  assert.match(text, /by:overall\|kind\|symbol/, "enums are listed so the model cannot invent a value");
  assert.match(text, /symbol\*/, "required arguments are marked");
  assert.ok(text.length < 6000, `the catalog is ${text.length} chars — it rides in every planner call`);
});

test("the planner is shown only what the caller may read", () => {
  const pub = plannerUser("what is going on", listResources({ visibility: "public" }));
  assert.doesNotMatch(pub, /portfolio\.holdings/);
  assert.doesNotMatch(pub, /registry\.strategies/);
  const adm = plannerUser("what is going on", listResources({ visibility: "admin" }));
  assert.match(adm, /portfolio\.holdings/);
});

test("a clean plan parses", () => {
  const p = parsePlan('{"reads":[{"resource":"argus.performance","args":{"by":"session"}}],"note":"slice the book"}');
  assert.equal(p.reads.length, 1);
  assert.equal(p.reads[0].resource, "argus.performance");
  assert.deepEqual(p.reads[0].args, { by: "session" });
  assert.equal(p.note, "slice the book");
});

test("a fenced or chatty reply still parses — every provider does this sometimes", () => {
  assert.equal(parsePlan('```json\n{"reads":[{"resource":"argus.status"}]}\n```').reads[0].resource, "argus.status");
  assert.equal(parsePlan('Sure! Here is the plan:\n{"reads":[{"resource":"argus.status"}]}\nHope that helps.')
    .reads[0].resource, "argus.status");
});

test("garbage returns null so the chain falls through to the next provider", () => {
  for (const bad of ["", "not json at all", "{", '{"reads":"argus.status"}', '{"note":"forgot the reads"}', null, 42]) {
    assert.equal(parsePlan(bad), null, `${JSON.stringify(bad)} must not parse`);
  }
  assert.equal(parsePlan("x".repeat(5000)), null, "an essay is not a plan");
});

test("an empty read set is a valid plan — 'nothing here answers that' is an answer", () => {
  const p = parsePlan('{"reads":[],"note":"no resource covers option greeks"}');
  assert.deepEqual(p.reads, []);
  assert.match(p.note, /option greeks/);
});

test("the plan is capped, and malformed entries are dropped rather than passed on", () => {
  const many = { reads: Array.from({ length: 20 }, () => ({ resource: "argus.status" })) };
  assert.equal(parsePlan(JSON.stringify(many)).reads.length, MAX_READS_PER_ROUND);
  const messy = parsePlan('{"reads":[{"resource":"argus.status"},{"nope":1},{"resource":"","args":{}},{"resource":"argus.trades","args":[1,2]}]}');
  assert.deepEqual(messy.reads.map((r) => r.resource), ["argus.status", "argus.trades"]);
  assert.deepEqual(messy.reads[1].args, {}, "an array is not an argument object");
});

test("screenPlan drops invented resources before they cost a round trip", () => {
  const known = listResources({ visibility: "public" }).map((r) => r.id);
  const { reads, dropped } = screenPlan(
    [{ resource: "argus.status" }, { resource: "argus.secrets" }, { resource: "portfolio.holdings" }],
    known,
  );
  assert.deepEqual(reads.map((r) => r.resource), ["argus.status"]);
  assert.deepEqual(dropped, ["argus.secrets", "portfolio.holdings"]);
});

test("the answer prompt carries the digests, their age, and any failure", () => {
  const at = Date.parse("2026-08-14T09:00:00Z");
  const user = answerUser("how is argus doing", [
    { resource: "argus.status", ok: true, asOf: at, stale: false, digest: "Argus · 2m ago\nEquity 7595" },
    { resource: "kronos.state", ok: true, asOf: at - 86_400_000, stale: true, digest: "Kronos · 1d ago" },
    { resource: "vol.iv", ok: false, error: "source_unavailable", detail: "upstream 503" },
  ]);
  assert.match(user, /Equity 7595/);
  assert.match(user, /\[STALE\]/, "the model must be told what is old");
  assert.match(user, /FAILED: source_unavailable \(upstream 503\)/);
  assert.match(user, /2026-08-14T09:00:00/);
});

test("two slices of the same resource are distinguishable in the prompt", () => {
  // A plan asking argus.performance by kind AND by session produced two
  // identical "### argus.performance" headings — the model could not tell which
  // table was which.
  const user = answerUser("which setups lose", [
    { resource: "argus.performance", args: { by: "kind" }, ok: true, asOf: 1, stale: false, digest: "by kind: …" },
    { resource: "argus.performance", args: { by: "session" }, ok: true, asOf: 1, stale: false, digest: "by session: …" },
  ]);
  assert.match(user, /### argus\.performance\(by=kind\)/);
  assert.match(user, /### argus\.performance\(by=session\)/);
});

test("the prompts state the rules the rest of the project runs on", () => {
  assert.match(ANSWER_SYSTEM, /NOT investment advice/);
  assert.match(ANSWER_SYSTEM, /Sample size travels with every average/);
  assert.match(ANSWER_SYSTEM, /Never recommend a trade/);
  assert.match(PLANNER_SYSTEM, /never invent an argument name/i);
});
