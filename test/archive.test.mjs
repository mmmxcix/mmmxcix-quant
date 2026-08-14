// The durable record under the Argus snapshot.
//
// The rule these tests exist for: a 24/7 agent must never stop saving its state
// because an archive write failed. Everything else here is secondary.

import { test } from "node:test";
import assert from "node:assert/strict";

import { archiveTrades, appendHistory } from "../functions/_lib/archive.mjs";

/** A minimal D1 stand-in that records what it was asked to do. */
function fakeDb({ failWith = null, missingUntilCreated = false } = {}) {
  const calls = { ddl: [], binds: [], batches: 0 };
  let created = !missingUntilCreated;
  const stmt = (sql) => ({
    sql,
    bind(...args) {
      calls.binds.push({ sql, args });
      return {
        sql, args,
        async run() {
          if (failWith) throw new Error(failWith);
          if (!created) throw new Error("D1_ERROR: no such table: argus_history");
          return { success: true };
        },
      };
    },
    async run() {
      if (/CREATE (TABLE|INDEX)/i.test(sql)) { calls.ddl.push(sql); created = true; return { success: true }; }
      if (failWith) throw new Error(failWith);
      return { success: true };
    },
  });
  return {
    calls,
    prepare: stmt,
    async batch(list) {
      if (failWith) throw new Error(failWith);
      if (!created) throw new Error("D1_ERROR: no such table: argus_trades");
      calls.batches++;
      return list.map(() => ({ success: true }));
    },
  };
}

const trade = (over = {}) => ({
  id: "t1", symbol: "BTCUSDT", market: "crypto", side: "long", kind: "breakout",
  outcome: "stop", openedAt: Date.UTC(2026, 7, 14, 9, 30), exitAt: Date.UTC(2026, 7, 14, 11, 0),
  R: -1.1, pnl: -110, riskAmt: 100, plannedR: 1.5, ...over,
});

const state = { equity: 7595, markEquity: 7590, unrealized: -5, dayPnl: -18, open: 2, forming: 1, heatPct: 0.043, heatCapPct: 0.2, portfolioLev: 6.05, halted: false };

test("closed trades are written with their queryable columns filled in", async () => {
  const db = fakeDb();
  assert.equal(await archiveTrades(db, [trade()]), 1);
  const bound = db.calls.binds[0].args;
  assert.equal(bound[0], "t1");
  assert.equal(bound[5], "london", "the session is derived once, at write time");
  assert.equal(bound[9], -1.1);
  assert.equal(JSON.parse(bound[12]).symbol, "BTCUSDT", "the full row travels as JSON alongside");
});

test("R is derived for a legacy row that only has pnl and riskAmt", async () => {
  const db = fakeDb();
  const legacy = trade(); delete legacy.R;
  await archiveTrades(db, [legacy]);
  assert.equal(db.calls.binds[0].args[9], -1.1, "tradeR() fills it rather than storing 0");
});

test("a trade without an exit is not archived — the table is the CLOSED book", async () => {
  const db = fakeDb();
  assert.equal(await archiveTrades(db, [trade({ exitAt: 0 }), { id: null }]), 0);
});

test("the tables create themselves on first use, then the write retries", async () => {
  const db = fakeDb({ missingUntilCreated: true });
  assert.equal(await appendHistory(db, state, 1_786_000_000_000), true);
  assert.ok(db.calls.ddl.some((s) => /CREATE TABLE IF NOT EXISTS argus_history/.test(s)));
  assert.ok(db.calls.ddl.some((s) => /CREATE INDEX/.test(s)));
});

test("heat is stored as the fraction the agent writes, not the percentage the UI shows", async () => {
  const db = fakeDb();
  await appendHistory(db, state, 1_786_000_000_000);
  const bound = db.calls.binds[db.calls.binds.length - 1].args;
  assert.equal(bound[7], 0.043);
  assert.equal(bound[8], 0.2);
  assert.equal(bound[10], 0, "halted is a 0/1 integer");
});

test("an archive failure is swallowed — the agent's persist must never depend on it", async () => {
  const broken = fakeDb({ failWith: "D1_ERROR: database is locked" });
  assert.equal(await archiveTrades(broken, [trade()]), 0);
  assert.equal(await appendHistory(broken, state), false);
  // And a missing binding is simply nothing to do, not a throw.
  assert.equal(await archiveTrades(null, [trade()]), 0);
  assert.equal(await appendHistory(null, state), false);
});
