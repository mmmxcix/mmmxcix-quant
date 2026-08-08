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

/** Relative volume: the latest bar's volume vs the average of the `period` bars
 *  BEFORE it. >1 = above-average participation (a breakout with conviction behind
 *  it); <1 = thin, prone to failing. Returns 1 when volume data is unavailable. */
export function relVolume(candles, period = 20) {
  const n = candles.length;
  if (n < period + 1) return 1;
  let sum = 0;
  for (let i = n - 1 - period; i < n - 1; i++) sum += candles[i].volume || 0;
  const avg = sum / period;
  const cur = candles[n - 1].volume || 0;
  return avg > 0 ? cur / avg : 1;
}

// ── portfolio-heat position sizing ──────────────────────────────────────────

const MAINT = 0.05; // maintenance-margin + fee buffer used for leverage/liquidation

// Per-asset "lean-in" weight — how large a share of the leverage range this asset
// class takes for the SAME conviction. NOT a hard ceiling: the real cap is safeMax
// (stop fires before liquidation) plus the noise-floor stop. Crypto/stocks are
// noisier/gappier so they lean a bit less; forex the most. Argus is free to reach
// maxTradeLev (100×) when the situation (tight stop + high conviction + rich R:R)
// warrants it. Tunable.
export const ASSET_LEV_BIAS = { crypto: 0.85, forex: 1.0, futures: 0.9, stock: 0.8, etf: 0.8, index: 0.85 };

// Minimum stop distance as a fraction of price, per asset — a stop tighter than
// this is just market noise (a 0.017% BTC stop liquidates on the spread). Argus
// widens a too-tight stop to at least this before sizing.
export const MIN_STOP_FRAC = { crypto: 0.004, forex: 0.0006, futures: 0.0015, stock: 0.002, etf: 0.002, index: 0.002 };

// Volatility-regime ceiling: ATR as a fraction of price on the trading timeframe
// above which conditions are too wild to trade cleanly (whipsaw, gap-through-stop
// risk). Per asset class. The risk gate skips a setup above the ceiling and sizes
// DOWN in the elevated band just below it.
export const VOL_CEIL_ATR_PCT = { crypto: 0.05, forex: 0.006, futures: 0.02, stock: 0.03, etf: 0.025, index: 0.02 };

/**
 * The volatility-regime verdict for a setup — the "Volatility check" of the risk
 * system. Given ATR-as-fraction-of-price and the asset class, returns whether the
 * regime is acceptable (`ok`), a size multiplier (1 normally, <1 when elevated),
 * and a human label. Extreme vol → ok:false (the gate skips the trade).
 * @returns {{ ok:boolean, mult:number, label:string, elevated?:boolean, reason?:string }}
 */
export function volStatus(atrPct, asset = "crypto") {
  const ceil = VOL_CEIL_ATR_PCT[asset] ?? 0.03;
  if (!Number.isFinite(atrPct) || atrPct <= 0) return { ok: true, mult: 1, label: "n/a" };
  const label = `${(atrPct * 100).toFixed(2)}%/bar`;
  if (atrPct > ceil) return { ok: false, mult: 0, label, reason: `volatility ${label} > ceiling ${(ceil * 100).toFixed(1)}%` };
  if (atrPct > 0.6 * ceil) return { ok: true, mult: 0.7, label, elevated: true };
  return { ok: true, mult: 1, label };
}

/**
 * Leverage Argus chooses for a trade — its OWN call, free across the whole
 * 1..maxTradeLev range depending on the situation, never bucketed to a fixed value.
 * Two things bound the free choice:
 *   • HARD safety — safeMax: the STOP must fire before liquidation (from entry/stop),
 *     so the margin safeguard (liq beyond the stop) always holds whatever it picks;
 *   • the user cap — maxTradeLev (100×).
 * Within that, the desired leverage rises steeply with CONVICTION (weak setups stay
 * small), is pressed harder on a rich REWARD:RISK, and trimmed on noisier asset
 * classes. Same conviction + different stop/asset/R:R ⇒ different leverage — Argus
 * then learns from the ledger whether that call was right (see reflect.js).
 */
