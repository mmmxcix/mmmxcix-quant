// registry.js — the Strategy Registry (Cortex). A local "lab
// notebook": strategies you backtest can be saved with their metrics and
// validation verdicts, then moved through a lifecycle:
//
//   factory  → a saved candidate, not yet validated
//   validated→ survived the validation pipeline (walk-forward / DSR / noise)
//   paper    → promoted to (future) paper trading by the local agent
//   graveyard→ buried; kept as a record of what didn't work
//
// Storage is localStorage (private, instant, no backend). Phase 3 adds a
// "publish" that pushes paper-status entries to the lab agent via /api/lab.

const KEY = "quant_registry";
const listeners = new Set();

// The lifecycle every strategy — self-found (saved from Backtest) or Cortex-found
// — flows through: factory → validated → paper as it clears re-testing, with two
// side-exits: "improve" for a strategy that has a KNOWN, fixable flaw (e.g. it
// only worked in the first half of the window) and "graveyard" for a dead one.
export const STATUSES = ["factory", "validated", "paper", "improve", "graveyard"];
export const STATUS_META = {
  factory: { label: "Factory", hint: "In the library — awaiting / between re-tests" },
  validated: { label: "Validated", hint: "Survived the validation pipeline" },
  paper: { label: "Paper", hint: "Promoted for paper trading" },
  improve: { label: "Improve", hint: "Salvageable — a known flaw worth fixing" },
  // "maxed" is not a status but a cross-cutting FLAG (e.crowned). It gets its own
  // pipeline column + filter so you can find the strategies Cortex has decided
  // are as good as they'll get. Meta lives here so the column/label reuse works.
  maxed: { label: "Maxed out", hint: "Cortex can't improve it further — its best version 👑" },
  graveyard: { label: "Graveyard", hint: "Buried — kept as a record of what failed" },
};

