// dataBias.js — the FUNDAMENTAL (news & data) bias, and the blend with the
// technical rule-based bias. Pure + dependency-free so it's unit-testable and runs
// identically on the client. The deterministic score below is the always-free base;
// a cached LLM sentence (via /api/bias) enriches it with current news / world context.

// Yahoo recommendationKey → a directional vote.
const RATING_VOTE = { strong_buy: 1, buy: 1, hold: 0, underperform: -1, sell: -1, strong_sell: -1 };

/**
 * Deterministic fundamental bias from the structured data a stock exposes:
 * analyst rating, price-target upside, the recent earnings beat/miss streak,
 * revenue growth and valuation. Each factor is one ±1 vote, mirroring the
 * technical rule-based bias so the two are directly comparable and blendable.
 * Crypto has no company fundamentals → an empty score (the LLM note leads instead).
 * @returns {{ verdict, score, maxScore, factors: {id,label,detail,vote}[], hasData }}
 */
export function computeDataBias(info, market = "stock") {
  if (market === "crypto" || !info) {
    return { verdict: "neutral", score: 0, maxScore: 0, factors: [], hasData: false };
  }
  const f = [];
  const { recommendation, analysts, targetMean, price, quarters, revenueGrowth, forwardPE, profitMargin } = info;

  // 1) Analyst consensus.
  if (recommendation) {
    const v = RATING_VOTE[String(recommendation).toLowerCase()] ?? 0;
    f.push({ id: "rating", label: "Analyst consensus", vote: v,
      detail: `${recommendation}${analysts ? ` · ${analysts} analysts` : ""}` });
  }
  // 2) Price-target upside.
  if (targetMean != null && price > 0) {
    const up = targetMean / price - 1;
    const v = up >= 0.08 ? 1 : up <= -0.08 ? -1 : 0;
    f.push({ id: "target", label: "Price target", vote: v,
      detail: `mean ${targetMean.toFixed(2)} · ${up >= 0 ? "+" : ""}${(up * 100).toFixed(1)}% to price` });
  }
  // 3) Earnings beat/miss streak (last ≤4 quarters).
  const qs = (quarters || []).filter((q) => q.actual != null && q.est != null).slice(-4);
  if (qs.length) {
    const net = qs.reduce((a, q) => a + (q.actual >= q.est ? 1 : -1), 0);
    const beats = qs.filter((q) => q.actual >= q.est).length;
    const v = net > 0 ? 1 : net < 0 ? -1 : 0;
    f.push({ id: "earnings", label: "Earnings delivery", vote: v,
      detail: `${beats}/${qs.length} recent quarters beat estimates` });
  }
  // 4) Revenue growth (yoy).
  if (revenueGrowth != null) {
    const v = revenueGrowth >= 0.03 ? 1 : revenueGrowth <= -0.03 ? -1 : 0;
    f.push({ id: "growth", label: "Revenue growth", vote: v,
      detail: `${revenueGrowth >= 0 ? "+" : ""}${(revenueGrowth * 100).toFixed(1)}% yoy${profitMargin != null ? ` · margin ${(profitMargin * 100).toFixed(0)}%` : ""}` });
  }
  // 5) Valuation — a cheap, profitable name is a tailwind; a very rich one a headwind.
  if (forwardPE != null && forwardPE > 0) {
    const v = forwardPE > 45 ? -1 : forwardPE < 12 && (profitMargin ?? 1) > 0 ? 1 : 0;
    f.push({ id: "valuation", label: "Valuation", vote: v,
      detail: `forward P/E ${forwardPE.toFixed(1)}${v < 0 ? " — stretched" : v > 0 ? " — cheap" : ""}` });
  }

  const score = f.reduce((a, x) => a + x.vote, 0);
  const maxScore = f.length; // one ±1 vote each
  const verdict = score >= 2 ? "long" : score <= -2 ? "short" : "neutral";
  return { verdict, score, maxScore, factors: f, hasData: f.length > 0 };
}

// A bias's score as a signed strength in [-1, 1] (0 when it has no votes).
export function biasNorm(bias) {
  if (!bias || !bias.maxScore) return 0;
  return Math.max(-1, Math.min(1, bias.score / bias.maxScore));
}

/**
 * How much the FUNDAMENTAL view should weigh vs the TECHNICAL one at a given
 * timeframe. Intraday, price action dominates and news barely matters; over weeks
 * and months, fundamentals/news drive the move. Grows smoothly with the log of the
 * candle interval, clamped to [0.1, 0.8]. (This is the user's a↔b dial.)
 */
export function horizonWeight(tfSeconds) {
  const s = Math.max(1, tfSeconds || 3600);
  const w = (Math.log10(s) - 2.3) * 0.17; // 5m≈0.03→0.1, 1h≈0.28, 1d≈0.45, 1w≈0.62, 1M≈0.70
  return Math.max(0.1, Math.min(0.8, w));
}

/**
 * Combine the technical and fundamental biases for a given timeframe. `dataNorm`
 * may come from the deterministic score OR (for crypto / when the LLM has a view
 * and the deterministic score is empty) from the LLM verdict, so the caller passes
 * the already-normalized values.
 * @returns {{ verdict, norm, wData, wTech }}
 */
export function combineBias(techNorm, dataNorm, tfSeconds) {
  const wData = horizonWeight(tfSeconds);
  const wTech = 1 - wData;
  const norm = wTech * (techNorm || 0) + wData * (dataNorm || 0);
  const verdict = norm > 0.15 ? "long" : norm < -0.15 ? "short" : "neutral";
  return { verdict, norm, wData, wTech };
}

// Which fundamental horizon a chart timeframe corresponds to — so a shared
// timeframe selector maps onto the news/data view's days/weeks/months targets.
export function tfHorizon(tfSeconds) {
  const s = tfSeconds || 3600;
  return s <= 3600 ? "short" : s <= 86400 ? "medium" : "long";
}
export const HORIZON_LABEL = { short: "days", medium: "weeks", long: "months" };

// Map an LLM/verbal verdict to a normalized strength so it can feed combineBias.
export function verdictNorm(verdict, confidence = 0.6) {
  const c = Math.max(0, Math.min(1, confidence));
  if (verdict === "long") return c;
  if (verdict === "short") return -c;
  return 0;
}
