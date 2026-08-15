// study.js — does the cluster-buy signal pay, and how would we know?
//
// This is the part the project's doctrine cares about. Argus cost a hundred
// trades to teach that a book which loses is not fixed by slicing it, so the
// order here is measurement first and product second. Nothing in this file
// builds a feature; it only tries to kill the hypothesis.
//
// THE MEASUREMENT, and why it is shaped this way.
//
// 1. CALENDAR-TIME PORTFOLIO, not an average of event returns. Insider clusters
//    arrive in waves — a market-wide sell-off produces hundreds of them in the
//    same fortnight. Averaging those events treats several hundred readings of
//    the SAME March as independent, which is how event studies produce t-stats
//    of 8 for effects that do not exist (Fama 1998 is the canonical complaint,
//    and the fix he recommends is exactly this). So: on each trading day, hold
//    every name whose cluster became public within the last `holdDays`, equally
//    weighted. That collapses the cross-correlation into ONE daily return
//    series, which is also the only form a Sharpe ratio means anything on.
//
// 2. ENTRY AT THE NEXT OPEN AFTER THE FILING DATE. Same convention as
//    src/lib/backtest.js. The cluster is dated by its last FILING, never by the
//    transactions inside it (see cluster.js).
//
// 3. EXCESS OVER THE BENCHMARK, per position and per day. Insider buying spikes
//    after drawdowns; a raw return series would mostly measure "bought the dip
//    in a rising market".
//
// 4. A PLACEBO, which is the test that actually settles it. Keep every symbol,
//    replace every event date with another date drawn from the same pool, rerun
//    the whole pipeline a few hundred times. That holds the calendar, the symbol
//    mix and the event count fixed and destroys only the timing. If the real
//    Sharpe sits inside that distribution, the signal is the sample, not the
//    insiders.
//
// 5. DEFLATED SHARPE over the number of variants tried, because we do try
//    several (window, insider count, holding period, value floor) and the best
//    of twenty draws is a prize chance hands out.
//
// Pure functions: prices come in as arrays, nothing is fetched here.

import { deflatedSharpe } from "../validation.js";

const DAY = 86_400_000;

// ── price plumbing ──────────────────────────────────────────────────────────

/**
 * Index a candle array for O(1) lookup on the master calendar.
 * @param {Array<{time,open,high,low,close}>} candles  unix SECONDS, ascending
 */
export function indexCandles(candles) {
  const at = new Map();
  for (let i = 0; i < candles.length; i++) at.set(candles[i].time, i);
  return { candles, at };
}

/**
 * The master trading calendar is the BENCHMARK's own days. Using a union of all
 * symbols' days would invent trading days for names that were halted, and a
 * position that "returns 0" on a halt day is a fabricated observation.
 */
export function buildCalendar(benchmarkCandles) {
  const times = benchmarkCandles.map((c) => c.time);
  const idx = new Map(times.map((t, i) => [t, i]));
  return { times, idx, candles: benchmarkCandles };
}

/**
 * First calendar index whose DAY is strictly after the event's day.
 *
 * The comparison is on UTC days and not on raw timestamps, and that distinction
 * is the difference between a study and a fantasy. A Form 4 carries a filing
 * DATE and no time — the SEC's deadline is 10 p.m. Eastern, so most of them
 * appear after the close — while a Yahoo daily bar is stamped at the session
 * OPEN (13:30 or 14:30 UTC). Comparing "filed on the 4th" (UTC midnight) against
 * "the 4th's bar" (13:30 UTC) therefore says the bar comes later, and the
 * position enters at the open of the very day the filing was still unpublished.
 *
 * The first version of this function did exactly that, and it produced a Sharpe
 * of 3.67 and a walk-forward return of 1,199,985%. Both numbers were the bug.
 */
export function nextTradingIndex(cal, ms) {
  const eventDay = Math.floor(ms / 86_400_000);
  let lo = 0, hi = cal.times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (Math.floor(cal.times[mid] / 86_400) <= eventDay) lo = mid + 1; else hi = mid;
  }
  return lo < cal.times.length ? lo : -1;
}

