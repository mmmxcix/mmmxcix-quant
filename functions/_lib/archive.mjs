// archive.mjs — the durable record under the Argus snapshot.
//
// /api/argus stores the agent's whole state as ONE JSON value, which is right
// for a live display and wrong for two things it can never do: keep more trades
// than fit in a single ~2 MB D1 value, and remember what yesterday looked like
// (the snapshot is overwritten every couple of minutes). See db/board-tables.sql
// for the measurements behind both.
//
// So every persist ALSO lands here: closed trades upserted into argus_trades,
// one state row appended to argus_history. Three rules, in order:
//
//   1. This must never fail the agent's persist. A 24/7 process that stops
//      saving because an archive write hiccuped is a far worse outcome than a
//      gap in the archive. Every entry point swallows its own errors.
//   2. The blob stays the source of truth for the live page. Nothing here is
//      read back by /api/argus, so the two can never disagree on screen.
//   3. The tables create themselves on first use, because the writer is an
//      unattended agent and a migration step nobody ran is a silent gap.

import { sessionOf } from "../../src/lib/argus/learn.js";
import { tradeR } from "../../src/lib/argus/core.js";

const TRADES_DDL = [
  `CREATE TABLE IF NOT EXISTS argus_trades (
     id TEXT PRIMARY KEY, symbol TEXT, market TEXT, side TEXT, kind TEXT,
     session TEXT, outcome TEXT, opened_at INTEGER, exit_at INTEGER,
     r REAL, pnl REAL, planned_r REAL, data TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_argus_trades_exit ON argus_trades (exit_at)`,
  `CREATE INDEX IF NOT EXISTS idx_argus_trades_kind ON argus_trades (kind, exit_at)`,
  `CREATE INDEX IF NOT EXISTS idx_argus_trades_session ON argus_trades (session, exit_at)`,
];

const HISTORY_DDL = [
  `CREATE TABLE IF NOT EXISTS argus_history (
     at INTEGER PRIMARY KEY, equity REAL, mark_equity REAL, unrealized REAL,
     day_pnl REAL, open_count INTEGER, forming_count INTEGER,
     heat REAL, heat_cap REAL, portfolio_lev REAL, halted INTEGER)`,
  `CREATE INDEX IF NOT EXISTS idx_argus_history_at ON argus_history (at)`,
];

const missingTable = (e) => /no such table/i.test(String(e?.message || e));

/**
 * Run statements, creating the tables once if they are not there yet. The DDL is
 * NOT run on every call — only when a write says the table is missing, so the
 * steady state costs nothing.
 */
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
const str = (v, n = 40) => (typeof v === "string" ? v.slice(0, n) : null);

/**
 * Upsert closed trades. Idempotent by trade id, so the agent re-sending a batch
 * (which it does after a restart) neither duplicates nor loses anything.
 * @returns {number} rows written; 0 on any failure, which is never surfaced.
 */
export async function archiveTrades(db, trades) {
  if (!db || !Array.isArray(trades) || !trades.length) return 0;
  const rows = trades.filter((t) => t && typeof t.id === "string" && t.exitAt);
  if (!rows.length) return 0;
  try {
    const stmt = db.prepare(
      `INSERT INTO argus_trades
         (id, symbol, market, side, kind, session, outcome, opened_at, exit_at, r, pnl, planned_r, data)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         outcome = excluded.outcome, exit_at = excluded.exit_at,
         r = excluded.r, pnl = excluded.pnl, data = excluded.data`,
    );
    const batch = rows.map((t) =>
      stmt.bind(
        t.id, str(t.symbol, 20), str(t.market, 20), str(t.side, 8), str(t.kind, 32),
        sessionOf(Number(t.openedAt)), str(t.outcome, 20),
        num(t.openedAt), num(t.exitAt), num(tradeR(t)), num(t.pnl), num(t.plannedR),
        JSON.stringify(t),
      ));
    await withTables(db, TRADES_DDL, () => db.batch(batch));
    return rows.length;
  } catch {
    return 0; // rule 1: the archive never breaks the persist
  }
}

/**
 * Append one state row. Called once per persist (~720/day, under 1% of the free
 * write budget) — this is the only way the equity curve, the heat history and
 * "what was open on Tuesday" become answerable at all.
 */
export async function appendHistory(db, state, at = Date.now()) {
  if (!db || !state) return false;
  try {
    await withTables(db, HISTORY_DDL, () =>
      db.prepare(
        `INSERT INTO argus_history
           (at, equity, mark_equity, unrealized, day_pnl, open_count, forming_count, heat, heat_cap, portfolio_lev, halted)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         -- Two persists in the SAME millisecond keep the first. Real cycles are
         -- minutes apart; this only matters for a replay or a test loop.
         ON CONFLICT(at) DO NOTHING`,
      ).bind(
        num(at), num(state.equity), num(state.markEquity), num(state.unrealized), num(state.dayPnl),
        num(state.open), num(state.forming),
        // Stored as the FRACTION the agent writes (0.2 = 20%); the percentage
        // conversion belongs in one place, and that place is the board.
        num(state.heatPct), num(state.heatCapPct), num(state.portfolioLev),
        state.halted ? 1 : 0,
      ).run());
    return true;
  } catch {
    return false;
  }
}
