// The executor's adaptive poll: quick when a human is waiting, quiet when the
// queue is empty. The numbers in these tests are the reason the module exists.
import test from "node:test";
import assert from "node:assert/strict";
import { nextDelay, dailyPollsIdle, PACE_DEFAULTS } from "../src/lib/pollPace.js";

const { minMs, maxMs, warmMs } = PACE_DEFAULTS;

test("a warm queue is polled at full speed", () => {
  // Right after a job, and for the whole warm window.
  assert.equal(nextDelay({ idleRounds: 0, sinceJobMs: 0 }), minMs);
  assert.equal(nextDelay({ idleRounds: 5, sinceJobMs: warmMs - 1 }), minMs,
    "still warm — idle rounds must not slow it down inside the window");
});

test("an idle queue backs off, doubling to the ceiling and no further", () => {
  const at = (r) => nextDelay({ idleRounds: r, sinceJobMs: warmMs + 1 });
  assert.equal(at(0), minMs);
  assert.equal(at(1), 2 * minMs);
  assert.equal(at(2), maxMs, "third round is already capped (4→8→12)");
  assert.equal(at(50), maxMs, "and it never climbs past the ceiling");
  assert.equal(at(1e9), maxMs, "not even with an absurd round count");
});

test("the ceiling stays inside human patience", () => {
  // The person who pressed "run" is waiting for this. 12s is the agreed worst
  // case; if someone raises it, this test is where they have to argue with it.
  assert.ok(maxMs <= 15_000, `worst-case start delay ${maxMs}ms is too long for a UI queue`);
});

test("equal min and max restores the old fixed interval", () => {
  // The escape hatch: LAB_EXECUTOR_POLL_MAX_MS = LAB_EXECUTOR_POLL_MS.
  for (const r of [0, 3, 99]) {
    assert.equal(nextDelay({ idleRounds: r, sinceJobMs: Infinity, minMs: 4000, maxMs: 4000 }), 4000);
  }
});

test("an agent that has never seen a job backs off by rounds, not by clock", () => {
  assert.equal(nextDelay({ idleRounds: 4, sinceJobMs: Infinity }), maxMs);
  // With no state at all the answer is the FAST pace, and that is deliberate:
  // uncertainty resolves toward answering the person who is waiting. The
  // back-off is earned by counted empty answers, never assumed.
  assert.equal(nextDelay({}), minMs);
});

test("the saving is real, and this is the arithmetic", () => {
  const before = dailyPollsIdle(4_000);
  const after = dailyPollsIdle(maxMs);
  assert.equal(before, 21_600, "the old fixed 4s pace");
  assert.equal(after, 7_200, "the new idle pace");
  assert.ok(before - after >= 14_000, `saving of ${before - after} requests/day`);
  // Worker free tier is 100k requests/day: this alone gives back ~14% of it.
  assert.ok((before - after) / 100_000 > 0.14);
});
