import { test } from "node:test";
import assert from "node:assert/strict";
import { canOpen, openedToday, paceStatus, dayKey, DEFAULT_MAX_CONCURRENT, DEFAULT_MAX_PER_DAY } from "../src/lib/argus/pace.js";

// Risk sizing does not limit how OFTEN the agent acts: heat caps what is at
// stake, so a run of tight-stop trades opens many small positions and never
// touches the cap. The live ledger did 95 trades in 1.6 days with 9 open at
// once. These caps are the part of that which is fixable for free.

const at = (iso) => Date.parse(iso);
const trade = (iso) => ({ openedAt: at(iso) });

test("the concurrency cap blocks a new trade", () => {
  assert.equal(canOpen(3, 0, { maxConcurrent: 4 }).ok, true);
  const no = canOpen(4, 0, { maxConcurrent: 4 });
  assert.equal(no.ok, false);
  assert.match(no.reason, /already open/);
});

test("the daily cap blocks a new trade even with room to hold it", () => {
  const no = canOpen(0, 12, { maxConcurrent: 4, maxPerDay: 12 });
  assert.equal(no.ok, false);
  assert.match(no.reason, /opened today/);
});

test("today's count includes OPEN positions, not just closed ones", () => {
  // The failure this prevents: a cap counting only closed trades resets itself
  // whenever positions stay open — precisely when the agent is most active.
  const now = at("2026-08-13T20:00:00Z");
  const ledger = [trade("2026-08-13T01:00:00Z"), trade("2026-08-13T02:00:00Z")];
  const open = [trade("2026-08-13T19:00:00Z"), trade("2026-08-13T19:30:00Z")];
  assert.equal(openedToday(ledger, open, now), 4);
});

test("yesterday's trades do not spend today's budget", () => {
  const now = at("2026-08-13T00:30:00Z");
  const ledger = [trade("2026-08-12T23:00:00Z"), trade("2026-08-13T00:10:00Z")];
  assert.equal(openedToday(ledger, [], now), 1);
  assert.notEqual(dayKey(at("2026-08-12T23:59:59Z")), dayKey(at("2026-08-13T00:00:01Z")));
});

test("a cap of zero means unlimited, not blocked", () => {
  // Opting out must not be the same as opting into a total freeze.
  assert.equal(canOpen(99, 99, { maxConcurrent: 0, maxPerDay: 0 }).ok, true);
});

test("the status report says what is left", () => {
  const now = at("2026-08-13T12:00:00Z");
  const open = [trade("2026-08-13T09:00:00Z"), trade("2026-08-13T10:00:00Z")];
  const ledger = [trade("2026-08-13T08:00:00Z")];
  const s = paceStatus(ledger, open, {}, now);
  assert.equal(s.open, 2);
  assert.equal(s.openedToday, 3);
  assert.equal(s.concurrencyLeft, DEFAULT_MAX_CONCURRENT - 2);
  assert.equal(s.dayLeft, DEFAULT_MAX_PER_DAY - 3);
  assert.equal(s.blocked, false);
});

test("the defaults are a real reduction on what the ledger actually did", () => {
  // 95 trades in 1.6 days is ~59/day with a peak of 9 concurrent. A cap that
  // would not have bound anything is not a cap.
  assert.ok(DEFAULT_MAX_PER_DAY < 59 / 2, "the daily budget must be well under the observed rate");
  assert.ok(DEFAULT_MAX_CONCURRENT < 9, "the concurrency cap must bind against the observed peak");
});
