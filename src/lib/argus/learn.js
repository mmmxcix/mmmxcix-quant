// argus/learn.js — the Hermes-style LEARNING loop for the Argus day-trader.
// Reads the CLOSED-thesis ledger, extracts per-bucket edge, turns the losers and
// winners into human-readable lessons, and folds them into a *gentle* sizing
// prior for a proposed setup. Pure + dependency-free (only ledgerStats math is
// reused) so it runs identically in the Node agent and in a browser test.
//
// Design invariants (see docs/DAYTRADER_AGENT.md, Phase 2 "Learn"):
//   • No bucket influences anything below `minSample` trades — small samples lie.
//   • The size multiplier is hard-clamped to [0.5, 1.25]. This is a prior, not a
//     lever; learning must never destabilise the agent.
//   • Skip (drop a setup entirely) is reserved for egregiously negative, well-
//     sampled buckets — rare by construction.
import { ledgerStats } from "./core.js";

// ── tunables (all conservative) ─────────────────────────────────────────────
const STRONG_EXPECTANCY = 0.20;    // ≥ this R/trade over the bucket → strong-positive
const HARD_CUT_EXPECTANCY = -0.30; // ≤ this → the firmer of the two size cuts
const MULT_FLOOR = 0.5, MULT_CEIL = 1.25;
const BOOST = 1.12, MILD_CUT = 0.85, HARD_CUT = 0.65;
const SKIP_EXPECTANCY = -0.8, SKIP_WINRATE = 0.28; // only truly broken buckets skip
// EVIDENCE-BASED SKIP (Aug 2026). The threshold pair above is sample-blind, and
// that cost real money: `breakout` ran 50 trades at a 10% win rate and −0.50R
// expectancy — −2,655 of the account — yet never skipped, because −0.50 never
// reaches −0.8 and a single-dimension bucket was barred from skipping at all.
// Meanwhile a 6-trade bucket at −0.85R WOULD have skipped. That ranking is
// backwards: what matters is whether the loss is EVIDENCE, not whether it is
// large. So a bucket may also skip when its mean R is negative with real
// statistical confidence (t ≤ −2, ~95% one-sided) over a decent sample.
const SKIP_T_STAT = -2.0;      // one-sided ~95% confidence that expectancy < 0
const SKIP_EVIDENCE_MIN_N = 25; // …over at least this many trades
// The guard the 2-dimension rule was really reaching for: never disable so much
// of the book that the agent stops trading. A skip is refused if the bucket
// covers more than this share of all closed trades.
const SKIP_MAX_BOOK_SHARE = 0.5;
// A skip (dropping a setup entirely) MUST come from a SPECIFIC bucket — at least
// this many defining dimensions (e.g. kind+symbol+side, not the blanket "all shorts"
// or "all technical"). A single broad dimension covers ~every trade, so letting it
// skip once froze the whole agent (it "learned" to stop trading). Broad buckets may
// still shrink SIZE; only a specific, well-sampled, genuinely-broken bucket skips.
const SKIP_MIN_DIMS = 2;
// Invalidation rate = share of a bucket's trades cut early because the setup thesis
// broke. Used ONLY to firm up a size cut (never to skip): a raw invalidation is a
// weak, often-wrong signal — a premature cut that a 12/24h review later reversed is
// excluded (`c.invalReview === "premature"`), so learning never avoids a setup just
// because the old, too-eager invalidation kept firing on it.
const ELEVATED_INVAL_RATE = 0.38; // enough to firm up the size cut on a specific bucket

// ── session bucketing (UTC-hour → trading session) ──────────────────────────
/** Coarse trading-session bucket for a trade's entry time (UTC hour). */
export function sessionOf(ts) {
  if (!Number.isFinite(ts)) return "off";
  const h = new Date(ts).getUTCHours();
  if (h >= 0 && h < 7) return "asia";     // Tokyo / Sydney
  if (h >= 7 && h < 12) return "london";  // London morning
  if (h >= 12 && h < 20) return "ny";     // New York (overlaps London pm)
  return "off";                           // 20–24 UTC — thin liquidity
}

const SESSION_LABEL = { asia: "Asia", london: "London", ny: "New York", off: "off-hours" };

/** A closed thesis is "event"-sourced iff it carried a catalyst, else technical. */
function sourceOf(c) {
  return c && c.catalyst ? "event" : "technical";
}

// ── 1. summarizeLedger — per-bucket stats across the reporting dimensions ────
/**
 * Break the closed ledger down by each reporting dimension, reusing ledgerStats
 * for the math. Every leaf is { n, wins, winRate, avgR, expectancy, pnl }.
 * @returns {{ overall, kind, symbol, side, session, source, bias }}
 */
