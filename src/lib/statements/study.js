// study.js — "at N comparable statements, the basket's median move after five
// days was X%, the spread was Y%."
//
// That sentence is the entire product. Everything here exists to make it either
// true or absent — never plausible-sounding.
//
// WHAT IS DIFFERENT FROM THE FORM 4 STUDY, and why.
//
// The insider project had filing DATES with no time of day, so the only safe
// entry rule was "the next calendar day's open", and comparing raw timestamps
// against a 13:30-stamped bar produced a look-ahead bug worth a Sharpe of 3.67.
// Here the opposite is true: Telegram gives a real timestamp to the second, so
// the honest rule is finer AND stricter:
//
//   the REACTION SESSION is the first bar whose CLOSE falls after the statement
//   — that is where the market actually repriced, and it is NOT tradeable;
//
//   the ENTRY is the first bar whose OPEN falls after the statement. For a
//   statement at 06:00 UTC that is the same session; for one at 14:00, when the
//   market is already open, it is the NEXT session.
//
// Reporting both is the whole answer to "this news is priced in seconds": the
// reaction session says how much moved before anyone could act, the entry return
// says what was left. A tool that only showed the first would be describing a
// profit nobody could take.
//
// The primitives (candle indexing, the position stream, the liquidity screen,
// the calendar-time portfolio) are imported from the insider study rather than
// copied. Two copies of a fill convention is a drift bug waiting to happen.

import {
  buildCalendar, calendarPortfolio, eligibleAt, indexCandles, mean, median,
  positionStream, seriesStats, stdev,
} from "../insider/study.js";
import { THEME_BY_ID } from "./themes.js";

export { buildCalendar, calendarPortfolio, indexCandles, mean, median, seriesStats, stdev };

// A US equity session is 6.5 hours. Yahoo stamps a daily bar at its OPEN, so the
// close is that plus this. Used only to decide which session a statement landed
// in — never to price anything.
const SESSION_LEN_SEC = 6.5 * 3600;

/** First bar whose OPEN is strictly after `atMs` — the first tradeable entry. */
export function entryIndexFor(cal, atMs) {
  const sec = atMs / 1000;
  let lo = 0, hi = cal.times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cal.times[mid] <= sec) lo = mid + 1; else hi = mid;
  }
  return lo < cal.times.length ? lo : -1;
}

/** First bar whose CLOSE is after `atMs` — the session that absorbed the news. */
export function reactionIndexFor(cal, atMs) {
  const sec = atMs / 1000;
  let lo = 0, hi = cal.times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cal.times[mid] + SESSION_LEN_SEC <= sec) lo = mid + 1; else hi = mid;
  }
  return lo < cal.times.length ? lo : -1;
}

/**
 * The benchmark as an indexed price series, built once per calendar.
 *
 * Memoised on the calendar object because `priceEvent` is called hundreds of
 * thousands of times across the placebo runs, and rebuilding a 2,500-entry Map
 * inside that loop turned a two-minute study into an hour-long one.
 */
function benchOf(cal) {
  if (!cal.__bench) cal.__bench = indexCandles(cal.candles);
  return cal.__bench;
}

/** Close-to-close return of one name across a single session index. */
function sessionReturn(priced, cal, idx) {
  if (idx <= 0) return null;
  const t = cal.times[idx], tPrev = cal.times[idx - 1];
  const i = priced.at.get(t), j = priced.at.get(tPrev);
  if (i === undefined || j === undefined) return null;
  const c = priced.candles[i].close, p = priced.candles[j].close;
  return c > 0 && p > 0 ? c / p - 1 : null;
}

/**
 * One statement, one theme, priced.
 *
 * @param {object} o
 * @param {number} o.at        statement timestamp, ms
 * @param {string[]} o.basket  the theme's tickers
 * @param {object} o.prices    ticker → indexCandles()
 * @param {object} o.cal       buildCalendar(benchmark)
 * @param {number[]} o.horizons  trading days held
 * @param {number} o.minNames  refuse the event below this many priceable names
 * @returns {null|object}
 *
 * Equal weight, entry at the open, exit at a close, benchmark-adjusted over
 * exactly the same bars. A member that cannot be priced or fails the liquidity
 * screen is dropped and COUNTED — a basket that quietly shrinks to two names is
 * not the basket the reader was shown.
 */