/** First calendar index at or after a millisecond timestamp (window bounds). */
export function indexAtOrAfter(cal, ms) {
  const sec = Math.floor(ms / 1000);
  let lo = 0, hi = cal.times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cal.times[mid] < sec) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * Is this name investable at all, judged ONLY on bars before the entry?
 *
 * Cluster buys concentrate in micro-caps, and a universe that keeps every one of
 * them is not measuring insider information — it is measuring what happens when
 * you equal-weight sub-dollar stocks, where a two-cent tick is +100% and no
 * portfolio could have taken the fill. Both floors are ex-ante observable, which
 * is what separates a universe screen from winsorising an inconvenient result.
 */
export function eligibleAt(priced, entryTime, { minPrice = 5, minDollarVol = 1e6, lookback = 20 } = {}) {
  // Indexed by the symbol's OWN bar list, not by the master calendar: the two
  // agree on dates but not on positions once a name has a halted day.
  const own = priced.at.get(entryTime);
  if (own === undefined || own <= 0) return false;
  const prev = priced.candles[own - 1];
  if (!prev || !(prev.close >= minPrice)) return false;
  if (!(minDollarVol > 0)) return true;
  const vols = [];
  for (let k = Math.max(0, own - lookback); k < own; k++) {
    const c = priced.candles[k];
    if (c && c.close > 0 && c.volume > 0) vols.push(c.close * c.volume);
  }
  if (vols.length < Math.min(5, lookback)) return false;   // too little history to judge
  vols.sort((a, b) => a - b);
  return vols[vols.length >> 1] >= minDollarVol;
}

// ── one position ────────────────────────────────────────────────────────────

/**
 * The per-day return stream of a single position, and of the benchmark over
 * exactly the same days with exactly the same convention.
 *
 * Entry day is open→close, every later day close→close. Both legs use that same
 * rule, so the excess on the entry day is not the artefact of comparing a
 * partial day against a full one.
 *
 * @returns {null|{days: number[], ret: number[], bench: number[], truncated: boolean}}
 *          `days` are master-calendar indices.
 */
export function positionStream(cal, priced, entryIdx, holdDays, feeBps = 10) {
  const days = [], ret = [], bench = [];
  const cost = (2 * feeBps) / 10_000;               // in and out, charged on day one
  let prevClose = null, prevBench = null;
  let truncated = false;

  for (let d = 0; d < holdDays; d++) {
    const k = entryIdx + d;
    if (k >= cal.times.length) { truncated = true; break; }
    const t = cal.times[k];
    const pi = priced.at.get(t);
    if (pi === undefined) {                          // no quote that day
      if (d === 0) return null;                      // could not have entered at all
      truncated = true; break;                       // holiday for this name / delisted mid-hold
    }
    const bar = priced.candles[pi];
    const bbar = cal.candles[k];
    if (!(bar.open > 0) || !(bar.close > 0) || !(bbar.open > 0) || !(bbar.close > 0)) {
      if (d === 0) return null;
      truncated = true; break;
    }
    if (d === 0) {
      ret.push(bar.close / bar.open - 1 - cost);
      bench.push(bbar.close / bbar.open - 1);
    } else {
      ret.push(bar.close / prevClose - 1);
      bench.push(bbar.close / prevBench - 1);
    }
    prevClose = bar.close;
    prevBench = bbar.close;
    days.push(k);
  }
  return days.length ? { days, ret, bench, truncated } : null;
}

// ── the calendar-time portfolio ─────────────────────────────────────────────

/**
 * Hold every event's symbol for `holdDays` from the day after it became public,
 * equally weighted, and report the daily EXCESS return of that book.
 *
 * @param {object} o
 * @param {Array}  o.events     from clusterBuys(); each needs { symbol, knownAt }
 * @param {object} o.prices     symbol → indexCandles() output
 * @param {object} o.cal        buildCalendar(benchmark)
 * @param {number} o.holdDays
 * @param {number} o.feeBps     round-trip cost, charged once per position
 * @param {number} o.maxPositions  cap on simultaneous names (0 = uncapped)
 * @param {object} o.universe   the ex-ante liquidity screen, see eligibleAt()
 */
