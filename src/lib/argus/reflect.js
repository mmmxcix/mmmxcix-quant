// argus/reflect.js — the Hermes loop for Argus: Observe → Execute → REFLECT →
// CRYSTALLISE → Reuse.
//
// The statistical memory in learn.js answers "which buckets pay?" — but only
// after 20 trades, and it never says WHY. Hermes-style learning is different:
// after EVERY closed trade the agent writes a short post-mortem — what actually
// happened, why it worked or didn't, what it should have done differently — into
// a persistent journal. Recurring lessons are then CRYSTALLISED into reusable
// rules ("skills") that are consulted before the next trade of that kind.
//
// Pure + dependency-free: prompt building, parsing and crystallisation are all
// testable without a network. The LLM call lives in llm.js.

/** Compact, factual account of a closed trade — the input to the post-mortem. */
export function describeTrade(t, ctx = {}) {
  const held = t.exitAt && t.openedAt ? Math.round((t.exitAt - t.openedAt) / 60000) : null;
  const dirWord = t.side === "long" ? "long" : "short";
  const lines = [
    `Instrument: ${t.symbol} (${t.asset || t.market || "?"}), timeframe ${t.timeframe || "?"}`,
    `Setup: ${t.kind || "?"} ${dirWord}${t.bias ? `, higher-timeframe bias ${t.bias}` : ""}`,
    `Reason at entry: ${t.reason || "(none recorded)"}`,
    t.catalyst ? `News catalyst: ${t.catalyst}` : null,
    `Entry ${fmt(t.entry)} · stop ${fmt(t.stop)} · target ${fmt(t.target)} (planned ${num(t.plannedR)}R)`,
    `Outcome: ${t.outcome} at ${fmt(t.exit)} → ${num(t.R)}R (${t.pnl >= 0 ? "+" : ""}${num(t.pnl)} on ${num(t.riskAmt)} risked)`,
    held != null ? `Held ${held} min` : null,
    ctx.marketNote ? `Market context: ${ctx.marketNote}` : null,
  ];
  return lines.filter(Boolean).join("\n");
}

const fmt = (v) => (Number.isFinite(v) ? (Math.abs(v) >= 100 ? v.toFixed(2) : v.toFixed(4)) : "?");
const num = (v) => (Number.isFinite(v) ? v.toFixed(2) : "?");