export function priceEvent({ at, basket, prices, cal, horizons = [1, 5, 21], feeBps = 10, universe = {}, minNames = 4 }) {
  const entry = entryIndexFor(cal, at);
  const reaction = reactionIndexFor(cal, at);
  if (entry < 0) return null;

  const usable = [];
  for (const sym of basket) {
    const priced = prices[sym];
    if (!priced) continue;
    if (!eligibleAt(priced, cal.times[entry], universe)) continue;
    usable.push({ sym, priced });
  }
  if (usable.length < minNames) return null;

  // The reaction session: how much had already happened before the first
  // tradeable open. Descriptive only, and labelled that way everywhere.
  const reactRets = [], reactBench = [];
  if (reaction >= 0) {
    const b = sessionReturn(benchOf(cal), cal, reaction);
    for (const u of usable) {
      const r = sessionReturn(u.priced, cal, reaction);
      if (r != null && b != null) { reactRets.push(r); reactBench.push(b); }
    }
  }

  const perHorizon = {};
  for (const h of horizons) {
    const rets = [], benches = [];
    for (const u of usable) {
      const s = positionStream(cal, u.priced, entry, h, feeBps);
      if (!s || s.days.length < h) continue;       // a partial hold is a different bet
      let cum = 1, cumB = 1;
      for (let d = 0; d < s.ret.length; d++) { cum *= 1 + s.ret[d]; cumB *= 1 + s.bench[d]; }
      rets.push(cum - 1);
      benches.push(cumB - 1);
    }
    if (rets.length < minNames) continue;
    const basketRet = mean(rets), benchRet = mean(benches);
    perHorizon[h] = {
      names: rets.length,
      retPct: basketRet * 100,
      benchPct: benchRet * 100,
      excessPct: (basketRet - benchRet) * 100,
      // The cross-sectional spread INSIDE the basket at this horizon — how much
      // the "basket" is one story versus seven unrelated ones.
      dispersionPct: stdev(rets) * 100,
    };
  }
  if (!Object.keys(perHorizon).length) return null;

  return {
    at, entryIdx: entry, reactionIdx: reaction,
    names: usable.length,
    sameSession: reaction === entry,   // pre-open statement: reaction IS tradeable
    reactionPct: reactRets.length ? mean(reactRets) * 100 : null,
    reactionExcessPct: reactRets.length ? (mean(reactRets) - mean(reactBench)) * 100 : null,
    perHorizon,
  };
}

/** p-th percentile of a sorted-on-the-fly sample. */
export function quantile(xs, p) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))));
  return s[i];
}

/**
 * Aggregate a theme's priced events into the sentence the tool is allowed to say.
 *
 * Median first, mean second. Event samples are small and fat-tailed — one
 * statement that happened to land on a 30% day would carry a mean of twenty, and
 * "the median was +0.3%, the spread ±6%" is both more robust and closer to what
 * a reader actually wants to know.
 */
