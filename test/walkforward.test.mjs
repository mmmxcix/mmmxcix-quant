import { test } from "node:test";
import assert from "node:assert/strict";
import { walkForward, walkForwardVerdict, contextOf } from "../src/lib/argus/walkforward.js";

// The circle this breaks: lessons derived from the whole ledger and applied to
// that same ledger cannot be wrong. Every claim about the learning loop's value
// rested on that, including mine. Here a lesson may only see trades that had
// already CLOSED before the trade it is judging opened.

const T = (o) => ({
  state: "closed", symbol: "BTCUSDT", side: "long", kind: "breakout",
  riskAmt: 100, ...o,
  pnl: (o.R ?? 0) * 100,
});

// A ledger where one setup is reliably bad and another reliably good.
const ledger = (n = 120) => Array.from({ length: n }, (_, i) => {
  const bad = i % 2 === 0;
  const at = 1_700_000_000_000 + i * 3600e3;
  return T({
    kind: bad ? "orb" : "liquidity-sweep",
    R: bad ? -1 : (i % 6 === 1 ? -1 : 1.2),
    openedAt: at, exitAt: at + 1800e3,
  });
});

test("a lesson never sees the trade it is judging, nor anything after it", () => {
  // The strongest form of the check: a setup that works for sixty trades and
  // then breaks completely. A leaking replay would refuse the bad era from its
  // first trade, because it would already know how the story ends.
  const half = 60;
  const led = Array.from({ length: 120 }, (_, i) => {
    const at = 1_700_000_000_000 + i * 3600e3;
    return T({ kind: "breakout", R: i < half ? 1.2 : -1, openedAt: at, exitAt: at + 1800e3 });
  });
  const wf = walkForward(led, { warmup: 10, minSample: 10 });
  assert.equal(wf.refused.n, 0, "nothing may be refused on evidence that had not happened yet");
  assert.equal(wf.kept.n, 110);
});

test("KNOWN LIMITATION: the loop never forgets, so a regime change never registers", () => {
  // The above passes for the right reason and a wrong one at the same time, and
  // the harness existing is what made the second one visible.
  //
  // Lessons are computed over the WHOLE past with equal weight. After sixty
  // winning trades at +1.2R, sixty straight full-stop losses still leave the
  // bucket at (72 − 60) / 120 = +0.1R — so a setup that has stopped working
  // entirely is never switched off, however long it keeps failing. Markets
  // change; this loop weights a lesson from months ago exactly like yesterday's.
  //
  // Pinned as a test rather than fixed on the spot, because the fix is a recency
  // weighting and its half-life is a decision that wants data, not a guess.
  const led = Array.from({ length: 120 }, (_, i) => {
    const at = 1_700_000_000_000 + i * 3600e3;
    return T({ kind: "breakout", R: i < 60 ? 1.2 : -1, openedAt: at, exitAt: at + 1800e3 });
  });
  const wf = walkForward(led, { warmup: 10, minSample: 10 });
  assert.equal(wf.refused.n, 0, "sixty consecutive losses are currently not enough");
  assert.ok(wf.kept.avgR < 0.2, "…and the kept book carries every one of them");
});

test("warm-up trades are reported separately, not counted as decisions", () => {
  const wf = walkForward(ledger(), { warmup: 25, minSample: 10 });
  assert.equal(wf.warmup.n, 25);
  assert.equal(wf.decided.n, wf.kept.n + wf.refused.n);
  assert.equal(wf.decided.n, 120 - 25, "everything after warm-up is a decision");
});

test("a loop that finds the bad setup keeps the better book", () => {
  const wf = walkForward(ledger(160), { warmup: 20, minSample: 10 });
  assert.ok(wf.refused.n > 0, "the reliably losing setup must get refused");
  assert.ok(wf.kept.avgR > wf.decided.avgR, "the surviving book must beat the traded one");
  assert.ok(wf.edgeR > 0);
  const v = walkForwardVerdict(wf);
  assert.equal(v.proven, true, v.reason);
});

test("a loop that refuses at random proves nothing", () => {
  // Every setup identical and equally mediocre: there is nothing to learn, so
  // whatever gets refused must not look like skill.
  let seed = 3;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const led = Array.from({ length: 160 }, (_, i) => {
    const at = 1_700_000_000_000 + i * 3600e3;
    return T({ kind: "breakout", R: rnd() > 0.7 ? 1.5 : -0.6, openedAt: at, exitAt: at + 1800e3 });
  });
  const wf = walkForward(led, { warmup: 20, minSample: 10 });
  const v = walkForwardVerdict(wf);
  if (v.proven) assert.ok(Math.abs(v.diff) < 0.5, `noise should not produce a large edge, got ${v.diff}`);
});

test("the verdict refuses to rule on a lopsided split", () => {
  const wf = { kept: { n: 100, avgR: 0.4 }, refused: { n: 3, avgR: -1 }, decided: { n: 103 } };
  const v = walkForwardVerdict(wf);
  assert.equal(v.proven, false);
  assert.match(v.reason, /too few/);
});

test("a loop whose refusals did BETTER is called out, not quietly passed", () => {
  const wf = { kept: { n: 40, avgR: -0.3 }, refused: { n: 40, avgR: 0.5 }, decided: { n: 80 } };
  const v = walkForwardVerdict(wf);
  assert.equal(v.proven, false);
  assert.match(v.reason, /refused did BETTER/);
});

test("the replay context matches what the live agent passes", () => {
  const c = contextOf(T({ kind: "orb", side: "short", symbol: "ETHUSDT", regime: "Bull", openedAt: Date.parse("2026-08-12T09:00:00Z") }));
  assert.equal(c.kind, "orb");
  assert.equal(c.side, "short");
  assert.equal(c.regime, "Bull");
  assert.equal(c.session, "london", "09:00 UTC is the London bucket");
  assert.equal(c.source, "technical");
});

test("an empty or unusable ledger returns zeroes rather than throwing", () => {
  for (const bad of [[], null, [{ state: "open" }], [{ state: "closed" }]]) {
    const wf = walkForward(bad);
    assert.equal(wf.decided.n, 0);
    assert.equal(wf.edgeR, 0);
  }
});
