// tradeBias.js — deterministic, rule-based market bias + SL/TP suggestion.
//
// No AI, no randomness: a fixed set of if-then rules, each voting bullish
// (+1), bearish (−1) or neutral (0). The sum decides the bias; the stop and
// targets come from the auto-detected structure (levels, swings) and ATR.
// Every rule reports its own reasoning so the user can audit the verdict.
//
// This is an educational readout of past data — NOT investment advice. The UI
// must always display that disclaimer alongside the output.

import { sma, rsi, macd, atr, closes } from "./indicators.js";
import { findPivots, detectLevels, detectTrendlines, detectFVGs, detectDoublePatterns } from "./autoAnnotate.js";

const fmtP = (v) => {
  if (v == null || !isFinite(v)) return "–";
  const a = Math.abs(v);
  const dec = a >= 1000 ? 0 : a >= 1 ? 2 : a >= 0.01 ? 4 : 6;
  return v.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
};

/**
 * Compute the rule-based bias and a structure-derived trade plan.
 * @param {Array} candles ascending OHLCV
 * @returns {null | {
 *   score:number, maxScore:number, verdict:"long"|"short"|"neutral",
 *   rules:{id,label,vote,detail}[],
 *   plan:null|{side,entry,stop,tp1,tp2,rr1,atr,stopBasis,tpBasis},
 *   caution:string|null,
 * }}
 */
