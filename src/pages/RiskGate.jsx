import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ShieldCheck, ShieldAlert, RefreshCw, Ban, Radar } from "lucide-react";
import { RULE_META, DEFAULT_RULES } from "@/lib/riskGate";
import { cn } from "@/lib/utils";

// RiskGate — the guard every paper entry passes through. Fails closed: a
// blocked rule flattens the strategy instead of entering. Same class of rules a
// prop firm enforces (daily loss limit, position caps, trading window, drawdown
// ceiling, blackout calendar). Data comes from the paper agent via /api/lab.

const TOKEN_KEY = "quant_dev_token";

function ruleValue(key, rules) {
  const v = rules?.[key] ?? DEFAULT_RULES[key];
  if (key === "tradingWindowUtc") return v ? `${v.start}:00–${v.end}:00 UTC` : "—";
  if (key === "blackout") return `${(v || []).length} window(s)`;
  const unit = RULE_META[key]?.unit || "";
  return `${v}${unit}`;
}

export default function RiskGate() {
  const [data, setData] = useState(undefined); // undefined=loading, null=none
  const [busy, setBusy] = useState(false);
  const token = (() => { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; } })();

  const load = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/lab", { headers: { "x-lab-token": token } });
      const out = await res.json();
      setData(res.ok ? (out.state?.riskgate ?? null) : null);
    } catch { setData(null); } finally { setBusy(false); }
  };
  useEffect(() => { if (token) load(); else setData(null); /* eslint-disable-next-line */ }, []);

  const armed = !!data?.armed;

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <h1 className="text-2xl font-bold">RiskGate</h1>
        {data !== undefined && data !== null && (
          <span className={cn(
            "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
            armed ? "border-up/40 bg-up/10 text-up" : "border-line bg-bg text-dim"
          )}>
            {armed ? <ShieldCheck className="w-3 h-3" /> : <ShieldAlert className="w-3 h-3" />}
            {armed ? "armed · fails closed" : "idle"}
          </span>
        )}
        <button onClick={load} disabled={busy || !token}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-xs text-dim hover:text-text disabled:opacity-50">
          <RefreshCw className={cn("w-3.5 h-3.5", busy && "animate-spin")} /> Refresh
        </button>
      </div>

      {!token && (
        <div className="rounded-xl border border-line lg-glass p-5 text-sm text-dim">
          RiskGate is private. Set the dev token on the <Link to="/coach" className="text-accent underline">Coach</Link> page to view it.
        </div>
      )}

      {token && data === null && (
        <div className="rounded-xl border border-line lg-glass p-5 text-sm text-dim">
          No RiskGate data yet — the paper agent hasn't reported. Once <code className="text-text">lab-agent.mjs</code> runs, every entry is gated and the verdicts land here.
        </div>
      )}

      {token && data && (
        <div className="space-y-6">
          {/* Gate radar — live pass/block per rule */}
          <section className="rounded-xl border border-line lg-glass p-5">
            <div className="flex items-center gap-2 mb-3">
              <Radar className="w-4 h-4 text-accent" />
              <h2 className="font-semibold">Gate radar — live verdicts</h2>
              <span className="text-[10px] text-dim ml-auto">
                checked {data.checkedAt ? `${Math.round((Date.now() - data.checkedAt) / 60000)} min ago` : "—"}
              </span>
            </div>
            <div className="grid sm:grid-cols-2 gap-2">
              {(data.verdicts || []).map((v) => (
                <div key={v.rule} className={cn(
                  "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm",
                  v.status === "pass" ? "border-up/20 bg-up/5" : "border-down/30 bg-down/5"
                )}>
                  <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", v.status === "pass" ? "bg-up" : "bg-down")} />
                  <span className="font-medium">{RULE_META[v.rule]?.label || v.rule}</span>
                  <span className="text-dim ml-auto text-xs font-mono">{v.detail}</span>
                </div>
              ))}
            </div>
          </section>

          {/* Active limits snapshot */}
          <section className="rounded-xl border border-line lg-glass p-5">
            <h2 className="font-semibold mb-3">Active limits</h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
              <Metric label="Open positions" value={`${data.activeLimits?.openPositions ?? 0} / ${data.rules?.maxSimultaneousPositions ?? "—"}`} />
              <Metric label="Combined drawdown" value={`${data.activeLimits?.combinedDrawdownPct ?? 0}% / ${data.rules?.maxCombinedDrawdownPct ?? "—"}%`} />
              <Metric label="Loss today" value={`${data.activeLimits?.dayLossPct ?? 0}% / ${data.rules?.dailyLossLimitPct ?? "—"}%`} />
              <Metric label="Trades today" value={`${data.activeLimits?.tradesToday ?? 0} / ${data.rules?.maxTradesPerDay ?? "—"}`} />
              <Metric label="Hour (UTC)" value={`${data.activeLimits?.hourUtc ?? "—"}:00`} />
            </div>
          </section>

          {/* Blocked this run */}
          {data.blockedCount > 0 && (
            <section className="rounded-xl border border-down/30 bg-down/5 p-5">
              <div className="flex items-center gap-2 mb-3">
                <Ban className="w-4 h-4 text-down" />
                <h2 className="font-semibold">Blocked this run ({data.blockedCount})</h2>
              </div>
              <ul className="space-y-1 text-sm">
                {data.blocked.map((b, i) => (
                  <li key={i} className="flex items-center gap-2">
                    <span className="font-mono text-dim">{b.name}</span>
                    <span className="text-down text-xs">— {b.reason}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Full rule set */}
          <section className="rounded-xl border border-line lg-glass p-5">
            <h2 className="font-semibold mb-3">Rule set</h2>
            <div className="space-y-2">
              {Object.keys(RULE_META).map((key) => (
                <div key={key} className="flex items-center gap-3 text-sm border-b border-line/50 last:border-0 py-1.5">
                  <span className="font-medium">{RULE_META[key].label}</span>
                  <span className={cn(
                    "text-[9px] uppercase tracking-wide rounded px-1.5 py-0.5",
                    RULE_META[key].live ? "bg-up/10 text-up" : "bg-line text-dim"
                  )}>{RULE_META[key].live ? "live-enforced" : "monitored"}</span>
                  <span className="text-dim ml-auto font-mono">{ruleValue(key, data.rules)}</span>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-dim/70 mt-3 leading-relaxed">
              Live-enforced rules gate every entry in real time and fail closed. Monitored rules
              (correlation) are surfaced as portfolio health and checked at promotion. Edit the
              defaults in <code className="text-text">src/lib/riskGate.js</code>, or override per-PC
              via <code className="text-text">local.riskRules</code> in the agent state file.
            </p>
          </section>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div>
      <p className="text-[10px] text-dim uppercase tracking-wide mb-0.5">{label}</p>
      <p className="font-mono font-semibold">{value}</p>
    </div>
  );
}