export function calendarPortfolio({ events, prices, cal, holdDays = 21, feeBps = 10, maxPositions = 0, universe = {} }) {
  const n = cal.times.length;
  const sumExcess = new Float64Array(n);
  const countActive = new Int32Array(n);
  let used = 0, noPrice = 0, noEntry = 0, truncated = 0, illiquid = 0;
  const perEvent = [];

  for (const e of events) {
    const priced = e.symbol ? prices[e.symbol] : null;
    if (!priced) { noPrice++; continue; }
    const entry = nextTradingIndex(cal, e.knownAt);
    if (entry < 0) { noEntry++; continue; }
    if (!eligibleAt(priced, cal.times[entry], universe)) { illiquid++; continue; }
    const s = positionStream(cal, priced, entry, holdDays, feeBps);
    if (!s) { noEntry++; continue; }
    if (s.truncated) truncated++;
    used++;
    let cum = 1, cumB = 1;
    for (let d = 0; d < s.days.length; d++) {
      const k = s.days[d];
      // A cap makes the book realistic when a wave produces 300 names at once.
      // Applied by arrival: the earliest events keep their slots.
      if (maxPositions > 0 && countActive[k] >= maxPositions) continue;
      sumExcess[k] += s.ret[d] - s.bench[d];
      countActive[k]++;
      cum *= 1 + s.ret[d];
      cumB *= 1 + s.bench[d];
    }
    perEvent.push({
      symbol: e.symbol, knownAt: e.knownAt, insiders: e.insiders, value: e.value,
      retPct: (cum - 1) * 100, benchPct: (cumB - 1) * 100, excessPct: (cum - cumB) * 100,
      days: s.days.length,
    });
  }

  // Flat days earn nothing and lose nothing: the book is in cash, which is
  // exactly zero excess over the benchmark by construction. Counting them is
  // what keeps the Sharpe honest about how rarely this signal is invested.
  const daily = new Array(n).fill(0);
  let investedDays = 0;
  for (let k = 0; k < n; k++) {
    if (countActive[k] > 0) { daily[k] = sumExcess[k] / countActive[k]; investedDays++; }
  }

  return {
    daily,
    times: cal.times,
    active: Array.from(countActive),
    perEvent,
    coverage: {
      events: events.length,
      used, noPrice, noEntry, illiquid, truncatedHolds: truncated,
      investedDays, totalDays: n,
      investedShare: n ? investedDays / n : 0,
      avgPositions: investedDays ? Array.from(countActive).reduce((a, b) => a + b, 0) / investedDays : 0,
    },
  };
}

// ── statistics ──────────────────────────────────────────────────────────────

export function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }

