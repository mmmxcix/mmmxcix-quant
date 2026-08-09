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
  const { minSharpe = 0.8, minPF = 1.15, minTrades = 30, minTradesPerYear = 8, bhMargin = 0 } = bar;
  const cur = entry?.status || "factory";
  const m = retest?.metrics;
  const wp = retest?.windowProfile || null;
  const keep = (failureReason = entry?.failureReason ?? null, reason = "held") =>
    ({ status: cur, failureReason, reason, changed: false });

  if (!m) return keep(entry?.failureReason ?? null, "no result"); // can't judge → leave it

  // 1) DEAD — degenerate trade count, lost money, or negative risk-adjusted return.
  //    Goes to the graveyard (out of the library) with a recorded reason.
  const degenerate = m.tradeCount < Math.max(10, Math.floor(minTrades / 3));
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
  const clears =
    m.tradeCount >= minTrades &&
    Number.isFinite(m.sharpe) && m.sharpe >= minSharpe &&
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
