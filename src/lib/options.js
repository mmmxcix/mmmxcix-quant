// Options data layer. Fetches equity option chains from Yahoo Finance through
// the /api/yahoo proxy (v7/finance/options), and computes Black-Scholes Greeks
// client-side (Yahoo provides implied volatility but not the Greeks).
//
// Data is delayed and for education/analysis only — not investment advice.

const YAHOO_OPTIONS = "/api/yahoo/v7/finance/options";
const RISK_FREE = 0.043; // ~current short-term T-bill yield; good enough for Greeks

// ── Black-Scholes ────────────────────────────────────────────────────────────

// Standard normal PDF and CDF (Abramowitz–Stegun approximation for the CDF).
function normPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}
function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (x > 0) p = 1 - p;
  return p;
}

// Greeks for one option. S=spot, K=strike, T=years to expiry, sigma=IV (decimal),
// r=risk-free, type="call"|"put". Returns per-share Greeks; theta is per DAY,
// vega per 1 percentage-point IV move. Returns null-ish values when inputs are bad.
export function blackScholesGreeks({ S, K, T, sigma, r = RISK_FREE, type }) {
  if (!(S > 0) || !(K > 0) || !(T > 0) || !(sigma > 0)) {
    return { delta: null, gamma: null, theta: null, vega: null, price: null };
  }
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const Nd1 = normCdf(d1);
  const Nd2 = normCdf(d2);
  const pdf = normPdf(d1);
  const disc = Math.exp(-r * T);

  const gamma = pdf / (S * sigma * sqrtT);
  const vega = (S * pdf * sqrtT) / 100; // per 1% IV change

  if (type === "call") {
    const price = S * Nd1 - K * disc * Nd2;
    const theta = (-(S * pdf * sigma) / (2 * sqrtT) - r * K * disc * Nd2) / 365;
    const rho = (K * T * disc * Nd2) / 100; // per 1% rate move
    return { delta: Nd1, gamma, theta, vega, rho, price, d1, d2 };
  }
  const price = K * disc * normCdf(-d2) - S * normCdf(-d1);
  const theta = (-(S * pdf * sigma) / (2 * sqrtT) + r * K * disc * normCdf(-d2)) / 365;
  const rho = (-K * T * disc * normCdf(-d2)) / 100;
  return { delta: Nd1 - 1, gamma, theta, vega, rho, price, d1, d2 };
}

/**
 * Implied volatility: the σ that makes Black-Scholes reproduce a market `price`.
 * Robust BISECTION (Newton can diverge near the money / at expiry) over σ∈(0.1%,600%].
 * Returns null when the price is outside the no-arbitrage bounds or won't converge.
 */
export function impliedVol({ price, S, K, T, r = RISK_FREE, type }) {
  if (!(price > 0) || !(S > 0) || !(K > 0) || !(T > 0)) return null;
  const disc = Math.exp(-r * T);
  // No-arbitrage bounds: below intrinsic (discounted) there's no σ that fits.
  const floor = type === "call" ? Math.max(0, S - K * disc) : Math.max(0, K * disc - S);
  const ceil = type === "call" ? S : K * disc;
  if (price < floor - 1e-6 || price > ceil + 1e-6) return null;
  const priceAt = (sig) => blackScholesGreeks({ S, K, T, sigma: sig, r, type }).price;
  let lo = 0.001, hi = 6;
  if (priceAt(lo) > price || priceAt(hi) < price) return null; // not bracketed
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const pm = priceAt(mid);
    if (Math.abs(pm - price) < 1e-6) return mid;
    if (pm < price) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// ── Chain fetch ──────────────────────────────────────────────────────────────

// Fetch the option chain for `symbol`. Pass a `date` (unix seconds, one of the
// available expirations) to get that expiry; omit for the nearest one. Returns:
// { symbol, spot, expirations: number[], expiry, calls: [...], puts: [...] }
// Each contract: { strike, last, change, pctChange, bid, ask, volume, openInterest,
//                  iv, inTheMoney, greeks }
export async function fetchOptionChain(symbol, date) {
  const sym = String(symbol || "").trim().toUpperCase();
  if (!sym) throw new Error("No symbol provided.");
  const url = date ? `${YAHOO_OPTIONS}/${encodeURIComponent(sym)}?date=${date}` : `${YAHOO_OPTIONS}/${encodeURIComponent(sym)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Options request failed (${res.status}) — does "${sym}" have listed options?`);
  const json = await res.json();
  const result = json?.optionChain?.result?.[0];
  if (!result) throw new Error(json?.optionChain?.error?.description || `No options for "${sym}".`);

  const spot = result.quote?.regularMarketPrice ?? null;
  const expirations = result.expirationDates || [];
  const opt = result.options?.[0];
  const expiry = opt?.expirationDate ?? date ?? expirations[0] ?? null;
  const nowSec = Date.now() / 1000;
  const T = expiry ? Math.max((expiry - nowSec) / (365 * 86400), 1 / 365) : null;

  const mapContract = (c, type) => {
    const iv = typeof c.impliedVolatility === "number" ? c.impliedVolatility : null;
    const greeks = spot && T && iv
      ? blackScholesGreeks({ S: spot, K: c.strike, T, sigma: iv, type })
      : { delta: null, gamma: null, theta: null, vega: null, price: null };
    return {
      strike: c.strike,
      last: c.lastPrice ?? null,
      change: c.change ?? null,
      pctChange: c.percentChange ?? null,
      bid: c.bid ?? null,
      ask: c.ask ?? null,
      volume: c.volume ?? 0,
      openInterest: c.openInterest ?? 0,
      iv,
      inTheMoney: !!c.inTheMoney,
      greeks,
    };
  };

  const calls = (opt?.calls || []).map((c) => mapContract(c, "call"));
  const puts = (opt?.puts || []).map((c) => mapContract(c, "put"));
  return { symbol: sym, spot, expirations, expiry, calls, puts };
}

