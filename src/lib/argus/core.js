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

// Volatility-regime ceiling: ATR as a fraction of price above which conditions
// are too wild to trade cleanly (whipsaw, gap-through-stop risk). Per asset
// class, quoted for a DAILY bar.
//
// These numbers were being compared against a 5-MINUTE ATR, and that made the
// whole gate dead code: the crypto ceiling of 5%/bar sits 12x above the largest
// 5m reading ever recorded in the live ledger (0.43%), so it never fired, and
// the "elevated" band at 0.6x never fired either — meaning the 0.7 size
// reduction it was supposed to apply had never once been applied.
export const VOL_CEIL_ATR_PCT = { crypto: 0.05, forex: 0.006, futures: 0.02, stock: 0.03, etf: 0.025, index: 0.02 };

/** Bars per day, used to scale a daily ceiling down to the trading timeframe. */
const BARS_PER_DAY = { "1m": 1440, "5m": 288, "15m": 96, "30m": 48, "1h": 24, "2h": 12, "4h": 6, "1d": 1, "1w": 1 / 7 };

/**
 * The daily ceiling scaled to `timeframe` by the square root of time — the
 * standard way volatility converts across horizons, not a fitted constant. A 5m
 * crypto ceiling lands at 0.295%/bar, which is roughly the 90th percentile of
 * what the live ledger actually saw, so the gate finally has something to bite on.
 */
export function volCeiling(asset = "crypto", timeframe = "1d") {
  const daily = VOL_CEIL_ATR_PCT[asset] ?? 0.03;
  const bars = BARS_PER_DAY[timeframe];
  return bars > 0 ? daily / Math.sqrt(bars) : daily;
}

/**
 * The volatility-regime verdict for a setup — the "Volatility check" of the risk
 * system. Given ATR-as-fraction-of-price and the asset class, returns whether the
 * regime is acceptable (`ok`), a size multiplier (1 normally, <1 when elevated),
 * and a human label. Extreme vol → ok:false (the gate skips the trade).
 * @returns {{ ok:boolean, mult:number, label:string, elevated?:boolean, reason?:string }}
 */
