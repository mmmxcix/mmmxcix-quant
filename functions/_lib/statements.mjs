// statements.mjs — the D1 half of /api/statements.
//
// Same three rules as functions/_lib/insider.mjs, for the same reasons: the
// tables build themselves (the writer is an unattended agent), writes are
// idempotent (the agent re-reads an overlapping window every pass), and reads
// are bounded here rather than by the caller.
//
// See db/statements-tables.sql for the schema and the volume measurements, and
// src/lib/statements/extract.js for why `themes` and `model_themes` are two
// different columns that must never be merged.

const DDL = [
  `CREATE TABLE IF NOT EXISTS statements (
     id TEXT PRIMARY KEY, at INTEGER NOT NULL, speaker_id TEXT, speaker TEXT, role TEXT,
     quote TEXT NOT NULL, subject TEXT, source TEXT, url TEXT,
     themes TEXT, model_themes TEXT, agreement TEXT, confidence TEXT, because TEXT,
     data TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_statements_at ON statements (at)`,
  `CREATE INDEX IF NOT EXISTS idx_statements_speaker ON statements (speaker_id, at)`,
];

const missingTable = (e) => /no such table/i.test(String(e?.message || e));

async function withTables(db, run) {
  try {
    return await run();
  } catch (e) {
    if (!missingTable(e)) throw e;
    for (const stmt of DDL) await db.prepare(stmt).run();
    return run();
  }
}

const str = (v, n) => (v == null ? null : String(v).slice(0, n));
const list = (v, n) => (Array.isArray(v) && v.length ? v.join(",").slice(0, n) : null);

/** Clamp a caller's integer; an ABSENT value takes the default, a bad one clamps. */
export function clampInt(v, lo, hi, fallback) {
  if (v == null || v === "") return fallback;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/** Roster ids are a closed set here too — see parse.js. */
export const SPEAKER_ID = /^[a-z][a-z0-9_]{0,23}$/;
export const THEME_ID = /^[a-z][a-z0-9_]{0,23}$/;

export async function putStatements(db, rows) {
  const clean = (rows || []).filter((s) => s && s.id && s.at && s.quote);
  if (!clean.length) return 0;
  const stmt = db.prepare(
    `INSERT INTO statements
       (id, at, speaker_id, speaker, role, quote, subject, source, url,
        themes, model_themes, agreement, confidence, because, data)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       themes = excluded.themes, model_themes = excluded.model_themes,
       agreement = excluded.agreement, confidence = excluded.confidence,
       because = excluded.because, data = excluded.data`,
  );
  const batch = clean.map((s) => stmt.bind(
    str(s.id, 120), Math.floor(Number(s.at)) || 0,
    str(s.speakerId, 24), str(s.speaker, 80), str(s.role, 80),
    str(s.quote, 600), str(s.subject, 80), str(s.channel || s.source, 60), str(s.url, 300),
    list(s.themes, 200), list(s.modelThemes, 200),
    str(s.agreement, 20), str(s.confidence, 10), str(s.because, 200),
    JSON.stringify(s),
  ));
  await withTables(db, () => db.batch(batch));
  return clean.length;
}

const EMPTY = { results: [] };

/**
 * Recent statements, newest first.
 *
 * `theme` and `speaker` are matched against fixed columns; the theme filter uses
 * a LIKE over the comma-joined list, with the needle wrapped in commas so
 * "semis" cannot match "semis_legacy" — the id pattern is validated by the
 * endpoint before it ever gets here.
 */
export async function readStatements(db, { days = 30, limit = 100, theme = null, speaker = null } = {}) {
  const since = Date.now() - days * 86_400_000;
  const where = ["at >= ?"];
  const bind = [since];
  if (theme) { where.push("(',' || themes || ',') LIKE ?"); bind.push(`%,${theme},%`); }
  if (speaker) { where.push("speaker_id = ?"); bind.push(speaker); }
  bind.push(limit);
  const sql = `SELECT data FROM statements WHERE ${where.join(" AND ")} ORDER BY at DESC LIMIT ?`;
  const { results } = await withTables(db, () => db.prepare(sql).bind(...bind).all()).catch(() => EMPTY);
  return (results || []).map((r) => { try { return JSON.parse(r.data); } catch { return null; } }).filter(Boolean);
}

/** How much is in there, how fresh, and how often the two classifiers agree. */
export async function readStats(db) {
  try {
    const row = await withTables(db, () => db.prepare(
      `SELECT COUNT(*) AS n, MAX(at) AS latest, MIN(at) AS earliest,
              SUM(CASE WHEN themes IS NOT NULL AND themes != '' THEN 1 ELSE 0 END) AS themed,
              SUM(CASE WHEN agreement = 'agree' THEN 1 ELSE 0 END) AS agreed,
              SUM(CASE WHEN agreement IS NOT NULL THEN 1 ELSE 0 END) AS classified
       FROM statements`,
    ).first());
    return {
      statements: row?.n ?? 0,
      themed: row?.themed ?? 0,
      earliestAt: row?.earliest ?? null,
      latestAt: row?.latest ?? null,
      // The lexicon-vs-model agreement rate. Not a quality score for either —
      // just the number that says whether the fixed rules still describe what
      // the words mean.
      modelAgreementRate: row?.classified ? (row.agreed || 0) / row.classified : null,
    };
  } catch {
    return { statements: 0, themed: 0, earliestAt: null, latestAt: null, modelAgreementRate: null };
  }
}