/** Messages for the per-trade post-mortem. Short, concrete, no hindsight bravado. */
export function buildReflectionMessages(trade, ctx = {}) {
  const system =
    "You are a disciplined day-trading coach reviewing ONE completed paper trade for an autonomous agent. " +
    "You are blunt and specific. You never explain a loss as bad luck without checking the setup first, and you never " +
    "praise a win that was taken for the wrong reason — a profitable trade from a bad process is still a bad trade. " +
    "You know that a single trade is a tiny sample: say when there is no lesson to draw. " +
    'Reply with STRICT JSON ONLY: {"verdict":"good-process"|"bad-process"|"neutral","cause":"...","mistake":"...",' +
    '"lesson":"...","applies":{"kind":"...","symbol":"...","side":"..."},"confidence":0..1}. ' +
    "`cause` = why it actually worked or failed (one sentence). `mistake` = what the agent should have done differently, " +
    'or "none" if the process was right. `lesson` = a REUSABLE rule for future trades, phrased as an instruction ' +
    '("skip mean-reversion shorts while the 1h bias is up"), or "" when this trade teaches nothing. ' +
    "`applies` = which dimensions the lesson is about; omit a field that isn't specific. No prose outside the JSON.";
  const devReason = String(ctx.devCloseReason || "").trim();
  const user =
    `CLOSED TRADE:\n${describeTrade(trade, ctx)}\n\n` +
    (devReason
      // The human closed this trade EARLY and said why. Treat that as the primary
      // signal: extract the reusable rule behind their judgement (e.g. "they cut a
      // range short before a red-folder news event").
      ? `IMPORTANT — the human dev closed this trade EARLY and gave this reason:\n"${devReason}"\n` +
        "Take their reasoning seriously and turn it into a reusable lesson the agent can apply itself next time.\n\n"
      : "") +
    (ctx.recentLessons?.length
      ? `Lessons already learned (do not repeat them; say if this trade CONTRADICTS one):\n- ${ctx.recentLessons.slice(0, 8).join("\n- ")}\n\n`
      : "") +
    "Write the post-mortem now.";
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

/** Parse the model's reply into a journal entry. Returns null when unusable. */
export function parseReflection(text, trade) {
  let t = String(text || "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  let o;
  try { o = JSON.parse(t.slice(a, b + 1)); } catch { return null; }
  if (!o || typeof o !== "object") return null;
  const verdict = ["good-process", "bad-process", "neutral"].includes(o.verdict) ? o.verdict : "neutral";
  return {
    id: trade?.id || null,
    at: Date.now(),
    symbol: trade?.symbol, kind: trade?.kind, side: trade?.side,
    outcome: trade?.outcome, R: Number.isFinite(trade?.R) ? +trade.R.toFixed(2) : null,
    verdict,
    // Preserve that the human closed it early + why, so the journal shows the origin.
    devCloseReason: trade?.devCloseReason ? String(trade.devCloseReason).slice(0, 200) : undefined,
    cause: String(o.cause || "").slice(0, 300),
    mistake: String(o.mistake || "").slice(0, 300),
    lesson: String(o.lesson || "").slice(0, 300),
    applies: {
      kind: o.applies?.kind ? String(o.applies.kind).slice(0, 40) : null,
      symbol: o.applies?.symbol ? String(o.applies.symbol).toUpperCase().slice(0, 12) : null,
      side: o.applies?.side === "long" || o.applies?.side === "short" ? o.applies.side : null,
    },
    confidence: Math.max(0, Math.min(1, Number(o.confidence) || 0)),
  };
}

// ── Crystallise: repeated lessons become reusable rules ─────────────────────
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const keyOf = (r) => `${r.applies?.kind || "*"}|${r.applies?.symbol || "*"}|${r.applies?.side || "*"}`;

/**
 * Turn a journal into SKILLS: rules the agent has now written down more than
 * once for the same situation. This is the "crystallise" step — one bad trade is
 * noise, the same post-mortem three times is a rule worth obeying.
 * @returns {Array<{scope,lesson,times,avgR,confidence,verdict}>} strongest first
 */
export function crystallise(journal, { minTimes = 3, minConfidence = 0.5 } = {}) {
  const groups = new Map();
  for (const r of journal || []) {
    if (!r || !r.lesson || r.confidence < minConfidence) continue;
    const k = `${keyOf(r)}::${norm(r.lesson).slice(0, 60)}`;
    const g = groups.get(k) || { scope: r.applies, lesson: r.lesson, times: 0, sumR: 0, conf: 0, bad: 0 };
    g.times++; g.sumR += r.R || 0; g.conf = Math.max(g.conf, r.confidence);
    if (r.verdict === "bad-process") g.bad++;
    groups.set(k, g);
  }
  return [...groups.values()]
    .filter((g) => g.times >= minTimes)
    .map((g) => ({
      scope: g.scope, lesson: g.lesson, times: g.times,
      avgR: +(g.sumR / g.times).toFixed(2),
      confidence: g.conf,
      verdict: g.bad > g.times / 2 ? "avoid" : "prefer",
    }))
    .sort((a, b) => b.times - a.times || Math.abs(b.avgR) - Math.abs(a.avgR));
}

/** Skills that apply to a proposed setup — what the agent should read before entering. */
export function skillsFor(skills, setup) {
  return (skills || []).filter((s) => {
    const sc = s.scope || {};
    if (sc.kind && sc.kind !== setup.kind) return false;
    if (sc.symbol && sc.symbol !== setup.symbol) return false;
    if (sc.side && sc.side !== setup.side) return false;
    return true;
  });
}