export function volStatus(atrPct, asset = "crypto", timeframe = "1d") {
  const ceil = volCeiling(asset, timeframe);
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
  // Liquidation must sit at least TWO stop-distances away, not just past the stop.
  // At (1 − MAINT) the liq price sat a hair beyond the stop, and a bar that gapped
  // through both filled at the LIQ level: the 11 live stops that overshot −1R
  // carried mean leverage 34 vs 20 for clean stops, −2.6R given back for nothing —
  // in this sizing model leverage has zero upside (risk is fixed by riskAmt;
  // leverage only moves the liq price closer).
  const safeMax = Math.max(1, Math.floor((entry / stopDist) * ((1 - MAINT) / 2)));
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
// Minimum planned reward:risk for a trade to be taken at all.
//
// This was 0.8, and that is not a tuning choice — it is arithmetic that cannot
// work. Risking 1 to make 0.8 needs a 55.6% win rate merely to break even, and
// no discretionary intraday system reaches that; the live ledger ran at 28.7%
// over 94 trades, with 13 trades taken at a planned RR below 1.0. At 1.5 the
// break-even win rate is 40%, which is at least in reach of this style.
//
// The live ledger also says the loss would have fallen from −1,970 to −131 with
// this gate. That number is NOT the reason for the change and should not be
// trusted: it is 94 trades from 1.6 days, and the same sweep says 1.8 and 2.0
// would have been WORSE than 1.5, which is how noise looks. The reason is the
// arithmetic above; the backtest merely fails to contradict it.
export const MIN_PLANNED_R = 1.5;

export function openThesis(setup, { equity, openRisk, openMargin = 0, openNotional = 0, asset, heatCap, baseRiskPct, maxTradeLev, portfolioLevCap, maxLeverage, conviction, minPlannedR = MIN_PLANNED_R, now = Date.now() }) {
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
    // The rest of the setup's context, persisted for the same reason as `bias`.
    // This list is a WHITELIST: everything the agent stamps on the setup that is
    // not named here silently dies at open. That is exactly what happened to
    // `explore` (1,187 probe grants, zero labeled probes in the ledger — three
    // layers of probe accounting counting an empty column), to `regime` (the HMM
    // lesson bucket trained on a column no record ever carried), and to
    // `conviction`/`atrPct`/`rvol` (the meta-labeller regexing ATR back out of a
    // UI string because the number was dropped here).
    explore: setup.explore || undefined,          // undefined → absent from JSON for normal bets
    regime: setup.regime ?? null,                 // HMM market state at entry ("Bear"/"Neutral"/"Bull")
    conviction: Number.isFinite(setup.conviction) ? setup.conviction : null,
    atrPct: Number.isFinite(setup.atrPct) ? setup.atrPct : null,
    rvol: Number.isFinite(setup.rvol) ? setup.rvol : null,
    momAtr: Number.isFinite(setup.momAtr) ? setup.momAtr : null,
    limitFill: !!setup.limitFill,
    shadow: setup.shadow ?? null,                 // would-veto flags logged, never enforced
    state: "open",
    reason: setup.reason, evidence: setup.evidence || [],
    entry: fillEntry, stop, target: setup.target, invalidation,
    // Where the invalidation level sits between entry and stop, in R — stamped at
    // open so exit forensics never have to reconstruct it from prices.
    invalLevelR: invalidation != null ? +(Math.abs(fillEntry - invalidation) / Math.abs(fillEntry - stop)).toFixed(3) : null,
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

// FIRSTBREAK mode (LAB_ARGUS_INVAL_MODE, default on): exit on the FIRST qualifying
// close instead of waiting out the confirm delay. Measured on the live ledger
// (Aug 19, 33 post-fix invalidations with recorded per-bar break state): the
// confirm delay cost −0.575R per invalidated trade, hurt in 32 of 33 and helped
// in 0 — the trade kept bleeding through the bars spent "confirming". The agent's
// own 12h/24h reviews agree (42 would-have-lost vs 2 premature of 47 reviewed).
// The arming threshold stays at 0.60 — the value the live overrides were actually
// running (invalPolicy "cut-earlier") and therefore the ONLY trigger the
// counterfactual was measured under; a looser trigger (0/0.15) fires on trades
// that were never in the sample, so it is explicitly not shipped.
// The fill is the arming bar's CLOSE with normal exit slippage — the same pricing
// the confirm rule used, so the whole measured gain is timing, not fill fiction.
const FIRSTBREAK_MIN_ADVERSE = 0.60;

/** Given the latest candle, decide if an open thesis exits, and how. */
export function evaluateExit(th, candle, { now = Date.now(), maxHoldMs = 3 * 864e5, invalMode = "confirm" } = {}) {
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
    const firstbreak = invalMode === "firstbreak";
    const buffer = th.invalBuffer ?? INVAL_BUFFER;
    // In firstbreak mode the per-thesis learned overrides are deliberately IGNORED:
    // the measured exit must not be quietly re-loosened by the same tuner whose
    // confirm-delay it replaces (review.invalPolicy is mode-aware for the same
    // reason — only its disable tier survives, at a raised bar).
    const minAdverse = firstbreak ? FIRSTBREAK_MIN_ADVERSE : (th.invalMinAdverse ?? INVAL_MIN_ADVERSE);
    const confirmBars = firstbreak ? 1 : (th.invalConfirmBars ?? INVAL_CONFIRM_BARS);
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
  const rs = closed.map((c) => tradeR(c));
  const sumR = rs.reduce((a, r) => a + r, 0);
  const avgR = sumR / n;
  // Dispersion of R, so a caller can ask whether a negative expectancy is
  // EVIDENCE or noise. Without it, "is this bucket broken?" can only be a
  // fixed threshold, which is sample-blind: -0.50R over 50 trades is far
  // stronger evidence than -0.85R over 6, yet a threshold ranks them the
  // other way round.
  const varR = n > 1 ? rs.reduce((a, r) => a + (r - avgR) ** 2, 0) / (n - 1) : 0;
  const sdR = Math.sqrt(varR);
  // The standard error is FLOORED, and that is not a detail. R in a stop/target
  // system clusters hard: a bucket where every trade stopped out has an observed
  // spread of literally zero, so the raw t-statistic divides by floating-point
  // dust. The live ledger showed XRPUSDT at t = −8.6e13 on four trades — a number
  // that would let any two-trade bucket clear any confidence bar we set.
  // Shrinking toward the dispersion such a system actually has (~0.6R) makes t
  // mean what it claims at small samples instead of exploding.
  const SD_FLOOR = 0.6;
  const se = n > 1 ? Math.max(sdR, SD_FLOOR) / Math.sqrt(n) : 0;
  return {
    n, wins, winRate: wins / n, pnl, sumR,
    avgR,
    expectancy: avgR, // R-expectancy per trade
    sdR,
    // t-statistic of "expectancy < 0". <= -2 is ~95% one-sided confidence that
    // this bucket genuinely loses, rather than having had a bad run.
    tStat: se > 0 ? avgR / se : 0,
  };
}

// ── excursion forensics ──────────────────────────────────────────────────────
// The agent records how far a trade ran in its favour and against it, AND when
// each happened (maxFavAt / maxAdvAt). The timestamps are what make these
// numbers answerable instead of merely suggestive: a trade that ran to +0.8R
// and reversed stores the same pair of magnitudes as one that dipped to −0.8R
// and recovered.

/** Which extreme came first. "unknown" when the trade predates the timestamps. */
export function excursionOrder(t) {
  const f = t?.maxFavAt, a = t?.maxAdvAt;
  if (!Number.isFinite(f) && !Number.isFinite(a)) return "unknown";
  if (!Number.isFinite(a)) return "ran-first";
  if (!Number.isFinite(f)) return "dipped-first";
  if (f === a) return "same-bar";     // one bar held both extremes — undecidable
  return f < a ? "ran-first" : "dipped-first";
}

/**
 * Counterfactual: would moving the stop to break-even after `trigger` R have
 * changed this trade's result?
 *
 * Returns { applies, before, after, delta, why }. `applies:false` means the rule
 * would never have armed on this trade, so it is neither helped nor harmed —
 * counting those as "no change" is what keeps the summary honest.
 *
 * The rule can only be judged where the ORDER is known. A trade whose extremes
 * fall on the same bar is excluded rather than guessed: intrabar we cannot tell
 * whether the high or the low came first, and assuming the favourable one is
 * exactly how a backtest flatters a stop rule.
 */
export function breakEvenOutcome(t, { trigger = 0.5 } = {}) {
  const R = tradeR(t);
  const fav = t?.maxFavR ?? 0;
  if (!(fav >= trigger)) {
    return { applies: false, before: R, after: R, delta: 0, why: "never reached the trigger" };
  }
  const order = excursionOrder(t);
  if (order === "unknown" || order === "same-bar") {
    return { applies: false, before: R, after: R, delta: 0, why: `excursion order ${order}` };
  }
  if (order === "dipped-first") {
    // The worst point came BEFORE the run, so the stop was still at its original
    // level when the damage was done — the rule cannot have changed anything.
    return { applies: false, before: R, after: R, delta: 0, why: "worst point preceded the run" };
  }
  // Ran first, then reversed. The stop was at break-even by then, so the trade
  // ends flat instead of wherever it actually ended — but only if it actually
  // came back through entry, which a LOSS by definition did.
  if (R >= 0) {
    return { applies: false, before: R, after: R, delta: 0, why: "won anyway" };
  }
  return { applies: true, before: R, after: 0, delta: -R, why: "ran, then reversed through entry" };
}

/** Apply breakEvenOutcome across a ledger and total the effect.
 *
 *  `delta` is the LOSER side only — trades saved by the BE stop — and is an
 *  upper bound by construction, because breakEvenOutcome calls every winner
 *  "won anyway": a winner that reached the trigger, dipped back through entry
 *  and THEN hit its target would in reality have been stopped flat, and the
 *  per-trade timestamps cannot prove that sequence (a winner's max-favourable
 *  time is essentially its exit, so the dip always time-sorts before it).
 *
 *  The study therefore adds the standard linear-path estimate for those killed
 *  winners: the trigger is assumed first touched at (trigger/maxFavR) of the
 *  way to the peak, and a winner whose below-entry dip (maxAdvR ≥ 0.05)
 *  happened after that touch counts as killed. `netDelta` = saved + killed is
 *  the number a decision may look at; quoting `delta` alone is how a one-sided
 *  instrument talks a break-even stop back into a book whose entire edge is
 *  its fat right tail. (Measured Aug 2026: delta +28R, netDelta ≈ −3R.) */
export function breakEvenStudy(closed, { trigger = 0.5 } = {}) {
  const rows = (closed || []).map((t) => ({ t, o: breakEvenOutcome(t, { trigger }) }));
  const applied = rows.filter((r) => r.o.applies);
  const undecidable = rows.filter((r) => !r.o.applies && /order (unknown|same-bar)/.test(r.o.why));
  const sumBefore = rows.reduce((a, r) => a + r.o.before, 0);
  const sumAfter = rows.reduce((a, r) => a + r.o.after, 0);
  let killed = 0, killedR = 0;
  for (const t of closed || []) {
    const R = tradeR(t);
    const fav = t?.maxFavR ?? 0;
    if (!(R > 0) || !(fav >= trigger)) continue;
    if (!((t?.maxAdvR ?? 0) >= 0.05)) continue; // never traded back below entry — BE stop untouched
    if (!Number.isFinite(t?.maxFavAt) || !Number.isFinite(t?.maxAdvAt) || !Number.isFinite(t?.openedAt)) continue;
    const firstTouch = t.openedAt + (trigger / fav) * (t.maxFavAt - t.openedAt); // linear-path proxy
    if (t.maxAdvAt > firstTouch) { killed++; killedR += -R; } // flat at BE instead of the +R it made
  }
  const delta = sumAfter - sumBefore;
  return {
    trigger,
    n: rows.length,
    applied: applied.length,
    undecidable: undecidable.length,
    sumBefore, sumAfter, delta,
    killed, killedR,
    netDelta: delta + killedR,
  };
}

// ── recency-weighted statistics ─────────────────────────────────────────────
// The learning loop weights the whole past equally, which the walk-forward
// harness caught immediately: a setup that wins sixty trades and then loses
// sixty straight full-stops still reads +0.1R and is never switched off.
// Markets change; a lesson from months ago should not carry the weight of
// yesterday's.
//
// Exponential decay with a HALF-LIFE — the age at which a trade counts half as
// much. The sample-size gates then have to be re-expressed, because a thousand
// heavily-discounted trades are not a thousand trades: `n` becomes Kish's
// EFFECTIVE sample size, (Σw)² / Σw², which is the standard correction and is
// what stops a long, stale history from looking like strong evidence.

/** Decay weight of a trade at `now`, given a half-life in ms. 0 or Infinity
 *  half-life means no decay at all — the old behaviour, exactly. */
export function decayWeight(trade, now, halfLifeMs) {
  if (!(halfLifeMs > 0) || !Number.isFinite(halfLifeMs)) return 1;
  const at = trade?.exitAt ?? trade?.openedAt;
  if (!Number.isFinite(at)) return 1;
  const age = Math.max(0, now - at);
  return Math.pow(0.5, age / halfLifeMs);
}

/**
 * `ledgerStats`, with each trade weighted by how recent it is.
 * Returns the same shape, so every caller keeps working; with no half-life it
 * returns the unweighted numbers to the last decimal.
 */
export function weightedLedgerStats(closed, { halfLifeMs = 0, now = Date.now() } = {}) {
  const n = closed.length;
  if (!n) return ledgerStats(closed);
  if (!(halfLifeMs > 0)) return ledgerStats(closed);

  const w = closed.map((c) => decayWeight(c, now, halfLifeMs));
  const sumW = w.reduce((a, b) => a + b, 0);
  if (!(sumW > 0)) return ledgerStats(closed);
  const sumW2 = w.reduce((a, b) => a + b * b, 0);
  // Kish's effective sample size. Equal weights give back exactly n.
  const nEff = (sumW * sumW) / sumW2;

  const rs = closed.map((c) => tradeR(c));
  const avgR = rs.reduce((a, r, i) => a + r * w[i], 0) / sumW;
  const wins = closed.reduce((a, c, i) => a + (c.pnl > 0 ? w[i] : 0), 0);
  const pnl = closed.reduce((a, c) => a + c.pnl, 0);   // money is money — never discounted
  const varR = nEff > 1
    ? rs.reduce((a, r, i) => a + w[i] * (r - avgR) ** 2, 0) / sumW * (nEff / (nEff - 1))
    : 0;
  const sdR = Math.sqrt(varR);
  const SD_FLOOR = 0.6;
  const se = nEff > 1 ? Math.max(sdR, SD_FLOOR) / Math.sqrt(nEff) : 0;
  return {
    n: nEff,
    rawN: n,
    wins: wins,
    winRate: wins / sumW,
    pnl,
    sumR: avgR * nEff,
    avgR,
    expectancy: avgR,
    sdR,
    tStat: se > 0 ? avgR / se : 0,
  };
}