export function stdev(xs) {
  const n = xs.length;
  if (n < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return Math.sqrt(s / (n - 1));
}

export function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

/** Student t of the mean against zero. */
export function tStat(xs) {
  const n = xs.length, sd = stdev(xs);
  return n > 1 && sd > 0 ? mean(xs) / (sd / Math.sqrt(n)) : 0;
}

/** Annualised stats of a daily return series (252 trading days). */
export function seriesStats(daily, periodsPerYear = 252) {
  const n = daily.length;
  if (!n) return { annRetPct: 0, annVolPct: 0, sharpe: 0, maxDDPct: 0, n: 0, totalPct: 0 };
  let eq = 1, peak = 1, maxDD = 0;
  for (const r of daily) {
    eq *= 1 + r;
    if (eq > peak) peak = eq;
    const dd = (peak - eq) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  const m = mean(daily), sd = stdev(daily);
  const annVol = sd * Math.sqrt(periodsPerYear);
  return {
    totalPct: (eq - 1) * 100,
    annRetPct: (Math.pow(Math.max(eq, 1e-9), periodsPerYear / n) - 1) * 100,
    annVolPct: annVol * 100,
    sharpe: annVol > 0 ? (m * periodsPerYear) / annVol : 0,
    maxDDPct: maxDD * 100,
    n,
  };
}

/** Equity curve of the excess series, for a chart or a registry entry. */
export function equityCurve(times, daily, start = 100) {
  let v = start;
  return times.map((t, i) => ({ x: t, y: (v *= 1 + (daily[i] || 0)) }));
}

// ── the event study (descriptive companion) ─────────────────────────────────

/**
 * Buy-and-hold return per event over several horizons, raw and benchmark-
 * adjusted.
 *
 * The t-statistics here are the NAIVE ones and are labelled as such wherever
 * they are printed: overlapping events on a shared calendar are not independent
 * draws, so these are systematically too confident. They are reported because
 * the shape of the distribution (median, hit rate, spread) is informative even
 * when its significance test is not. The portfolio Sharpe and the placebo are
 * what decides anything.
 */
export function eventStudy({ events, prices, cal, horizons = [5, 21, 63], feeBps = 10, universe = {} }) {
  const out = {};
  for (const h of horizons) {
    const excess = [], raw = [];
    let used = 0;
    for (const e of events) {
      const priced = e.symbol ? prices[e.symbol] : null;
      if (!priced) continue;
      const entry = nextTradingIndex(cal, e.knownAt);
      if (entry < 0) continue;
      if (!eligibleAt(priced, cal.times[entry], universe)) continue;
      const s = positionStream(cal, priced, entry, h, feeBps);
      if (!s || s.days.length < h) continue;         // a partial hold is a different bet
      let cum = 1, cumB = 1;
      for (let d = 0; d < s.ret.length; d++) { cum *= 1 + s.ret[d]; cumB *= 1 + s.bench[d]; }
      raw.push((cum - 1) * 100);
      excess.push((cum - cumB) * 100);
      used++;
    }
    out[h] = {
      n: used,
      meanExcessPct: mean(excess), medianExcessPct: median(excess),
      meanRawPct: mean(raw),
      hitRate: excess.length ? excess.filter((x) => x > 0).length / excess.length : 0,
      sdExcessPct: stdev(excess),
      tStatNaive: tStat(excess),
    };
  }
  return out;
}

// ── the placebo ─────────────────────────────────────────────────────────────

function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Rerun the portfolio with the dates shuffled among the events.
 *
 * Every symbol keeps its event count and the calendar keeps its date
 * distribution; only "which company on which day" is destroyed. So the null is
 * not "random stocks in a random decade" — it is "these exact companies, these
 * exact dates, paired by chance", which is the only null that can separate the
 * signal from the sample.
 *
 * @returns {{sharpes: number[], pValue: number, mean: number, p95: number}}
 */
export function placebo({ events, prices, cal, holdDays, feeBps, maxPositions, universe, realSharpe, runs = 200, seed = 11 }) {
  const rand = mulberry32(seed);
  const dates = events.map((e) => e.knownAt);
  const sharpes = [];
  for (let r = 0; r < runs; r++) {
    // Fisher–Yates over a copy of the date pool.
    const shuffled = [...dates];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const fake = events.map((e, i) => ({ ...e, knownAt: shuffled[i] }));
    const pf = calendarPortfolio({ events: fake, prices, cal, holdDays, feeBps, maxPositions, universe });
    sharpes.push(seriesStats(pf.daily).sharpe);
  }
  const sorted = [...sharpes].sort((a, b) => a - b);
  const beaten = sharpes.filter((s) => s >= realSharpe).length;
  return {
    runs,
    sharpes,
    mean: mean(sharpes),
    p95: sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))],
    // One-sided empirical p-value with the +1 correction, so a run that is never
    // beaten reports 1/(runs+1) rather than an impossible zero.
    pValue: (beaten + 1) / (runs + 1),
  };
}

// ── grid + walk-forward ─────────────────────────────────────────────────────

/**
 * Score every parameter combination on one span of the calendar.
 *
 * @param {(params) => Array} makeEvents  re-clusters the filings for a setting
 * @param {Array<object>} grid            the settings to try
 * @returns {Array<{params, stats, coverage}>} sorted best Sharpe first
 */
export function gridSearch({ grid, makeEvents, prices, cal, feeBps = 10, maxPositions = 0, universe = {}, from = null, to = null }) {
  const rows = [];
  for (const params of grid) {
    let events = makeEvents(params);
    if (from != null) events = events.filter((e) => e.knownAt >= from);
    if (to != null) events = events.filter((e) => e.knownAt < to);
    const pf = calendarPortfolio({ events, prices, cal, holdDays: params.holdDays, feeBps, maxPositions, universe });
    rows.push({ params, stats: seriesStats(pf.daily), coverage: pf.coverage });
  }
  rows.sort((a, b) => b.stats.sharpe - a.stats.sharpe);
  return rows;
}

/**
 * Walk-forward over the event calendar: choose the setting on window i, apply it
 * frozen to window i+1, and keep only the out-of-sample stretches.
 *
 * The embargo matters here in a way it does not in a normal backtest: a position
 * opened on the last training day is still open `holdDays` into the test window,
 * so without a gap the test period inherits trades that were chosen with
 * knowledge of it. Events inside the embargo are dropped from both sides.
 */