export function computeBias(candles) {
  if (!Array.isArray(candles) || candles.length < 60) return null;

  const cl = closes(candles);
  const n = candles.length;
  const last = candles[n - 1];
  const entry = last.close;

  const sma20 = sma(cl, 20)[n - 1];
  const sma50 = sma(cl, 50)[n - 1];
  const rsi14 = rsi(cl, 14)[n - 1];
  const macdNow = macd(cl)[n - 1];
  const atr14 = atr(candles, 14)[n - 1];
  if (sma50 == null || rsi14 == null || atr14 == null || !(atr14 > 0)) return null;

  const pivots = findPivots(candles);
  const levels = detectLevels(candles);
  const trendlines = detectTrendlines(candles);
  const fvgs = detectFVGs(candles);
  const patterns = detectDoublePatterns(candles);

  const rules = [];
  const vote = (id, label, v, detail) => rules.push({ id, label, vote: v, detail });

  // 1) Price vs. trend average.
  vote("ma", "Price vs. SMA 50",
    entry > sma50 ? 1 : -1,
    `close ${fmtP(entry)} ${entry > sma50 ? ">" : "<"} SMA50 ${fmtP(sma50)}`);

  // 2) Average alignment (fast above slow = established uptrend).
  if (sma20 != null) {
    vote("align", "SMA 20 vs. SMA 50",
      sma20 > sma50 ? 1 : -1,
      `SMA20 ${fmtP(sma20)} ${sma20 > sma50 ? ">" : "<"} SMA50 ${fmtP(sma50)}`);
  }

  // 3) Market structure from the last two swing highs + lows.
  const { highs, lows } = pivots;
  if (highs.length >= 2 && lows.length >= 2) {
    const hh = highs[highs.length - 1].price > highs[highs.length - 2].price;
    const hl = lows[lows.length - 1].price > lows[lows.length - 2].price;
    const v = hh && hl ? 1 : !hh && !hl ? -1 : 0;
    vote("structure", "Swing structure",
      v,
      v === 1 ? "higher highs + higher lows" : v === -1 ? "lower highs + lower lows" : "mixed (no clean structure)");
  }

  // 4) RSI momentum around the 50 line.
  vote("rsi", "RSI(14) momentum",
    rsi14 > 55 ? 1 : rsi14 < 45 ? -1 : 0,
    `RSI ${rsi14.toFixed(1)} ${rsi14 > 55 ? "> 55 (bullish)" : rsi14 < 45 ? "< 45 (bearish)" : "≈ neutral zone"}`);

  // 5) MACD line vs. signal line.
  if (macdNow) {
    vote("macd", "MACD vs. signal",
      macdNow.macd > macdNow.signal ? 1 : -1,
      `MACD ${macdNow.macd > macdNow.signal ? "above" : "below"} signal (hist ${macdNow.hist >= 0 ? "+" : ""}${macdNow.hist.toFixed(2)})`);
  }

  // 6) Active auto trendline (a broken line was already discarded upstream).
  const hasUp = trendlines.some((t) => t.kind === "up");
  const hasDown = trendlines.some((t) => t.kind === "down");
  vote("trendline", "Active trendline",
    hasUp && !hasDown ? 1 : hasDown && !hasUp ? -1 : 0,
    hasUp && !hasDown ? "intact ascending support line" : hasDown && !hasUp ? "intact descending resistance line" : "none / both");

  // 7) Most recent unfilled fair value gap.
  const lastFvg = fvgs[fvgs.length - 1];
  vote("fvg", "Latest unfilled FVG",
    lastFvg ? (lastFvg.kind === "bull" ? 1 : -1) : 0,
    lastFvg ? `${lastFvg.kind === "bull" ? "bullish" : "bearish"} gap ${fmtP(lastFvg.bottom)}–${fmtP(lastFvg.top)}` : "none active");

  // 8) Room to the next level: closer to support favors long, and vice versa.
  const supBelow = levels.filter((l) => l.price < entry).sort((a, b) => b.price - a.price)[0] || null;
  const resAbove = levels.filter((l) => l.price > entry).sort((a, b) => a.price - b.price)[0] || null;
  if (supBelow && resAbove) {
    const dSup = entry - supBelow.price;
    const dRes = resAbove.price - entry;
    const v = dRes > dSup * 1.5 ? 1 : dSup > dRes * 1.5 ? -1 : 0;
    vote("room", "Room between S/R",
      v,
      `support ${fmtP(dSup)} below · resistance ${fmtP(dRes)} above`);
  }

  // 9) Reversal pattern on the recent swings.
  const pat = patterns[patterns.length - 1];
  vote("pattern", "Double top/bottom",
    pat ? (pat.type === "double-bottom" ? 1 : -1) : 0,
    pat ? pat.type.replace("-", " ") : "none detected");

  const score = rules.reduce((s, r) => s + r.vote, 0);
  const maxScore = rules.length;
  const verdict = score >= 2 ? "long" : score <= -2 ? "short" : "neutral";

  // Overextension caution: bias may be up but chasing RSI 80 is a bad entry.
  let caution = null;
  if (verdict === "long" && rsi14 > 70) caution = `RSI ${rsi14.toFixed(0)} is overbought — extended, consider waiting for a pullback.`;
  if (verdict === "short" && rsi14 < 30) caution = `RSI ${rsi14.toFixed(0)} is oversold — extended, consider waiting for a bounce.`;

  // ── Structure-based SL/TP plan ────────────────────────────────────────────
  let plan = null;
  if (verdict !== "neutral") {
    const lastLow = lows.length ? lows[lows.length - 1].price : null;
    const lastHigh = highs.length ? highs[highs.length - 1].price : null;
    const buf = atr14 * 0.3;

    if (verdict === "long") {
      // Stop under the nearest structure below (level or last swing low).
      const candidates = [supBelow?.price, lastLow].filter((p) => p != null && p < entry);
      const structure = candidates.length ? Math.max(...candidates) : null;
      const usable = structure != null && entry - structure <= atr14 * 3;
      const stop = usable ? structure - buf : entry - atr14 * 1.5;
      const risk = entry - stop;
      // First target: nearest meaningful resistance; fallback 2 ATR.
      const tp1 = resAbove && resAbove.price - entry >= atr14 * 0.5 ? resAbove.price : entry + atr14 * 2;
      const tp2 = entry + risk * 2;
      plan = {
        side: "long", entry, stop, tp1, tp2, atr: atr14,
        rr1: risk > 0 ? (tp1 - entry) / risk : 0,
        stopBasis: usable ? "below nearest support/swing low − 0.3 ATR" : "1.5 × ATR below entry (no clean structure nearby)",
        tpBasis: resAbove && resAbove.price - entry >= atr14 * 0.5 ? "nearest resistance level" : "2 × ATR above entry",
      };
    } else {
      const candidates = [resAbove?.price, lastHigh].filter((p) => p != null && p > entry);
      const structure = candidates.length ? Math.min(...candidates) : null;
      const usable = structure != null && structure - entry <= atr14 * 3;
      const stop = usable ? structure + buf : entry + atr14 * 1.5;
      const risk = stop - entry;
      const tp1 = supBelow && entry - supBelow.price >= atr14 * 0.5 ? supBelow.price : entry - atr14 * 2;
      const tp2 = entry - risk * 2;
      plan = {
        side: "short", entry, stop, tp1, tp2, atr: atr14,
        rr1: risk > 0 ? (entry - tp1) / risk : 0,
        stopBasis: usable ? "above nearest resistance/swing high + 0.3 ATR" : "1.5 × ATR above entry (no clean structure nearby)",
        tpBasis: supBelow && entry - supBelow.price >= atr14 * 0.5 ? "nearest support level" : "2 × ATR below entry",
      };
    }
  }

  return { score, maxScore, verdict, rules, plan, caution };
}
