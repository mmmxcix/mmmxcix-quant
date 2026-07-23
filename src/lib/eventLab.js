// eventLab.js — event-study statistics (the "AAPL WWDC straddle" reel as a
// real tool). Given a symbol's daily candles and a list of event dates:
// how does the stock actually move on event days, what would an ATM straddle
// have paid, and what does Kelly say about sizing it?
//
// Honesty rules: event samples are SMALL (4-20 events) — every output carries
// n, and the verdict compares event moves against the stock's ordinary days
// instead of pretending a mean of 8 numbers is a law of nature.

/** Map an event date (YYYY-MM-DD) to the index of that (or the next) trading day. */
function tradingDayIndex(candles, dateStr) {
  const target = Date.parse(dateStr + "T00:00:00Z");
  if (!Number.isFinite(target)) return -1;
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].time * 1000 >= target) return i;
  }
  return -1;
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const std = (xs) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};
const skewness = (xs) => {
  const n = xs.length;
  if (n < 3) return 0;
  const m = mean(xs), s = std(xs);
  if (s === 0) return 0;
  return (n / ((n - 1) * (n - 2))) * xs.reduce((a, b) => a + ((b - m) / s) ** 3, 0);
};
const kurtosis = (xs) => {
  const n = xs.length;
  if (n < 4) return 0;
  const m = mean(xs), s = std(xs);
  if (s === 0) return 0;
  const m4 = mean(xs.map((x) => ((x - m) / s) ** 4));
  return m4 - 3; // excess kurtosis
};

/**
 * The event study.
 * @param candles daily candles (ascending)
 * @param dates   ["YYYY-MM-DD", …] event dates
 * @param premiumPct straddle cost as % of spot (both legs, e.g. 4 = 4%)
 * @returns stats + per-event rows + straddle/Kelly analysis
 */
export function eventStudy(candles, dates, premiumPct = 4) {
  const rows = [];
  for (const d of dates) {
    const i = tradingDayIndex(candles, d);
    if (i < 1 || i >= candles.length) continue;
    const prevClose = candles[i - 1].close;
    if (!(prevClose > 0)) continue;
    // Event-day move: prior close → event close (the straddle window of the
    // reel: hold over the announcement).
    const ret = candles[i].close / prevClose - 1;
    rows.push({
      date: d,
      tradedOn: new Date(candles[i].time * 1000).toISOString().slice(0, 10),
      retPct: +(ret * 100).toFixed(2),
      absPct: +(Math.abs(ret) * 100).toFixed(2),
    });
  }
  if (rows.length < 3) return { ok: false, reason: `only ${rows.length} events matched the price history — need at least 3` };

  const rets = rows.map((r) => r.retPct / 100);
  const absMoves = rows.map((r) => r.absPct / 100);

  // Baseline: the stock's ORDINARY daily move (median |return| across all days)
  // — the honest yardstick for "do events actually move it more?"
  const allAbs = [];
  for (let i = 1; i < candles.length; i++) {
    if (candles[i - 1].close > 0) allAbs.push(Math.abs(candles[i].close / candles[i - 1].close - 1));
  }
  allAbs.sort((a, b) => a - b);
  const typicalAbs = allAbs.length ? allAbs[Math.floor(allAbs.length / 2)] : 0;

  // Straddle economics: profit when |move| exceeds the premium paid.
  const prem = premiumPct / 100;
  const pnl = absMoves.map((m) => m - prem);
  const wins = pnl.filter((x) => x > 0);
  const losses = pnl.filter((x) => x <= 0);
  const p = pnl.length ? wins.length / pnl.length : 0;
  const avgWin = wins.length ? mean(wins) : 0;
  const avgLoss = losses.length ? Math.abs(mean(losses)) : prem;
  const b = avgLoss > 0 ? avgWin / avgLoss : 0;
  // Kelly fraction f* = p − (1−p)/b — clamped at 0; also show quarter-Kelly,
  // which is what practitioners actually size with.
  const kelly = b > 0 ? Math.max(0, p - (1 - p) / b) : 0;

  return {
    ok: true,
    n: rows.length,
    rows,
    stats: {
      meanPct: +(mean(rets) * 100).toFixed(2),
      stdPct: +(std(rets) * 100).toFixed(2),
      skew: +skewness(rets).toFixed(2),
      kurtosis: +kurtosis(rets).toFixed(2),
      meanAbsPct: +(mean(absMoves) * 100).toFixed(2),
      typicalAbsPct: +(typicalAbs * 100).toFixed(2),
      moveRatio: typicalAbs > 0 ? +(mean(absMoves) / typicalAbs).toFixed(1) : null,
    },
    straddle: {
      premiumPct,
      winRatePct: +(p * 100).toFixed(0),
      avgWinPct: +(avgWin * 100).toFixed(2),
      avgLossPct: +(avgLoss * 100).toFixed(2),
      payoffRatio: +b.toFixed(2),
      avgPnlPct: +(mean(pnl) * 100).toFixed(2),
      kellyPct: +(kelly * 100).toFixed(1),
      quarterKellyPct: +((kelly / 4) * 100).toFixed(1),
    },
  };
}
