// scorecard.js — the five component scores Argus records for every trade it opens.
//
// Argus collapses everything it knows about a setup into ONE number (`conviction`)
// plus a pass/fail risk checklist. That is enough to decide with and far too little
// to learn from: when a bucket loses, a single number cannot say which part of the
// read was wrong — whether the trend call, the participation, or the catalyst.
// This module keeps the parts.
//
// NOTHING HERE CHANGES A DECISION. The scores are computed from values the agent
// has already gathered at the moment of entry, written onto the thesis, and read
// back afterwards: as features for metalabel.js and as slices for the learning
// loop. Recording is the whole point — every trade that closes without them is a
// row no later model can use. If a component turns out to predict, meta-labelling
// will say so; until then this is instrumentation and is labelled as such.
//
// Each component is 0–10, 5 means "neutral / nothing to say". Absence of evidence
// scores 5, never 0 — a setup with no catalyst is not a setup with a bad one.

/** The components, in the order the UI and the feature matrix expect them. */
export const SCORE_KEYS = ["trend", "momentum", "volume", "catalyst", "risk"];

const clamp10 = (x) => Math.max(0, Math.min(10, x));
const round1 = (x) => Math.round(x * 10) / 10;
// Smooth, saturating map onto 0–10 around a neutral 5: never rewards an outlier
// twice as much as a strong-but-plausible reading.
const soft = (x, scale) => clamp10(5 + 5 * Math.tanh(x / scale));

/**
 * Higher-timeframe agreement: does the trade side sit with the 1h bias?
 * Reversal setups fade by design and will score low here — that is the reading,
 * not a defect. The kind is already recorded next to it, so the two can be
 * separated later.
 */
export function trendScore(side, bias) {
  if (bias !== "up" && bias !== "down") return 5;
  const aligned = (side === "long" && bias === "up") || (side === "short" && bias === "down");
  return aligned ? 8.5 : 2;
}

/** Move of the last hour in ATR units, signed into the trade's direction. */
export function momentumScore(side, momAtr) {
  if (!Number.isFinite(momAtr)) return 5;
  return soft((side === "long" ? 1 : -1) * momAtr, 2);
}

/** Participation behind the move: relative volume against the last 20 bars. */
export function volumeScore(rvol) {
  if (!Number.isFinite(rvol) || rvol <= 0) return 5;
  return soft(rvol - 1, 1.2);
}

/**
 * The event channel's read on this symbol. Neutral without one; a confident
 * agreement lifts, a disagreement cuts. (A ≥0.7 opposing catalyst never reaches
 * here — the agent vetoes the trade before sizing it.)
 */
export function catalystScore({ evented = false, opposes = false, confidence = 0 } = {}) {
  const c = Math.max(0, Math.min(1, confidence));
  if (evented) return clamp10(5 + 5 * c);
  if (opposes) return clamp10(5 - 5 * c);
  return 5;
}

/**
 * How much room the trade has: the reward:risk it was planned at, penalised for
 * an elevated volatility regime and for how full the risk book already is. This
 * is the *quality* of the risk taken, not whether the gates passed — a trade only
 * gets scored once every gate has already said yes.
 */
export function riskScore({ plannedR, volElevated = false, heatUsedPct = 0, heatCapPct = 0 } = {}) {
  let s = Number.isFinite(plannedR) ? soft(plannedR - 1.5, 1.5) : 5;
  if (volElevated) s -= 1.5;
  const frac = heatCapPct > 0 ? Math.max(0, Math.min(1, heatUsedPct / heatCapPct)) : 0;
  s -= 2 * frac;
  return clamp10(s);
}

/**
 * The full scorecard for one entry.
 *
 * @param {object} ctx
 * @param {"long"|"short"} ctx.side
 * @param {"up"|"down"|"flat"|null} ctx.bias   1h bias the scanner tagged
 * @param {number} ctx.momAtr                 last hour's move in ATR units (signed, market direction)
 * @param {number} ctx.rvol                   relative volume on the trigger bar
 * @param {boolean} ctx.evented               an event bias agrees with this side
 * @param {boolean} ctx.opposes               an event bias disagrees
 * @param {number} ctx.confidence             that bias's confidence, 0–1
 * @param {number} ctx.plannedR               reward:risk as planned
 * @param {boolean} ctx.volElevated           sized down by the volatility gate
 * @param {number} ctx.heatUsedPct/heatCapPct book fill at entry
 * @returns {{trend,momentum,volume,catalyst,risk,total}} components 0–10, total 0–100
 */
export function scoreSetup(ctx = {}) {
  const trend = trendScore(ctx.side, ctx.bias);
  const momentum = momentumScore(ctx.side, ctx.momAtr);
  const volume = volumeScore(ctx.rvol);
  const catalyst = catalystScore(ctx);
  const risk = riskScore(ctx);
  const parts = [trend, momentum, volume, catalyst, risk];
  return {
    trend: round1(trend), momentum: round1(momentum), volume: round1(volume),
    catalyst: round1(catalyst), risk: round1(risk),
    // Equal weights, deliberately. A weighting would be a claim about which
    // component matters, and that claim is exactly what the record is meant to
    // settle. The total is a summary for the eye — it decides nothing.
    total: Math.round(10 * (parts.reduce((a, v) => a + v, 0) / parts.length)),
  };
}
