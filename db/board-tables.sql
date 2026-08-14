-- Two tables the JSON-blob storage cannot grow into.
--
-- Everything the agents persist lives in argus_kv as ONE JSON value per key.
-- That is cheap to read (D1 bills rows, not bytes, so the whole 171 KB Argus
-- snapshot costs one of five million free daily row reads) and it stays well
-- inside the CPU budget (1.49 ms to parse at the 500-trade ledger cap, against
-- a 10 ms limit). It has exactly two limits, and both are structural:
--
--   1. A single D1 value is capped at ~2 MB. The ledger is capped at 500 trades
--      to stay under it — but meta-labelling needs ~272 MORE trades before it
--      produces a model at all, and then it wants every trade forever. At 12
--      trades a day a year is ~4,400 rows ≈ 5.5 MB in one blob: over the cap.
--   2. The snapshot is OVERWRITTEN. "What did equity do last week", "when did
--      heat spike", "what was the agent holding on Tuesday" are not answerable
--      by anything — not by the board, not by the page, not by a human.
--
-- Both tables are written ADDITIVELY by /api/argus alongside the blob, inside a
-- try/catch that can never fail the agent's persist. The blob remains the source
-- of truth for the live page; these are the durable record underneath it.
--
-- The endpoint creates them on first use (CREATE TABLE IF NOT EXISTS on a "no
-- such table" error, then one retry), so no manual step is required. This file
-- is the readable schema and the manual path:
--   npx wrangler d1 execute mmmxcix-quant-auth --remote --file db/board-tables.sql

-- ── the closed-trade ledger ────────────────────────────────────────────────
-- Denormalised columns for querying plus the full row as JSON, exactly the
-- pattern functions/api/library.js already uses in this database.
CREATE TABLE IF NOT EXISTS argus_trades (
  id         TEXT PRIMARY KEY,
  symbol     TEXT,
  market     TEXT,
  side       TEXT,
  kind       TEXT,
  session    TEXT,     -- asia | london | ny | off, from learn.js sessionOf()
  outcome    TEXT,     -- target | stop | invalidated | timeout | manual
  opened_at  INTEGER,  -- ms, like everything Argus writes
  exit_at    INTEGER,
  r          REAL,     -- tradeR(): falls back to pnl/riskAmt on legacy rows
  pnl        REAL,
  planned_r  REAL,
  data       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_argus_trades_exit    ON argus_trades (exit_at);
CREATE INDEX IF NOT EXISTS idx_argus_trades_kind    ON argus_trades (kind, exit_at);
CREATE INDEX IF NOT EXISTS idx_argus_trades_session ON argus_trades (session, exit_at);

-- ── the state history ──────────────────────────────────────────────────────
-- One row per persist (~720/day, under 1% of the free write budget; a few MB a
-- year). Heat is stored as the FRACTION the agent writes, not the percentage the
-- UI renders — the unit is fixed once, at the edge, in src/lib/board/format.js.
CREATE TABLE IF NOT EXISTS argus_history (
  at            INTEGER PRIMARY KEY, -- ms
  equity        REAL,
  mark_equity   REAL,
  unrealized    REAL,
  day_pnl       REAL,
  open_count    INTEGER,
  forming_count INTEGER,
  heat          REAL,
  heat_cap      REAL,
  portfolio_lev REAL,
  halted        INTEGER
);

CREATE INDEX IF NOT EXISTS idx_argus_history_at ON argus_history (at);
