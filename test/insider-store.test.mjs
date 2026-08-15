// The D1 half of /api/insider.
//
// Unlike the Argus archive, this store IS the record rather than a shadow of
// one — a write that fails silently here does not degrade a display, it looks
// like the insiders stopped trading. So the properties are: the columns say what
// the JSON says, the tables build themselves, and nothing a caller sends can
// choose a table, a column or a predicate.

import { test } from "node:test";
import assert from "node:assert/strict";

import { clampInt, filingColumns, putClusters, putFilings, readFilings, TICKER } from "../functions/_lib/insider.mjs";

/** A minimal D1 stand-in that records the SQL and the bindings it was given. */
function fakeDb({ missingUntilCreated = false, failWith = null, rows = [] } = {}) {
  const calls = { ddl: [], binds: [], sql: [] };
  let created = !missingUntilCreated;
  const prepare = (sql) => {
    calls.sql.push(sql);
    return {
      sql,
      bind(...args) {
        calls.binds.push({ sql, args });
        return {
          sql, args,
          async run() {
            if (failWith) throw new Error(failWith);
            if (!created) throw new Error("D1_ERROR: no such table: insider_filings");
            return { success: true };
          },
          async all() {
            if (!created) throw new Error("D1_ERROR: no such table: insider_filings");
            return { results: rows };
          },
          async first() { return rows[0] ?? null; },
        };
      },
      async run() {
        if (/CREATE (TABLE|INDEX)/i.test(sql)) { calls.ddl.push(sql); created = true; return { success: true }; }
        if (failWith) throw new Error(failWith);
        return { success: true };
      },
    };
  };
  return {
    calls, prepare,
    async batch(list) {
      if (failWith) throw new Error(failWith);
      if (!created) throw new Error("D1_ERROR: no such table: insider_filings");
      return list.map(() => ({ success: true }));
    },
  };
}

const filing = (over = {}) => ({
  accession: "0001234567-26-000001",
  filedAt: Date.UTC(2026, 2, 4), periodAt: Date.UTC(2026, 2, 2),
  issuerCik: "0000123456", issuer: "Acme Corp", symbol: "ACME",
  owners: [{ cik: "0000000042", name: "Doe Jane", isDirector: false, isOfficer: true, isTenPercent: false, isOther: false, title: "CEO" }],
  trans: [
    { date: Date.UTC(2026, 2, 2), code: "P", shares: 1000, price: 12.5, ad: "A", ownership: "D", security: "Common Stock" },
    { date: Date.UTC(2026, 2, 2), code: "S", shares: 400, price: 13, ad: "D", ownership: "D", security: "Common Stock" },
    { date: Date.UTC(2026, 2, 2), code: "A", shares: 9999, price: 0, ad: "A", ownership: "D", security: "Common Stock" },
  ],
  ...over,
});

test("purchases and sales are split into their own columns; grants are neither", () => {
  const c = filingColumns(filing());
  assert.equal(c.buy_shares, 1000);
  assert.equal(c.buy_value, 12_500);
  assert.equal(c.sell_shares, 400);
  assert.equal(c.sell_value, 5_200);
  assert.equal(c.codes, "APS", "every code on the filing is recorded, sorted, for display");
  assert.equal(c.roles, "officer");
  assert.equal(c.symbol, "ACME");
});

test("the row carries the full filing as JSON next to its queryable columns", async () => {
  const db = fakeDb();
  assert.equal(await putFilings(db, [filing()]), 1);
  const args = db.calls.binds[0].args;
  assert.equal(args[0], "0001234567-26-000001");
  assert.equal(args[1], Date.UTC(2026, 2, 4), "the filing date, in milliseconds like everything else here");
  assert.equal(JSON.parse(args[13]).owners[0].title, "CEO");
});

test("a filing with no accession or no filing date is not stored at all", async () => {
  const db = fakeDb();
  assert.equal(await putFilings(db, [{ accession: "", filedAt: 1 }, { accession: "x", filedAt: 0 }]), 0);
  assert.equal(await putFilings(db, []), 0);
});

test("the tables create themselves on first use, then the write retries", async () => {
  const db = fakeDb({ missingUntilCreated: true });
  assert.equal(await putFilings(db, [filing()]), 1);
  assert.ok(db.calls.ddl.some((s) => /CREATE TABLE IF NOT EXISTS insider_filings/.test(s)));
  assert.ok(db.calls.ddl.some((s) => /CREATE INDEX/.test(s)));
});

test("a cluster is keyed by issuer and the date it became knowable, so a rerun updates in place", async () => {
  const db = fakeDb();
  const e = { issuerCik: "0000123456", issuer: "Acme", symbol: "ACME", knownAt: 1_770_000_000_000, insiders: 3, filings: 3, value: 1e6, shares: 1000, roles: ["officer", "director"], names: ["A", "B"], firstBuyAt: 1, lastBuyAt: 2, maxLagDays: 4 };
  assert.equal(await putClusters(db, [e], { windowDays: 10 }), 1);
  const args = db.calls.binds[0].args;
  assert.equal(args[0], "0000123456:1770000000000");
  assert.match(db.calls.binds[0].sql, /ON CONFLICT\(id\) DO UPDATE/);
  assert.equal(args[14], JSON.stringify({ windowDays: 10 }), "the setting that produced the row travels with it");
});

test("the purchases-only predicate is chosen here, never written by the caller", async () => {
  const db = fakeDb({ rows: [] });
  await readFilings(db, { purchasesOnly: true });
  assert.match(db.calls.sql[0], /buy_shares > 0/);
  const db2 = fakeDb({ rows: [] });
  await readFilings(db2, { purchasesOnly: false });
  assert.doesNotMatch(db2.calls.sql[0], /buy_shares > 0/);
});

test("limits clamp instead of trusting the caller", () => {
  assert.equal(clampInt("999999", 1, 500, 100), 500);
  assert.equal(clampInt("-5", 1, 500, 100), 1);
  assert.equal(clampInt("abc", 1, 500, 100), 100);
  assert.equal(clampInt(null, 1, 3650, 90), 90);
});

test("the ticker class refuses everything that is not a ticker", () => {
  for (const ok of ["ACME", "BRK.B", "RDS-A", "F"]) assert.ok(TICKER.test(ok), ok);
  for (const bad of ["../../etc/passwd", "A'; DROP TABLE", "acme", "", "TOOLONGSYMBOL", "1ABC"]) {
    assert.ok(!TICKER.test(bad), `${bad} must not pass`);
  }
});
