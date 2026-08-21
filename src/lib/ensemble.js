// ensemble.js — the Tier-1 geometry (see docs/CORTEX_BENCHMARK.md).
//
// One rule is graded on its POOLED daily returns across every market it ran on
// (equal-weight, rebalanced daily): a single-asset timing rule realistically
// carries Sharpe 0.2–0.5, and pooling N low-correlation venues is what lifts a
// real edge above noise — breadth does the statistical work that per-market
// trade counts never could (Carver; Grinold's IR = IC·√breadth). Rules that
// clear the pooled bars then combine into ONE ensemble book, and the hard
// quant-grade bars (Sharpe ≥ 1, beat buy&hold) apply to THAT book — the level
// where they are achievable and meaningful.
//
// Pure module: imported by Node agents and (later) React pages. No fetch/DOM.

/** UTC calendar date of a unix-seconds timestamp. */
const dateOf = (t) => new Date(t * 1000).toISOString().slice(0, 10);

/**
 * Per-bar equity curve [{time, value}] → daily return series
 * [{ d: "YYYY-MM-DD", r }] using the LAST equity mark of each UTC day.
 * Zero-value marks (liquidation) end the series — no returns after ruin.
 */
export function dailyReturnsOf(equity) {
  const byDay = new Map();
  for (const p of equity || []) {
    if (p && Number.isFinite(p.value)) byDay.set(dateOf(p.time), p.value);
  }
  const days = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const out = [];
  for (let i = 1; i < days.length; i++) {
    const prev = days[i - 1][1];
    if (!(prev > 0)) break; // ruined — the curve has no further returns
    out.push({ d: days[i][0], r: days[i][1] / prev - 1 });
  }
  return out;
}

/** Close-price daily returns of a candle array — the buy&hold twin of a rule's
 *  dailyReturnsOf, used to build the ensemble's benchmark portfolio. */
export function dailyCloseReturns(candles) {
  return dailyReturnsOf((candles || []).map((c) => ({ time: c.time, value: c.close })));
}

/**
 * Pool several daily-return series by calendar date: each date's pooled return
 * is the MEAN over the series that report that date (an equal-weight portfolio
 * whose breadth grows as instruments' histories come online — ragged early
 * windows are represented honestly as a narrower portfolio, not dropped).
 * Returns { dates: string[], returns: number[] } sorted by date.
 */
export function poolDaily(seriesList) {
  const acc = new Map(); // date -> { sum, n }
  for (const series of seriesList || []) {
    for (const { d, r } of series || []) {
      if (!Number.isFinite(r)) continue;
      const a = acc.get(d) || { sum: 0, n: 0 };
      a.sum += r; a.n++;
      acc.set(d, a);
    }
  }
  const dates = [...acc.keys()].sort();
  return { dates, returns: dates.map((d) => acc.get(d).sum / acc.get(d).n) };
}

/** Annualized Sharpe of a daily-return series (√252, sample stdev, rf 0). */
export function sharpeDaily(returns, minObs = 20) {
  const r = (returns || []).filter(Number.isFinite);
  if (r.length < minObs) return 0;
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const varr = r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1);
  const sd = Math.sqrt(varr);
  return sd > 0 ? (mean / sd) * Math.sqrt(252) : 0;
}

/** Max drawdown (%) of the compounded daily-return series. */
export function maxDrawdownPctDaily(returns) {
  let eq = 1, peak = 1, dd = 0;
  for (const r of returns || []) {
    if (!Number.isFinite(r)) continue;
    eq *= 1 + r;
    peak = Math.max(peak, eq);
    if (peak > 0) dd = Math.max(dd, (peak - eq) / peak);
  }
  return dd * 100;
}

/** Total compounded return (%) of a daily-return series. */
export function totalReturnPctDaily(returns) {
  let eq = 1;
  for (const r of returns || []) if (Number.isFinite(r)) eq *= 1 + r;
  return (eq - 1) * 100;
}

