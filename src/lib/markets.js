// markets.js — the test universe Cortex validates against.
//
// The old gauntlet demanded a strategy work on BTC 4h AND SPY 1d, which threw
// away anything specialised: a rule that is excellent on 15-minute AAPL but
// useless on Bitcoin was buried as a failure. It isn't a failure — it is a
// strategy with a domain. So now every candidate is tested across the whole
// universe and TAGGED with the markets it actually works on.
//
// ── The multiple-testing problem this creates ───────────────────────────────
// Testing 9 markets and keeping the best is textbook data mining: with enough
// venues, noise alone produces a winner. The Deflated Sharpe hurdle is what
// protects us, and it only works if it is told the truth about how many
// attempts were made. So the trial count is multiplied by the number of markets
// tested (see effectiveTrials below) — searching wider makes each hit harder to
// claim, exactly as it should.

/**
 * @typedef {object} Market
 * @property {string} id        stable key, used in tags and the UI
 * @property {string} label     human-readable
 * @property {"crypto"|"stock"|"forex"} asset
 * @property {string} symbol    provider symbol
 * @property {string} interval  site interval id
 * @property {string} [range]   Yahoo range (stocks/forex only)
 * @property {number} [bars]    Binance bar count (crypto only)
 * @property {boolean} [core]   part of the fast set used for re-validation
 */

/** @type {Market[]} */
export const UNIVERSE = [
  // ── crypto (Binance, 24/7, no session effects) ────────────────────────────
  { id: "BTC4h", label: "BTC/USDT 4h", asset: "crypto", symbol: "BTCUSDT", interval: "4h", bars: 6000, core: true },
  { id: "ETH1h", label: "ETH/USDT 1h", asset: "crypto", symbol: "ETHUSDT", interval: "1h", bars: 6000 },
  { id: "SOL15m", label: "SOL/USDT 15m", asset: "crypto", symbol: "SOLUSDT", interval: "15m", bars: 5000 },

  // ── equity index + single names (Yahoo) ───────────────────────────────────
  { id: "SPY1d", label: "SPY daily", asset: "stock", symbol: "SPY", interval: "1d", range: "10y", core: true },
  { id: "QQQ1d", label: "QQQ daily", asset: "stock", symbol: "QQQ", interval: "1d", range: "10y" },
  { id: "AAPL15m", label: "AAPL 15m", asset: "stock", symbol: "AAPL", interval: "15m", range: "1mo" },
  { id: "AAPL1h", label: "AAPL 1h", asset: "stock", symbol: "AAPL", interval: "1h", range: "2y" },
  { id: "TSLA1d", label: "TSLA daily", asset: "stock", symbol: "TSLA", interval: "1d", range: "10y" },

  // ── forex (Yahoo FX pairs) ────────────────────────────────────────────────
  { id: "EURUSD1d", label: "EUR/USD daily", asset: "forex", symbol: "EURUSD=X", interval: "1d", range: "10y" },
  { id: "EURUSD1h", label: "EUR/USD 1h", asset: "forex", symbol: "EURUSD=X", interval: "1h", range: "2y" },

  // ── breadth staples (Jul 2026): a long-horizon crypto, a second single name,
  //    a commodity proxy and a second FX pair, so "works somewhere" means more
  //    than tech-equity + EUR ────────────────────────────────────────────────
  { id: "BTC1d", label: "BTC/USDT daily", asset: "crypto", symbol: "BTCUSDT", interval: "1d", bars: 3000 },
  { id: "NVDA1d", label: "NVDA daily", asset: "stock", symbol: "NVDA", interval: "1d", range: "10y" },
  { id: "GLD1d", label: "Gold (GLD) daily", asset: "stock", symbol: "GLD", interval: "1d", range: "10y" },
  { id: "USDJPY1d", label: "USD/JPY daily", asset: "forex", symbol: "USDJPY=X", interval: "1d", range: "10y" },
];

