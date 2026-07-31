// intraday.mjs — the INTRADAY-TEMPLATE alpha channel (Cortex phase-7 upgrade).
//
// The research loop is literature-driven and the mining loop is calendar/
// autocorr-driven — both skew toward daily bars. This channel seeds the gauntlet
// with the classic INTRADAY archetypes a day-trader actually runs: opening-range
// breakouts, ADX trend (with the short side), VWAP reclaim/reversion, RSI-2 with
// a trend filter, Supertrend flips and Donchian breakouts. Each is a hand-written,
// evergreen template (not a data-mined fit) — it goes straight into the SAME
// gauntlet (multi-market backtest → k-fold → noise → holdout → DSR) as every other
// candidate, so the intraday markets in the universe (SOL 15m, ETH 1h, AAPL 15m/
// 1h, EUR/USD 1h) are where these get their edge tagged.
//
// Every template is tried ONCE (key-deduped, like mining): pass → candidate,
// fail → graveyard. Honest: each is one trial, charged to the DSR window by the
// caller exactly like a mined hit.

function thesis(edge, works, breaks) {
  return `// EDGE: ${edge}\n// WORKS: ${works}\n// BREAKS: ${breaks}\n`;
}

// Causal ADX/DI, embedded verbatim in the ADX templates (indicators.js has no
// ADX). Wilder smoothing; value at bar i uses only bars ≤ i.
const ADX_HELPER = `
  function _adx(candles, period) {
    const n = candles.length;
    const tr = new Array(n).fill(0), pDM = new Array(n).fill(0), mDM = new Array(n).fill(0);
    for (let i = 1; i < n; i++) {
      const up = candles[i].high - candles[i - 1].high;
      const dn = candles[i - 1].low - candles[i].low;
      pDM[i] = (up > dn && up > 0) ? up : 0;
      mDM[i] = (dn > up && dn > 0) ? dn : 0;
      const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
      tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    }
    const pdi = new Array(n).fill(0), mdi = new Array(n).fill(0), adx = new Array(n).fill(0);
    let trS = 0, pS = 0, mS = 0;
    for (let i = 1; i < n; i++) {
      if (i <= period) { trS += tr[i]; pS += pDM[i]; mS += mDM[i]; continue; }
      trS = trS - trS / period + tr[i];
      pS = pS - pS / period + pDM[i];
      mS = mS - mS / period + mDM[i];
      const p = trS > 0 ? 100 * pS / trS : 0;
      const m = trS > 0 ? 100 * mS / trS : 0;
      pdi[i] = p; mdi[i] = m;
      const dx = (p + m) > 0 ? 100 * Math.abs(p - m) / (p + m) : 0;
      adx[i] = adx[i - 1] > 0 ? (adx[i - 1] * (period - 1) + dx) / period : dx;
    }
    return { adx, pdi, mdi };
  }`;