export function summarizeLedger(closed) {
  const list = Array.isArray(closed) ? closed : [];
  const group = (keyFn) => {
    const g = new Map();
    for (const c of list) {
      const k = keyFn(c);
      if (k == null) continue;
      if (!g.has(k)) g.set(k, []);
      g.get(k).push(c);
    }
    const out = {};
    for (const [k, arr] of g) out[k] = ledgerStats(arr);
    return out;
  };
  return {
    overall: ledgerStats(list),
    kind: group((c) => c.kind ?? null),
    symbol: group((c) => c.symbol ?? null),
    side: group((c) => c.side ?? null),
    session: group((c) => sessionOf(c.openedAt)),
    source: group((c) => sourceOf(c)),
    bias: group((c) => c.bias ?? null), // empty unless theses carried a bias tag
  };
}

// ── 2. deriveLessons — one lesson per bucket that clears minSample ───────────
// Each "view" projects a closed thesis onto a bucket's defining dimensions (or
// null to exclude it). Single dimensions plus the useful compounds, so a lesson
// can be as specific as "mean-reversion shorts on SOLUSDT".
const VIEWS = [
  (c) => ({ kind: c.kind }),
  (c) => ({ symbol: c.symbol }),
  (c) => ({ side: c.side }),
  (c) => ({ session: sessionOf(c.openedAt) }),
  (c) => ({ source: sourceOf(c) }),
  (c) => (c.bias != null ? { bias: c.bias } : null),
  (c) => ({ kind: c.kind, side: c.side }),
  (c) => ({ kind: c.kind, symbol: c.symbol }),
  (c) => ({ symbol: c.symbol, side: c.side }),
  (c) => ({ kind: c.kind, symbol: c.symbol, side: c.side }),
];

function dimsValid(dims) {
  if (!dims) return false;
  for (const v of Object.values(dims)) if (v == null) return false;
  return true;
}

