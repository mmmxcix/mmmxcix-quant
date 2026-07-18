// profiles.js — the two strictness regimes every part of Cortex reads from.
//
// A strategy is never "good" in the abstract; it is good *for an account*. A
// prop-firm account dies at an 8% drawdown, so it needs shallow-drawdown
// strategies and will reject an otherwise excellent one that digs a 25% hole.
// A private account can sit through that hole — but it still has to be paid for
// taking the pain, so the profit bar goes UP as the drawdown allowance goes up.
//
// Three things vary per profile and they are deliberately kept together, so a
// change to "how strict is prop?" is one edit and not a hunt through four files:
//
//   risk        RiskGate rules — enforced live on every entry (lab-agent)
//   validation  the research gauntlet's pass/fail bars (research-agent)
//   promotion   what it takes to reach the paper portfolio, and how many fit
//
// Pure module: imported by Node agents AND React pages. No DOM, no fetch.

/** @typedef {"prop"|"private"} ProfileId */

export const PROFILES = {
  // ── prop firm: survival first ─────────────────────────────────────────────
  // Calibrated against typical evaluation accounts (FTMO/Topstep class): ~10%
  // max total drawdown, ~5% daily. We sit *under* those so the gate blocks
  // before the firm's own breach trigger does — a blocked entry is recoverable,
  // a breached account is not.
  prop: {
    id: "prop",
    label: "Prop firm",
    blurb: "Survives an evaluation account. Shallow drawdowns, tight daily loss, US session only.",
    risk: {
      tradingWindowUtc: { start: 13, end: 21 }, // US cash session
      maxSimultaneousPositions: 3,
      maxCombinedDrawdownPct: 8,
      dailyLossLimitPct: 4,
      maxTradesPerDay: 12,
      maxPairwiseCorrelation: 0.6,
      blackout: [],
    },
    validation: {
      minTrades: 30,           // more trades = the DSR estimate means something
      minProfitFactor: 1.25,
      minReturnPct: 0,
      maxBacktestDrawdownPct: 15, // hard ceiling: a 20% backtest DD breaches an 8% live rule
      minDsr: 97,
      requireKFold: true,
      requireNoise: true,
    },
    promotion: {
      minDsr: 97,
      cap: 3,
      // Re-validation must still clear this after the strategy has aged a day.
      minDsrOnRevalidate: 95,
    },
  },

  // ── private account: drawdown is affordable, mediocrity is not ────────────
  // The looser drawdown allowance is not a lower bar overall — it is a trade.
  // We accept a 35% backtest hole, but only from something that clears a higher
  // profit factor than prop demands. Otherwise "private" silently becomes
  // "the profile where bad strategies go to get promoted".
  private: {
    id: "private",
    label: "Private account",
    blurb: "Your own capital. Deep drawdowns tolerated — but the payoff has to justify them.",
    risk: {
      tradingWindowUtc: { start: 0, end: 24 }, // 24/7, crypto-friendly
      maxSimultaneousPositions: 8,
      maxCombinedDrawdownPct: 30,
      dailyLossLimitPct: 10,
      maxTradesPerDay: 30,
      maxPairwiseCorrelation: 0.8,
      blackout: [],
    },
    validation: {
      minTrades: 20,
      minProfitFactor: 1.35,   // HIGHER than prop — deeper holes must pay better
      minReturnPct: 0,
      maxBacktestDrawdownPct: 35,
      minDsr: 95,
      requireKFold: true,
      requireNoise: true,
    },
    promotion: {
      minDsr: 95,
      cap: 8,
      minDsrOnRevalidate: 92,
    },
  },
};

export const PROFILE_IDS = /** @type {ProfileId[]} */ (Object.keys(PROFILES));
export const DEFAULT_PROFILE = "private";

/** Resolve a profile by id, falling back to the default rather than throwing. */
export function getProfile(id) {
  return PROFILES[id] || PROFILES[DEFAULT_PROFILE];
}

/**
 * The RiskGate rule set for a profile, with optional per-machine overrides
 * (local.riskRules in the agent state file) layered on top.
 */
export function riskRulesFor(id, overrides = {}) {
  return { ...getProfile(id).risk, ...overrides };
}

/**
 * Judge finished backtest metrics against a profile's validation bars.
 * Returns the FIRST failure so the graveyard reason names one concrete cause,
 * not a wall of them.
 *
 * @param {object} p
 * @param {ProfileId} p.profileId
 * @param {Array<{name:string, m:object}>} p.perSet  per-dataset metrics
 * @param {number} [p.dsrPct]  deflated Sharpe in percent (omit to skip the check)
 * @returns {{ pass:boolean, reason?:string }}
 */
export function judgeMetrics({ profileId, perSet, dsrPct }) {
  const v = getProfile(profileId).validation;

  for (const s of perSet) {
    const m = s.m;
    if (m.tradeCount < v.minTrades) {
      return { pass: false, reason: `only ${m.tradeCount} trades on ${s.name} (need ≥${v.minTrades})` };
    }
    if (m.totalReturnPct <= v.minReturnPct) {
      return { pass: false, reason: `no edge on ${s.name} (ret ${m.totalReturnPct.toFixed(0)}%)` };
    }
    if (m.profitFactor < v.minProfitFactor) {
      return { pass: false, reason: `PF ${m.profitFactor.toFixed(2)} < ${v.minProfitFactor} on ${s.name}` };
    }
    if (m.maxDrawdownPct > v.maxBacktestDrawdownPct) {
      return { pass: false, reason: `drawdown ${m.maxDrawdownPct.toFixed(0)}% > ${v.maxBacktestDrawdownPct}% on ${s.name}` };
    }
  }

  if (dsrPct != null && dsrPct < v.minDsr) {
    return { pass: false, reason: `DSR ${dsrPct.toFixed(1)}% < ${v.minDsr}%` };
  }
  return { pass: true };
}

/**
 * Which profiles does this result qualify for? A strategy is evaluated against
 * BOTH regimes in one pass — the same backtest can be prop-grade, private-grade,
 * both, or neither. Returning the set (rather than a single verdict) is what
 * lets one nightly run feed two portfolios.
 *
 * @returns {{ qualified: ProfileId[], reasons: Record<ProfileId, string> }}
 */
export function qualifyAll({ perSet, dsrPct }) {
  const qualified = [];
  const reasons = {};
  for (const id of PROFILE_IDS) {
    const r = judgeMetrics({ profileId: id, perSet, dsrPct });
    if (r.pass) qualified.push(id);
    else reasons[id] = r.reason;
  }
  return { qualified, reasons };
}
