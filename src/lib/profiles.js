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
      // Sample-size research (Aug 2026): ~30 trades is only the CLT floor,
      // ~100 is basic reliability, 200–500 is the institutional standard
      // (López de Prado). Per single market our 10y windows cap what a sane
      // 8–12 trades/yr strategy can produce at ~80–120, so the per-market
      // floor sits at "basic reliability" and the institutional confidence
      // comes from minPooledTrades across ALL tested markets below.
      minTrades: 100,          // per market — below this, variance dominates the estimate
      minTradesPerYear: 12,    // …AND a rate floor: sparse trades over 10y is luck, not an edge (≥1/month)
      minPooledTrades: 300,    // across ALL markets combined (judged when perSet spans >1 market)
      minProfitFactor: 1.25,
      minReturnPct: 0,
      maxBacktestDrawdownPct: 15, // hard ceiling: a 20% backtest DD breaches an 8% live rule
      // Calibrated against measurement, not intuition — see
      // docs/CORTEX_CALIBRATION.md for the full table.
      //
      // The old 97% bar was unreachable in practice. Measured DSR at a
      // realistic 90 effective trials: QQQ trend (Sharpe 1.05) 58.7%, TSLA
      // 41.7%, SPY 35.2%, an RSI mean-reversion noise strategy 5.5%. A 97%
      // bar rejects all of them, so after a few dozen papers the agent could
      // never promote anything again regardless of quality.
      //
      // 70% is where the prop bar actually discriminates: it demands better
      // than the best of this sample, which is the right posture for an
      // account that dies at an 8% drawdown.
      minDsr: 70,
      requireKFold: true,
      requireNoise: true,
      // ── Tier-1 pooled bars (docs/CORTEX_BENCHMARK.md §4) ──────────────────
      // A rule is graded on its POOLED daily returns across every market it ran
      // on — realistic single-rule Sharpe is 0.2–0.5, and pooling is what makes
      // that statistically confirmable. PF here is a pooled-liveness bar, not
      // the old per-market 1.25: at 300+ pooled trades even a strong diversified
      // edge sits near 1.1 (trend shapes win rarely and big). The quant-grade
      // Sharpe-1 / beat-B&H bars apply to the ENSEMBLE book, not the rule.
      pooled: {
        minSharpe: 0.30,
        minProfitFactor: 1.08,
        maxDrawdownPct: 12,   // pooled DD is diversified — a prop book still dies at 8% live
        minTrades: 300,
        minTradesPerYear: 12,
      },
    },
    promotion: {
      minDsr: 70,
      cap: 4, // entries, not rules — an ensemble rule promotes its top markets
      // Re-validation must still clear this after the strategy has aged a day.
      minDsrOnRevalidate: 60,
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
      // See the prop note: 80 ≈ what a healthy 8-trades/yr strategy can even
      // produce on a 10y window; the institutional sample comes from pooling.
      minTrades: 80,
      minTradesPerYear: 8,     // rate floor too — a few lucky trades across years is not an edge
      minPooledTrades: 300,    // across ALL markets combined (judged when perSet spans >1 market)
      minProfitFactor: 1.35,   // HIGHER than prop — deeper holes must pay better
      minReturnPct: 0,
      maxBacktestDrawdownPct: 35,
      // See the prop note above. At 90 effective trials this admits the
      // QQQ-class signal (58.7%) and rejects the noise strategy (5.5%) — the
      // separation the measurement actually supports.
      //
      // Expect this to promote ONE or TWO strategies a month, not dozens. That
      // is the Deflated Sharpe doing its job: once you have tried hundreds of
      // ideas, only an exceptional result is still credible. The structural
      // suite (k-fold, noise, out-of-sample holdout, multi-market agreement)
      // is the primary filter; DSR is the final quality gate on top of it.
      minDsr: 50,
      requireKFold: true,
      requireNoise: true,
      // See the prop pooled note. Private tolerates deeper pooled drawdowns but
      // demands slightly better pooled economics (PF) for taking them.
      pooled: {
        minSharpe: 0.30,
        minProfitFactor: 1.10,
        maxDrawdownPct: 30,
        minTrades: 300,
        minTradesPerYear: 8,
      },
    },
    promotion: {
      minDsr: 50,
      cap: 10, // entries, not rules
      minDsrOnRevalidate: 40,
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
    // …and enough trades PER YEAR: an absolute count can be reached by a handful of
    // lucky trades spread across a decade, so a rate floor makes the edge earn it.
    // The reason names "trades/yr" so the improve loop knows to raise trade frequency.
    if (v.minTradesPerYear && m.spanYears > 0.5) {
      const perYear = m.tradesPerYear ?? m.tradeCount / m.spanYears;
      if (perYear < v.minTradesPerYear) {
        return { pass: false, reason: `only ${perYear.toFixed(1)} trades/yr on ${s.name} over ${m.spanYears.toFixed(1)}y (need ≥${v.minTradesPerYear}/yr — too few to rule out luck)` };
      }
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

  // Pooled sample floor — statistical confidence comes from the TOTAL trade
  // count across venues (institutional standard: 200–500), not from any single
  // market clearing its per-market floor. Only judged when perSet actually
  // spans several markets: the per-market callers (research pass 2, the
  // revalidator) pass one set at a time and must not trip a pooled bar.
  if (v.minPooledTrades && perSet.length > 1) {
    const pooled = perSet.reduce((s, x) => s + (x.m?.tradeCount || 0), 0);
    if (pooled < v.minPooledTrades) {
      return { pass: false, reason: `only ${pooled} trades pooled across ${perSet.length} markets (need ≥${v.minPooledTrades} total — raise the trade frequency or make it work on more markets)` };
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

/**
 * Tier-1 judgement: grade the POOLED portfolio object of one rule (its daily
 * returns pooled across every tested market) against a profile's pooled bars.
 * First failure names one concrete cause, like judgeMetrics.
 *
 * @param {object} p
 * @param {ProfileId} p.profileId
 * @param {{sharpe:number, pf:number, ddPct:number, trades:number,
 *          tradesPerYear:number, obsDays:number}} p.pooled
 * @param {number} [p.dsrPct]
 * @param {{minSharpe?:number}} [p.overrides] — the revalidator passes its
 *        slightly softer floor here (same WHY as minDsrOnRevalidate).
 */
export function judgePooled({ profileId, pooled, dsrPct, overrides = {} }) {
  const v = getProfile(profileId).validation;
  const b = v.pooled || {};
  const minSharpe = overrides.minSharpe ?? +(process.env.LAB_MIN_POOLED_SHARPE || b.minSharpe || 0.30);
  if (pooled.obsDays < 200) {
    return { pass: false, reason: `only ${pooled.obsDays} pooled daily observations (need ≥200)` };
  }
  if (pooled.sharpe < minSharpe) {
    return { pass: false, reason: `pooled Sharpe ${pooled.sharpe.toFixed(2)} < ${minSharpe} across the universe` };
  }
  if (pooled.trades < (b.minTrades ?? 300)) {
    return { pass: false, reason: `only ${pooled.trades} trades pooled across all markets (need ≥${b.minTrades ?? 300})` };
  }
  if (b.minTradesPerYear && pooled.tradesPerYear < b.minTradesPerYear) {
    return { pass: false, reason: `only ${pooled.tradesPerYear.toFixed(1)} pooled trades/yr (need ≥${b.minTradesPerYear}/yr)` };
  }
  if (pooled.pf < (b.minProfitFactor ?? 1.08)) {
    return { pass: false, reason: `pooled PF ${pooled.pf.toFixed(2)} < ${b.minProfitFactor} after costs` };
  }
  if (pooled.ddPct > (b.maxDrawdownPct ?? 30)) {
    return { pass: false, reason: `pooled drawdown ${pooled.ddPct.toFixed(0)}% > ${b.maxDrawdownPct}%` };
  }
  if (dsrPct != null && dsrPct < v.minDsr) {
    return { pass: false, reason: `DSR ${dsrPct.toFixed(1)}% < ${v.minDsr}% (pooled)` };
  }
  return { pass: true };
}

/** judgePooled against both profiles in one pass. */
export function qualifyPooledAll({ pooled, dsrPct }) {
  const qualified = [];
  const reasons = {};
  for (const id of PROFILE_IDS) {
    const r = judgePooled({ profileId: id, pooled, dsrPct });
    if (r.pass) qualified.push(id);
    else reasons[id] = r.reason;
  }
  return { qualified, reasons };
}