export function summarise(events, horizons = [1, 5, 21]) {
  const out = {};
  for (const h of horizons) {
    const xs = events.map((e) => e.perHorizon[h]?.excessPct).filter((x) => x != null);
    if (!xs.length) { out[h] = { n: 0 }; continue; }
    // The RAW basket move and the benchmark's own, alongside the excess. These
    // baskets are concentrated and higher-beta than SPY, so a negative excess in
    // a rising market and a positive one in a falling market are partly just
    // that — the reader needs all three numbers to tell those apart.
    const raw = events.map((e) => e.perHorizon[h]?.retPct).filter((x) => x != null);
    const bench = events.map((e) => e.perHorizon[h]?.benchPct).filter((x) => x != null);
    out[h] = {
      n: xs.length,
      medianPct: median(xs),
      meanPct: mean(xs),
      medianRawPct: median(raw),
      medianBenchPct: median(bench),
      p25Pct: quantile(xs, 0.25),
      p75Pct: quantile(xs, 0.75),
      sdPct: stdev(xs),
      hitRate: xs.filter((x) => x > 0).length / xs.length,
      // The naive t is reported with its own health warning wherever it prints:
      // statements arrive in waves (one crisis produces forty), so these are not
      // independent draws and the statistic is systematically over-confident.
      tStatNaive: xs.length > 1 && stdev(xs) > 0 ? mean(xs) / (stdev(xs) / Math.sqrt(xs.length)) : 0,
    };
  }
  const react = events.map((e) => e.reactionExcessPct).filter((x) => x != null);
  return {
    horizons: out,
    reaction: react.length ? { n: react.length, medianPct: median(react), meanPct: mean(react) } : { n: 0 },
    // How often the statement landed outside market hours, so entry and reaction
    // are the same session and nothing was missed.
    tradeableSameSession: events.length ? events.filter((e) => e.sameSession).length / events.length : 0,
  };
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
 * Shift every one of a theme's statements by the SAME random offset and redo the
 * whole measurement, a few hundred times.
 *
 * A common shift, not independent random dates, and the difference is the point.
 * Statements arrive in waves — a war produces forty Hormuz headlines in a
 * fortnight — so a theme's events are heavily clustered in time. Independent
 * random dates would destroy that clustering as well as the timing, and the null
 * would then be far too easy to beat: any theme whose events happened to cluster
 * in a good month would look significant. Shifting them together keeps the wave
 * intact and removes only the alignment with what was said.
 *
 * @returns {{runs, medians: number[], pValue, mean, p95}} for one horizon
 */
export function placeboShift({ statements, basket, prices, cal, horizon, feeBps, universe, minNames, realMedian, runs = 200, seed = 5, minShiftDays = 10, maxShiftDays = 400 }) {
  const rand = mulberry32(seed);
  const DAY = 86_400_000;
  const medians = [];
  for (let r = 0; r < runs; r++) {
    const sign = rand() < 0.5 ? -1 : 1;
    const shift = sign * (minShiftDays + Math.floor(rand() * (maxShiftDays - minShiftDays))) * DAY;
    const xs = [];
    for (const s of statements) {
      const ev = priceEvent({ at: s.at + shift, basket, prices, cal, horizons: [horizon], feeBps, universe, minNames });
      const v = ev?.perHorizon[horizon]?.excessPct;
      if (v != null) xs.push(v);
    }
    if (xs.length) medians.push(median(xs));
  }
  if (!medians.length) return { runs: 0, medians: [], pValue: 1, mean: 0, p95: 0 };
  const sorted = [...medians].sort((a, b) => a - b);
  // Two-sided: the question is whether the real median is unusual in EITHER
  // direction. A basket that reliably falls after a statement is as much of a
  // finding as one that rises, and a one-sided test would throw half of them away.
  const beaten = medians.filter((m) => Math.abs(m) >= Math.abs(realMedian)).length;
  return {
    runs: medians.length,
    medians,
    mean: mean(medians),
    p95: sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))],
    pValue: (beaten + 1) / (medians.length + 1),
  };
}

/**
 * The same shifted-date placebo across every theme at once.
 *
 * One offset for the whole corpus per run, for the same reason as above: themes
 * are not independent either (a Middle East crisis fills tankers, oil and
 * defense in the same fortnight), so shifting them apart would break a structure
 * that is really there and make the null too weak.
 *
 * @param {Array<{statements, basket}>} groups
 */
