// progression.js — the auto-progression brain for the strategy library.
//
// Given a strategy's CURRENT stage and a FRESH re-test, decide where it belongs
// next: advance it up the pipeline (factory → validated → paper) when it clears
// the bar, bury it in the graveyard when it's dead, or sideline it to "improve"
// when it has a fixable, time-window flaw (the good-early / good-late / erratic
// shapes windowProfile detects). Cortex runs this over the whole library so the
// stage windows always reflect reality — the "cortex moves them through the
// windows" part of the plan.
//
// Pure and dependency-free: it takes a metrics+windowProfile object and returns a
// decision, so it's fully testable without a backtest or a network.

const PIPELINE = ["factory", "validated", "paper"]; // the forward ladder

function buryReason(m, wp) {
  const bits = [];
  if (wp?.summary) bits.push(wp.summary);
  if (Number.isFinite(m.sharpe)) bits.push(`Sharpe ${m.sharpe.toFixed(2)}`);
  if (Number.isFinite(m.totalReturnPct)) bits.push(`${m.totalReturnPct >= 0 ? "+" : ""}${m.totalReturnPct.toFixed(0)}%`);
  if (Number.isFinite(m.tradeCount)) bits.push(`${m.tradeCount} trades`);
  return `Buried on re-test — ${bits.join(" · ")}`;
}

/**
 * @param {object} entry             the library entry (needs .status)
 * @param {{metrics:object, windowProfile?:object}} retest  a fresh backtest
 * @param {object} [bar]             quality thresholds
 * @returns {{status:string, failureReason:(string|null), reason:string, changed:boolean}}
 */