export function chooseLeverage(entry, stopDist, { conviction = 0.5, maxTradeLev = 100, asset = "crypto", rr = 2 } = {}) {
  if (!(stopDist > 0) || !(entry > 0)) return 1;
  const safeMax = Math.max(1, Math.floor((entry / stopDist) * (1 - MAINT)));   // stop before liquidation (hard)
  const c = Math.max(0, Math.min(1, conviction));
  const bias = ASSET_LEV_BIAS[asset] ?? 0.8;
  const rrBoost = 1 + Math.max(0, Math.min(0.5, (rr - 2) * 0.15));              // 2:1 → ×1, 5:1 → ×1.45
  const frac = Math.max(0.02, Math.min(1, (c ** 2.5) * bias * rrBoost));        // steep conviction curve
  const desired = Math.round(maxTradeLev * frac);
  return Math.max(1, Math.min(maxTradeLev, safeMax, desired));
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
 * decides the MARGIN it ties up (margin = notional / leverage). CONCURRENCY is
 * governed by RISK — Argus may hold as many trades as it likes until the heat cap
 * is reached; margin does NOT limit the book. Two gates bound the size:
 *   • heat:      Σ stop-risk ≤ heatCap × equity           (the real risk cap — how many trades)
 *   • portfolio: Σ notional   ≤ portfolioLevCap × equity   (a generous gross-exposure safety)
 * (margin is still computed/returned for display.) Returns null when there's no
 * room (caller parks the setup in watch-mode).
 * @returns {null | { size, riskAmt, leverage, margin, notional, liqPrice }}
 */
export function sizePosition({
  equity, entry, stop, side = "long", asset = "crypto",
  openRisk = 0, openMargin = 0, openNotional = 0,
  heatCap = 0.06, baseRiskPct = 0.02,
  maxTradeLev = 100, portfolioLevCap, maxLeverage, conviction = 0.5, rr = 2,
}) {
  const stopDist = Math.abs(entry - stop);
  if (!(stopDist > 0) || !(equity > 0) || !(entry > 0)) return null;
  const levCap = portfolioLevCap ?? maxLeverage ?? 20; // aggregate-exposure ceiling (×equity)

  // Round-trip cost matters: `entry` is already the SLIPPED entry fill, but the
  // EXIT fill slips too (a stop-out sells below the stop / covers above it). If we
  // size on the bare stop distance, a stop-out realises MORE than the risk budget
  // (e.g. crypto ~-1.15R). Size on the effective distance that INCLUDES the exit
  // spread/fee, so a clean stop-out lands at ≈ -1.00R and riskAmt is the honest,
  // all-in risk. (Entry slippage is already baked into `entry`, hence `stop`.)
  const bps = (SLIP_BPS[asset] ?? 4) / 10000;
  const exitSlipPerUnit = stop * bps;                    // adverse move on the exit fill
  const effStopDist = stopDist + exitSlipPerUnit;        // all-in risk per unit

  // 1) Risk-based size (against the all-in stop distance).
  const riskRoom = heatCap * equity - openRisk;
  const riskAmt0 = Math.min(baseRiskPct * equity, riskRoom);
  if (riskAmt0 <= equity * 0.0005) return null;          // no meaningful heat room → wait
  let size = riskAmt0 / effStopDist;

  // 2) Argus's leverage — its free, situational choice (conviction + R:R + asset),
  //    never so high that a stop-out becomes a liquidation.
  const leverage = chooseLeverage(entry, stopDist, { conviction, maxTradeLev, asset, rr });

  // 3) Exposure gate — concurrency is governed by RISK (the heat cap in step 1); the
  //    ONLY extra bound is a generous gross-notional ceiling so a run of tight-stop
  //    trades can't build unbounded exposure. Margin does NOT cap the book, so Argus
  //    can hold as many heat-approved trades as it wants.
  const sizeFromNotional = Math.max(0, levCap * equity - openNotional) / entry; // portfolio exposure ceiling
  if (sizeFromNotional <= 0) return null;                                // gross exposure ceiling reached → wait
  if (size > sizeFromNotional) size = sizeFromNotional;

  const notional = size * entry;
  return {
    // riskAmt is the ALL-IN risk (incl. exit slippage) so a stop-out ≈ -1.00R.
    size, riskAmt: size * effStopDist, leverage,
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
  // A LIMIT (retest) fill gets its price OR BETTER — never adverse slippage. Only a
  // MARKET entry pays the spread. (Applying slippage to a limit recorded a short
  // BELOW its own level — an entry "where the market wasn't".)
  const fillEntry = setup.limitFill ? setup.entry : fillPrice(setup.entry, setup.side, "entry", asset);
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
    conviction: conviction ?? setup.conviction ?? 0.5, rr,
  });
  if (!sized) return null;
  // Structural invalidation: the level where the SETUP THESIS is wrong on a CLOSE,
  // so Argus bails EARLY (before the wider hard stop) when the reason is gone. Only
  // kept when it sits strictly between entry and stop on the LOSS side — otherwise
  // the stop hits first and it would be redundant.
  let invalidation = null;
  if (Number.isFinite(setup.invalidation)) {
    const inv = setup.invalidation;
    const usable = setup.side === "long" ? inv < fillEntry && inv > stop : inv > fillEntry && inv < stop;
    if (usable) invalidation = inv;
  }
  return {
    id: newId(),
    symbol: setup.symbol, market: setup.market, asset,
    side: setup.side, kind: setup.kind, timeframe: setup.timeframe,
    bias: setup.bias ?? null, // higher-TF regime at entry — carried into the ledger for learning
    state: "open",
    reason: setup.reason, evidence: setup.evidence || [],
    entry: fillEntry, stop, target: setup.target, invalidation,
    size: sized.size, riskAmt: sized.riskAmt,
    // Pyramiding state: one unit at entry; baseSize is the unit to add later, and
    // riskBudget is the ORIGINAL risk the trailing stop keeps total risk inside as
    // units are added (see pyramidAdd).
    units: 1, baseSize: sized.size, riskBudget: sized.riskAmt,
    leverage: sized.leverage, margin: sized.margin, notional: sized.notional, liqPrice: sized.liqPrice,
    plannedR: rr,
    openedAt: now, lastPoll: now,
  };
}

