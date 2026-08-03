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

const MAINT = 0.05; // maintenance-margin + fee buffer used for leverage/liquidation

// Per-asset-class leverage ceiling. Crypto is NOISY (wide spreads, mini-wicks) —
// so 100× there gets liquidated by noise before a stop matters; forex moves in
// tiny pips so high leverage is safe; stocks/futures gap. Tunable ceilings.
export const ASSET_MAX_LEV = { crypto: 20, forex: 100, futures: 25, stock: 15, etf: 15, index: 20 };

// Minimum stop distance as a fraction of price, per asset — a stop tighter than
// this is just market noise (a 0.017% BTC stop liquidates on the spread). Argus
// widens a too-tight stop to at least this before sizing.
export const MIN_STOP_FRAC = { crypto: 0.004, forex: 0.0006, futures: 0.0015, stock: 0.002, etf: 0.002, index: 0.002 };

/**
 * Leverage Argus chooses for a trade — bounded on THREE sides so it's never
 * reckless: (1) the STOP must fire before liquidation (safeMax from entry/stop),
 * (2) an ASSET-class ceiling (crypto low, forex high), (3) CONFIDENCE scaling
 * (a routine setup uses a small fraction of the ceiling; a high-conviction one
 * uses most). This is dynamic, not a flat 100×.
 */
export function chooseLeverage(entry, stopDist, { conviction = 0.5, maxTradeLev = 100, asset = "crypto" } = {}) {
  if (!(stopDist > 0) || !(entry > 0)) return 1;
  const safeMax = Math.max(1, Math.floor((entry / stopDist) * (1 - MAINT)));       // stop before liquidation
  const assetCap = Math.min(maxTradeLev, ASSET_MAX_LEV[asset] ?? 15);              // asset-class ceiling
  const c = Math.max(0, Math.min(1, conviction));
  const frac = c >= 0.85 ? 1.0 : c >= 0.75 ? 0.7 : c >= 0.6 ? 0.45 : 0.25;         // confidence scaling
  return Math.max(1, Math.min(assetCap, safeMax, Math.round(assetCap * frac)));
}

/** Widen a stop that's tighter than the asset's noise floor, keeping direction. */
export function enforceMinStop(entry, stop, side, asset = "crypto") {
  const minDist = (MIN_STOP_FRAC[asset] ?? 0.002) * entry;
  if (Math.abs(entry - stop) >= minDist) return stop;
  return side === "long" ? entry - minDist : entry + minDist;
}

/** Liquidation price for a leveraged position (approx, incl. a maintenance buffer). */
export function liquidationPrice(entry, side, leverage) {
  if (!(leverage > 1)) return null;
  const move = (1 - MAINT) / leverage;
  return side === "short" ? entry * (1 + move) : entry * (1 - move);
}

/**
 * Size a trade. Position size is set by RISK (`baseRiskPct` of equity, capped by
 * the remaining heat budget) — exactly like a real day-trader risking a fixed %
 * per trade. Argus then chooses a per-trade leverage (≤ `maxTradeLev`), which
 * decides the MARGIN it ties up (margin = notional / leverage). Three capital
 * gates then bound the size, whichever is tightest:
 *   • heat:      Σ stop-risk ≤ heatCap × equity
 *   • margin:    Σ margin     ≤ equity            (can't post more margin than you have)
 *   • portfolio: Σ notional   ≤ portfolioLevCap × equity   (hard aggregate-exposure ceiling)
 * Returns null when there's no room (caller parks the setup in watch-mode).
 * @returns {null | { size, riskAmt, leverage, margin, notional, liqPrice }}
 */
export function sizePosition({
  equity, entry, stop, side = "long", asset = "crypto",
  openRisk = 0, openMargin = 0, openNotional = 0,
  heatCap = 0.06, baseRiskPct = 0.02,
  maxTradeLev = 100, portfolioLevCap, maxLeverage, conviction = 0.5,
}) {
  const stopDist = Math.abs(entry - stop);
  if (!(stopDist > 0) || !(equity > 0) || !(entry > 0)) return null;
  const levCap = portfolioLevCap ?? maxLeverage ?? 20; // aggregate-exposure ceiling (×equity)

  // 1) Risk-based size.
  const riskRoom = heatCap * equity - openRisk;
  const riskAmt0 = Math.min(baseRiskPct * equity, riskRoom);
  if (riskAmt0 <= equity * 0.0005) return null;          // no meaningful heat room → wait
  let size = riskAmt0 / stopDist;

  // 2) Argus's leverage — dynamic by asset class + conviction, and never so high
  //    that a stop-out becomes a liquidation.
  const leverage = chooseLeverage(entry, stopDist, { conviction, maxTradeLev, asset });

  // 3) Capital gates — the tightest wins.
  const notionalRoom = Math.max(0, levCap * equity - openNotional);      // portfolio exposure ceiling
  const marginRoom = Math.max(0, equity - openMargin);                    // margin budget
  const sizeFromNotional = notionalRoom / entry;
  const sizeFromMargin = (marginRoom * leverage) / entry;                 // margin = size*entry/lev ≤ marginRoom
  const maxSize = Math.min(sizeFromNotional, sizeFromMargin);
  if (maxSize <= 0) return null;                                          // capital fully committed → wait
  if (size > maxSize) size = maxSize;

  const notional = size * entry;
  return {
    size, riskAmt: size * stopDist, leverage,
    margin: notional / leverage, notional,
    liqPrice: liquidationPrice(entry, side, leverage),
  };
}

