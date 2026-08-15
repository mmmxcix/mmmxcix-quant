// The D1 half of /api/statements.
//
// The property that matters most here is not a query detail: the MEASURED theme
// assignment and the MODEL's opinion are two different columns, and a write that
// merges them silently invalidates every number in docs/STATEMENTS_FINDINGS.md.

import { test } from "node:test";
import assert from "node:assert/strict";

import { clampInt, putStatements, readStatements, SPEAKER_ID, THEME_ID } from "../functions/_lib/statements.mjs";

function fakeDb({ missingUntilCreated = false, rows = [] } = {}) {
  const calls = { ddl: [], binds: [], sql: [] };
  let created = !missingUntilCreated;
  const prepare = (sql) => {
    calls.sql.push(sql);
    return {
      sql,
      bind(...args) {
        calls.binds.push({ sql, args });
        return {
          async run() {
            if (!created) throw new Error("D1_ERROR: no such table: statements");
            return { success: true };
          },
          async all() {
            if (!created) throw new Error("D1_ERROR: no such table: statements");
            return { results: rows };
          },
          async first() { return rows[0] ?? null; },
        };
      },
      async run() {
        if (/CREATE (TABLE|INDEX)/i.test(sql)) { calls.ddl.push(sql); created = true; return { success: true }; }
        return { success: true };
      },
    };
  };
  return {
    calls, prepare,
    async batch(list) {
      if (!created) throw new Error("D1_ERROR: no such table: statements");
      return list.map(() => ({ success: true }));
    },
  };
}

const row = (over = {}) => ({
  id: "tg:WalterBloomberg/34407", at: Date.UTC(2026, 7, 14, 20, 4),
  speakerId: "trump", speaker: "Donald Trump", role: "US President",
  quote: "PRETTY SOON I'LL BE DECLARING HORMUZ STRAIT A TERRITORY OF THE UNITED STATES",
  subject: "IRAN", channel: "WalterBloomberg", url: "https://t.me/WalterBloomberg/34407",
  themes: ["tankers"], modelThemes: ["tankers", "oil_gas"], agreement: "model-wider",
  confidence: "high", because: "a closed strait lengthens every voyage",
  ...over,
});

test("the measured themes and the model's are stored as separate columns", async () => {
  const db = fakeDb();
  assert.equal(await putStatements(db, [row()]), 1);
  const a = db.calls.binds[0].args;
  assert.equal(a[9], "tankers", "the lexicon's answer — the only one a statistic may attach to");
  assert.equal(a[10], "tankers,oil_gas", "the model's, recorded beside it");
  assert.equal(a[11], "model-wider");
  assert.equal(JSON.parse(a[14]).quote, row().quote);
});

test("a statement the lexicon did not recognise is still stored, with no measured theme", async () => {
  const db = fakeDb();
  await putStatements(db, [row({ speakerId: null, themes: [], modelThemes: ["semis"], agreement: "model-only" })]);
  const a = db.calls.binds[0].args;
  assert.equal(a[9], null, "an empty measured list is NULL, never the model's list");
  assert.equal(a[10], "semis");
  assert.equal(a[11], "model-only");
});

test("a row without an id, a time or a quote is not stored", async () => {
  const db = fakeDb();
  assert.equal(await putStatements(db, [row({ id: "" }), row({ at: 0 }), row({ quote: "" })]), 0);
  assert.equal(await putStatements(db, []), 0);
});

test("the table creates itself on first use, then the write retries", async () => {
  const db = fakeDb({ missingUntilCreated: true });
  assert.equal(await putStatements(db, [row()]), 1);
  assert.ok(db.calls.ddl.some((s) => /CREATE TABLE IF NOT EXISTS statements/.test(s)));
});

test("re-pushing the same statement updates the classification and never duplicates", async () => {
  const db = fakeDb();
  await putStatements(db, [row()]);
  assert.match(db.calls.binds[0].sql, /ON CONFLICT\(id\) DO UPDATE/);
  // The quote and the timestamp are NOT in the update list — a wire desk editing
  // its own line later must not silently move when a statement was made.
  assert.doesNotMatch(db.calls.binds[0].sql, /DO UPDATE SET[\s\S]*\bat = excluded/);
});

test("the theme filter is comma-bounded so one id cannot match another's prefix", async () => {
  const db = fakeDb({ rows: [] });
  await readStatements(db, { theme: "semis" });
  const { sql, args } = db.calls.binds[db.calls.binds.length - 1];
  assert.match(sql, /\(',' \|\| themes \|\| ','\) LIKE \?/);
  assert.equal(args[1], "%,semis,%", "not '%semis%', which would also match semis_legacy");
});

test("limits clamp and absent parameters take the default", () => {
  assert.equal(clampInt("9999", 1, 500, 100), 500);
  assert.equal(clampInt("0", 1, 500, 100), 1);
  assert.equal(clampInt(null, 1, 3650, 30), 30, "absent is the default, not the minimum");
  assert.equal(clampInt("", 1, 3650, 30), 30);
});

test("the id patterns refuse everything that is not an id", () => {
  for (const ok of ["trump", "china_adrs", "oil_gas"]) {
    assert.ok(THEME_ID.test(ok) && SPEAKER_ID.test(ok), ok);
  }
  for (const bad of ["../../etc/passwd", "a' OR 1=1 --", "Trump", "", "%", "9lives"]) {
    assert.ok(!THEME_ID.test(bad), `${bad} must not pass`);
  }
});
