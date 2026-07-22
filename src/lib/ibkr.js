// ibkr.js — real-time stock quotes from a locally running IBKR Client Portal
// Gateway (dev-only feature, gated behind the dev token).
//
// How it works: the user runs IBKR's Client Portal Gateway on their machine
// (default https://localhost:5000), logs in there once, and allows this site's
// origin in the gateway's conf.yaml CORS section (allowCredentials: true).
// The browser then talks to the gateway directly — no server of ours ever
// sees broker data. Exchange licensing: this is PERSONAL data consumption
// through the user's own brokerage subscriptions; it must never be exposed to
// other visitors, which is why the whole feature requires the dev token.
//
// Endpoints used (all relative to {gateway}/v1/api):
//   POST /tickle                       keep the session alive (~1/min)
//   GET  /iserver/auth/status          authenticated? (POST per docs; GET works)
//   GET  /trsrv/stocks?symbols=A,B     symbol → conid resolution
//   GET  /iserver/marketdata/snapshot  ?conids=..&fields=31,83 (poll; the
//        first call primes the subscription, subsequent calls carry data)

const KEY_URL = "quant_ibkr_gateway";
const KEY_ON = "quant_ibkr_enabled";
const KEY_CONIDS = "quant_ibkr_conids";
const DEFAULT_URL = "https://localhost:5000";

// Fields: 31 = last price, 83 = change % (day).
const FIELDS = "31,83";

const listeners = new Set();
function emit() {
  listeners.forEach((fn) => fn());
  try { window.dispatchEvent(new Event("quant-ibkr")); } catch { /* SSR/tests */ }
}
export function subscribeIbkr(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getGatewayUrl() {
  try { return localStorage.getItem(KEY_URL) || DEFAULT_URL; } catch { return DEFAULT_URL; }
}
export function setGatewayUrl(url) {
  try { localStorage.setItem(KEY_URL, (url || DEFAULT_URL).replace(/\/+$/, "")); } catch { /* quota */ }
  emit();
}

/** Feature switch: the user enabled it (Tools page — which is itself dev-only).
 * No secret involved: the gateway runs on the OWNER's machine; other visitors
 * simply have no gateway to talk to. */
export function ibkrActive() {
  try { return localStorage.getItem(KEY_ON) === "1"; } catch { return false; }
}
export function setIbkrEnabled(on) {
  try { localStorage.setItem(KEY_ON, on ? "1" : "0"); } catch { /* quota */ }
  emit();
}

function api(path, init = {}) {
  return fetch(`${getGatewayUrl()}/v1/api${path}`, {
    credentials: "include", // gateway session cookie
    ...init,
    signal: init.signal ?? AbortSignal.timeout(4000),
  });
}

/**
 * Connection probe for the settings card.
 * @returns {{ ok: boolean, authenticated?: boolean, error?: string }}
 */
export async function checkGateway() {
  try {
    const res = await api("/iserver/auth/status", { method: "POST" });
    if (!res.ok) return { ok: false, error: `Gateway answered HTTP ${res.status} — logged in?` };
    const json = await res.json();
    return { ok: true, authenticated: !!json?.authenticated };
  } catch (e) {
    const msg = e?.name === "TimeoutError"
      ? "No response — is the gateway running and the certificate accepted?"
      : "Unreachable — check gateway, CORS config (conf.yaml) and certificate.";
    return { ok: false, error: msg };
  }
}

// ── Symbol → conid resolution (cached in localStorage) ──────────────────────

let conidCache = null; // { [symbol]: number }
function loadConids() {
  if (conidCache) return conidCache;
  try { conidCache = JSON.parse(localStorage.getItem(KEY_CONIDS)) || {}; }
  catch { conidCache = {}; }
  return conidCache;
}
function saveConids() {
  try { localStorage.setItem(KEY_CONIDS, JSON.stringify(conidCache)); } catch { /* quota */ }
}

// Only plain US-style stock tickers — indices (^GSPC), futures (ES=F), FX
// pairs and crypto never resolve via trsrv/stocks and would just 500.
const STOCK_RE = /^[A-Z][A-Z.]{0,7}$/;

async function resolveConids(symbols) {
  const cache = loadConids();
  const wanted = symbols.filter((s) => STOCK_RE.test(s));
  const missing = wanted.filter((s) => !(s in cache));
  if (missing.length) {
    const res = await api(`/trsrv/stocks?symbols=${encodeURIComponent(missing.join(","))}`);
    if (res.ok) {
      const json = await res.json();
      for (const sym of missing) {
        const entries = json?.[sym];
        // Prefer the US-listed contract; fall back to the first one.
        let conid = null;
        for (const e of entries || []) {
          const c = (e?.contracts || []).find((x) => x?.isUS) || e?.contracts?.[0];
          if (c?.conid) { conid = c.conid; break; }
        }
        cache[sym] = conid; // null = known-unresolvable, don't retry every tick
      }
      saveConids();
    }
  }
  const out = new Map();
  for (const s of wanted) if (cache[s]) out.set(s, cache[s]);
  return out;
}

// ── Quotes ───────────────────────────────────────────────────────────────────

// Snapshot values may arrive prefixed ("C123.45" = prior close while the
// market is closed, "H" = halted) — strip the letters, keep the number.
function parsePx(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/^[A-Za-z]+/, ""));
  return Number.isFinite(n) ? n : null;
}

