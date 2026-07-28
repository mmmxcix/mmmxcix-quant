// argus/notify.js — notify-only live scaffolding (Phase 3 groundwork). Argus NEVER
// places an order; on a real account it only *notifies the human* with a clean
// trade card, and the person decides. `formatTradeAlert` is pure + tested;
// `sendTradeAlert` best-effort emails via Resend when creds exist, else no-ops.
// See docs/DAYTRADER_AGENT.md ("Notify-only live", "There is no order endpoint").

function fmt(n, dp = 4) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function rewardRisk(th) {
  if (Number.isFinite(th?.plannedR)) return th.plannedR;
  const { entry, stop, target } = th || {};
  if ([entry, stop, target].every((x) => Number.isFinite(x)) && entry !== stop) {
    return Math.abs(target - entry) / Math.abs(entry - stop);
  }
  return null;
}

/**
 * Render a thesis into a clean notify-only trade card.
 * @returns {{ subject:string, markdown:string, text:string }}
 */
export function formatTradeAlert(th = {}) {
  const dir = th.side === "long" ? "LONG" : "SHORT";
  const arrow = th.side === "long" ? "▲" : "▼";
  const r = rewardRisk(th);
  const subject = `Argus ${dir} ${th.symbol || "?"}${th.catalyst ? " ⚡" : ""} — ${th.kind || "setup"} @ ${fmt(th.entry)}`;

  const lines = [
    `**Argus paper alert — ${dir} ${th.symbol || "?"}** ${arrow}`,
    ``,
    `- **Setup:** ${th.kind || "—"}${th.timeframe ? ` · ${th.timeframe}` : ""}`,
    `- **Entry:** ${fmt(th.entry)}`,
    `- **Stop:** ${fmt(th.stop)}`,
    `- **Target:** ${fmt(th.target)}`,
    r != null ? `- **Reward:risk:** ${r.toFixed(2)}R` : null,
    Number.isFinite(th.riskAmt) ? `- **Risk budget:** ${fmt(th.riskAmt, 0)} (paper)` : null,
    th.horizon ? `- **Horizon:** ${th.horizon}` : null,
    typeof th.confidence === "number" ? `- **Confidence:** ${(th.confidence * 100).toFixed(0)}%` : null,
    ``,
    `**Reasoning:** ${th.catalyst || th.reason || "technical setup"}`,
  ];
  const evidence = Array.isArray(th.evidence) ? th.evidence.slice(0, 4) : [];
  if (evidence.length) {
    lines.push(``, `**Evidence:**`, ...evidence.map((e) => `- ${e}`));
  }
  lines.push(
    ``,
    `_Educational paper trade. Argus never places orders — you decide whether to act._`,
  );

  const markdown = lines.filter((x) => x != null).join("\n");
  const text = markdown.replace(/\*\*/g, "").replace(/^- /gm, "• ").replace(/^_/gm, "").replace(/_$/gm, "");
  return { subject, markdown, text };
}

/**
 * Best-effort notify via Resend. No-ops (never throws) when creds/recipient are
 * missing. This is a NOTIFICATION only — it places no orders, by design.
 * @returns {Promise<{ok:boolean, skipped?:boolean, reason?:string, status?:number, error?:string}>}
 */
export async function sendTradeAlert(th, opts = {}) {
  const {
    apiKey = (typeof process !== "undefined" ? process.env?.RESEND_API_KEY : undefined),
    to = (typeof process !== "undefined" ? process.env?.ARGUS_ALERT_TO : undefined),
    from = (typeof process !== "undefined" ? process.env?.ARGUS_ALERT_FROM : undefined) || "Argus <argus@mmmxcix.com>",
    fetchImpl = (typeof fetch !== "undefined" ? fetch : undefined),
  } = opts;

  if (!apiKey || !to) return { ok: false, skipped: true, reason: "no RESEND_API_KEY / recipient" };
  if (!fetchImpl) return { ok: false, skipped: true, reason: "no fetch available" };

  const alert = formatTradeAlert(th);
  try {
    const res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        from,
        to: Array.isArray(to) ? to : [to],
        subject: alert.subject,
        text: alert.text,
      }),
    });
    if (!res.ok) return { ok: false, skipped: false, status: res.status };
    return { ok: true };
  } catch (e) {
    return { ok: false, skipped: false, error: String(e?.message || e) };
  }
}
