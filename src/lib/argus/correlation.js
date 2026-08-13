// correlation.js — a light asset-class correlation model for Argus's risk gate.
//
// The heat cap (max total risk) should scale with DIVERSIFICATION: three
// correlated crypto longs are effectively one big bet, but a crypto long + a gold
// long + a bond position spread the risk, so a larger total budget is warranted.
// Real rolling correlations would need price history every cycle; a static
// asset-class model is honest enough to size the budget and costs nothing.

// Map a symbol to a broad asset class.
export function classOf(sym) {
  const s = String(sym || "").toUpperCase();
  if (/USDT$|USDC$/.test(s)) return "crypto";
  if (s === "TLT" || s === "IEF" || s === "SHY") return "bond";
  if (s === "UUP" || s === "USDU") return "dollar";
  if (["USO", "XOP", "UNG", "GLD", "SLV", "GDX", "DBC"].includes(s)) return "commodity";
  return "equity"; // stocks + sector/broad ETFs
}

// Symmetric class-vs-class correlation (rough, defensible priors).
const M = {
  crypto:    { crypto: 0.80, equity: 0.40, commodity: 0.20, bond: -0.10, dollar: -0.20 },
  equity:    { equity: 0.70, commodity: 0.20, bond: -0.30, dollar: -0.20 },
  commodity: { commodity: 0.30, bond: 0.00, dollar: -0.30 },
  bond:      { bond: 0.85, dollar: 0.20 },
  dollar:    { dollar: 1.00 },
};
function classCorr(a, b) {
  return M[a]?.[b] ?? M[b]?.[a] ?? 0.3;
}

/** Correlation between two instruments (1 for the same symbol). */
export function pairCorr(a, b) {
  if (!a || !b) return 0;
  if (String(a).toUpperCase() === String(b).toUpperCase()) return 1;
  return classCorr(classOf(a), classOf(b));
}

/** Average pairwise correlation across a set of symbols (0 or 1 symbol → 0). */
export function avgPairwiseCorr(symbols) {
  const u = [...new Set(symbols.filter(Boolean))];
  if (u.length < 2) return 0;
  let sum = 0, n = 0;
  for (let i = 0; i < u.length; i++) for (let j = i + 1; j < u.length; j++) { sum += pairCorr(u[i], u[j]); n++; }
  return n ? sum / n : 0;
}

/**
 * Correlation with DIRECTION taken into account.
 *
 * Two positions in correlated assets are only one bet when they point the same
 * way. Long BTC + long ETH compound; long BTC + SHORT ETH largely cancel, and
 * treating those two books as equally risky — which the unsigned version above
 * does — is the gap this closes. The live ledger ran with roughly half of each
 * trade's concurrent siblings pointing the opposite way, so the distinction is
 * not hypothetical.
 *
 * Same side → +ρ (risks add). Opposite side → −ρ (risks offset). Positions on
 * the SAME symbol are the pure case: +1 doubling down, −1 flat.
 *
 * @param positions [{ symbol, side }] — side "long" | "short"
 */
export function signedAvgCorr(positions) {
  const list = (positions || []).filter((p) => p && p.symbol);
  if (list.length < 2) return 0;
  let sum = 0, n = 0;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const rho = pairCorr(list[i].symbol, list[j].symbol);
      const same = (list[i].side || "long") === (list[j].side || "long");
      sum += same ? rho : -rho;
      n++;
    }
  }
  return n ? sum / n : 0;
}

/**
 * The effective heat cap for a portfolio: `base` when everything is correlated,
 * rising toward `max` as the open positions (plus the candidate) become
 * uncorrelated. Negative correlations count as maximum diversification.
 * @param {string[]} openSymbols  currently open instrument symbols
 * @param {string} newSymbol      the candidate being considered
 */
export function effectiveHeatCap(openPositions, candidate, base = 0.10, max = 0.20) {
  // Accepts plain symbols (the original signature) or { symbol, side } objects.
  // Strings fall back to the unsigned model, which is the conservative reading:
  // an unknown direction is assumed to compound rather than to hedge.
  const norm = (x) => (typeof x === "string" ? { symbol: x, side: null } : x);
  const all = [...(openPositions || []).map(norm), norm(candidate)].filter((p) => p && p.symbol);
  const anyDirected = all.some((p) => p.side);
  const corr = anyDirected
    ? signedAvgCorr(all.map((p) => ({ ...p, side: p.side || "long" })))
    : avgPairwiseCorr(all.map((p) => p.symbol));
  // A NEGATIVE average (a genuinely hedged book) counts as full diversification,
  // not as something better than that — the cap still stops at `max`.
  const diversification = 1 - Math.max(0, Math.min(1, corr)); // 0 (all one way) → 1 (uncorrelated or hedged)
  return Math.max(base, Math.min(max, base + (max - base) * diversification));
}