let lastTickle = 0;
async function tickle() {
  const now = Date.now();
  if (now - lastTickle < 60_000) return;
  lastTickle = now;
  try { await api("/tickle", { method: "POST" }); } catch { /* next poll retries */ }
}

// ── Positions (READ-ONLY portfolio import) ───────────────────────────────────
// This module must NEVER touch order endpoints (/iserver/account/.../orders,
// /iserver/reply, …) — the gateway may be logged into a LIVE account. Reading
// positions is safe; placing or modifying orders through this site is off-limits.

/**
 * Fetch current stock positions from the local gateway, read-only.
 * Returns [{ symbol, name, shares, avgPrice }] — stocks only (assetClass STK),
 * zero positions skipped. Throws on connectivity/auth problems so the caller
 * can show a useful message.
 */
export async function fetchIbkrPositions() {
  const acctRes = await api("/portfolio/accounts");
  if (!acctRes.ok) throw new Error(`accounts HTTP ${acctRes.status} — logged in?`);
  const accts = await acctRes.json();
  const acctId = Array.isArray(accts) ? accts[0]?.accountId || accts[0]?.id : null;
  if (!acctId) throw new Error("No IBKR account visible on the gateway.");

  const out = [];
  // Positions are paged (30/page); a personal book rarely exceeds a few pages.
  for (let page = 0; page < 10; page++) {
    const res = await api(`/portfolio/${encodeURIComponent(acctId)}/positions/${page}`);
    if (!res.ok) throw new Error(`positions HTTP ${res.status}`);
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows) {
      if (r?.assetClass !== "STK") continue; // stocks only — options/futures don't map
      const shares = Number(r.position);
      // For STK, avgCost ≈ avgPrice (per share). Prefer avgPrice when present.
      const avg = Number(r.avgPrice) || Number(r.avgCost);
      const symbol = (r.ticker || r.contractDesc || "").toUpperCase().trim();
      if (!symbol || !Number.isFinite(shares) || shares === 0) continue;
      out.push({
        symbol,
        name: r.name || r.contractDesc || symbol,
        shares,
        avgPrice: Number.isFinite(avg) && avg > 0 ? avg : 0,
      });
    }
    if (rows.length < 30) break;
  }
  return out;
}

/**
 * One batched real-time quote fetch for a list of stock symbols.
 * Returns Map<SYMBOL, { price, changePct }> — symbols that didn't resolve or
 * carry no data yet are simply absent (caller falls back to Yahoo).
 */
export async function fetchIbkrQuotes(symbols) {
  const upper = [...new Set(symbols.map((s) => s.toUpperCase()))];
  const conids = await resolveConids(upper);
  const out = new Map();
  if (!conids.size) return out;

  tickle(); // fire-and-forget keep-alive

  const list = [...conids.values()].join(",");
  const res = await api(`/iserver/marketdata/snapshot?conids=${list}&fields=${FIELDS}`);
  if (!res.ok) throw new Error(`snapshot HTTP ${res.status}`);
  const rows = await res.json();
  const bySymbol = new Map([...conids.entries()].map(([sym, id]) => [id, sym]));
  for (const row of Array.isArray(rows) ? rows : []) {
    const sym = bySymbol.get(row?.conid);
    if (!sym) continue;
    const price = parsePx(row["31"]);
    const changePct = parsePx(row["83"]);
    if (price != null) out.set(sym, { price, changePct });
  }
  return out;
}
