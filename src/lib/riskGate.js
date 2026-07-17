// riskGate.js — the RiskGate (Cortex — the live risk layer).
//
// Every proposed ENTRY (a strategy going flat → long/short) passes through the
// gate before it is allowed to fill. The gate FAILS CLOSED: if any rule is
// violated, or the rule can't be evaluated with confidence, the entry is
// blocked. Exits (risk-reducing) are always allowed. These are the same class
// of guard-rails a prop firm enforces — daily loss limit, position caps,
// trading window, drawdown ceiling, news/blackout calendar.
//
// Pure module: imported by the Node paper-trader (scripts/lab-agent.mjs) AND
// the React RiskGate page. No DOM, no fetch.

export const DEFAULT_RULES = {
  // Only take new entries during this UTC hour window [start, end). A full
  // 0–24 window means "always on" (sensible for 24/7 crypto); tighten it to a
  // session (e.g. 13–21 for US futures) when trading instruments with hours.
  tradingWindowUtc: { start: 0, end: 24 },
  // Never hold more than this many positions across the whole portfolio.
  maxSimultaneousPositions: 5,
  // Block new entries once the portfolio is this far below its equity peak.
  maxCombinedDrawdownPct: 20,
  // Block new entries for the rest of the UTC day after losing this much today.
  dailyLossLimitPct: 5,
  // Cap on new entries opened per UTC day across the portfolio.
  maxTradesPerDay: 20,
  // Advisory ceiling on how correlated two live strategies may be. Enforced at
  // promotion time and surfaced as a portfolio health metric (see notes below).
  maxPairwiseCorrelation: 0.8,
  // Hard "do not trade" windows: [{ start: ISO, end: ISO, label }]. Use for
  // known high-impact events (FOMC, CPI, NFP) or scheduled maintenance.
  blackout: [],
};

// Human-readable metadata so the UI can render the rule set without hardcoding.
export const RULE_META = {
  tradingWindowUtc: { label: "Trading window (UTC)", live: true },
  maxSimultaneousPositions: { label: "Max open positions", live: true },
  maxCombinedDrawdownPct: { label: "Max combined drawdown", live: true, unit: "%" },
  dailyLossLimitPct: { label: "Daily loss limit", live: true, unit: "%" },
  maxTradesPerDay: { label: "Max trades / day", live: true },
  maxPairwiseCorrelation: { label: "Max pairwise correlation", live: false },
  blackout: { label: "Blackout calendar", live: true },
};

const pass = (rule, detail) => ({ rule, status: "pass", detail });
const block = (rule, detail) => ({ rule, status: "block", detail });

/**
 * Evaluate whether a new ENTRY is allowed right now.
 * @param {object} p
 * @param {object} p.rules      merged rule set (DEFAULT_RULES ∪ overrides)
 * @param {object} p.ctx        live portfolio context:
 *   { now:ms, hourUtc, openPositions, combinedDrawdownPct, dayLossPct, tradesToday }
 * @returns {{ allow:boolean, verdicts:Array<{rule,status,detail}> }}
 */
export function evaluateEntry({ rules = DEFAULT_RULES, ctx }) {
  const r = { ...DEFAULT_RULES, ...rules };
  const v = [];

  // 1. trading window
  const { start, end } = r.tradingWindowUtc || { start: 0, end: 24 };
  const inWindow = start <= end
    ? ctx.hourUtc >= start && ctx.hourUtc < end
    : ctx.hourUtc >= start || ctx.hourUtc < end; // window wrapping midnight
  const full = start <= 0 && end >= 24;
  v.push(full || inWindow
    ? pass("tradingWindowUtc", full ? "always on (24/7)" : `${ctx.hourUtc}:00 UTC in [${start},${end})`)
    : block("tradingWindowUtc", `${ctx.hourUtc}:00 UTC outside [${start},${end})`));

  // 2. max simultaneous positions
  v.push(ctx.openPositions < r.maxSimultaneousPositions
    ? pass("maxSimultaneousPositions", `${ctx.openPositions}/${r.maxSimultaneousPositions} open`)
    : block("maxSimultaneousPositions", `${ctx.openPositions}/${r.maxSimultaneousPositions} — full`));

  // 3. combined drawdown ceiling
  v.push(ctx.combinedDrawdownPct <= r.maxCombinedDrawdownPct
    ? pass("maxCombinedDrawdownPct", `dd ${ctx.combinedDrawdownPct.toFixed(1)}% ≤ ${r.maxCombinedDrawdownPct}%`)
    : block("maxCombinedDrawdownPct", `dd ${ctx.combinedDrawdownPct.toFixed(1)}% > ${r.maxCombinedDrawdownPct}%`));

  // 4. daily loss limit
  v.push(ctx.dayLossPct <= r.dailyLossLimitPct
    ? pass("dailyLossLimitPct", `today ${(-ctx.dayLossPct).toFixed(1)}%`)
    : block("dailyLossLimitPct", `today -${ctx.dayLossPct.toFixed(1)}% ≥ -${r.dailyLossLimitPct}% limit`));

  // 5. max trades per day
  v.push(ctx.tradesToday < r.maxTradesPerDay
    ? pass("maxTradesPerDay", `${ctx.tradesToday}/${r.maxTradesPerDay} today`)
    : block("maxTradesPerDay", `${ctx.tradesToday}/${r.maxTradesPerDay} — day cap hit`));

  // 6. blackout calendar
  const bl = (r.blackout || []).find((w) => {
    const s = Date.parse(w.start), e = Date.parse(w.end);
    return Number.isFinite(s) && Number.isFinite(e) && ctx.now >= s && ctx.now <= e;
  });
  v.push(bl
    ? block("blackout", `in blackout${bl.label ? ` (${bl.label})` : ""}`)
    : pass("blackout", "clear"));

  return { allow: v.every((x) => x.status === "pass"), verdicts: v };
}

/** Peak-to-current drawdown (%) of a [{t,v}] equity history. 0 if none. */
export function drawdownPct(history) {
  if (!Array.isArray(history) || history.length === 0) return 0;
  let peak = -Infinity;
  const last = history[history.length - 1].v;
  for (const p of history) if (p.v > peak) peak = p.v;
  if (!(peak > 0)) return 0;
  return Math.max(0, ((peak - last) / peak) * 100);
}

/** Loss (%) today vs the equity at the UTC day's first recorded point. */
export function dayLossPct(history, now = Date.now()) {
  if (!Array.isArray(history) || history.length === 0) return 0;
  const dayStart = Math.floor(now / 86400000) * 86400000;
  const today = history.filter((p) => p.t >= dayStart);
  if (today.length < 2) return 0;
  const open = today[0].v, last = today[today.length - 1].v;
  if (!(open > 0)) return 0;
  return Math.max(0, ((open - last) / open) * 100);
}