// ── Strategy / payoff engine ────────────────────────────────────────────────

const MULTIPLIER = 100; // US equity options: 1 contract = 100 shares

// Best available price for a contract: mid of bid/ask, else last.
export function markPrice(contract) {
  if (contract.bid != null && contract.ask != null && contract.bid > 0 && contract.ask > 0) {
    return (contract.bid + contract.ask) / 2;
  }
  return contract.last ?? contract.bid ?? contract.ask ?? 0;
}

// Intrinsic value of one option at underlying price S.
function intrinsic(type, strike, S) {
  return type === "call" ? Math.max(0, S - strike) : Math.max(0, strike - S);
}

// P/L of one leg at expiry (per unit ×100). Option leg:
// { type:"call"|"put", strike, premium, side, qty }. Stock leg:
// { kind:"stock", entry, side, qty } where qty is round lots of 100 shares.
function legPayoff(leg, S) {
  if (leg.kind === "stock") {
    const perShare = leg.side === "long" ? S - leg.entry : leg.entry - S;
    return perShare * leg.qty * MULTIPLIER;
  }
  const intr = intrinsic(leg.type, leg.strike, S);
  const perShare = leg.side === "long" ? intr - leg.premium : leg.premium - intr;
  return perShare * leg.qty * MULTIPLIER;
}

// Net cost of the position: negative = net debit (you pay), positive = credit.
// A long stock leg costs its entry; a short option/stock receives its price.
export function netCost(legs) {
  return legs.reduce((sum, l) => {
    const price = l.kind === "stock" ? l.entry : l.premium;
    return sum + (l.side === "long" ? -price : price) * l.qty * MULTIPLIER;
  }, 0);
}

// Aggregate (position) Greeks summed across legs, in position terms:
// delta = share-equivalent, theta = $/day, vega = $ per 1% IV, gamma per $1.
// Returns null when no leg has usable Greeks.
export function positionGreeks(legs) {
  const acc = { delta: 0, gamma: 0, theta: 0, vega: 0 };
  let any = false;
  for (const l of legs) {
    if (!l.greeks) continue;
    const m = (l.side === "long" ? 1 : -1) * l.qty * MULTIPLIER;
    if (l.greeks.delta != null) { acc.delta += l.greeks.delta * m; any = true; }
    if (l.greeks.gamma != null) acc.gamma += l.greeks.gamma * m;
    if (l.greeks.theta != null) acc.theta += l.greeks.theta * m;
    if (l.greeks.vega != null) acc.vega += l.greeks.vega * m;
  }
  return any ? acc : null;
}

// ── One-click strategy presets ───────────────────────────────────────────────

function nearest(list, target) {
  if (!list?.length) return null;
  return list.reduce((b, c) => (Math.abs(c.strike - target) < Math.abs(b.strike - target) ? c : b), list[0]);
}
// Build a leg from a chain contract.
function leg(contract, type, side, qty = 1) {
  if (!contract) return null;
  return { type, strike: contract.strike, premium: +markPrice(contract).toFixed(2), side, qty, greeks: contract.greeks };
}
// A stock leg (qty in round lots of 100 shares). Delta = ±1 per share.
function stockLeg(side, spot, qty = 1) {
  if (!(spot > 0)) return null;
  return { kind: "stock", side, entry: +spot.toFixed(2), qty, greeks: { delta: 1, gamma: 0, theta: 0, vega: 0 } };
}
const clean = (legs) => (legs && legs.every(Boolean) ? legs : null);