export function placeboPooled({ groups, prices, cal, horizon, feeBps, universe, minNames, realMedian, runs = 200, seed = 9, minShiftDays = 10, maxShiftDays = 400 }) {
  const rand = mulberry32(seed);
  const DAY = 86_400_000;
  const medians = [];
  for (let r = 0; r < runs; r++) {
    const sign = rand() < 0.5 ? -1 : 1;
    const shift = sign * (minShiftDays + Math.floor(rand() * (maxShiftDays - minShiftDays))) * DAY;
    const xs = [];
    for (const g of groups) {
      for (const s of g.statements) {
        const ev = priceEvent({ at: s.at + shift, basket: g.basket, prices, cal, horizons: [horizon], feeBps, universe, minNames });
        const v = ev?.perHorizon[horizon]?.excessPct;
        if (v != null) xs.push(v);
      }
    }
    if (xs.length) medians.push(median(xs));
  }
  if (!medians.length) return { runs: 0, medians: [], pValue: 1, mean: 0, p95: 0 };
  const sorted = [...medians].sort((a, b) => a - b);
  const beaten = medians.filter((m) => Math.abs(m) >= Math.abs(realMedian)).length;
  return {
    runs: medians.length, medians,
    mean: mean(medians),
    p95: sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))],
    pValue: (beaten + 1) / (medians.length + 1),
  };
}

/**
 * Run the whole thing for one theme.
 *
 * `minEvents` is a refusal, not a warning. Below it the summary is still
 * returned — the counts are informative — but `verdict.enough` is false and
 * nothing downstream is allowed to print a median as if it meant something.
 * This is the same discipline as the meta-label gate in Argus: the sample rule
 * is not negotiated down because the numbers came out interesting.
 */
export function studyTheme({ themeId, statements, prices, cal, horizons = [1, 5, 21], feeBps = 10, universe = {}, minNames = 4, minEvents = 30, placeboRuns = 200, placeboHorizon = 5 }) {
  const theme = THEME_BY_ID.get(themeId);
  if (!theme) return null;

  // "No events" has two very different causes and conflating them hides a
  // broken basket behind a thin sample. A theme whose basket cannot field
  // `minNames` priceable tickers at all is UNMEASURABLE, not merely quiet — the
  // immigration basket is two names, so it can never produce a single event no
  // matter how much history is added.
  const priceable = theme.basket.filter((s) => prices[s]).length;
  if (priceable < minNames) {
    return {
      themeId, name: theme.name, why: theme.why, basket: theme.basket,
      statements: statements.length, events: 0, unpriceable: statements.length,
      basketPriceable: priceable,
      summary: summarise([], horizons), placebo: null,
      verdict: {
        enough: false, finding: false,
        reason: `basket has only ${priceable} priceable names (${minNames} needed) — unmeasurable, not quiet`,
      },
      perEvent: [],
    };
  }

  const events = [];
  let unpriceable = 0;
  for (const s of statements) {
    const ev = priceEvent({ at: s.at, basket: theme.basket, prices, cal, horizons, feeBps, universe, minNames });
    if (ev) events.push({ ...ev, speakerId: s.speakerId, quote: s.quote }); else unpriceable++;
  }
  const summary = summarise(events, horizons);
  const enough = events.length >= minEvents;

  let placebo = null;
  if (enough && summary.horizons[placeboHorizon]?.n) {
    placebo = placeboShift({
      statements, basket: theme.basket, prices, cal, horizon: placeboHorizon,
      feeBps, universe, minNames, realMedian: summary.horizons[placeboHorizon].medianPct,
      runs: placeboRuns,
    });
  }

  return {
    themeId, name: theme.name, why: theme.why, basket: theme.basket,
    statements: statements.length, events: events.length, unpriceable,
    basketPriceable: priceable,
    summary, placebo,
    verdict: {
      enough,
      reason: enough
        ? (placebo && placebo.pValue <= 0.05
          ? `median move survives a shifted-date placebo (p = ${placebo.pValue.toFixed(3)})`
          : `shifting the dates reproduces it${placebo ? ` (p = ${placebo.pValue.toFixed(3)})` : ""}`)
        : `${events.length} priced events, ${minEvents} needed before a median means anything`,
      // The only combination this project is willing to call a finding.
      finding: enough && !!placebo && placebo.pValue <= 0.05,
    },
    perEvent: events,
  };
}
