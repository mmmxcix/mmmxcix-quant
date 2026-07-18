// ibkrPaper.mjs — order placement against a local IBKR Client Portal Gateway,
// for the PAPER account only.
//
// src/lib/ibkr.js is the browser half and stays read-only (quotes). Trading
// cannot live there: a browser tab is not a scheduler, and the paper agent runs
// every 15 minutes whether or not the site is open. So the write path lives
// here, in Node, next to the agent that already decides positions.
//
// TLS: the gateway serves a self-signed certificate on localhost. Global fetch
// gives no per-request TLS control and Node 24 does not expose undici as an
// importable package, so the only remaining options were
// NODE_TLS_REJECT_UNAUTHORIZED=0 (disables verification for EVERY request this
// process makes — including Binance, Yahoo and our own API) or talking to the
// gateway through node:https directly. This module does the latter: the
// exception is scoped to one host and never leaks to the other fetchers.
//
// SAFETY — three independent brakes, all on by default:
//   1. opt-in           nothing happens unless LAB_IBKR_TRADE=1
//   2. paper assertion  refuses any account id that is not IBKR paper (DU/DF)
//   3. kill switch      LAB_IBKR_KILL=1 blocks every order without code changes
//
// Not investment advice. Paper account only, by construction.

import https from "node:https";
import { URL } from "node:url";

const GATEWAY = process.env.LAB_IBKR_GATEWAY || "https://localhost:5000";
export const TRADING_ENABLED = process.env.LAB_IBKR_TRADE === "1";
const KILLED = process.env.LAB_IBKR_KILL === "1";

// IBKR paper accounts are prefixed DU (individual) or DF (advisor/family).
// Live accounts are U…/F…. This is the assertion that keeps a mis-logged-in
// gateway from turning the research loop into a live trading system.
const PAPER_RE = /^(DU|DF)\d+$/i;

class IbkrError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}

/**
 * One request to the gateway. Scoped TLS exception (see the header note).
 * The gateway holds its own session cookie after the user logs in through the
 * browser once, so no credentials pass through this file — ever.
 */
function gw(path, { method = "GET", body = null, timeout = 8000 } = {}) {
  const url = new URL(`${GATEWAY}/v1/api${path}`);
  const payload = body == null ? null : JSON.stringify(body);
  const opts = {
    method,
    hostname: url.hostname,
    port: url.port || 443,
    path: url.pathname + url.search,
    headers: {
      accept: "application/json",
      ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
    },
    // Scoped to this request only — see the TLS note in the header.
    rejectUnauthorized: false,
    timeout,
  };
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let raw = "";
      res.on("data", (d) => { raw += d; });
      res.on("end", () => {
        if (res.statusCode >= 400) return reject(new IbkrError(`HTTP ${res.statusCode}: ${raw.slice(0, 160)}`, res.statusCode));
        try { resolve(raw ? JSON.parse(raw) : null); }
        catch { reject(new IbkrError(`non-JSON response: ${raw.slice(0, 120)}`, res.statusCode)); }
      });
    });
    req.on("timeout", () => { req.destroy(new IbkrError("gateway timeout")); });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Is the gateway up and logged in? Never throws. */
export async function status() {
  try {
    const s = await gw("/iserver/auth/status", { method: "POST" });
    return { ok: true, authenticated: !!s?.authenticated, connected: !!s?.connected };
  } catch (e) {
    return { ok: false, error: e.message.slice(0, 120) };
  }
}

/** Keep the gateway session from idling out. Fire-and-forget. */
export async function tickle() {
  try { await gw("/tickle", { method: "POST" }); } catch { /* next run retries */ }
}

/**
 * Resolve the account to trade and PROVE it is a paper account.
 * Throws rather than returning a flag: a caller that forgets to check a boolean
 * would trade live, so the failure mode has to be loud.
 */
export async function resolvePaperAccount() {
  const accounts = await gw("/iserver/accounts");
  const ids = accounts?.accounts || [];
  if (!ids.length) throw new IbkrError("gateway returned no accounts — logged in?");

  const wanted = process.env.LAB_IBKR_ACCOUNT;
  const id = wanted && ids.includes(wanted) ? wanted : ids[0];

  if (!PAPER_RE.test(id)) {
    throw new IbkrError(
      `account ${id} is not an IBKR paper account (expected DU…/DF…). ` +
      `Refusing to trade. Log the gateway into the paper account, or set LAB_IBKR_ACCOUNT.`
    );
  }
  if (ids.length > 1 && !wanted) {
    console.log(`  ℹ gateway exposes ${ids.length} accounts; using ${id}. Pin one with LAB_IBKR_ACCOUNT.`);
  }
  return id;
}

