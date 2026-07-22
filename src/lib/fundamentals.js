// fundamentals.js — what a symbol IS, plus real fundamentals beyond the price.
// Stocks/ETFs: Yahoo quoteSummary via the site's own /api/yahoo proxy (company
// profile, analyst targets, quarterly EPS estimate vs. actual, next earnings).
// Crypto: curated descriptions (no earnings — there's nothing to report).

const CACHE = new Map(); // symbol -> { t, v }
const TTL_MS = 10 * 60 * 1000;

const MODULES = "assetProfile,defaultKeyStatistics,calendarEvents,earningsHistory,financialData";

/** Normalized stock/ETF fundamentals for the info panel. Throws on failure. */
export async function fetchStockInfo(symbol) {
  const key = String(symbol).toUpperCase();
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.t < TTL_MS) return hit.v;

  const res = await fetch(`/api/yahoo/v10/finance/quoteSummary/${encodeURIComponent(key)}?modules=${MODULES}`);
  if (!res.ok) throw new Error(`fundamentals HTTP ${res.status}`);
  const m = (await res.json())?.quoteSummary?.result?.[0];
  if (!m) throw new Error("no fundamentals for this symbol");

  const p = m.assetProfile || {};
  const fd = m.financialData || {};
  const ks = m.defaultKeyStatistics || {};
  const ce = m.calendarEvents || {};

  const v = {
    summary: p.longBusinessSummary || "",
    sector: p.sectorDisp || p.sector || null,
    industry: p.industryDisp || p.industry || null,
    website: p.website || null,
    employees: p.fullTimeEmployees ?? null,
    price: fd.currentPrice?.raw ?? null,
    targetMean: fd.targetMeanPrice?.raw ?? null,
    targetHigh: fd.targetHighPrice?.raw ?? null,
    targetLow: fd.targetLowPrice?.raw ?? null,
    recommendation: fd.recommendationKey || null, // "buy" | "hold" | …
    analysts: fd.numberOfAnalystOpinions?.raw ?? null,
    profitMargin: fd.profitMargins?.raw ?? null,   // fraction
    revenueGrowth: fd.revenueGrowth?.raw ?? null,  // fraction, yoy
    trailingEps: ks.trailingEps?.raw ?? null,
    forwardPE: ks.forwardPE?.raw ?? null,
    nextEarnings: ce.earnings?.earningsDate?.[0]?.fmt || null,
    // Quarterly report card: what analysts expected vs. what was delivered.
    quarters: ((m.earningsHistory || {}).history || [])
      .map((q) => ({
        quarter: q.quarter?.fmt || "",
        est: q.epsEstimate?.raw ?? null,
        actual: q.epsActual?.raw ?? null,
        surprisePct: q.surprisePercent?.raw != null ? q.surprisePercent.raw * 100 : null,
      }))
      .filter((q) => q.est != null || q.actual != null),
  };

  CACHE.set(key, { t: Date.now(), v });
  return v;
}

// Curated crypto descriptions — what it is and what it's known for. Keyed by
// base asset (BTCUSDT → BTC). Static on purpose: identity doesn't change daily.
export const CRYPTO_INFO = {
  BTC: "Bitcoin — the first and largest cryptocurrency (2009, Satoshi Nakamoto). A decentralized, fixed-supply (21M) digital asset secured by proof-of-work; known as 'digital gold' and the market's reserve asset.",
  ETH: "Ethereum — the leading smart-contract platform (2015, Vitalik Buterin). Runs decentralized apps, DeFi and NFTs; ETH pays for computation ('gas') and is staked to secure the proof-of-stake network.",
  SOL: "Solana — a high-throughput smart-contract chain known for very fast, cheap transactions (proof-of-history + proof-of-stake). Popular for DeFi, NFTs and consumer apps.",
  BNB: "BNB — the exchange token of Binance, the largest crypto exchange. Used for trading-fee discounts and as the gas token of the BNB Chain ecosystem.",
  XRP: "XRP — the token of the XRP Ledger (Ripple), built for fast, low-cost cross-border payments and used by payment institutions.",
  ADA: "Cardano (ADA) — a research-driven proof-of-stake chain (Charles Hoskinson, Ethereum co-founder), known for peer-reviewed development and staking.",
  DOGE: "Dogecoin — the original meme coin (2013), a Litecoin fork with unlimited supply. Known for its community and Elon Musk's endorsements.",
  AVAX: "Avalanche (AVAX) — a fast proof-of-stake platform with 'subnets' (app-specific chains), positioned for DeFi and institutional use.",
  LINK: "Chainlink (LINK) — the dominant oracle network: it feeds real-world data (prices, events) to smart contracts across many chains. Critical DeFi infrastructure.",
  DOT: "Polkadot (DOT) — a multi-chain network (Gavin Wood, Ethereum co-founder) connecting specialized 'parachains' through a shared security layer.",
  MATIC: "Polygon (MATIC/POL) — Ethereum's best-known scaling ecosystem: cheaper, faster transactions that settle back to Ethereum.",
  POL: "Polygon (POL) — Ethereum's best-known scaling ecosystem: cheaper, faster transactions that settle back to Ethereum.",
  LTC: "Litecoin — one of the oldest Bitcoin forks (2011): 'silver to Bitcoin's gold', with faster blocks and lower fees; often used for payments.",
  TRX: "TRON (TRX) — a smart-contract chain known for cheap transfers and for carrying a large share of stablecoin (USDT) payments volume.",
  SHIB: "Shiba Inu — a Dogecoin-inspired meme token on Ethereum with a large community and its own DEX/L2 ambitions (Shibarium).",
  UNI: "Uniswap (UNI) — governance token of the largest decentralized exchange; its automated-market-maker model defined how DeFi trading works.",
  ATOM: "Cosmos (ATOM) — the 'internet of blockchains': an ecosystem of sovereign, interoperable chains connected through the IBC protocol.",
  XLM: "Stellar (XLM) — a payments-focused network for fast, low-cost cross-border transfers and asset tokenization, sibling to Ripple by design.",
  NEAR: "NEAR — a developer-friendly proof-of-stake chain with sharding, known for usability and an AI-adjacent ecosystem push.",
};

/** Crypto description for a trading pair (BTCUSDT → BTC entry), or null. */
export function cryptoInfoFor(symbol) {
  const base = String(symbol).toUpperCase().replace(/(USDT|USD|USDC|EUR)$/, "");
  return CRYPTO_INFO[base] ? { base, summary: CRYPTO_INFO[base] } : { base, summary: null };
}