/** k contiguous time folds of the pooled series — how many are profitable?
 *  The pooled twin of kFoldCode: pure math on the series, no re-backtesting. */
export function foldsProfitable(returns, k = 5) {
  const r = (returns || []).filter(Number.isFinite);
  const total = Math.min(k, Math.max(1, Math.floor(r.length / 40))); // ≥40 obs per fold
  const size = Math.floor(r.length / total) || 1;
  let profitable = 0;
  for (let f = 0; f < total; f++) {
    const slice = r.slice(f * size, f === total - 1 ? r.length : (f + 1) * size);
    let eq = 1;
    for (const x of slice) eq *= 1 + x;
    if (eq > 1) profitable++;
  }
  return { profitable, total };
}

/** Stats of the most recent `frac` of the series — the pooled holdout tail. */
export function tailStats(returns, frac = 0.3) {
  const r = (returns || []).filter(Number.isFinite);
  const cut = Math.floor(r.length * (1 - frac));
  const tail = r.slice(cut);
  return { n: tail.length, retPct: totalReturnPctDaily(tail), sharpe: sharpeDaily(tail, 10) };
}

/**
 * Pearson correlation of two daily series over their date intersection.
 * Returns null when the overlap is too short to mean anything — the caller
 * treats "unknown" as admissible rather than inventing a number.
 */
export function corrDaily(a, b, minOverlap = 60) {
  const mapA = new Map();
  for (let i = 0; i < (a?.dates?.length || 0); i++) mapA.set(a.dates[i], a.returns[i]);
  const xs = [], ys = [];
  for (let i = 0; i < (b?.dates?.length || 0); i++) {
    const va = mapA.get(b.dates[i]);
    if (va != null && Number.isFinite(va) && Number.isFinite(b.returns[i])) { xs.push(va); ys.push(b.returns[i]); }
  }
  if (xs.length < minOverlap) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
  const my = ys.reduce((s, v) => s + v, 0) / ys.length;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  const den = Math.sqrt(dx * dy);
  return den > 0 ? num / den : 0;
}

/** Pooled profit factor across all markets' trade lists: Σwins / |Σlosses|. */
export function pooledProfitFactor(tradesArrays) {
  let win = 0, loss = 0;
  for (const trades of tradesArrays || []) {
    for (const t of trades || []) {
      const p = Number(t?.pnl);
      if (!Number.isFinite(p)) continue;
      if (p >= 0) win += p; else loss -= p;
    }
  }
  return loss > 0 ? win / loss : win > 0 ? Infinity : 0;
}

/** Compact a {dates, returns} series for storage: 5-decimal returns. */
export function compactSeries(series) {
  return {
    dates: series?.dates || [],
    returns: (series?.returns || []).map((r) => +Number(r).toFixed(5)),
  };
}

/**
 * The ensemble book: equal weight per RULE (each member is itself a pooled
 * multi-market series), plus its grade against the hard bars. `bh` is the
 * equal-weight buy&hold portfolio of the universe, pooled the same way.
 */
export function ensembleGrade(memberSeries, bhSeries) {
  const ens = poolDaily(memberSeries || []);
  const sharpe = sharpeDaily(ens.returns);
  const bhSharpe = bhSeries ? sharpeDaily(bhSeries.returns) : null;
  return {
    obsDays: ens.returns.length,
    sharpe: +sharpe.toFixed(2),
    ddPct: +maxDrawdownPctDaily(ens.returns).toFixed(1),
    retPct: +totalReturnPctDaily(ens.returns).toFixed(1),
    bhSharpe: bhSharpe != null ? +bhSharpe.toFixed(2) : null,
    // The hard bars, applied where they belong: the BOOK is quant-grade when it
    // clears Sharpe 1 and beats holding the universe risk-adjusted.
    quantGrade: sharpe >= 1 && (bhSharpe == null || sharpe >= bhSharpe + 0.1),
    series: ens,
  };
}
