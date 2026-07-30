import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Radio, TrendingUp, TrendingDown, Trophy, AlertTriangle, Zap, Newspaper, GraduationCap, LineChart, X, Ban } from "lucide-react";
import { cn, fmtNum } from "@/lib/utils";
import { ledgerStats } from "@/lib/argus/core";
import { useSession } from "@/lib/authClient";
import Skeleton from "@/components/Skeleton";

// Argus — the 24/7 day-trading agent (Phase 0: technical channel, paper only).
// Reads the agent's KV state from /api/argus. Public: everyone can watch what
// the agent does. Dev-only controls (close/cancel a trade) are gated inline.

const money = (n) => (n >= 0 ? "+" : "−") + fmtNum(Math.abs(n), 2);

// Map an Argus instrument to Charts market + a sane interval, then hand the
// trade over as namespaced params so Charts draws entry/stop/target + reason.
const CRYPTO = /USDT$|USD$|BTC$|ETH$/;
const TF_TO_INTERVAL = { "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1h", "2h": "2h", "4h": "4h", "1d": "1d" };
function chartHref(t, outcome = "open") {
  const market = t.asset === "crypto" || (t.asset == null && CRYPTO.test(t.symbol)) ? "crypto" : "stock";
  const p = new URLSearchParams({ market, symbol: t.symbol, interval: TF_TO_INTERVAL[t.timeframe] || "15m" });
  if (Number.isFinite(t.entry)) p.set("tEntry", String(t.entry));
  if (Number.isFinite(t.stop)) p.set("tStop", String(t.stop));
  if (Number.isFinite(t.target)) p.set("tTarget", String(t.target));
  if (t.side) p.set("tSide", t.side);
  const at = t.openedAt ?? t.exitAt ?? t.at;
  if (at) p.set("tAt", String(Math.round(at / 1000))); // ms → unix seconds
  if (t.reason || t.catalyst) p.set("tReason", (t.reason || t.catalyst).slice(0, 180));
  p.set("tOutcome", outcome);
  return `/charts?${p.toString()}`;
}
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
  const [cmdBusy, setCmdBusy] = useState(null); // id being closed/cancelled
  const { data: session } = useSession();
  const isDev = session?.user?.role === "admin";

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

  // Dev-only: queue a "close now" / "cancel" the agent acts on next cycle.
  // Session-gated server-side (admin cookie), so no token travels from the client.
  const command = async (type, id, label) => {
    if (!isDev || cmdBusy) return;
    if (!window.confirm(`${type === "close" ? "Close" : "Cancel"} ${label}? Argus will act on its next scan.`)) return;
    setCmdBusy(id);
    try {
      const r = await fetch("/api/argus", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: { type, id } }),
      });
      if (!r.ok) throw new Error();
    } catch { /* surfaced by the button staying enabled */ } finally { setCmdBusy(null); }
  };

  if (data === undefined) return <Skeleton className="h-64 w-full rounded-xl" />;

  const { state, theses = [], ledger = [] } = data;
  const stats = ledgerStats(ledger);
  const live = state && Date.now() - state.at < 20 * 60_000; // agent heartbeats each ~15-min full scan

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
          <p className="text-sm text-dim">24/7 day-trading agent · technical + event channel · <span className="text-dim">paper only — educational, not advice</span></p>
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
              <div key={t.id} className="rounded-xl border border-line lg-glass p-4 hover:border-accent/40 transition-colors">
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
                <div className="flex items-center gap-2 mt-3">
                  <Link to={chartHref(t, "open")} className="btn-ghost text-xs flex items-center gap-1.5">
                    <LineChart className="w-3.5 h-3.5" /> View on chart
                  </Link>
                  {isDev && (
                    <button onClick={() => command("close", t.id, `${t.symbol} ${t.side}`)} disabled={cmdBusy === t.id}
                      className="btn-ghost text-xs flex items-center gap-1.5 !text-down hover:!bg-down/10 ml-auto">
                      <X className="w-3.5 h-3.5" /> {cmdBusy === t.id ? "Closing…" : "Close now"}
                    </button>
                  )}
                </div>
                {t.catalyst && (
                  <div className="mt-2 rounded-lg border border-accent/30 bg-accent/5 px-2.5 py-1.5">
                    <p className="text-[10px] uppercase tracking-wide text-accent font-semibold flex items-center gap-1 mb-0.5">
                      <Zap className="w-3 h-3" /> Catalyst{typeof t.confidence === "number" ? ` · ${(t.confidence * 100).toFixed(0)}% conf` : ""}
                    </p>
                    <p className="text-[11px] text-text/90 leading-snug">{t.catalyst}</p>
                    {t.evidence?.length > 0 && (
                      <ul className="mt-1 space-y-0.5">
                        {t.evidence.slice(0, 3).map((e, i) => <li key={i} className="text-[10px] text-dim leading-snug">· {e}</li>)}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* event watch — alt-data biases the LLM channel is tracking, awaiting a technical trigger */}
      {state?.events?.length > 0 && (
        <div>
          <p className="text-xs text-dim font-medium mb-2 flex items-center gap-1.5">
            <Newspaper className="w-3.5 h-3.5" /> Event watch — alt-data biases awaiting a technical trigger
          </p>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {state.events.map((e) => (
              <div key={e.symbol} className="rounded-xl border border-line lg-glass p-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-mono font-semibold text-sm">{e.symbol}</span>
                  <SideTag side={e.side} />
                  {typeof e.confidence === "number" && <span className="text-[10px] text-dim">{(e.confidence * 100).toFixed(0)}%</span>}
                  <span className="ml-auto text-[10px] text-dim">{ago(e.at)} ago</span>
                </div>
                <p className="text-[11px] text-dim leading-snug">{e.thesis}</p>
                <div className="flex items-center gap-2 mt-2">
                  <Link to={chartHref({ symbol: e.symbol, side: e.side, reason: e.thesis, at: e.at }, "planned")}
                    className="text-[10px] text-accent hover:underline flex items-center gap-1"><LineChart className="w-3 h-3" /> chart</Link>
                  {isDev && (
                    <button onClick={() => command("cancel", e.symbol, `${e.symbol} bias`)} disabled={cmdBusy === e.symbol}
                      className="text-[10px] text-down hover:underline flex items-center gap-1 ml-auto"><Ban className="w-3 h-3" /> {cmdBusy === e.symbol ? "…" : "cancel"}</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* what Argus has learned — Hermes-style lessons from the closed ledger */}
      {state?.lessons?.length > 0 && (
        <div>
          <p className="text-xs text-dim font-medium mb-2 flex items-center gap-1.5">
            <GraduationCap className="w-3.5 h-3.5" /> What Argus has learned — from {stats.n} closed trades
          </p>
          <div className="grid sm:grid-cols-2 gap-2">
            {state.lessons.map((l, i) => (
              <div key={i} className={cn("rounded-xl border lg-glass p-3 text-[11px] leading-snug",
                l.verdict === "strong-positive" ? "border-up/30" : l.verdict === "losing" ? "border-down/30" : "border-line")}>
                <span className={cn("font-semibold uppercase tracking-wide text-[9px] mr-1.5",
                  l.verdict === "strong-positive" ? "text-up" : l.verdict === "losing" ? "text-down" : "text-dim")}>
                  {l.verdict === "strong-positive" ? "favor" : l.verdict === "losing" ? "suppress" : "neutral"}
                </span>
                <span className="text-dim">{l.text}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Hermes journal — a post-mortem per closed trade, and the rules that
          repeated often enough to become binding. */}
      {(data.skills?.length > 0 || data.journal?.length > 0) && (
        <div className="grid lg:grid-cols-2 gap-3">
          {data.skills?.length > 0 && (
            <div className="rounded-xl border border-line lg-glass p-4">
              <p className="text-xs text-dim font-medium mb-2 flex items-center gap-1.5">
                <GraduationCap className="w-3.5 h-3.5" /> Rules Argus wrote for itself
              </p>
              <div className="space-y-2">
                {data.skills.slice(0, 6).map((s, i) => (
                  <div key={i} className={cn("rounded-lg border p-2.5 text-[11px] leading-snug",
                    s.verdict === "avoid" ? "border-down/30" : "border-up/30")}>
                    <span className={cn("font-semibold uppercase tracking-wide text-[9px] mr-1.5",
                      s.verdict === "avoid" ? "text-down" : "text-up")}>{s.verdict}</span>
                    <span className="text-text/90">{s.lesson}</span>
                    <span className="text-dim"> · learned {s.times}× · {s.avgR >= 0 ? "+" : ""}{s.avgR}R avg</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {data.journal?.length > 0 && (
            <div className="rounded-xl border border-line lg-glass p-4">
              <p className="text-xs text-dim font-medium mb-2 flex items-center gap-1.5">
                <Newspaper className="w-3.5 h-3.5" /> Trade post-mortems
              </p>
              <div className="space-y-2 max-h-72 overflow-y-auto">
                {data.journal.slice(0, 12).map((r, i) => (
                  <div key={i} className="border-b border-line/40 pb-2 last:border-0 text-[11px] leading-snug">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="font-mono font-semibold">{r.symbol}</span>
                      <span className="text-dim">{r.kind} {r.side}</span>
                      <span className={cn("font-mono", (r.R ?? 0) >= 0 ? "text-up" : "text-down")}>
                        {(r.R ?? 0) >= 0 ? "+" : ""}{r.R}R
                      </span>
                      <span className={cn("ml-auto text-[9px] uppercase tracking-wide font-semibold",
                        r.verdict === "bad-process" ? "text-down" : r.verdict === "good-process" ? "text-up" : "text-dim")}>
                        {r.verdict?.replace("-", " ")}
                      </span>
                    </div>
                    <p className="text-dim">{r.cause}</p>
                    {r.mistake && r.mistake !== "none" && <p className="text-down/80">Should have: {r.mistake}</p>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

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
                  <tr key={c.id} className="border-t border-line/40 hover:bg-accent/5">
                    <td className="py-1.5 font-semibold">
                      <Link to={chartHref(c, c.outcome)} className="hover:text-accent flex items-center gap-1">
                        {c.symbol} <LineChart className="w-3 h-3 text-dim" />
                      </Link>
                    </td>
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
        risk model (max 6% total at risk, ~2% per trade, stop-defined), and paper-trades them. An
        event channel reads the live alt-data briefing — news, conflicts, disasters and shipping
        chokepoints — and proposes directional biases; a trade only opens when price confirms the
        catalyst, never on the spike itself. Every R-multiple and the win rate are shown honestly.
        Notify-only live mode comes later. Educational tool, not investment advice.
      </p>
    </div>
  );
}