function signedR(r) {
  const v = Number(r) || 0;
  return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}R`;
}

/** Natural-language description of a bucket's defining dimensions. */
function describeDims(d) {
  const sidePl = d.side ? (d.side === "long" ? "longs" : "shorts") : null;
  let core;
  if (d.kind && sidePl) core = `${d.kind} ${sidePl}`;
  else if (d.kind) core = `${d.kind} setups`;
  else if (sidePl) core = sidePl;
  else core = "trades";
  const parts = [core];
  if (d.symbol) parts.push(`on ${d.symbol}`);
  if (d.session) parts.push(`in the ${SESSION_LABEL[d.session] || d.session} session`);
  if (d.source) parts.push(d.source === "event" ? "(event-driven)" : "(technical)");
  if (d.bias) parts.push(`with ${d.bias}-bias`);
  return parts.join(" ");
}

function makeLesson(dims, items) {
  const s = ledgerStats(items);
  // Count only invalidations the retrospective review did NOT rule premature — a
  // cut that would have reached target is a fault of the (old) invalidation, not
  // evidence the setup is bad. Unreviewed invalidations still count (innocent until
  // reviewed); confirmed-premature ones drop out.
  const invalidated = items.reduce((a, c) => a + (c.outcome === "invalidated" && c.invalReview !== "premature" ? 1 : 0), 0);
  const invalRate = items.length ? invalidated / items.length : 0;
  let verdict, action;
  if (s.expectancy >= STRONG_EXPECTANCY) { verdict = "strong-positive"; action = "boost"; }
  else if (s.expectancy < 0) { verdict = "losing"; action = "suppress"; }
  else if (invalRate >= ELEVATED_INVAL_RATE) { verdict = "chronic-invalidation"; action = "suppress"; } // real breaks at ~break-even → ease off
  else { verdict = "neutral"; action = "neutral"; }
  const word = action === "boost" ? "favor" : action === "suppress" ? "suppress" : "neutral";
  const invalNote = invalRate >= ELEVATED_INVAL_RATE ? `, ${Math.round(invalRate * 100)}% invalidated` : "";
  const text = `${describeDims(dims)}: ${Math.round(s.winRate * 100)}% win, ${signedR(s.expectancy)} over ${s.n} trades${invalNote} → ${word}`;
  return {
    dims, verdict, action,
    n: s.n, wins: s.wins, winRate: s.winRate, avgR: s.avgR, expectancy: s.expectancy, pnl: s.pnl, invalRate,
    sdR: s.sdR, tStat: s.tStat,
    text,
  };
}

/**
 * Extract lessons from the closed ledger. One lesson per bucket (single-dim and
 * compound) that reaches `minSample` trades, classified strong-positive /
 * neutral / losing, sorted strongest-and-most-evidenced first (neutrals last).
 * @returns {Array<{dims,verdict,action,n,wins,winRate,avgR,expectancy,pnl,text}>}
 */
export function deriveLessons(closed, { minSample = 20, max = 50 } = {}) {
  const list = Array.isArray(closed) ? closed : [];
  const lessons = [];
  for (const view of VIEWS) {
    const groups = new Map(); // json(dims) -> { dims, items }
    for (const c of list) {
      const dims = view(c);
      if (!dimsValid(dims)) continue;
      const key = JSON.stringify(dims);
      if (!groups.has(key)) groups.set(key, { dims, items: [] });
      groups.get(key).items.push(c);
    }
    for (const { dims, items } of groups.values()) {
      if (items.length < minSample) continue;
      // bookShare feeds the anti-freeze guard in `adjustment`: a bucket that
      // covers most of the closed book must never be allowed to skip, however
      // convincing its numbers, or the agent learns to stop trading entirely.
      const lesson = makeLesson(dims, items);
      lesson.bookShare = list.length ? items.length / list.length : 0;
      lessons.push(lesson);
    }
  }
  lessons.sort((a, b) => {
    const an = a.action === "neutral" ? 1 : 0, bn = b.action === "neutral" ? 1 : 0;
    if (an !== bn) return an - bn;                                 // actionable first
    return Math.abs(b.expectancy) - Math.abs(a.expectancy) || b.n - a.n;
  });
  return lessons.slice(0, max);
}

// ── 3. adjustment — fold the lessons into a gentle sizing prior ──────────────
function matches(dims, setup) {
  for (const k of Object.keys(dims)) {
    if (!setup || setup[k] !== dims[k]) return false;
  }
  return true;
}

/**
 * Turn the lessons into a conservative sizing decision for a proposed setup.
 * Only lessons whose bucket cleared `minSample` AND whose dimensions all match
 * the setup contribute. Losing buckets shrink size (or, when egregious, skip);
 * strong buckets get a mild boost. The net multiplier is hard-clamped to
 * [0.5, 1.25] — a nudge, never a swing.
 * @param setup {{kind?,symbol?,side?,session?,source?,bias?}}
 * @returns {{ mult:number, skip:boolean, reasons:string[] }}
 */
export function adjustment(lessons, setup, opts = {}) {
  const {
    minSample = 20,
    floor = MULT_FLOOR, ceil = MULT_CEIL,
    boost = BOOST, mildCut = MILD_CUT, hardCut = HARD_CUT,
    hardCutExpectancy = HARD_CUT_EXPECTANCY,
    skipExpectancy = SKIP_EXPECTANCY, skipWinRate = SKIP_WINRATE, skipMinSample = minSample,
    skipTStat = SKIP_T_STAT, skipEvidenceMinN = SKIP_EVIDENCE_MIN_N, skipMaxBookShare = SKIP_MAX_BOOK_SHARE,
  } = opts;
  let mult = 1, skip = false;
  const reasons = [];
  for (const l of lessons || []) {
    if (!l || !l.dims || l.n < minSample) continue;
    if (!matches(l.dims, setup)) continue;
    if (l.action === "boost") {
      mult *= boost;
      reasons.push(l.text);
    } else if (l.action === "suppress") {
      // A high-invalidation bucket earns the firmer cut even before its expectancy
      // is catastrophic — the setup keeps entering and breaking (real breaks only;
      // premature cuts are already filtered out of invalRate).
      const firmer = l.expectancy <= hardCutExpectancy || (l.invalRate ?? 0) >= ELEVATED_INVAL_RATE;
      mult *= firmer ? hardCut : mildCut;
      reasons.push(l.text);
      // Skip entirely ONLY when a SPECIFIC (≥2-dim), well-sampled bucket is genuinely
      // broken — egregiously-negative expectancy AND a poor win rate. A single broad
      // dimension (all shorts / all technical) can shrink size but must NEVER skip:
      // that once "learned" the agent into trading nothing at all.
      const specific = Object.keys(l.dims || {}).length >= SKIP_MIN_DIMS;
      const brokenEdge = l.expectancy <= skipExpectancy && l.winRate <= skipWinRate;
      // (a) the original rule: a SPECIFIC bucket whose numbers are egregious.
      if (specific && l.n >= skipMinSample && brokenEdge) skip = true;
      // (b) evidence rule: ANY bucket — including a single `kind` — whose mean R
      //     is negative with statistical confidence over a real sample. This is
      //     what finally catches a setup that bleeds steadily instead of
      //     spectacularly. `bookShare` (set by the caller from the ledger) is the
      //     anti-freeze guard: a bucket covering most of the book never skips.
      const provenLoser = (l.tStat ?? 0) <= skipTStat && l.n >= skipEvidenceMinN;
      const tooBroad = (l.bookShare ?? 0) > skipMaxBookShare;
      if (provenLoser && !tooBroad) skip = true;
    }
  }
  mult = Math.max(floor, Math.min(ceil, mult));
  return { mult, skip, reasons };
}