// Every template as { key, name, code }. Codes are self-contained strategy(ctx)
// functions; causal indicators are precomputed once (safe — value[i] uses ≤ i).
const TEMPLATES = [
  // ── Opening-range breakout (the canonical intraday setup), 2 variants ──
  ...[
    { rangeBars: 6, targetR: 1.5 },
    { rangeBars: 12, targetR: 1 },
  ].map(({ rangeBars, targetR }) => ({
    key: `orb:${rangeBars}:${targetR}`,
    name: `Opening-Range Breakout (long/short)`,
    code:
      thesis(
        `builds a range from the first ${rangeBars} bars of each UTC day, then goes long on a break above / short on a break below, opposite range edge as the stop and ${targetR}R as the target — one trade per day.`,
        "intraday sessions with a real open (equities/FX/crypto) where the first bars set the day's balance and a break signals directional flow.",
        "chop that fakes the break both ways; illiquid opens; a daily/weekly interval where 'the open' is meaningless."
      ) +
`const RANGE_BARS = ${rangeBars}, TARGET_R = ${targetR};
let hi = -Infinity, lo = Infinity, count = 0, traded = false, side = 0, stop = 0, target = 0;
function strategy(ctx) {
  if (ctx.session.isNewDay) { hi = -Infinity; lo = Infinity; count = 0; traded = false; side = 0; }
  if (count < RANGE_BARS) { hi = Math.max(hi, ctx.high); lo = Math.min(lo, ctx.low); count++; return "flat"; }
  if (ctx.position !== "flat") return side === 1 ? { signal: "long", stop, target } : { signal: "short", stop, target };
  if (traded) return "flat";
  const width = hi - lo;
  if (!(width > 0)) return "flat";
  if (ctx.close > hi) { side = 1; stop = lo; target = ctx.close + TARGET_R * width; traded = true; return { signal: "long", stop, target }; }
  if (ctx.close < lo) { side = -1; stop = hi; target = ctx.close - TARGET_R * width; traded = true; return { signal: "short", stop, target }; }
  return "flat";
}`,
  })),

  // ── ADX trend, WITH the short side (user asked for "adx trend (short)") ──
  {
    key: "adx-trend:14:25",
    name: "ADX trend (long/short)",
    code:
      thesis(
        "trades in the trend's direction only when ADX(14) > 25: long when +DI > −DI, short when −DI > +DI; a wide ATR(14) stop lets the trend breathe. Sits flat in weak-trend (low-ADX) chop.",
        "trending intraday regimes — ADX confirms a real directional move so trend-following pays.",
        "range-bound days where ADX stays low and DI whipsaws; the ATR stop still bleeds in chop."
      ) +
`const ADX_MIN = 25, ATR_MULT = 2.5;
let C = null;` + ADX_HELPER + `
function strategy(ctx) {
  const i = ctx.index, c = ctx.candles;
  if (!C) C = { adx: _adx(c, 14), atr: ctx.indicators.atr(c, 14) };
  const adx = C.adx.adx[i], p = C.adx.pdi[i], m = C.adx.mdi[i], atr = C.atr[i];
  if (!(adx > ADX_MIN) || !(atr > 0)) return "flat";
  if (p > m) return { signal: "long", stop: ctx.close - ATR_MULT * atr };
  if (m > p) return { signal: "short", stop: ctx.close + ATR_MULT * atr };
  return "flat";
}`,
  },

  // ── VWAP reclaim / rejection (session-anchored, long/short) ──
  {
    key: "vwap-reclaim:atr2",
    name: "VWAP reclaim/reject (long/short)",
    code:
      thesis(
        "anchors a volume-weighted average price to each UTC session; goes long when price is above VWAP and momentum is up, short when below and momentum is down — an ATR(14) stop. Trades the session's mean as the line in the sand.",
        "liquid intraday instruments where VWAP is the reference institutions trade around; directional days.",
        "flat, low-volume sessions where price oscillates around VWAP and every cross is noise."
      ) +
`const ATR_MULT = 2;
let day = null, pv = 0, vol = 0, C = null;
function strategy(ctx) {
  const i = ctx.index, c = ctx.candles;
  if (!C) C = { atr: ctx.indicators.atr(c, 14) };
  if (ctx.session.isNewDay) { pv = 0; vol = 0; }
  const tp = (ctx.high + ctx.low + ctx.close) / 3;
  const v = c[i].volume || 1;
  pv += tp * v; vol += v;
  const vwap = vol > 0 ? pv / vol : ctx.close;
  const atr = C.atr[i];
  if (!(atr > 0) || i < 1) return "flat";
  const up = ctx.close > c[i - 1].close;
  if (ctx.close > vwap && up) return { signal: "long", stop: ctx.close - ATR_MULT * atr };
  if (ctx.close < vwap && !up) return { signal: "short", stop: ctx.close + ATR_MULT * atr };
  return "flat";
}`,
  },

  // ── RSI-2 with an EMA trend filter (mean-reversion, long/short) ──
  {
    key: "rsi2-trend:200",
    name: "RSI-2 pullback in trend (long/short)",
    code:
      thesis(
        "in an uptrend (close > EMA200) buys RSI(2) < 10 and exits on RSI(2) > 60; in a downtrend (close < EMA200) shorts RSI(2) > 90 and covers on RSI(2) < 40 — buys short-term dips / sells pops in the direction of the trend.",
        "trending intraday markets with mean-reverting noise around the trend.",
        "regime flips where the EMA filter lags and the reversion fights a fresh trend."
      ) +
`let C = null;
function strategy(ctx) {
  const i = ctx.index, c = ctx.candles;
  if (!C) { const cl = ctx.indicators.closes(c); C = { ema: ctx.indicators.ema(cl, 200), rsi: ctx.indicators.rsi(cl, 2) }; }
  const ema = C.ema[i], r = C.rsi[i];
  if (!(ema > 0) || !Number.isFinite(r)) return "flat";
  const up = ctx.close > ema;
  if (up) return r < 10 ? "long" : r > 60 ? "flat" : ctx.position === "long" ? "long" : "flat";
  return r > 90 ? "short" : r < 40 ? "flat" : ctx.position === "short" ? "short" : "flat";
}`,
  },

  // ── Supertrend flip (trend-following, long/short) ──
  {
    key: "supertrend:10:3",
    name: "Supertrend flip (long/short)",
    code:
      thesis(
        "follows a Supertrend(10, 3) line: long while price is above the line, short while below — flips on the line cross. A pure ATR-band trend follower.",
        "persistently trending intraday sessions where the ATR band contains pullbacks.",
        "choppy ranges where the band is repeatedly crossed and every flip is a whipsaw loss."
      ) +
`let C = null;
function strategy(ctx) {
  const i = ctx.index, c = ctx.candles;
  if (!C) C = { st: ctx.indicators.supertrend(c, 10, 3) };
  const s = C.st[i];          // { value, dir } | null  (dir +1 up, -1 down)
  if (!s) return "flat";
  if (s.dir === 1) return "long";
  if (s.dir === -1) return "short";
  return "flat";
}`,
  },

  // ── Donchian breakout with ATR stop (long/short) ──
  {
    key: "donchian:20",
    name: "Donchian breakout (long/short)",
    code:
      thesis(
        "goes long on a close above the 20-bar high, short on a close below the 20-bar low, with an ATR(14) stop — the classic channel breakout adapted to intraday bars.",
        "expansion regimes where a new N-bar extreme kicks off a run.",
        "range compression where every breakout immediately reverses back into the channel."
      ) +
`const ATR_MULT = 2.5;
let C = null;
function strategy(ctx) {
  const i = ctx.index, c = ctx.candles;
  if (!C) C = { dc: ctx.indicators.donchian(c, 20), atr: ctx.indicators.atr(c, 14) };
  if (i < 21) return "flat";
  const prev = C.dc[i - 1];   // { upper, lower } | null — prior bar's channel (no look-ahead)
  const atr = C.atr[i];
  if (!prev || !(atr > 0)) return "flat";
  if (ctx.close > prev.upper) return { signal: "long", stop: ctx.close - ATR_MULT * atr };
  if (ctx.close < prev.lower) return { signal: "short", stop: ctx.close + ATR_MULT * atr };
  return ctx.position;
}`,
  },
];

/**
 * The intraday templates not yet tried this lifetime.
 * @param {Set<string>} doneKeys keys already sent through the gauntlet
 * @returns {{key,name,code}[]}
 */
export function intradayTemplates(doneKeys = new Set()) {
  return TEMPLATES.filter((t) => !doneKeys.has(t.key));
}

export const ALL_INTRADAY_KEYS = TEMPLATES.map((t) => t.key);