// Each preset builds legs from the loaded chain (needs chain.spot/calls/puts).
export const STRATEGY_PRESETS = [
  { id: "long-call", label: "Long Call",
    build: (ch) => clean([leg(nearest(ch.calls, ch.spot), "call", "long")]) },
  { id: "long-put", label: "Long Put",
    build: (ch) => clean([leg(nearest(ch.puts, ch.spot), "put", "long")]) },
  { id: "bull-call", label: "Bull Call Spread",
    build: (ch) => clean([leg(nearest(ch.calls, ch.spot), "call", "long"), leg(nearest(ch.calls, ch.spot * 1.05), "call", "short")]) },
  { id: "bear-put", label: "Bear Put Spread",
    build: (ch) => clean([leg(nearest(ch.puts, ch.spot), "put", "long"), leg(nearest(ch.puts, ch.spot * 0.95), "put", "short")]) },
  { id: "straddle", label: "Long Straddle",
    build: (ch) => clean([leg(nearest(ch.calls, ch.spot), "call", "long"), leg(nearest(ch.puts, ch.spot), "put", "long")]) },
  { id: "strangle", label: "Long Strangle",
    build: (ch) => clean([leg(nearest(ch.calls, ch.spot * 1.05), "call", "long"), leg(nearest(ch.puts, ch.spot * 0.95), "put", "long")]) },
  { id: "iron-condor", label: "Iron Condor",
    build: (ch) => clean([
      leg(nearest(ch.puts, ch.spot * 0.9), "put", "long"),
      leg(nearest(ch.puts, ch.spot * 0.95), "put", "short"),
      leg(nearest(ch.calls, ch.spot * 1.05), "call", "short"),
      leg(nearest(ch.calls, ch.spot * 1.1), "call", "long"),
    ]) },
  { id: "call-butterfly", label: "Call Butterfly",
    build: (ch) => clean([
      leg(nearest(ch.calls, ch.spot * 0.95), "call", "long"),
      leg(nearest(ch.calls, ch.spot), "call", "short", 2),
      leg(nearest(ch.calls, ch.spot * 1.05), "call", "long"),
    ]) },
  { id: "covered-call", label: "Covered Call",
    build: (ch) => clean([stockLeg("long", ch.spot), leg(nearest(ch.calls, ch.spot * 1.05), "call", "short")]) },
  { id: "cash-secured-put", label: "Cash-Secured Put",
    build: (ch) => clean([leg(nearest(ch.puts, ch.spot * 0.95), "put", "short")]) },
];

// ── Term structure ──────────────────────────────────────────────────────────

// ATM implied volatility per expiration — the volatility "term structure".
// Fetches up to `max` expirations (concurrency-limited) and, for each, takes
// the average IV of the call and put nearest the spot. Returns
// [{ expiry, dte, iv }] ascending by expiry. Best-effort: skips failures.
export async function fetchTermStructure(symbol, max = 6) {
  const first = await fetchOptionChain(symbol);
  const spot = first.spot;
  const atmIv = (chain) => {
    const c = nearest(chain.calls.filter((x) => x.iv), spot);
    const p = nearest(chain.puts.filter((x) => x.iv), spot);
    const ivs = [c?.iv, p?.iv].filter((v) => v > 0);
    return ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : null;
  };
  const nowSec = Date.now() / 1000;
  const exps = (first.expirations || []).slice(0, max);
  const points = [];

  // First expiry is already loaded.
  const iv0 = atmIv(first);
  if (iv0) points.push({ expiry: first.expiry, dte: Math.max(1, Math.round((first.expiry - nowSec) / 86400)), iv: iv0 * 100 });

  const rest = exps.filter((e) => e !== first.expiry);
  let i = 0;
  async function worker() {
    while (i < rest.length) {
      const ex = rest[i++];
      try {
        const ch = await fetchOptionChain(symbol, ex);
        const iv = atmIv(ch);
        if (iv) points.push({ expiry: ex, dte: Math.max(1, Math.round((ex - nowSec) / 86400)), iv: iv * 100 });
      } catch { /* skip */ }
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  return points.sort((a, b) => a.expiry - b.expiry);
}

// Build a P/L-at-expiry curve across a price range around `center` (usually
// spot). Returns { points: [{x, y}], breakevens, maxProfit, maxLoss }.
export function payoffCurve(legs, center, { steps = 120, spread = 0.5 } = {}) {
  if (!legs.length || !(center > 0)) return { points: [], breakevens: [], maxProfit: 0, maxLoss: 0 };
  const lo = Math.max(0, center * (1 - spread));
  const hi = center * (1 + spread);
  const points = [];
  let maxProfit = -Infinity, maxLoss = Infinity;
  const breakevens = [];
  let prev = null;
  for (let i = 0; i <= steps; i++) {
    const S = lo + ((hi - lo) * i) / steps;
    const y = legs.reduce((sum, l) => sum + legPayoff(l, S), 0);
    points.push({ x: S, y });
    if (y > maxProfit) maxProfit = y;
    if (y < maxLoss) maxLoss = y;
    if (prev && ((prev.y < 0 && y >= 0) || (prev.y > 0 && y <= 0))) {
      // linear interpolate the zero crossing
      const t = Math.abs(prev.y) / (Math.abs(prev.y) + Math.abs(y) || 1);
      breakevens.push(prev.x + (S - prev.x) * t);
    }
    prev = { x: S, y };
  }
  return { points, breakevens, maxProfit, maxLoss };
}