export function walkForwardEvents({ grid, makeEvents, prices, cal, folds = 4, feeBps = 10, maxPositions = 0, universe = {}, embargoDays = 63 }) {
  // The folds span the EVENT calendar, not the price calendar. Price history
  // reaches back years further than the filings panel, and splitting on it hands
  // the first fold a training window with zero events — which then "chooses" a
  // setting at random and reports the result as out-of-sample evidence.
  const probe = makeEvents(grid[0]);
  if (!probe.length) return null;
  let evFrom = Infinity, evTo = -Infinity;
  for (const e of probe) { if (e.knownAt < evFrom) evFrom = e.knownAt; if (e.knownAt > evTo) evTo = e.knownAt; }
  const t0 = Math.max(cal.times[0] * 1000, evFrom);
  const t1 = Math.min(cal.times[cal.times.length - 1] * 1000, evTo);
  const span = (t1 - t0) / folds;
  if (!(span > 30 * DAY)) return null;
  const embargo = embargoDays * DAY;

  const results = [];
  const oosDaily = [];
  const oosTimes = [];
  let skipped = 0;

  for (let f = 0; f < folds - 1; f++) {
    const trainFrom = t0 + f * span;
    const trainTo = t0 + (f + 1) * span - embargo;
    const testFrom = t0 + (f + 1) * span;
    const testTo = f + 2 === folds ? t1 + DAY : t0 + (f + 2) * span;
    if (trainTo <= trainFrom) continue;

    const ranked = gridSearch({ grid, makeEvents, prices, cal, feeBps, maxPositions, universe, from: trainFrom, to: trainTo });
    // A window that cannot support a choice does not get to make one. Falling
    // back to the top of a ranking where every row has zero events is picking at
    // random and then calling the next window's result out-of-sample evidence.
    const best = ranked.find((r) => r.coverage.used >= 20);
    if (!best) { skipped++; continue; }

    const testEvents = makeEvents(best.params).filter((e) => e.knownAt >= testFrom && e.knownAt < testTo);
    const pf = calendarPortfolio({ events: testEvents, prices, cal, holdDays: best.params.holdDays, feeBps, maxPositions, universe });
    // Keep only the test window's days of the stitched OOS series. The last fold
    // runs to the end of the calendar, so `end` clamps rather than wraps.
    const lo = indexAtOrAfter(cal, testFrom);
    const end = Math.min(cal.times.length, indexAtOrAfter(cal, testTo));
    for (let k = lo; k < end; k++) { oosDaily.push(pf.daily[k]); oosTimes.push(cal.times[k]); }

    results.push({
      fold: f + 1,
      params: best.params,
      trainSharpe: best.stats.sharpe,
      trainEvents: best.coverage.used,
      testStats: seriesStats(pf.daily.slice(lo, end)),
      testEvents: pf.coverage.used,
    });
  }

  const stitched = seriesStats(oosDaily);
  const positive = results.filter((r) => r.testStats.totalPct > 0).length;
  return {
    folds: results,
    oos: stitched,
    oosTimes,
    oosDaily,
    profitableFolds: positive,
    totalFolds: results.length,
    skippedFolds: skipped,
    from: t0,
    to: t1,
    verdict: results.length && stitched.totalPct > 0 && positive >= Math.ceil(results.length / 2) ? "pass" : "fail",
  };
}

/**
 * The whole verdict in one object.
 *
 * `nTrials` must be the size of the grid actually searched, not 1 — the deflated
 * Sharpe exists precisely to charge for the search, and passing 1 after trying
 * twenty settings turns the safeguard into decoration.
 */
export function verdict({ stats, dsr, placeboOut, wf, coverage, minEvents = 100 }) {
  const reasons = [];
  if (coverage.used < minEvents) reasons.push(`only ${coverage.used} usable events (${minEvents} needed to say anything)`);
  if (!(stats.sharpe > 0)) reasons.push(`out-of-sample-agnostic Sharpe is ${stats.sharpe.toFixed(2)}`);
  if (placeboOut && placeboOut.pValue > 0.05) reasons.push(`shuffled dates reproduce it (placebo p = ${placeboOut.pValue.toFixed(3)})`);
  if (dsr && dsr.dsr < 0.95) reasons.push(`deflated Sharpe ${(dsr.dsr * 100).toFixed(1)}% after ${dsr.sr0 ? "the search" : "no search"}`);
  if (wf && wf.verdict !== "pass") reasons.push("walk-forward does not hold up out of sample");
  return { pass: reasons.length === 0, reasons };
}

export { deflatedSharpe };