/**
 * PYRAMIDING (money-management borrow, Turtle-style): scale INTO a winner by
 * adding a unit at `addPrice`, then TRAIL the stop so total risk never exceeds the
 * original budget — you increase exposure on the house's money, not your own. Pure:
 * returns the updated thesis fields, or null if it shouldn't add (already flat/at
 * the unit cap / not in profit). Leverage is held constant; margin/liq/risk recompute.
 * @returns {null | {entry,size,stop,riskAmt,notional,margin,liqPrice,units,plannedR}}
 */
export function pyramidAdd(th, addPrice, { maxUnits = 4 } = {}) {
  const units = th.units || 1;
  if (units >= maxUnits) return null;
  const dir = th.side === "long" ? 1 : -1;
  if ((addPrice - th.entry) * dir <= 0) return null;   // only add when the trade is in profit
  const addSize = th.baseSize || th.size;              // one unit
  const newSize = th.size + addSize;
  const avgEntry = (th.entry * th.size + addPrice * addSize) / newSize;
  const budget = th.riskBudget || th.riskAmt;          // the risk the stop must keep total inside
  // Trail the stop so total risk == the original budget; never move it BACKWARDS.
  const trailed = avgEntry - dir * (budget / newSize);
  const stop = dir === 1 ? Math.max(th.stop, trailed) : Math.min(th.stop, trailed);
  const lev = th.leverage || 1;
  const notional = newSize * avgEntry;
  return {
    entry: avgEntry, size: newSize, stop,
    riskAmt: Math.abs(avgEntry - stop) * newSize,
    notional, margin: notional / lev, liqPrice: liquidationPrice(avgEntry, th.side, lev),
    units: units + 1, plannedR: plannedRR(th.side, avgEntry, stop, th.target),
  };
}

