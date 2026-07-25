// argus/core.js — the risk, sizing and paper-fill math for the Argus day-trading
// agent (see docs/DAYTRADER_AGENT.md). Pure and dependency-free so it runs
// identically in the Node agent and in a browser test. No LLM here — Phase 0.

// ── indicators ──────────────────────────────────────────────────────────────

/** Average True Range over the last `period` bars (Wilder). */
export function atr(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  const trs = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

/** Rolling session-ish VWAP over the last `bars` candles (typical price). */
export function vwap(candles, bars = 60) {
  const slice = candles.slice(-bars);
  let pv = 0, vol = 0;
  for (const c of slice) {
    const tp = (c.high + c.low + c.close) / 3;
    const v = c.volume || 1;
    pv += tp * v; vol += v;
  }
  return vol ? pv / vol : slice[slice.length - 1]?.close;
}

/** Highest high / lowest low over the last `n` bars, excluding the current one. */
export function priorHigh(candles, n) {
  const s = candles.slice(-(n + 1), -1);
  return Math.max(...s.map((c) => c.high));
}
export function priorLow(candles, n) {
  const s = candles.slice(-(n + 1), -1);
  return Math.min(...s.map((c) => c.low));
}

// ── portfolio-heat position sizing ──────────────────────────────────────────

/**
 * Size a trade under the portfolio-heat model. Per-trade risk is `baseRiskPct`
 * of equity, but never enough to push total open risk past `heatCap` of equity —
 * so late trades auto-shrink and, when heat is full, sizing returns null (the
 * caller parks the setup in watch-mode). Stop distance sets the size; the % only
 * sets how much cash is at risk. No fixed-% stops.
 * @returns {null | { size, riskAmt }}
 */
export function sizePosition({ equity, entry, stop, openRisk = 0, heatCap = 0.06, baseRiskPct = 0.02 }) {
  const stopDist = Math.abs(entry - stop);
  if (!(stopDist > 0) || !(equity > 0)) return null;
  const room = heatCap * equity - openRisk;              // cash still allowed
  const riskAmt = Math.min(baseRiskPct * equity, room);
  if (riskAmt <= equity * 0.0005) return null;           // no meaningful room → wait
  return { size: riskAmt / stopDist, riskAmt };
}

// ── realistic paper fills ───────────────────────────────────────────────────

// Round-trip-ish cost per asset class, in basis points applied to each fill.
const SLIP_BPS = { crypto: 6, stock: 3, etf: 3, forex: 1.5, index: 3 };

/** Fill price with spread/slippage against the trader (worse price on entry+exit). */
export function fillPrice(refPrice, side, action, asset = "stock") {
  const bps = (SLIP_BPS[asset] ?? 4) / 10000;
  // Buying (long entry / short exit) pays up; selling (long exit / short entry) gets less.
  const buying = (side === "long" && action === "entry") || (side === "short" && action === "exit");
  return refPrice * (buying ? 1 + bps : 1 - bps);
}

// ── thesis lifecycle ────────────────────────────────────────────────────────

let _seq = 0;
export function newId() {
  return `ar_${Date.now().toString(36)}_${(_seq++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

/**
 * Open a thesis from a validated setup: fills the entry, sizes it, computes the
 * cash risk. Returns null if there's no heat room (caller keeps it forming).
 */
export function openThesis(setup, { equity, openRisk, asset, heatCap, baseRiskPct, now = Date.now() }) {
  const fillEntry = fillPrice(setup.entry, setup.side, "entry", asset);
  const sized = sizePosition({ equity, entry: fillEntry, stop: setup.stop, openRisk, heatCap, baseRiskPct });
  if (!sized) return null;
  return {
    id: newId(),
    symbol: setup.symbol, market: setup.market, asset,
    side: setup.side, kind: setup.kind, timeframe: setup.timeframe,
    state: "open",
    reason: setup.reason, evidence: setup.evidence || [],
    entry: fillEntry, stop: setup.stop, target: setup.target,
    size: sized.size, riskAmt: sized.riskAmt,
    plannedR: Math.abs(setup.target - fillEntry) / Math.abs(fillEntry - setup.stop),
    openedAt: now, lastPoll: now,
  };
}

/** Given the latest candle, decide if an open thesis exits, and how. */
export function evaluateExit(th, candle, { now = Date.now(), maxHoldMs = 3 * 864e5 } = {}) {
  const hi = candle.high, lo = candle.low;
  const hitStop = th.side === "long" ? lo <= th.stop : hi >= th.stop;
  const hitTarget = th.side === "long" ? hi >= th.target : lo <= th.target;
  // If a bar spans both, assume the stop hit first (conservative).
  if (hitStop) return finalize(th, th.stop, "stop", now);
  if (hitTarget) return finalize(th, th.target, "target", now);
  if (now - th.openedAt > maxHoldMs) return finalize(th, candle.close, "timeout", now);
  return null;
}

function finalize(th, refExit, outcome, now) {
  const exit = fillPrice(refExit, th.side, "exit", th.asset);
  const dir = th.side === "long" ? 1 : -1;
  const pnl = (exit - th.entry) * th.size * dir;
  const R = pnl / th.riskAmt;
  return { ...th, state: "closed", exit, exitAt: now, outcome, pnl, R };
}

/** Aggregate stats for the closed-thesis ledger. */
export function ledgerStats(closed) {
  const n = closed.length;
  if (!n) return { n: 0, wins: 0, winRate: 0, pnl: 0, avgR: 0, expectancy: 0 };
  const wins = closed.filter((c) => c.pnl > 0).length;
  const pnl = closed.reduce((a, c) => a + c.pnl, 0);
  const sumR = closed.reduce((a, c) => a + (c.R || 0), 0);
  return {
    n, wins, winRate: wins / n, pnl,
    avgR: sumR / n,
    expectancy: sumR / n, // R-expectancy per trade
  };
}