/** Planned reward:risk from levels (side-aware). Positive for a coherent setup. */
export function plannedRR(side, entry, stop, target) {
  const risk = side === "long" ? entry - stop : stop - entry;
  const reward = side === "long" ? target - entry : entry - target;
  return risk > 0 ? reward / risk : 0;
}

// ── realistic paper fills ───────────────────────────────────────────────────

// Round-trip-ish cost per asset class, in basis points applied to each fill.
const SLIP_BPS = { crypto: 6, stock: 3, etf: 3, forex: 1.5, futures: 2, index: 3 };

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
export function openThesis(setup, { equity, openRisk, openMargin = 0, openNotional = 0, asset, heatCap, baseRiskPct, maxTradeLev, portfolioLevCap, maxLeverage, conviction, minPlannedR = 0.8, now = Date.now() }) {
  const fillEntry = fillPrice(setup.entry, setup.side, "entry", asset);
  // Widen an absurdly tight stop to the asset's noise floor BEFORE sizing, so the
  // stop is meaningful (not liquidated by the spread) and risk/size stay coherent.
  const stop = enforceMinStop(fillEntry, setup.stop, setup.side, asset);
  // Widening the stop lowers reward:risk — if it drops below the floor, the trade
  // isn't worth taking (skip, let it re-form).
  const rr = plannedRR(setup.side, fillEntry, stop, setup.target);
  if (rr < minPlannedR) return null;
  const sized = sizePosition({
    equity, entry: fillEntry, stop, side: setup.side, asset,
    openRisk, openMargin, openNotional, heatCap, baseRiskPct,
    maxTradeLev, portfolioLevCap, maxLeverage,
    conviction: conviction ?? setup.conviction ?? 0.5,
  });
  if (!sized) return null;
  return {
    id: newId(),
    symbol: setup.symbol, market: setup.market, asset,
    side: setup.side, kind: setup.kind, timeframe: setup.timeframe,
    bias: setup.bias ?? null, // higher-TF regime at entry — carried into the ledger for learning
    state: "open",
    reason: setup.reason, evidence: setup.evidence || [],
    entry: fillEntry, stop, target: setup.target,
    size: sized.size, riskAmt: sized.riskAmt,
    leverage: sized.leverage, margin: sized.margin, notional: sized.notional, liqPrice: sized.liqPrice,
    plannedR: rr,
    openedAt: now, lastPoll: now,
  };
}

/** Given the latest candle, decide if an open thesis exits, and how. */
export function evaluateExit(th, candle, { now = Date.now(), maxHoldMs = 3 * 864e5 } = {}) {
  const hi = candle.high, lo = candle.low;
  // Liquidation: with leverage chosen so the stop sits inside the liq price, a
  // normal stop-out fires first — but if a bar GAPS past the stop to the liq
  // level, the position is liquidated there (a bigger, honest loss). Checked
  // first only when it's actually closer than the stop (gap-through).
  const hitLiq = th.liqPrice != null && (th.side === "long" ? lo <= th.liqPrice : hi >= th.liqPrice);
  const hitStop = th.side === "long" ? lo <= th.stop : hi >= th.stop;
  const hitTarget = th.side === "long" ? hi >= th.target : lo <= th.target;
  if (hitLiq && !hitStop) return finalize(th, th.liqPrice, "liquidation", now); // gapped through the stop
  // If a bar spans both stop and target, assume the stop hit first (conservative).
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

/** Force-close a thesis at a reference price (a human "close now"), filled and
 *  accounted exactly like a normal exit but tagged "manual". */
export function closeThesisAt(th, refPrice, now = Date.now()) {
  return finalize(th, refPrice, "manual", now);
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
