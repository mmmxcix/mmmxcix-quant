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

export const STATUSES = ["factory", "validated", "paper", "graveyard"];
export const STATUS_META = {
  factory: { label: "Factory", hint: "Saved candidate — not yet validated" },
  validated: { label: "Validated", hint: "Survived the validation pipeline" },
  paper: { label: "Paper", hint: "Promoted for paper trading" },
  graveyard: { label: "Graveyard", hint: "Buried — kept as a record" },
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
export function saveEntry({ name, market, symbol, interval, range, mode, strategyId, params, code, positionPct, feeBps, metrics, equity, tradeReturns, validation, status = "factory", candidateId = null, language = null }) {
  const entry = {
    id: newId(),
    createdAt: Date.now(),
    // Which research candidate this came from — lets auto-promotion recognise
    // what it has already imported instead of adding a copy on every poll.
    candidateId,
    language,
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
  return entry;
}

export function setStatus(id, status) {
  if (!STATUSES.includes(status)) return;
  write(read().map((e) => (e.id === id ? { ...e, status } : e)));
}

export function attachValidation(id, validation) {
  write(read().map((e) => (e.id === id ? { ...e, validation: { ...e.validation, ...validation } } : e)));
}

export function setNote(id, note) {
  write(read().map((e) => (e.id === id ? { ...e, note } : e)));
}

export function removeEntry(id) {
  write(read().filter((e) => e.id !== id));
}
