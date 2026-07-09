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
    return { delta: Nd1, gamma, theta, vega, price };
  }
  const price = K * disc * normCdf(-d2) - S * normCdf(-d1);
  const theta = (-(S * pdf * sigma) / (2 * sqrtT) + r * K * disc * normCdf(-d2)) / 365;
  return { delta: Nd1 - 1, gamma, theta, vega, price };
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

// P/L of one leg at expiry (per contract, ×100). A leg is
// { type, strike, premium, side: "long"|"short", qty }.
function legPayoff(leg, S) {
  const intr = intrinsic(leg.type, leg.strike, S);
  const perShare = leg.side === "long" ? intr - leg.premium : leg.premium - intr;
  return perShare * leg.qty * MULTIPLIER;
}

// Net cost of the position: negative = net debit (you pay), positive = credit.
export function netCost(legs) {
  return legs.reduce(
    (sum, l) => sum + (l.side === "long" ? -l.premium : l.premium) * l.qty * MULTIPLIER,
    0
  );
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
