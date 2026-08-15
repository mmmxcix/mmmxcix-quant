-- Form 4 insider transactions, and the cluster buys derived from them.
--
-- Written by scripts/insider-agent.mjs through /api/insider (machine token) and
-- read publicly, because everything in here is already a public SEC filing.
--
-- WHY TABLES AND NOT THE argus_kv BLOB PATTERN. The agents' snapshot lives as
-- one JSON value per key, which is right when the whole state is read at once
-- and rewritten every cycle. This is the opposite: ~1,000 new filings a day,
-- append-only, and every useful question is a filter ("purchases over $250k in
-- the last week", "everything for this ticker") rather than "give me all of it".
-- A single D1 value is also capped at ~2 MB, which a year of Form 4s passes in
-- about six weeks.
--
-- Volume, measured on the 2021Q1–2026Q1 panel: ~1,000 Form 4 filings per trading
-- day, of which ~8% contain an open-market purchase. That is ~250k rows a year
-- at roughly 1 KB each — well inside the 5 GB free allowance, and ~1,000 writes
-- a day against a 100,000/day budget.
--
-- Created automatically by functions/_lib/insider.mjs on first use (the writer is
-- an unattended agent, and a migration nobody ran is a silent gap). This file is
-- the readable schema and the manual path:
--   npx wrangler d1 execute mmmxcix-quant-auth --remote --file db/insider-tables.sql

-- ── one Form 4 filing ──────────────────────────────────────────────────────
-- Denormalised columns for querying plus the full normalized filing as JSON,
-- the same pattern functions/api/library.js and argus_trades already use.
--
-- Sales are stored alongside purchases even though only purchases carry the
-- signal: "insiders bought" without "and sold twice as much the same week" is a
-- half-truth, and the display needs both to avoid telling one.
CREATE TABLE IF NOT EXISTS insider_filings (
  accession   TEXT PRIMARY KEY,   -- 0001234567-26-000123
  filed_at    INTEGER NOT NULL,   -- ms, UTC midnight — the date it became public
  period_at   INTEGER,            -- ms, the reported transaction period
  issuer_cik  TEXT,
  issuer      TEXT,
  symbol      TEXT,
  owners      TEXT,               -- reporting owners, joined for display/search
  roles       TEXT,               -- officer | director | 10% | other, deduped
  codes       TEXT,               -- distinct transaction codes on the filing
  buy_shares  REAL,               -- open-market purchases only (code P, acquired)
  buy_value   REAL,
  sell_shares REAL,               -- open-market sales only (code S, disposed)
  sell_value  REAL,
  data        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_insider_filings_filed  ON insider_filings (filed_at);
CREATE INDEX IF NOT EXISTS idx_insider_filings_symbol ON insider_filings (symbol, filed_at);
CREATE INDEX IF NOT EXISTS idx_insider_filings_buy    ON insider_filings (buy_value, filed_at);

-- ── the derived cluster events ─────────────────────────────────────────────
-- Several distinct insiders of one issuer buying inside a rolling window. The
-- agent recomputes these over a trailing window after every ingest pass and
-- upserts them, so a late filing that completes an older cluster is picked up.
--
-- `known_at` is the date the LAST constituent filing became public — the first
-- moment anyone outside the company could have acted. It is the only date any
-- study or display is allowed to enter on, and the reason the congressional
-- 45-day rule is a different problem entirely.
CREATE TABLE IF NOT EXISTS insider_clusters (
  id           TEXT PRIMARY KEY,  -- issuerCik:known_at
  known_at     INTEGER NOT NULL,
  issuer_cik   TEXT,
  issuer       TEXT,
  symbol       TEXT,
  insiders     INTEGER,           -- distinct reporting owners
  filings      INTEGER,           -- distinct accessions (≥2, so a joint filing is not a cluster)
  value        REAL,
  shares       REAL,
  roles        TEXT,
  names        TEXT,
  first_buy_at INTEGER,
  last_buy_at  INTEGER,
  max_lag_days INTEGER,           -- worst filing delay inside the cluster
  params       TEXT,              -- the clustering setting that produced this row
  data         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_insider_clusters_known  ON insider_clusters (known_at);
CREATE INDEX IF NOT EXISTS idx_insider_clusters_symbol ON insider_clusters (symbol, known_at);
