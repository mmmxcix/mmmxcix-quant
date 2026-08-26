// argus/eventTrade.js — turning a catalyst into a risk-defined trade.
//
// This is the part of docs/DAYTRADER_AGENT.md that was designed, documented as
// "the differentiator (news → ticker → trade)", and then never built. What
// existed instead was a BIAS: the LLM's read tilted a technical setup's
// conviction by a few percent and could veto one on strong disagreement, but it
// could not itself open anything. The ledger says exactly that — all 47 closed
// trades carry source "technical", none "event", so the one channel that is not
// already arbitraged by everyone running the same five indicators has never
// produced a single measurable observation.
//
// A catalyst thesis has no chart level to hang a stop on, which is presumably
// why it stayed a bias. So the stop is STRUCTURAL instead of technical: a
// multiple of current ATR, which is the honest statement "I am wrong if this
// moves N normal bars against me", and the target is a fixed multiple of that
// risk. No level is invented, nothing is fitted, and the trade is risk-defined
// before it is taken — the same contract every technical setup signs.
//
// The point of this module is not that catalyst trades will work. It is that
// after this they will be MEASURED: tagged source "event" in the ledger, graded
// by the same learning loop against the same bar, and switched off by evidence
// if the channel is noise.

import { atr } from "./core.js";

/** Fresh enough to act on. A catalyst decays faster than a chart level does. */
export const DEFAULT_MAX_AGE_MS = 90 * 60_000;

/**
 * Build a risk-defined setup from an LLM catalyst read, or return null.
 *
 * Every refusal returns null with no side effects, because this runs inside the
 * scan loop and a catalyst that does not qualify must cost nothing.
 *
 * @param bias        { side, thesis, confidence, evidence, horizon, at, model }
 * @param candles     the SIGNAL series (already the timeframe being traded)
 * @param opts.minConfidence  the bar a catalyst must clear to be tradable at all
 * @param opts.atrMult        stop distance in ATR units
 * @param opts.rMult          target as a multiple of the stop distance
 * @returns setup | null
 */
export function eventSetup(bias, candles, {
  timeframe = "15m",
  minConfidence = 0.75,
  atrMult = 1.5,
  rMult = 2.5,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  now = Date.now(),
} = {}) {
  if (!bias || (bias.side !== "long" && bias.side !== "short")) return null;
  const conf = Number(bias.confidence);
  // The confidence bar is deliberately high. A channel with no track record gets
  // the agent's smallest, most selective slice of attention, not its widest.
  if (!Number.isFinite(conf) || conf < minConfidence) return null;
  if (Number.isFinite(bias.at) && now - bias.at > maxAgeMs) return null;
  if (!Array.isArray(candles) || candles.length < 20) return null;

  const last = candles[candles.length - 1];
  const entry = Number(last?.close);
  const a = atr(candles, 14);
  if (!(entry > 0) || !(a > 0)) return null;

  const stopDist = atrMult * a;
  // A stop inside the spread is not a stop. The agent widens tight stops to the
  // asset noise floor at open anyway; refusing here keeps a degenerate ATR (a
  // frozen or gapped series) from reaching sizing at all.
  if (!(stopDist / entry > 0.0005)) return null;

  const long = bias.side === "long";
  const stop = long ? entry - stopDist : entry + stopDist;
  const target = long ? entry + rMult * stopDist : entry - rMult * stopDist;

  const barSec = timeframe === "15m" ? 900 : 300;
  const signalBarMs = Number.isFinite(last?.time) ? (last.time + barSec) * 1000 : null;

  return {
    kind: "event",
    side: bias.side,
    entry, stop, target,
    // No structural invalidation level: the catalyst's invalidation is a
    // sentence, not a price, and inventing a number for it would be fiction.
    // It is carried on the catalyst record and reviewed like any other exit.
    invalidation: null,
    timeframe,
    signalBarMs,
    barMs: barSec * 1000,
    atrPct: a / entry,
    rvol: null,
    momAtr: null,
    // Setup "strength" for ranking. The catalyst's own confidence is the only
    // quality signal there is here, so it is used directly rather than being
    // blended into something that looks more sophisticated than it is.
    strength: conf,
    rMult,
    reason: `Catalyst (${Math.round(conf * 100)}%): ${String(bias.thesis || "").slice(0, 120)}`,
    evidence: Array.isArray(bias.evidence) ? bias.evidence.slice(0, 6) : [],
    // The field the ledger buckets on: learn.sourceOf reads `catalyst` and
    // records source "event". Without it this channel would be invisible in its
    // own track record, which is the whole failure being fixed.
    catalyst: {
      thesis: String(bias.thesis || "").slice(0, 400),
      invalidation: String(bias.invalidation || "").slice(0, 300),
      confidence: conf,
      horizon: String(bias.horizon || "").slice(0, 40),
      model: bias.model || null,
      at: bias.at ?? now,
    },
  };
}
