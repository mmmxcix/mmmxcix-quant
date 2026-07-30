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
  graveyard: { label: "Graveyard", hint: "Buried — kept as a record of what failed" },
};

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
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* private mode / quota */ }
  listeners.forEach((fn) => fn());
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
    if (j.entries.length === 0 && local.length > 0) {
      await push({ bulkUpsert: local }); // migrate this browser's library to the server
      return true;
    }
    write(j.entries); // server is the source of truth
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
export function saveEntry({ name, market, symbol, interval, range, mode, strategyId, params, code, positionPct, feeBps, metrics, equity, tradeReturns, validation, status = "factory", candidateId = null, language = null, windowProfile = null, failureReason = null, research = null }) {
  const entry = {
    id: newId(),
    createdAt: Date.now(),
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
  write(read().map((e) => (e.id === id ? { ...e, status } : e)));
  push({ setStatus: { id, status } });
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
