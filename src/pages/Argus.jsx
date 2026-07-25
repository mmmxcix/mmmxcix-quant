import { useEffect, useState } from "react";
import { Radio, TrendingUp, TrendingDown, Trophy, AlertTriangle } from "lucide-react";
import { cn, fmtNum } from "@/lib/utils";
import { ledgerStats } from "@/lib/argus/core";
import Skeleton from "@/components/Skeleton";

// Argus — the 24/7 day-trading agent (Phase 0: technical channel, paper only).
// Reads the agent's KV state from /api/argus. Educational, not advice.

const money = (n) => (n >= 0 ? "+" : "−") + fmtNum(Math.abs(n), 2);
const ago = (ts) => {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
};

function SideTag({ side }) {
  const long = side === "long";
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold",
      long ? "bg-up/10 text-up" : "bg-down/10 text-down")}>
      {long ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}{side}
    </span>
  );
}

function Stat({ label, value, sub, tone = "text-text" }) {
  return (
    <div className="rounded-xl border border-line lg-glass px-4 py-3">
      <p className="text-[11px] text-dim mb-1">{label}</p>
      <p className={cn("font-mono font-semibold text-lg", tone)}>{value}</p>
      {sub && <p className="text-xs text-dim mt-0.5">{sub}</p>}
    </div>
  );
}

export default function Argus() {
  const [data, setData] = useState(undefined); // undefined=loading

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/argus?what=all");
        const j = await r.json();
        if (alive) setData(j.ok ? j : { state: null, theses: [], ledger: [] });
      } catch { if (alive) setData({ state: null, theses: [], ledger: [] }); }
    };
    load();
    const id = setInterval(() => { if (!document.hidden) load(); }, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  if (data === undefined) return <Skeleton className="h-64 w-full rounded-xl" />;

  const { state, theses = [], ledger = [] } = data;
  const stats = ledgerStats(ledger);
  const live = state && Date.now() - state.at < 6 * 60_000;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">Argus
            <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
              live ? "border-up/40 bg-up/10 text-up" : "border-line bg-bg text-dim")}>
              <Radio className="w-3 h-3" />{live ? "live" : "offline"}
            </span>
          </h1>
          <p className="text-sm text-dim">24/7 day-trading agent · technical channel (Phase 0) · <span className="text-dim">paper only — educational, not advice</span></p>
        </div>
        {state?.halted && (
          <span className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-down/40 bg-down/10 text-down px-2 py-1 text-xs font-semibold">
            <AlertTriangle className="w-3.5 h-3.5" /> daily-loss halt
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <Stat label="Paper equity" value={state ? fmtNum(state.equity, 0) : "–"} big />
        <Stat label="Open theses" value={theses.length} sub={state ? `${(state.forming ?? 0)} forming` : ""} />
        <Stat label="Portfolio heat" value={state ? `${(state.heatPct * 100).toFixed(1)}%` : "–"} sub="of 6% cap"
          tone={state && state.heatPct > 0.05 ? "text-down" : "text-text"} />
        <Stat label="Today's P/L" value={state ? money(state.dayPnl || 0) : "–"} tone={state && state.dayPnl < 0 ? "text-down" : "text-up"} />
        <Stat label="Track record" value={stats.n ? `${(stats.winRate * 100).toFixed(0)}% · ${stats.avgR >= 0 ? "+" : ""}${stats.avgR.toFixed(2)}R` : "–"}
          sub={stats.n ? `${stats.n} closed · ${money(stats.pnl)}` : "no closed trades yet"}
          tone={stats.expectancy > 0 ? "text-up" : stats.expectancy < 0 ? "text-down" : "text-text"} />
      </div>

      {/* open theses as trade cards */}
      <div>
        <p className="text-xs text-dim font-medium mb-2">Open theses</p>
        {theses.length === 0 ? (
          <div className="rounded-xl border border-line lg-glass p-8 text-center text-sm text-dim">
            {live ? "No open theses right now — Argus is scanning." : "Argus agent is offline. Start scripts/argus-agent.mjs to begin paper trading."}
          </div>
        ) : (
          <div className="grid md:grid-cols-2 gap-3">
            {theses.map((t) => (
              <div key={t.id} className="rounded-xl border border-line lg-glass p-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className="font-mono font-semibold">{t.symbol}</span>
                  <SideTag side={t.side} />
                  <span className="text-[11px] text-dim">{t.kind} · {t.timeframe}</span>
                  <span className="ml-auto text-[11px] text-dim">{ago(t.openedAt)} ago</span>
                </div>
                <div className="grid grid-cols-4 gap-x-3 gap-y-1 font-mono text-xs">
                  <span className="text-dim">Entry</span><span className="text-dim">Stop</span><span className="text-dim">Target</span><span className="text-dim">Plan</span>
                  <span>{fmtNum(t.entry, 4)}</span>
                  <span className="text-down">{fmtNum(t.stop, 4)}</span>
                  <span className="text-up">{fmtNum(t.target, 4)}</span>
                  <span>{t.plannedR?.toFixed(1)}R</span>
                </div>
                <p className="text-[11px] text-dim mt-2 leading-snug">{t.reason} · risk {fmtNum(t.riskAmt, 0)}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ledger */}
      {ledger.length > 0 && (
        <div className="rounded-xl border border-line lg-glass p-4">
          <p className="text-sm font-semibold mb-3 flex items-center gap-2"><Trophy className="w-4 h-4 text-accent" /> Closed theses ({stats.n})</p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-dim text-[10px] uppercase tracking-wide">
                  <th className="text-left font-medium pb-1">Symbol</th><th className="text-left font-medium">Side</th>
                  <th className="text-left font-medium">Kind</th><th className="text-left font-medium">Outcome</th>
                  <th className="text-right font-medium">R</th><th className="text-right font-medium">P/L</th><th className="text-right font-medium">When</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {ledger.slice(0, 40).map((c) => (
                  <tr key={c.id} className="border-t border-line/40">
                    <td className="py-1.5 font-semibold">{c.symbol}</td>
                    <td className={c.side === "long" ? "text-up" : "text-down"}>{c.side}</td>
                    <td className="text-dim">{c.kind}</td>
                    <td className={cn(c.outcome === "target" ? "text-up" : c.outcome === "stop" ? "text-down" : "text-dim")}>{c.outcome}</td>
                    <td className={cn("text-right", c.R >= 0 ? "text-up" : "text-down")}>{c.R >= 0 ? "+" : ""}{c.R?.toFixed(2)}</td>
                    <td className={cn("text-right", c.pnl >= 0 ? "text-up" : "text-down")}>{money(c.pnl)}</td>
                    <td className="text-right text-dim">{c.exitAt ? ago(c.exitAt) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p className="text-xs text-dim leading-relaxed">
        Argus scans several timeframes for technical setups, sizes each trade under a portfolio-heat
        risk model (max 6% total at risk, ~2% per trade, stop-defined), and paper-trades them. Every
        R-multiple and the win rate are shown honestly. This is Phase 0 — the alt-data/news brain and
        the notify-only live mode come later. Educational tool, not investment advice.
      </p>
    </div>
  );
}
