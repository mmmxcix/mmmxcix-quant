// Local, offline-first store for the user's Watchlist and (simulated) Portfolio.
//
// This module is the SINGLE SOURCE OF TRUTH for "symbols the user cares about".
// Other features (e.g. the news digest) read distinctSymbols() from here, so the
// exported shapes below are stable — do not rename fields.
//
// Everything is backed by localStorage but must NEVER throw: private-mode
// browsers and blocked storage fall back to an in-memory copy, so the UI keeps
// working (just not persisted). A tiny pub/sub lets open components refresh on
// mutation, and a window "storage" listener syncs changes across tabs.
//
// Shapes:
//   Watchlist entry : { market, symbol, name }
//   Portfolio pos.  : { id, market, symbol, name, shares, avgPrice, addedAt,
//                       buyDate?, sellPrice?, sellDate? }
//   buyDate/sellDate are ms timestamps. A position with a sellPrice is CLOSED:
//   its P/L is realized and the equity graph freezes it at the sale proceeds.

const WATCHLIST_KEY = "quant_watchlist";
const PORTFOLIO_KEY = "quant_portfolio";

// ── Safe storage layer ───────────────────────────────────────────────────────
// In-memory shadow so reads still work if localStorage is unavailable.
const memory = new Map();

function safeGet(key) {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw != null) return raw;
  } catch {
    /* private mode / disabled storage */
  }
  return memory.has(key) ? memory.get(key) : null;
}

function safeSet(key, value) {
  memory.set(key, value);
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* keep the in-memory copy; nothing else we can do */
  }
}

function readArray(key) {
  const raw = safeGet(key);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeArray(key, arr) {
  safeSet(key, JSON.stringify(arr));
  emit();
}

// ── Pub/sub ──────────────────────────────────────────────────────────────────
const listeners = new Set();

export function subscribe(fn) {
  if (typeof fn !== "function") return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* a broken listener must not break the others */
    }
  }
}

// Cross-tab sync: another tab wrote one of our keys → notify local listeners.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === WATCHLIST_KEY || e.key === PORTFOLIO_KEY || e.key === null) emit();
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function sameSymbol(a, b, market, symbol) {
  return (
    a === market &&
    String(b || "").toUpperCase() === String(symbol || "").toUpperCase()
  );
}

function genId() {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function toNum(n) {
  const v = typeof n === "string" ? Number(n.replace(",", ".")) : Number(n);
  return Number.isFinite(v) ? v : 0;
}

// ── Watchlist ────────────────────────────────────────────────────────────────
export function getWatchlist() {
  return readArray(WATCHLIST_KEY);
}

export function isWatched(market, symbol) {
  return getWatchlist().some((e) => sameSymbol(e.market, e.symbol, market, symbol));
}

// entry: { market, symbol, name }. No-op if already present. Returns the list.
export function addToWatchlist(entry) {
  if (!entry || !entry.market || !entry.symbol) return getWatchlist();
  const list = getWatchlist();
  if (list.some((e) => sameSymbol(e.market, e.symbol, entry.market, entry.symbol))) {
    return list;
  }
  const next = [
    ...list,
    {
      market: entry.market,
      symbol: String(entry.symbol).toUpperCase(),
      name: entry.name || String(entry.symbol).toUpperCase(),
    },
  ];
  writeArray(WATCHLIST_KEY, next);
  return next;
}

export function removeFromWatchlist(market, symbol) {
  const next = getWatchlist().filter(
    (e) => !sameSymbol(e.market, e.symbol, market, symbol)
  );
  writeArray(WATCHLIST_KEY, next);
  return next;
}

// ── Portfolio ────────────────────────────────────────────────────────────────
export function getPortfolio() {
  return readArray(PORTFOLIO_KEY);
}

// Parse an optional ms timestamp (number or date-input string) → ms | null.
function toDateMs(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

// { market, symbol, name, shares, avgPrice, buyDate? } → adds a position.
export function addPosition({ market, symbol, name, shares, avgPrice, buyDate }) {
  if (!market || !symbol) return getPortfolio();
  const pos = {
    id: genId(),
    market,
    symbol: String(symbol).toUpperCase(),
    name: name || String(symbol).toUpperCase(),
    shares: toNum(shares),
    avgPrice: toNum(avgPrice),
    addedAt: Date.now(),
    buyDate: toDateMs(buyDate) ?? Date.now(),
    sellPrice: null,
    sellDate: null,
  };
  const next = [...getPortfolio(), pos];
  writeArray(PORTFOLIO_KEY, next);
  return next;
}

// patch may include { shares, avgPrice, buyDate, sellPrice, sellDate, name, ... }.
// Numeric fields are coerced; sellPrice "" / null reopens the position.
export function updatePosition(id, patch) {
  const next = getPortfolio().map((p) => {
    if (p.id !== id) return p;
    const merged = { ...p, ...patch };
    if ("shares" in patch) merged.shares = toNum(patch.shares);
    if ("avgPrice" in patch) merged.avgPrice = toNum(patch.avgPrice);
    if ("buyDate" in patch) merged.buyDate = toDateMs(patch.buyDate) ?? p.buyDate ?? p.addedAt;
    if ("sellPrice" in patch) {
      const sp = toNum(patch.sellPrice);
      merged.sellPrice = sp > 0 ? sp : null;
      if (merged.sellPrice == null) merged.sellDate = null;
    }
    if ("sellDate" in patch) merged.sellDate = merged.sellPrice != null ? toDateMs(patch.sellDate) ?? Date.now() : null;
    return merged;
  });
  writeArray(PORTFOLIO_KEY, next);
  return next;
}

/** True when the position is closed (has a realized sale). */
export const isClosed = (p) => p?.sellPrice != null && p.sellPrice > 0;

export function removePosition(id) {
  const next = getPortfolio().filter((p) => p.id !== id);
  writeArray(PORTFOLIO_KEY, next);
  return next;
}

// ── Cross-feature helper ─────────────────────────────────────────────────────
// Unique { market, symbol, name } across watchlist + portfolio. Used by the
// news digest to filter headlines to symbols the user actually tracks.
export function distinctSymbols() {
  const seen = new Set();
  const out = [];
  for (const e of [...getWatchlist(), ...getPortfolio()]) {
    if (!e || !e.market || !e.symbol) continue;
    const key = `${e.market}:${String(e.symbol).toUpperCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      market: e.market,
      symbol: String(e.symbol).toUpperCase(),
      name: e.name || String(e.symbol).toUpperCase(),
    });
  }
  return out;
}
