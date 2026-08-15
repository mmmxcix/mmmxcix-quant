// insider.mjs — the D1 half of /api/insider.
//
// Same three rules as functions/_lib/archive.mjs, for the same reasons:
//
//   1. The tables create themselves on first use. The writer is an unattended
//      agent on the user's PC; a migration step nobody ran is a silent gap that
//      only shows up as an empty page weeks later.
//   2. Writes are idempotent. The agent re-reads a few days of the daily index
//      on every pass (a filing can be disseminated late), so the same accession
//      arrives repeatedly and must neither duplicate nor lose anything.
//   3. Reads are bounded by construction. Every limit clamps, every ordering is
//      fixed here rather than taken from the caller, and no caller-supplied
//      string ever reaches a column or table name — /api/argus once bound an
//      arbitrary key into a lookup and that was an authorization bypass.
//
// See db/insider-tables.sql for the schema and the volume measurements.

import { CODE_PURCHASE, CODE_SALE, purchaseValue, roleOf } from "../../src/lib/insider/form4.js";

const FILINGS_DDL = [
  `CREATE TABLE IF NOT EXISTS insider_filings (
     accession TEXT PRIMARY KEY, filed_at INTEGER NOT NULL, period_at INTEGER,
     issuer_cik TEXT, issuer TEXT, symbol TEXT, owners TEXT, roles TEXT, codes TEXT,
     buy_shares REAL, buy_value REAL, sell_shares REAL, sell_value REAL,
     data TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_insider_filings_filed ON insider_filings (filed_at)`,
  `CREATE INDEX IF NOT EXISTS idx_insider_filings_symbol ON insider_filings (symbol, filed_at)`,
  `CREATE INDEX IF NOT EXISTS idx_insider_filings_buy ON insider_filings (buy_value, filed_at)`,
];

const CLUSTERS_DDL = [
  `CREATE TABLE IF NOT EXISTS insider_clusters (
     id TEXT PRIMARY KEY, known_at INTEGER NOT NULL, issuer_cik TEXT, issuer TEXT,
     symbol TEXT, insiders INTEGER, filings INTEGER, value REAL, shares REAL,
     roles TEXT, names TEXT, first_buy_at INTEGER, last_buy_at INTEGER,
     max_lag_days INTEGER, params TEXT, data TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_insider_clusters_known ON insider_clusters (known_at)`,
  `CREATE INDEX IF NOT EXISTS idx_insider_clusters_symbol ON insider_clusters (symbol, known_at)`,
];

const missingTable = (e) => /no such table/i.test(String(e?.message || e));

async function withTables(db, ddl, run) {
  try {
    return await run();
  } catch (e) {
    if (!missingTable(e)) throw e;
    for (const stmt of ddl) await db.prepare(stmt).run();
    return run();
  }
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v, n) => (v == null ? null : String(v).slice(0, n));

/**
 * Clamp a caller's integer into a range.
 *
 * An ABSENT parameter takes the default; a present-but-nonsense one clamps.
 * Those are different cases and conflating them is a real bug: `Number(null)` is
 * 0, so an omitted `days=` would silently become the minimum rather than the
 * intended default and the endpoint would answer a question nobody asked.
 */