// Structural invalidation is a LAST-RESORT early exit, not an eager one. Reviewing
// real invalidated trades showed it was cutting winners: setups that wobbled 50–70%
// of the way to the stop, got cut, then ran to target. So it now fires only when the
// trade is DECISIVELY failing — the close is beyond the structural level (by a small
// anti-poke buffer) AND price has already surrendered most of the entry→stop room
// (INVAL_MIN_ADVERSE), sustained over INVAL_CONFIRM_BARS DISTINCT bars (a sweep that
// reclaims resets the count). By then the trade is nearly at the stop anyway, so we
// exit on a confirmed close rather than wait for the exact tick — but a trade that
// can still reverse to target is left alone. A per-thesis override
// (th.invalMinAdverse / th.invalConfirmBars / th.invalBuffer, or th.invalidation=null
// to disable) lets the 12/24h retrospective LEARNING loosen this further for setups
// whose invalidations kept proving premature. `th.invalBrokeCount`/`invalBrokeBar`
// carry the sustained-break state between bars (the agent is the only caller and
// already mutates the thesis each poll).
const INVAL_BUFFER = 0.15;      // close must clear the structural level by this × entry→stop distance
const INVAL_MIN_ADVERSE = 0.80; // …AND be ≥ this fraction of the way from entry to the stop (nearly dead)
const INVAL_CONFIRM_BARS = 2;   // sustained over this many DISTINCT bars before bailing

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
  // Early THESIS-BREAK exit: the setup's structural level is lost — but only when the
  // trade is DECISIVELY failing (close beyond the level by a buffer AND already deep
  // toward the stop), sustained over consecutive DISTINCT bars. A sweep-and-reclaim,
  // or a 50–70% wobble that can still run to target, no longer cuts the trade.
  if (th.invalidation != null) {
    const riskDist = Math.abs(th.entry - th.stop) || 1;
    const buffer = th.invalBuffer ?? INVAL_BUFFER;
    const minAdverse = th.invalMinAdverse ?? INVAL_MIN_ADVERSE;
    const confirmBars = th.invalConfirmBars ?? INVAL_CONFIRM_BARS;
    const beyond = th.side === "long" ? th.invalidation - candle.close : candle.close - th.invalidation;   // past the structural level
    const adverse = th.side === "long" ? th.entry - candle.close : candle.close - th.entry;                // loss on the close (price units)
    const broke = beyond >= buffer * riskDist && adverse >= minAdverse * riskDist;
    const barTs = candle.time ?? now;
    if (broke) {
      if (th.invalBrokeBar !== barTs) { th.invalBrokeCount = (th.invalBrokeCount || 0) + 1; th.invalBrokeBar = barTs; } // count once per distinct bar
      if ((th.invalBrokeCount || 0) >= confirmBars) return finalize(th, candle.close, "invalidated", now);
    } else {
      th.invalBrokeCount = 0; th.invalBrokeBar = null;                 // reclaimed / recovered — reset
    }
  }
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

/** One trade's R, recomputed from pnl/riskAmt when the stored R is missing — so a
 *  legacy/null-R close can never silently dilute the aggregate (0 in the sum but 1
 *  in the count). The UI and ledgerStats share this so header and rows always agree. */
export function tradeR(c) {
  if (Number.isFinite(c?.R)) return c.R;
  return c && c.riskAmt > 0 && Number.isFinite(c.pnl) ? c.pnl / c.riskAmt : 0;
}

/** Aggregate stats for the closed-thesis ledger. avgR is the per-trade expectancy;
 *  sumR is the cumulative R (avgR × n) — both exposed so the header can't be
 *  misread as one when it shows the other. */
export function ledgerStats(closed) {
  const n = closed.length;
  if (!n) return { n: 0, wins: 0, winRate: 0, pnl: 0, sumR: 0, avgR: 0, expectancy: 0 };
  const wins = closed.filter((c) => c.pnl > 0).length;
  const pnl = closed.reduce((a, c) => a + c.pnl, 0);
  const sumR = closed.reduce((a, c) => a + tradeR(c), 0);
  return {
    n, wins, winRate: wins / n, pnl, sumR,
    avgR: sumR / n,
    expectancy: sumR / n, // R-expectancy per trade
  };
}