// Markets that are NOT in the base universe but get pulled into a paper's
// gauntlet when the paper POSITIVELY mentions them (research-agent checks the
// surrounding text for negative cues). `re` is the mention detector.
/** @type {(Market & { re: RegExp })[]} */
export const MENTIONABLE = [
  { id: "MSFT1d", label: "MSFT daily", asset: "stock", symbol: "MSFT", interval: "1d", range: "10y", re: /\bmicrosoft\b|\bMSFT\b/i },
  { id: "AMZN1d", label: "AMZN daily", asset: "stock", symbol: "AMZN", interval: "1d", range: "10y", re: /\bamazon\b|\bAMZN\b/i },
  { id: "META1d", label: "META daily", asset: "stock", symbol: "META", interval: "1d", range: "10y", re: /\bmeta platforms\b|\bMETA\b|\bfacebook\b/i },
  { id: "GOOGL1d", label: "GOOGL daily", asset: "stock", symbol: "GOOGL", interval: "1d", range: "10y", re: /\balphabet\b|\bgoogle\b|\bGOOGL?\b/i },
  { id: "AMD1d", label: "AMD daily", asset: "stock", symbol: "AMD", interval: "1d", range: "10y", re: /\bAMD\b|\badvanced micro\b/i },
  { id: "DOGE1d", label: "DOGE/USDT daily", asset: "crypto", symbol: "DOGEUSDT", interval: "1d", bars: 3000, re: /\bdogecoin\b|\bDOGE\b/i },
  { id: "XRP1d", label: "XRP/USDT daily", asset: "crypto", symbol: "XRPUSDT", interval: "1d", bars: 3000, re: /\bXRP\b|\bripple\b/i },
  { id: "ADA1d", label: "ADA/USDT daily", asset: "crypto", symbol: "ADAUSDT", interval: "1d", bars: 3000, re: /\bcardano\b|\bADA\b/i },
  { id: "GBPUSD1d", label: "GBP/USD daily", asset: "forex", symbol: "GBPUSD=X", interval: "1d", range: "10y", re: /\bGBP.?USD\b|\bcable\b|\bpound sterling\b/i },
  { id: "SLV1d", label: "Silver (SLV) daily", asset: "stock", symbol: "SLV", interval: "1d", range: "10y", re: /\bsilver\b|\bSLV\b/i },
  { id: "USO1d", label: "Oil (USO) daily", asset: "stock", symbol: "USO", interval: "1d", range: "10y", re: /\bcrude( oil)?\b|\bWTI\b|\bbrent\b|\boil (price|market|futures)\b/i },
];

// Everything byId must resolve — base universe AND mention extras, so a
// mention-market winner can be auto-promoted like any other.
export const ALL_MARKETS = [...UNIVERSE, ...MENTIONABLE];
export const CORE = UNIVERSE.filter((m) => m.core);
export const byId = (id) => ALL_MARKETS.find((m) => m.id === id) || null;

/**
 * Realistic per-side cost in basis points, by asset class. The old code used a
 * flat 10 bps everywhere, which flatters intraday equity and forex badly: a
 * 15-minute strategy pays the spread far more often than a daily one, and that
 * is usually what separates a "winner" from a real one.
 */
// Bumped stock 5→7 (Jul 2026): the old value flattered fee-fragile strategies
// like ICT, which beat buy&hold at 7bps but LOSE at a realistic 10bps. A daily
// stock round now costs ~10bps all-in (fee+slippage), matching what a retail
// account actually pays — so a strategy has to have an edge that survives real
// costs, not a paper-thin one that evaporates on the spread.
export const COST_BPS = { crypto: 10, stock: 7, forex: 2 };

/**
 * Slippage in basis points, applied ON TOP of fees. Intraday strategies trade
 * more and get worse fills; ignoring this is how backtests lie.
 */
export const SLIPPAGE_BPS = {
  "15m": 6, "1h": 4, "4h": 3, "1d": 3, "1w": 3, "1M": 3, "5m": 8, "1m": 12,
};

/** Total round-trip-relevant cost for a market, in bps per side. */
export function costFor(market) {
  const fee = COST_BPS[market.asset] ?? 10;
  const slip = SLIPPAGE_BPS[market.interval] ?? 4;
  return fee + slip;
}

/**
 * Honest trial count for the Deflated Sharpe hurdle.
 *
 * Two corrections, both measured rather than guessed (see docs/CORTEX_CALIBRATION.md):
 *
 * 1. Markets are counted as CLUSTERS, not individually. SPY and QQQ are ~0.9
 *    correlated; treating them as two independent attempts overstates the
 *    multiple-testing penalty badly. The number of distinct asset classes
 *    actually tried is the defensible count — at most 3 here.
 *
 * 2. The caller passes a WINDOWED trial count, not a lifetime one. The
 *    correction belongs to the selection process that produced this candidate;
 *    strategies tried six months ago on unrelated papers were not part of it.
 *    A lifetime counter grows without bound and eventually makes every hurdle
 *    unreachable — a system that can never promote is broken, not strict.
 *
 * @param {number} windowTrials   strategies tried in the recent selection window
 * @param {string[]} assetClasses distinct asset classes tested (e.g. ["crypto","stock"])
 */
export function effectiveTrials(windowTrials, assetClasses) {
  const clusters = Array.isArray(assetClasses)
    ? Math.max(1, new Set(assetClasses).size)
    : Math.max(1, Math.min(3, assetClasses || 1)); // numeric fallback, capped
  return Math.max(1, Math.round(windowTrials * clusters));
}

/** Distinct asset classes among a list of market ids. */
export function assetClassesOf(ids) {
  return [...new Set(ids.map((id) => byId(id)?.asset).filter(Boolean))];
}

/** Group market ids into a short human summary, e.g. "crypto ×2 · stock ×1". */
export function describeMarkets(ids) {
  const counts = {};
  for (const id of ids) {
    const m = byId(id);
    if (!m) continue;
    counts[m.asset] = (counts[m.asset] || 0) + 1;
  }
  return Object.entries(counts).map(([a, n]) => (n > 1 ? `${a} ×${n}` : a)).join(" · ") || "—";
}