// ── contracts ───────────────────────────────────────────────────────────────
const conidCache = new Map();

/** Symbol → conid for plain US stock tickers. null when unresolvable. */
export async function conidFor(symbol) {
  const sym = String(symbol || "").toUpperCase();
  if (conidCache.has(sym)) return conidCache.get(sym);
  if (!/^[A-Z][A-Z.]{0,7}$/.test(sym)) { conidCache.set(sym, null); return null; }

  let conid = null;
  try {
    const res = await gw(`/trsrv/stocks?symbols=${encodeURIComponent(sym)}`);
    for (const entry of res?.[sym] || []) {
      const c = (entry?.contracts || []).find((x) => x?.isUS) || entry?.contracts?.[0];
      if (c?.conid) { conid = c.conid; break; }
    }
  } catch (e) {
    console.error(`  conid ${sym}: ${e.message.slice(0, 70)}`);
  }
  conidCache.set(sym, conid);
  return conid;
}

/** Current position size for a conid (signed; positive = long). */
export async function positionFor(accountId, conid) {
  try {
    const rows = await gw(`/portfolio/${accountId}/position/${conid}`);
    const row = Array.isArray(rows) ? rows[0] : rows;
    return Number(row?.position ?? 0) || 0;
  } catch (e) {
    if (e.status === 404) return 0; // no position is a 404 here, not an error
    throw e;
  }
}

// ── orders ──────────────────────────────────────────────────────────────────
/**
 * Place a market order and clear IBKR's confirmation prompts.
 *
 * The gateway answers order submissions with a chain of "reply" questions
 * (order size warnings, market-data disclaimers). Each must be confirmed by id
 * before the order actually reaches the book — an unanswered reply silently
 * means "no order was placed", which is the classic way this integration
 * appears to work while doing nothing.
 */
export async function placeMarketOrder({ accountId, conid, side, quantity, tif = "DAY" }) {
  if (KILLED) return { skipped: "kill_switch" };
  if (!TRADING_ENABLED) return { skipped: "trading_disabled" };
  const qty = Math.floor(Math.abs(quantity));
  if (!(qty > 0)) return { skipped: "zero_quantity" };

  const order = {
    conid, secType: `${conid}:STK`, orderType: "MKT",
    side: side === "BUY" ? "BUY" : "SELL",
    quantity: qty, tif, outsideRTH: false,
  };

  let res = await gw(`/iserver/account/${accountId}/orders`, { method: "POST", body: { orders: [order] } });

  // Walk the reply chain — bounded, so a loop of questions cannot hang the run.
  for (let i = 0; i < 5; i++) {
    const first = Array.isArray(res) ? res[0] : res;
    if (!first?.id || !first?.message) break;
    res = await gw(`/iserver/reply/${first.id}`, { method: "POST", body: { confirmed: true } });
  }

  const first = Array.isArray(res) ? res[0] : res;
  if (first?.order_id || first?.orderId) {
    return { ok: true, orderId: first.order_id || first.orderId, status: first.order_status || first.status || "submitted" };
  }
  return { ok: false, response: JSON.stringify(res).slice(0, 200) };
}

/**
 * Bring the broker position in line with the strategy's desired state.
 *
 * Deliberately mirrors DIRECTION, not the simulator's virtual sizing: the
 * simulator compounds a virtual 10k, the paper account has its own balance,
 * and trying to keep the two numerically identical would drift on the first
 * fill difference. Sizing here is a fixed share count per strategy so the
 * comparison stays about the SIGNAL, which is the thing being validated.
 *
 * @returns {{action:string, detail?:string, orderId?:string}}
 */
export async function syncPosition({ accountId, symbol, target, shares }) {
  const conid = await conidFor(symbol);
  if (!conid) return { action: "skip", detail: `no conid for ${symbol}` };

  const held = await positionFor(accountId, conid);
  const want = target === "long" ? shares : target === "short" ? -shares : 0;
  const delta = want - held;
  if (Math.abs(delta) < 1) return { action: "hold", detail: `${held} shares, target ${want}` };

  const side = delta > 0 ? "BUY" : "SELL";
  const res = await placeMarketOrder({ accountId, conid, side, quantity: Math.abs(delta) });
  if (res.skipped) return { action: "skip", detail: res.skipped };
  if (!res.ok) return { action: "fail", detail: res.response };
  return { action: `${side} ${Math.abs(delta)}`, detail: `${held} → ${want}`, orderId: res.orderId };
}