export function progressEntry(entry, retest, bar = {}) {
  // minTrades 100: sample-size research (Aug 2026) — ~30 is only the CLT
  // floor; below ~100 trades variance dominates and a lucky streak looks like
  // an edge. 100 is what a healthy 8–12 trades/yr strategy produces on the
  // 10y windows the library re-tests on.
  const {
    minSharpe = 0.8, minPF = 1.15, minTrades = 100, minTradesPerYear = 8, bhMargin = 0,
    // Tier-1 pooled bars, used only for ensemble legs (see the branch below).
    pooledMinSharpe = 0.3, pooledMinPF = 1.08, pooledMinTrades = 300,
  } = bar;
  const cur = entry?.status || "factory";
  const m = retest?.metrics;
  const wp = retest?.windowProfile || null;
  const keep = (failureReason = entry?.failureReason ?? null, reason = "held") =>
    ({ status: cur, failureReason, reason, changed: false });

  if (!m) return keep(entry?.failureReason ?? null, "no result"); // can't judge → leave it

  // ── Tier-1: an ENSEMBLE LEG is not a standalone strategy ────────────────────
  // A pooled rule is accepted on its WHOLE portfolio; one leg's Sharpe is
  // attribution, not a verdict — and a leg is allowed to lose money while the
  // rule earns (that is what diversification looks like from inside). Judging a
  // leg by the standalone library bar would bury every pooled rule the day it
  // was promoted. So: quality defers to the rule's pooled record (refreshed on
  // fresh data by the revalidate agent, which retires rules that truly decayed),
  // and this pass only reacts to LEG-LOCAL facts — a leg that stopped trading.
  const pooled = entry?.pooled;
  if (entry?.ensembleRule && pooled && Number.isFinite(pooled.sharpe)) {
    if (m.tradeCount < Math.max(5, Math.floor(minTrades / 10))) {
      return {
        status: "improve",
        failureReason: `ensemble leg went quiet — only ${m.tradeCount} trades on re-test; the rule's pooled record stands (Sharpe ${pooled.sharpe})`,
        reason: "leg-quiet", changed: cur !== "improve",
      };
    }
    if (pooled.sharpe < 0 || (Number.isFinite(pooled.pf) && pooled.pf < 1)) {
      return {
        status: "graveyard",
        failureReason: `pooled record failed: Sharpe ${pooled.sharpe}, PF ${pooled.pf ?? "?"} across ${pooled.trades ?? "?"} trades`,
        reason: "pooled failed", changed: cur !== "graveyard",
      };
    }
    const pooledClears =
      pooled.sharpe >= pooledMinSharpe &&
      (!Number.isFinite(pooled.pf) || pooled.pf >= pooledMinPF) &&
      (!Number.isFinite(pooled.trades) || pooled.trades >= pooledMinTrades);
    if (pooledClears) {
      if (cur === "improve") return { status: "factory", failureReason: null, reason: "recovered (pooled)", changed: true };
      const i = PIPELINE.indexOf(cur);
      if (i >= 0 && i < PIPELINE.length - 1) {
        return { status: PIPELINE[i + 1], failureReason: null, reason: "pooled rule clears", changed: true };
      }
      return keep(null, "top of pipeline (pooled)");
    }
    return keep(
      `pooled Sharpe ${pooled.sharpe} below the ${pooledMinSharpe} floor — improve the RULE, not this leg`,
      "pooled below bar"
    );
  }

  // 1) DEAD — degenerate trade count, lost money, or negative risk-adjusted return.
  //    Goes to the graveyard (out of the library) with a recorded reason.
  //    (Burial threshold is deliberately far below the ADVANCEMENT floor: a
  //    profitable 40-trade strategy is sidelined to improve, not executed.)
  const degenerate = m.tradeCount < Math.max(10, Math.floor(minTrades / 5));
  const lost = !(m.totalReturnPct > 0);
  const negSharpe = Number.isFinite(m.sharpe) && m.sharpe < 0;
  if (degenerate || lost || negSharpe) {
    return { status: "graveyard", failureReason: buryReason(m, wp), reason: "failed re-test", changed: cur !== "graveyard" };
  }

  // 2) TIME-WINDOW FLAW — profitable overall but not stable across time. Sideline
  //    to "improve" and keep the shape, so Cortex can later pair a good-early with
  //    a good-late one (areComplementary). Don't demote something already in paper
  //    for a mild flaw — only from the earlier stages.
  if (wp && (wp.profile === "good-early" || wp.profile === "good-late" || wp.profile === "erratic") && cur !== "paper") {
    return { status: "improve", failureReason: wp.summary, reason: `window:${wp.profile}`, changed: cur !== "improve" };
  }

  // 2b) TOO FEW TRADES PER YEAR — profitable, but too infrequent to trust (a handful
  //     of trades across years could be luck). Instead of clearing OR burying it,
  //     sideline to "improve" with a trades-focused reason, so Cortex specifically
  //     tries to RAISE the trade frequency next round rather than lose the idea.
  const tpy = m.spanYears > 0.5 ? (m.tradesPerYear ?? m.tradeCount / m.spanYears) : Infinity;
  if (tpy < minTradesPerYear && m.totalReturnPct > 0 && cur !== "paper") {
    return {
      status: "improve",
      failureReason: `only ${tpy.toFixed(1)} trades/yr (need ≥${minTradesPerYear}/yr) — raise the trade frequency: looser entry, shorter holds, or more instruments/sessions`,
      reason: "too-few-trades/yr", changed: cur !== "improve",
    };
  }

  // 3) CLEARS THE BAR — real, consistent edge. Advance one rung (or rescue an
  //    "improve" strategy back into the pipeline). Note: reaching "paper" is a
  //    STATUS only; handing it to the live agent stays a manual "Publish" click.
  //
  //    SHARPE IS TIERED BY SAMPLE SIZE (t-stat ≈ SR·√n): a thin sample can only
  //    convince with a strong signal. ≥300 trades → the base bar; 150–299 →
  //    at least 1.0; under 150 → at least 1.2.
  const sharpeBar = m.tradeCount >= 300 ? minSharpe
    : m.tradeCount >= 150 ? Math.max(minSharpe, 1.0)
    : Math.max(minSharpe, 1.2);
  const clears =
    m.tradeCount >= minTrades &&
    Number.isFinite(m.sharpe) && m.sharpe >= sharpeBar &&
    (!Number.isFinite(m.profitFactor) || m.profitFactor >= minPF) &&
    (m.buyHoldSharpe == null || !Number.isFinite(m.buyHoldSharpe) || m.sharpe >= m.buyHoldSharpe + bhMargin);

  if (clears) {
    if (cur === "improve") return { status: "factory", failureReason: null, reason: "recovered", changed: true };
    const i = PIPELINE.indexOf(cur);
    if (i >= 0 && i < PIPELINE.length - 1) {
      return { status: PIPELINE[i + 1], failureReason: null, reason: "cleared the bar", changed: true };
    }
    return keep(null, "top of pipeline"); // already paper & consistent → stay, clear any old flaw text
  }

  // 4) Profitable but below the bar — hold where it is.
  return keep(entry?.failureReason ?? null, "below the bar");
}