const BACKUP_KEY = KEY + "_backup";

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function write(list) {
  try {
    // SHRINK GUARD: never let a write silently destroy strategies. If the new
    // list has fewer entries than what's stored, stash the current version in a
    // backup first, so an accidental overwrite / bad sync is always recoverable
    // (restoreBackup / auto-restore on next load). This is the safety net that
    // makes losing your library impossible.
    const prevRaw = localStorage.getItem(KEY);
    if (prevRaw) {
      const prev = JSON.parse(prevRaw);
      if (Array.isArray(prev) && prev.length > (Array.isArray(list) ? list.length : 0)) {
        localStorage.setItem(BACKUP_KEY, prevRaw);
      }
    }
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch { /* private mode / quota */ }
  listeners.forEach((fn) => fn());
}

/** The last pre-shrink snapshot, if any — strategies that were dropped by a
 *  write can be recovered from here. */
export function readBackup() {
  try {
    const raw = localStorage.getItem(BACKUP_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

/** Restore any strategies present in the backup but missing from the live
 *  library (union — never removes current ones). Returns how many came back. */
export function restoreBackup() {
  const backup = readBackup();
  if (!backup.length) return 0;
  const cur = read();
  const have = new Set(cur.map((e) => e.id));
  const missing = backup.filter((e) => e && e.id && !have.has(e.id));
  if (missing.length) {
    const merged = [...cur, ...missing];
    write(merged);
    push({ bulkUpsert: missing });
  }
  return missing.length;
}

// Merge two entry lists by id — union, keeping the NEWER copy of any duplicate
// (by statusAt / createdAt). Never drops an entry that exists on either side.
function mergeById(a, b) {
  const by = new Map();
  const stamp = (e) => Math.max(e?.statusAt || 0, e?.createdAt || 0);
  for (const e of [...a, ...b]) {
    if (!e || !e.id) continue;
    const cur = by.get(e.id);
    if (!cur || stamp(e) >= stamp(cur)) by.set(e.id, e);
  }
  return [...by.values()];
}

// ── Server sync (D1-backed /api/library, admin-gated) ────────────────────────
// localStorage stays the instant cache (offline-first, no UI lag); every write is
// mirrored to the server so the library is identical on every device and Cortex
// can manage it centrally. Network calls are fire-and-forget — offline just means
// the local copy leads until the next syncFromServer().
async function push(body) {
  try {
    await fetch("/api/library", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body), keepalive: true,
    });
  } catch { /* offline — the local cache still holds it */ }
}

/** Pull the server library and make it the local truth. Call on the Registry
 *  page mount. On an empty server with a non-empty local cache, migrates the
 *  browser's existing library up (one-time). Returns true if a sync happened. */
export async function syncFromServer() {
  try {
    const r = await fetch("/api/library");
    if (!r.ok) return false; // not admin / DB not bound → stay local-only
    const j = await r.json();
    if (!j.ok || !Array.isArray(j.entries)) return false;
    const local = read();
    // NON-DESTRUCTIVE: union local + server by id (newer wins). The server is a
    // MIRROR, not a replacement — a strategy that only exists locally (saved while
    // the D1 push was offline) is NEVER destroyed by a sync. This is the bug that
    // wiped self-found strategies: `write(j.entries)` blindly overwrote local.
    const merged = mergeById(local, j.entries);
    write(merged);
    // Push anything the server is missing back UP, so a future localStorage clear
    // can't lose it — the library becomes durable across devices and resets.
    const serverIds = new Set(j.entries.map((e) => e.id));
    const localOnly = local.filter((e) => e && e.id && !serverIds.has(e.id));
    if (localOnly.length) push({ bulkUpsert: localOnly });
    return true;
  } catch { return false; }
}

export function getEntries() {
  return read();
}

export function subscribeRegistry(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let idCounter = 0;
function newId() {
  return `s_${Date.now().toString(36)}_${(idCounter++).toString(36)}`;
}

/**
 * Downsample an equity curve to a compact day-over-day return series for
 * correlation. Returns [{ d: dayIndex, r: dailyReturn }], capped in length.
 */
export function buildReturnSeries(equity, maxPoints = 800) {
  if (!Array.isArray(equity) || equity.length < 2) return [];
  // Last equity value per UTC day.
  const perDay = new Map();
  for (const p of equity) perDay.set(Math.floor(p.time / 86400), p.value);
  const days = [...perDay.keys()].sort((a, b) => a - b);
  const out = [];
  for (let i = 1; i < days.length; i++) {
    const prev = perDay.get(days[i - 1]);
    const cur = perDay.get(days[i]);
    if (prev > 0) out.push({ d: days[i], r: cur / prev - 1 });
  }
  if (out.length <= maxPoints) return out;
  const step = out.length / maxPoints;
  return Array.from({ length: maxPoints }, (_, i) => out[Math.floor(i * step)]);
}

/** Pearson correlation of two return series over their shared days. */
export function correlate(a, b) {
  if (!a?.length || !b?.length) return null;
  const mapB = new Map(b.map((p) => [p.d, p.r]));
  const xs = [], ys = [];
  for (const p of a) {
    if (mapB.has(p.d)) { xs.push(p.r); ys.push(mapB.get(p.d)); }
  }
  const n = xs.length;
  if (n < 8) return null; // too little overlap to mean anything
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx <= 0 || syy <= 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/**
 * Pairwise correlation matrix for a set of entries.
 * @returns {{ ids, names, matrix }} matrix[i][j] in [-1,1] or null.
 */
export function correlationMatrix(entries) {
  const ids = entries.map((e) => e.id);
  const names = entries.map((e) => e.name);
  const matrix = entries.map((a, i) =>
    entries.map((b, j) => (i === j ? 1 : correlate(a.returnSeries, b.returnSeries)))
  );
  return { ids, names, matrix };
}

/**
 * Save a backtest result as a new registry entry.
 * @param {Object} p
 * @returns {Object} the created entry
 */
export function saveEntry({ name, market, symbol, interval, range, mode, strategyId, params, code, positionPct, feeBps, metrics, equity, tradeReturns, validation, status = "factory", candidateId = null, language = null, windowProfile = null, failureReason = null, research = null, crowned = false }) {
  const entry = {
    id: newId(),
    createdAt: Date.now(),
    crowned: !!crowned, // "maxed out" — Cortex reached its best version (👑)
    // Which research candidate this came from — lets auto-promotion recognise
    // what it has already imported instead of adding a copy on every poll.
    candidateId,
    language,
    // The research context (thesis / committee verdict / DSR / source / markets)
    // when this came from Cortex — so the library card is as rich as the old feed.
    research,
    // Time-window memory (src/lib/windowProfile.js): where in the backtest the
    // money was made, and the flaw text if it decayed / was erratic.
    windowProfile,
    failureReason,
    name: name || (mode === "builder" ? strategyId : "Code strategy"),
    market, symbol, interval, range,
    mode, strategyId: strategyId || null, params: params || null,
    code: mode === "code" ? code : null,
    positionPct, feeBps,
    metrics: metrics || null,
    validation: validation || null,
    returnSeries: buildReturnSeries(equity),
    tradeCount: metrics?.tradeCount ?? (tradeReturns?.length || 0),
    status,
    note: "",
  };
  write([entry, ...read()]);
  push({ upsert: entry });
  return entry;
}

export function setStatus(id, status) {
  if (!STATUSES.includes(status)) return;
  // Stamp WHEN it entered this stage so the UI can show "newly added to Paper".
  const next = read().map((e) => (e.id === id ? { ...e, status, statusAt: Date.now() } : e));
  write(next);
  const updated = next.find((e) => e.id === id);
  if (updated) push({ upsert: updated });
}

// Crown / uncrown a strategy — the "maxed out" mark (Cortex reached its best
// version, or you decided it's done). A flag, not a status: a crowned strategy
// keeps its pipeline stage (a crowned Paper strat still trades) and also shows in
// the Maxed-out column and the 👑 filter.
export function setCrowned(id, crowned = true) {
  const next = read().map((e) => (e.id === id ? { ...e, crowned: !!crowned } : e));
  write(next);
  const updated = next.find((e) => e.id === id);
  if (updated) push({ upsert: updated });
}

export function attachValidation(id, validation) {
  const next = read().map((e) => (e.id === id ? { ...e, validation: { ...e.validation, ...validation } } : e));
  write(next);
  const updated = next.find((e) => e.id === id);
  if (updated) push({ upsert: updated });
}

export function setNote(id, note) {
  const next = read().map((e) => (e.id === id ? { ...e, note } : e));
  write(next);
  const updated = next.find((e) => e.id === id);
  if (updated) push({ upsert: updated });
}

export function removeEntry(id) {
  write(read().filter((e) => e.id !== id));
  push({ remove: id });
}
