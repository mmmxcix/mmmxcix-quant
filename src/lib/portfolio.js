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
//   Deposit         : { id, amount, currency, date (YYYY-MM-DD), rate, usd, addedAt }
//   buyDate/sellDate are ms timestamps. A position with a sellPrice is CLOSED:
//   its P/L is realized and the equity graph freezes it at the sale proceeds.
//
// CASH MODEL: the account is kept in USD. Cash is DERIVED, never stored:
//   cashUSD = Σ deposits.usd  −  Σ buys (shares×avgPrice)  +  Σ realized sells
//             (shares×sellPrice)
// so it stays consistent under edits, deletes and cross-device merges for free.

const WATCHLIST_KEY = "quant_watchlist";
const PORTFOLIO_KEY = "quant_portfolio";
const DEPOSITS_KEY = "quant_deposits";

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
  // SHRINK GUARD: if this write would drop entries, stash the current version to
  // a backup first so an accidental wipe is recoverable (restoreBackups on load).
  const prev = readArray(key);
  if (Array.isArray(prev) && prev.length > (Array.isArray(arr) ? arr.length : 0)) {
    safeSet(key + "_backup", JSON.stringify(prev));
  }
  safeSet(key, JSON.stringify(arr));
  pushToServer(key, arr); // durable server copy — survives a localStorage clear
  emit();
}

// ── Durable server mirror (/api/prefs → D1) ──────────────────────────────────
// localStorage is fast but fragile (a browser clear wiped the watchlist &
// portfolio once). Every write is mirrored to the server, and syncFromServer()
// merges the two on load — NON-destructively, union by identity, so nothing is
// ever lost from either side.
const SERVER_NAME = {
  [WATCHLIST_KEY]: "watchlist",
  [PORTFOLIO_KEY]: "portfolio",
  [DEPOSITS_KEY]: "deposits",
};

async function pushToServer(key, arr) {
  const name = SERVER_NAME[key];
  if (!name || typeof fetch === "undefined") return;
  try {
    await fetch("/api/prefs", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: name, data: arr }), keepalive: true,
    });
  } catch { /* offline — local copy still holds it, retried on next write/sync */ }
}

function mergeWatchlist(a, b) {
  const by = new Map();
  for (const e of [...a, ...b]) {
    if (!e || !e.market || !e.symbol) continue;
    by.set(`${e.market}|${String(e.symbol).toUpperCase()}`, e);
  }
  return [...by.values()];
}

function mergePortfolio(a, b) {
  const by = new Map();
  const stamp = (e) => Math.max(e?.sellDate || 0, e?.buyDate || 0, e?.addedAt || 0);
  for (const e of [...a, ...b]) {
    if (!e || !e.id) continue;
    const cur = by.get(e.id);
    if (!cur || stamp(e) >= stamp(cur)) by.set(e.id, e);
  }
  return [...by.values()];
}

function mergeDeposits(a, b) {
  const by = new Map();
  for (const e of [...a, ...b]) {
    if (!e || !e.id) continue;
    const cur = by.get(e.id);
    if (!cur || (e.addedAt || 0) >= (cur.addedAt || 0)) by.set(e.id, e);
  }
  return [...by.values()];
}

const SYNC_KEYS = [
  [WATCHLIST_KEY, mergeWatchlist],
  [PORTFOLIO_KEY, mergePortfolio],
  [DEPOSITS_KEY, mergeDeposits],
];

/** Pull watchlist + portfolio from the server and MERGE with local (union, newer
 *  wins). Never destroys local-only entries; pushes the merged truth back up. */
export async function syncFromServer() {
  if (typeof fetch === "undefined") return false;
  let changed = false;
  for (const [key, merge] of SYNC_KEYS) {
    try {
      const r = await fetch(`/api/prefs?key=${SERVER_NAME[key]}`);
      if (!r.ok) continue;
      const j = await r.json();
      const server = Array.isArray(j.data) ? j.data : [];
      const local = readArray(key);
      const merged = merge(local, server);
      if (merged.length !== local.length || merged.length !== server.length) {
        safeSet(key, JSON.stringify(merged));
        pushToServer(key, merged);
        changed = true;
      }
    } catch { /* offline */ }
  }
  if (changed) emit();
  return changed;
}

/** Recover watchlist/portfolio entries a bad write may have dropped, from the
 *  shrink-guard backup. Union — never removes current entries. */
export function restoreBackups() {
  let recovered = 0;
  for (const [key, merge] of SYNC_KEYS) {
    const raw = safeGet(key + "_backup");
    if (!raw) continue;
    try {
      const backup = JSON.parse(raw);
      if (!Array.isArray(backup) || !backup.length) continue;
      const cur = readArray(key);
      const merged = merge(cur, backup);
      if (merged.length > cur.length) {
        recovered += merged.length - cur.length;
        safeSet(key, JSON.stringify(merged));
        pushToServer(key, merged);
      }
    } catch { /* ignore corrupt backup */ }
  }
  if (recovered) emit();
  return recovered;
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
    if (e.key === WATCHLIST_KEY || e.key === PORTFOLIO_KEY || e.key === DEPOSITS_KEY || e.key === null) emit();
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

// ── Deposits & cash ──────────────────────────────────────────────────────────
export function getDeposits() {
  return readArray(DEPOSITS_KEY);
}

// { amount, currency, date: "YYYY-MM-DD", rate, usd } — rate/usd are computed by
// the caller (see fx.js) at the deposit's DATE, then frozen here forever.
export function addDeposit({ amount, currency, date, rate, usd }) {
  const dep = {
    id: genId(),
    amount: toNum(amount),
    currency: String(currency || "USD").toUpperCase(),
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(date)) ? date : new Date().toISOString().slice(0, 10),
    rate: toNum(rate) || 1,
    usd: toNum(usd),
    addedAt: Date.now(),
  };
  if (!(dep.amount > 0) || !(dep.usd > 0)) return getDeposits();
  const next = [...getDeposits(), dep];
  writeArray(DEPOSITS_KEY, next);
  return next;
}

export function removeDeposit(id) {
  const next = getDeposits().filter((d) => d.id !== id);
  writeArray(DEPOSITS_KEY, next);
  return next;
}

/** Derived USD cash balance: deposits in, buys out, realized sells back in.
 *  Can go negative when positions were bought without a covering deposit. */
export function cashUSD(positions = getPortfolio(), deposits = getDeposits()) {
  let cash = 0;
  for (const d of deposits) cash += toNum(d.usd);
  for (const p of positions) {
    cash -= toNum(p.shares) * toNum(p.avgPrice);
    if (isClosed(p)) cash += toNum(p.shares) * toNum(p.sellPrice);
  }
  return cash;
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