export function clampInt(v, lo, hi, fallback) {
  if (v == null || v === "") return fallback;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

// Symbols are interpolated nowhere, but they ARE compared against a column, and
// a ticker character class keeps a 400-character "symbol" out of the index.
export const TICKER = /^[A-Z][A-Z0-9.\-]{0,9}$/;

/** The denormalised columns of one normalized filing. */
export function filingColumns(f) {
  const buy = purchaseValue(f);
  let sellShares = 0, sellValue = 0;
  const codes = new Set();
  for (const t of f.trans || []) {
    if (t.code) codes.add(t.code);
    if (t.code === CODE_SALE && t.ad === "D" && t.shares > 0) {
      sellShares += t.shares;
      if (t.price > 0) sellValue += t.shares * t.price;
    }
  }
  return {
    accession: String(f.accession || ""),
    filed_at: num(f.filedAt),
    period_at: num(f.periodAt),
    issuer_cik: str(f.issuerCik, 12),
    issuer: str(f.issuer, 150),
    symbol: str((f.symbol || "").toUpperCase(), 12),
    owners: str((f.owners || []).map((o) => o.name).join(" · "), 300),
    roles: str([...new Set((f.owners || []).map(roleOf))].join(","), 40),
    codes: str([...codes].sort().join(""), 20),
    buy_shares: buy.shares || 0,
    buy_value: buy.value || 0,
    sell_shares: sellShares,
    sell_value: sellValue,
  };
}

/**
 * Upsert filings. Returns how many rows were written; throws only on a real DB
 * failure, because unlike the Argus archive this IS the store, not a shadow of
 * one — a silent failure here would look like "the insiders stopped trading".
 */
export async function putFilings(db, filings) {
  const rows = (filings || []).filter((f) => f && f.accession && f.filedAt);
  if (!rows.length) return 0;
  const stmt = db.prepare(
    `INSERT INTO insider_filings
       (accession, filed_at, period_at, issuer_cik, issuer, symbol, owners, roles, codes,
        buy_shares, buy_value, sell_shares, sell_value, data)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(accession) DO UPDATE SET
       filed_at = excluded.filed_at, period_at = excluded.period_at,
       symbol = excluded.symbol, owners = excluded.owners, roles = excluded.roles,
       codes = excluded.codes, buy_shares = excluded.buy_shares, buy_value = excluded.buy_value,
       sell_shares = excluded.sell_shares, sell_value = excluded.sell_value, data = excluded.data`,
  );
  const batch = rows.map((f) => {
    const c = filingColumns(f);
    return stmt.bind(
      c.accession, c.filed_at, c.period_at, c.issuer_cik, c.issuer, c.symbol,
      c.owners, c.roles, c.codes, c.buy_shares, c.buy_value, c.sell_shares, c.sell_value,
      JSON.stringify(f),
    );
  });
  await withTables(db, FILINGS_DDL, () => db.batch(batch));
  return rows.length;
}

/** Upsert cluster events. Keyed by issuer + the date it became knowable. */
export async function putClusters(db, events, params) {
  const rows = (events || []).filter((e) => e && e.issuerCik && e.knownAt);
  if (!rows.length) return 0;
  const p = JSON.stringify(params || {});
  const stmt = db.prepare(
    `INSERT INTO insider_clusters
       (id, known_at, issuer_cik, issuer, symbol, insiders, filings, value, shares,
        roles, names, first_buy_at, last_buy_at, max_lag_days, params, data)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       insiders = excluded.insiders, filings = excluded.filings, value = excluded.value,
       shares = excluded.shares, roles = excluded.roles, names = excluded.names,
       first_buy_at = excluded.first_buy_at, last_buy_at = excluded.last_buy_at,
       max_lag_days = excluded.max_lag_days, params = excluded.params, data = excluded.data`,
  );
  const batch = rows.map((e) => stmt.bind(
    `${e.issuerCik}:${e.knownAt}`, num(e.knownAt), str(e.issuerCik, 12), str(e.issuer, 150),
    str((e.symbol || "").toUpperCase(), 12), num(e.insiders), num(e.filings),
    num(e.value) || 0, num(e.shares) || 0,
    str((e.roles || []).join(","), 60), str((e.names || []).join(" · "), 300),
    num(e.firstBuyAt), num(e.lastBuyAt), num(e.maxLagDays), p,
    JSON.stringify(e),
  ));
  await withTables(db, CLUSTERS_DDL, () => db.batch(batch));
  return rows.length;
}

const EMPTY = { results: [] };

/** Recent cluster events, newest first. */
export async function readClusters(db, { days = 90, limit = 100, symbol = null } = {}) {
  const since = Date.now() - days * 86_400_000;
  const sql = symbol
    ? `SELECT * FROM insider_clusters WHERE known_at >= ? AND symbol = ? ORDER BY known_at DESC LIMIT ?`
    : `SELECT * FROM insider_clusters WHERE known_at >= ? ORDER BY known_at DESC LIMIT ?`;
  const bind = symbol ? [since, symbol, limit] : [since, limit];
  const { results } = await withTables(db, CLUSTERS_DDL, () => db.prepare(sql).bind(...bind).all()).catch(() => EMPTY);
  return results || [];
}

/**
 * Recent filings. `purchasesOnly` is a boolean the caller may set, not a
 * predicate the caller may write — the two statements are fixed here.
 */
export async function readFilings(db, { days = 7, limit = 200, symbol = null, purchasesOnly = false } = {}) {
  const since = Date.now() - days * 86_400_000;
  const buy = purchasesOnly ? "AND buy_shares > 0" : "";
  const sql = symbol
    ? `SELECT * FROM insider_filings WHERE filed_at >= ? AND symbol = ? ${buy} ORDER BY filed_at DESC LIMIT ?`
    : `SELECT * FROM insider_filings WHERE filed_at >= ? ${buy} ORDER BY filed_at DESC LIMIT ?`;
  const bind = symbol ? [since, symbol, limit] : [since, limit];
  const { results } = await withTables(db, FILINGS_DDL, () => db.prepare(sql).bind(...bind).all()).catch(() => EMPTY);
  return results || [];
}

/** How much is in there, and how fresh — the first thing to check when a page is empty. */
export async function readStats(db) {
  const one = async (sql, ddl) => {
    try { return await withTables(db, ddl, () => db.prepare(sql).first()); } catch { return null; }
  };
  const f = await one(
    `SELECT COUNT(*) AS n, MAX(filed_at) AS latest, MIN(filed_at) AS earliest,
            SUM(CASE WHEN buy_shares > 0 THEN 1 ELSE 0 END) AS purchases FROM insider_filings`,
    FILINGS_DDL,
  );
  const c = await one(`SELECT COUNT(*) AS n, MAX(known_at) AS latest FROM insider_clusters`, CLUSTERS_DDL);
  return {
    filings: f?.n ?? 0,
    purchaseFilings: f?.purchases ?? 0,
    earliestFiledAt: f?.earliest ?? null,
    latestFiledAt: f?.latest ?? null,
    clusters: c?.n ?? 0,
    latestClusterAt: c?.latest ?? null,
  };
}
