import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Radio, TrendingUp, TrendingDown, Trophy, AlertTriangle, Zap, Newspaper, GraduationCap, LineChart, X, Ban, RotateCcw, History } from "lucide-react";
import { cn, fmtNum } from "@/lib/utils";
import { GLOSSARY } from "@/lib/glossary";
import { ledgerStats, tradeR } from "@/lib/argus/core";
import { useSession } from "@/lib/authClient";
import Skeleton from "@/components/Skeleton";

// Argus — the 24/7 day-trading agent (Phase 0: technical channel, paper only).
// Reads the agent's KV state from /api/argus. Public: everyone can watch what
// the agent does. Dev-only controls (close/cancel a trade) are gated inline.

import { chartHref as href } from "@/lib/chartLink";

const money = (n) => (n >= 0 ? "+" : "−") + fmtNum(Math.abs(n), 2);

// Argus trades carry MILLISECOND timestamps; chartHref takes `atMs` and does the
// conversion in one place (see lib/chartLink.js for why that matters).
function chartHref(t, outcome = "open") {
  return href({
    symbol: t.symbol, asset: t.asset, timeframe: t.timeframe,
    entry: t.entry, stop: t.stop, target: t.target, side: t.side,
    atMs: t.openedAt ?? t.exitAt ?? t.at,
    reason: t.reason || t.catalyst,
  }, outcome);
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
    let reason = "";
    if (type === "close") {
      // Ask WHY you're closing early — Argus feeds this into its post-mortem so it
      // learns from your judgement, not just the number. Cancel the prompt to abort.
      const r = window.prompt(`Close ${label} early — why? (Argus learns from this; leave blank if it's just a manual close)`, "");
      if (r === null) return; // prompt cancelled
      reason = r.slice(0, 200);
    } else if (!window.confirm(`Cancel ${label}? Argus will act on its next scan.`)) {
      return;
    }
    setCmdBusy(id);
    try {
      const r = await fetch("/api/argus", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: { type, id, reason } }),
      });
      if (!r.ok) throw new Error();
    } catch { /* surfaced by the button staying enabled */ } finally { setCmdBusy(null); }
  };

  // Dev-only: reset the paper book to $10k. Queues a "reset" command the running
  // agent drains (within ~15s) — clears the book + track record but keeps the
  // learned skills. Session-gated server-side.
  const resetArgus = async () => {
    if (!isDev || cmdBusy) return;
    if (!window.confirm("Reset Argus to $10,000?\n\nThis clears the paper book and the closed track record. Argus KEEPS its learned skills. The running agent applies it within ~15 seconds.")) return;
    setCmdBusy("reset");
    try {
      const r = await fetch("/api/argus", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: { type: "reset" } }),
      });
      if (!r.ok) throw new Error();
    } catch { /* stays enabled */ } finally { setCmdBusy(null); }
  };

  if (data === undefined) return <Skeleton className="h-64 w-full rounded-xl" />;

  const { state, theses = [], ledger = [] } = data;
  const stats = ledgerStats(ledger);
  const live = state && Date.now() - state.at < 20 * 60_000; // agent heartbeats each ~15-min full scan
  // When the daily-loss limit trips, Argus stops opening trades — surface that as a
  // distinct COOLDOWN state, not "scanning" (it isn't).
  const paused = !!(live && state?.halted);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">Argus
            <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
              !live ? "border-line bg-bg text-dim" : paused ? "border-warn/40 bg-warn/10 text-warn" : "border-up/40 bg-up/10 text-up")}>
              <Radio className="w-3 h-3" />{!live ? "offline" : paused ? "cooldown" : "live"}
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

      {/* Learning banner — make it unmistakable that Argus is paper-only, not
          advice, and only goes public once its record shows a REAL edge. Govind
          (tradingbot.gobiautomates.com) rightly warns that win rate alone can
          hide losses, so the readiness gate is positive R-EXPECTANCY over a real
          sample, with win rate shown but not the gate. */}
      {(() => {
        // Readiness is gated on GROWING THE PAPER ACCOUNT, not a trade count.
        // Argus never stops on its own — it keeps learning until it has doubled
        // the book to $20k with a real positive edge, and you choose to graduate it.
        const START_EQ = 10000, GRADUATE_EQ = 20000;
        const eq = state?.markEquity ?? state?.equity ?? START_EQ;
        const eligible = eq >= GRADUATE_EQ && stats.expectancy > 0 && stats.n >= 30;
        const pct = Math.max(0, Math.min(100, Math.round(((eq - START_EQ) / (GRADUATE_EQ - START_EQ)) * 100)));
        return (
          <div className="rounded-xl border border-accent/30 bg-accent/5 p-4">
            <div className="flex items-center gap-2 mb-1">
              <Radio className="w-4 h-4 text-accent" />
              <p className="text-sm font-semibold">Watch Argus learn — live on paper</p>
            </div>
            <p className="text-[13px] text-dim leading-relaxed">
              Argus is an educational agent learning to day-trade with <span className="text-text">virtual money</span>.
              {" "}<span className="text-text">This is not financial advice.</span> It keeps trading and learning on paper —
              it won't be considered ready to go public until it has <span className="text-text">grown the paper account to $20k</span>
              {" "}with a real, positive edge (not merely a high win rate), and you decide to graduate it. It never stops on its own.
            </p>
            <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] font-mono">
              <div className="flex items-center gap-2">
                <div className="w-28 h-1.5 rounded-full bg-line overflow-hidden">
                  <div className={cn("h-full", eq >= START_EQ ? "bg-accent" : "bg-down")} style={{ width: `${eq >= START_EQ ? pct : 100}%` }} />
                </div>
                <span className="text-dim">{money(eq)} <span className="text-dim/60">/ $20k</span></span>
              </div>
              <span className="text-dim">expectancy <span className={stats.expectancy > 0 ? "text-up" : "text-down"}>{stats.expectancy >= 0 ? "+" : ""}{stats.expectancy.toFixed(2)}R</span></span>
              <span className="text-dim">{stats.n} trades · win {(stats.winRate * 100).toFixed(0)}%</span>
              <span className={cn("ml-auto inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 uppercase tracking-wide text-[10px] font-semibold",
                eligible ? "border-up/40 bg-up/10 text-up" : "border-line bg-bg text-dim")}>
                {eligible ? "✓ ready to graduate — your call" : "learning…"}
              </span>
            </div>
            {isDev && (
              <div className="mt-3 pt-3 border-t border-line/60 flex items-center justify-between gap-2">
                <span className="text-[10px] text-dim">Dev · resets the paper book to $10k (keeps learned skills)</span>
                <button onClick={resetArgus} disabled={cmdBusy === "reset"}
                  className="inline-flex items-center gap-1.5 text-[11px] text-dim hover:text-down transition-colors disabled:opacity-50">
                  <RotateCcw className="w-3 h-3" /> {cmdBusy === "reset" ? "Resetting…" : "Reset to $10k"}
                </button>
              </div>
            )}
          </div>
        );
      })()}

      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
        <Stat label="Paper equity" value={state ? fmtNum(state.markEquity ?? state.equity, 0) : "–"} big
          sub={state && state.unrealized ? `${money(state.equity)} + ${money(state.unrealized)} floating` : "mark-to-market"} />
        <Stat label="Open theses" value={theses.length} sub={state ? `${(state.forming ?? 0)} forming` : ""} />
        <Stat label="Portfolio heat" value={state ? `${(state.heatPct * 100).toFixed(1)}%` : "–"}
          sub={state && state.heatCapPct ? `of ${(state.heatCapPct * 100).toFixed(0)}% cap` : "of 10–20% cap"}
          tone={state && state.heatCapPct && state.heatPct > state.heatCapPct * 0.85 ? "text-down" : "text-text"} />
        <Stat label="Portfolio leverage" value={state && state.portfolioLev != null ? `${state.portfolioLev.toFixed(2)}×` : "–"}
          sub={state && state.portfolioLevCap ? `of ${state.portfolioLevCap}× cap · margin ${state.marginPct != null ? (state.marginPct * 100).toFixed(0) : "–"}%` : "gross exposure"}
          tone={state && state.portfolioLevCap && state.portfolioLev > state.portfolioLevCap * 0.85 ? "text-down" : "text-text"} />
        <Stat label="Today's P/L" value={state ? money(state.dayPnlTotal ?? state.dayPnl ?? 0) : "–"}
          sub={state && state.unrealized ? `${money(state.dayPnl || 0)} real · ${money(state.unrealized)} float` : "realized + floating"}
          tone={state && (state.dayPnlTotal ?? state.dayPnl) < 0 ? "text-down" : "text-up"} />
        {/* How much of its own candidate flow the learning loop is refusing. The
            anti-freeze guard is per-bucket, so a dozen separately-reasonable skips
            can add up to "trade nothing" without any one of them tripping it. A
            high number here means the entries have no edge to allocate — which is
            not something learning can fix. */}
        <Stat label="Pace" value={state?.pace ? `${state.pace.open}/${state.pace.maxConcurrent} open` : "–"}
          sub={state?.pace
            ? `${state.pace.openedToday}/${state.pace.maxPerDay} today${state?.probes ? ` · ${state.probes.used}/${state.probes.budget} probes` : ""}`
            : "concurrency + daily budget"}
          tone={state?.pace?.blocked ? "text-warn" : "text-text"} />
        <Stat label="Learning gate" value={state?.learnConsidered ? `${(state.learnRefusedPct ?? 0).toFixed(0)}% refused` : "–"}
          sub={state?.learnConsidered ? `of ${state.learnConsidered} setups considered` : "no setups considered yet"}
          tone={(state?.learnRefusedPct ?? 0) > 60 ? "text-down" : (state?.learnRefusedPct ?? 0) > 35 ? "text-warn" : "text-text"} />
        <Stat label="Track record" value={stats.n ? `${(stats.winRate * 100).toFixed(0)}% · ${stats.avgR >= 0 ? "+" : ""}${stats.avgR.toFixed(2)}R avg` : "–"}
          sub={stats.n ? `${stats.n} closed · ${money(stats.pnl)} · ${stats.sumR >= 0 ? "+" : ""}${stats.sumR.toFixed(2)}R total` : "no closed trades yet"}
          tone={stats.expectancy > 0 ? "text-up" : stats.expectancy < 0 ? "text-down" : "text-text"} />
      </div>

      {/* open theses as trade cards */}
      <div>
        <p className="text-xs text-dim font-medium mb-2">Open theses</p>
        {theses.length === 0 ? (
          <div className="rounded-xl border border-line lg-glass p-8 text-center text-sm text-dim">
            {!live
              ? "Argus agent is offline. Start scripts/argus-agent.mjs to begin paper trading."
              : paused
                ? "Paused — daily-loss limit reached. Argus is in cooldown and won't open new trades until the session resets."
                : "No open theses right now — Argus is scanning."}
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
                {(() => {
                  // R from the CURRENT levels (side-aware) so it always matches
                  // entry/stop/target even after a trailing/event adjustment (Bug 3).
                  const risk = t.side === "long" ? t.entry - t.stop : t.stop - t.entry;
                  const reward = t.side === "long" ? t.target - t.entry : t.entry - t.target;
                  const rr = risk > 0 ? reward / risk : null;
                  return (
                    <div className="grid grid-cols-4 gap-x-3 gap-y-1 font-mono text-xs">
                      <span className="text-dim">Entry</span><span className="text-dim">Stop</span><span className="text-dim">Target</span><span className="text-dim">Plan</span>
                      <span>{fmtNum(t.entry, 4)}</span>
                      <span className="text-down">{fmtNum(t.stop, 4)}</span>
                      <span className="text-up">{fmtNum(t.target, 4)}</span>
                      <span>{rr != null ? `${rr.toFixed(2)}R` : "–"}</span>
                    </div>
                  );
                })()}
                {/* Structural invalidation — Argus bails early if the setup's level
                    is lost on a close, before the wider hard stop. */}
                {Number.isFinite(t.invalidation) && (
                  <p className="text-[10px] font-mono text-dim/80 mt-1">
                    invalidation <span className="text-warn">{fmtNum(t.invalidation, 4)}</span>
                    <span className="text-dim/80"> · early exit if it closes {t.side === "long" ? "below" : "above"} this</span>
                  </p>
                )}
                {/* Live price + floating (unrealized) P&L — updates every scan (Bug 4). */}
                {Number.isFinite(t.currentPrice) && (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-2 text-[11px] font-mono">
                    <span className="text-dim">now <span className="text-text">{fmtNum(t.currentPrice, 4)}</span></span>
                    <span className={cn("font-semibold", (t.unrealizedPnl || 0) >= 0 ? "text-up" : "text-down")}>
                      {(t.unrealizedPnl || 0) >= 0 ? "+" : ""}{fmtNum(t.unrealizedPnl || 0, 0)}
                      {Number.isFinite(t.unrealizedR) && <span className="text-dim"> ({t.unrealizedR >= 0 ? "+" : ""}{t.unrealizedR.toFixed(2)}R)</span>}
                    </span>
                    <span className="text-dim/70">floating</span>
                  </div>
                )}
                {(() => {
                  // What Argus actually committed: per-trade leverage (notional ÷
                  // margin — NOT notional ÷ total equity), the margin it ties up,
                  // and the cash at risk. Liquidation shown when it's leveraged.
                  const notional = Number.isFinite(t.notional) ? t.notional : (Number.isFinite(t.size) && Number.isFinite(t.entry) ? t.size * t.entry : null);
                  const lev = Number.isFinite(t.leverage) ? t.leverage : (t.margin ? notional / t.margin : null);
                  return (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-2 text-[11px] font-mono">
                      {notional != null && <span className="text-dim">notional <span className="text-text">{fmtNum(notional, 0)}</span></span>}
                      {lev != null && (
                        <span className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold",
                          lev > 3 ? "bg-down/10 text-down" : lev > 1.1 ? "bg-accent/10 text-accent" : "bg-line/40 text-dim")}>
                          {lev.toFixed(lev >= 10 ? 0 : 1)}× lev
                        </span>
                      )}
                      {Number.isFinite(t.margin) && <span className="text-dim">margin <span className="text-text">{fmtNum(t.margin, 0)}</span></span>}
                      <span className="text-dim">risk <span className="text-text">{fmtNum(t.riskAmt, 0)}</span></span>
                      {t.units > 1 && <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold bg-up/10 text-up" title="Pyramided — units scaled into the winner, stop trailed to keep total risk inside the original budget">▲ {t.units} units</span>}
                      {Number.isFinite(t.liqPrice) && <span className="text-dim/70">liq {fmtNum(t.liqPrice, 4)}</span>}
                    </div>
                  );
                })()}
                {/* The risk system's checklist — every gate that had to pass before
                    this trade was allowed (slide 5). All ✓ since it's live. */}
                {t.riskChecks && (
                  <div className="flex flex-wrap items-center gap-1.5 mt-2 text-[10px]">
                    {[["Size", true], ["Exposure", true], ["DD", t.riskChecks.drawdown !== false], ["Vol", t.riskChecks.volatility?.ok !== false], ["MaxLoss", t.riskChecks.maxLoss !== false]].map(([label, ok]) => (
                      <span key={label} title={GLOSSARY[label]} className={cn("inline-flex items-center gap-0.5 rounded px-1 py-0.5 font-medium cursor-help", ok ? "bg-up/10 text-up" : "bg-down/10 text-down")}>
                        {ok ? "✓" : "✕"} {label}
                      </span>
                    ))}
                    {t.riskChecks.volatility?.elevated && <span className="text-warn/80 font-mono">vol {t.riskChecks.volatility.label} · sized down</span>}
                    {t.riskChecks.volume?.rvol != null && <span className="text-dim/80 font-mono">rvol {t.riskChecks.volume.rvol}×</span>}
                    {Number.isFinite(t.riskChecks.heatUsedPct) && <span className="text-dim/80 font-mono">heat {t.riskChecks.heatUsedPct}%/{t.riskChecks.heatCapPct}%</span>}
                  </div>
                )}
                <p className="text-[11px] text-dim mt-1.5 leading-snug">{t.reason}</p>
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

      {/* Crypto Fear & Greed — the sentiment reading Argus's event channel factors in. */}
      {state?.fng && (() => {
        const v = state.fng.value;
        const tone = v <= 25 ? "text-down" : v >= 75 ? "text-up" : v >= 55 ? "text-up/80" : v <= 45 ? "text-down/80" : "text-dim";
        return (
          <div className="flex items-center gap-3 rounded-xl border border-line lg-glass px-4 py-2.5">
            <span className="text-[11px] text-dim uppercase tracking-wide">Crypto Fear &amp; Greed</span>
            <div className="flex-1 h-1.5 rounded-full bg-gradient-to-r from-down via-dim to-up relative">
              <div className="absolute top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full bg-text ring-2 ring-bg" style={{ left: `calc(${v}% - 5px)` }} />
            </div>
            <span className={cn("font-mono text-sm font-semibold", tone)}>{v}</span>
            <span className="text-[11px] text-dim">{state.fng.classification}</span>
          </div>
        );
      })()}

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

      {/* Retrospective review — Argus re-judges every early "invalidated" exit 12h
          and 24h later (replaying the original trade: would it have hit target, or
          the stop?) and eases the invalidation on setups whose cuts kept proving
          premature. This is the answer to "was cutting early actually right?". */}
      {state?.invalReview && (state.invalReview.premature + state.invalReview.justified + state.invalReview.unnecessary + (state.invalReview.pending || 0)) > 0 && (
        <div className="rounded-xl border border-line lg-glass p-4">
          <p className="text-xs text-dim font-medium mb-1 flex items-center gap-1.5">
            <History className="w-3.5 h-3.5" /> Invalidation review — was cutting early right?
          </p>
          <p className="text-[11px] text-dim mb-3 leading-snug max-w-2xl">
            Every early exit is re-checked 12h and 24h later by replaying the original trade — would it have reached target, or the stop first? Setups whose cuts keep proving premature get eased or switched off; setups whose cuts keep proving right cut a touch earlier to recover the risk they save.
          </p>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] mb-3">
            <span className="text-down"><b>{state.invalReview.premature}</b> premature <span className="text-dim">· should have held</span></span>
            <span className="text-up"><b>{state.invalReview.justified}</b> justified <span className="text-dim">· the cut saved the loss</span></span>
            {state.invalReview.unnecessary > 0 && <span className="text-dim"><b>{state.invalReview.unnecessary}</b> no-op</span>}
            {state.invalReview.pending > 0 && <span className="text-dim"><b>{state.invalReview.pending}</b> awaiting review</span>}
          </div>
          {state.invalReview.kinds?.filter((k) => k.premature || k.justified || k.unnecessary).length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {state.invalReview.kinds.filter((k) => k.premature || k.justified || k.unnecessary).map((k, i) => (
                <span key={i} className={cn("rounded-lg border px-2 py-1 text-[10px] leading-none",
                  k.policy === "cut-off" ? "border-down/40 text-down"
                    : k.policy === "cut-later" ? "border-warn/40 text-warn"
                    : (k.policy === "cut-earlier" || k.policy === "cut-sooner") ? "border-up/40 text-up"
                    : "border-line text-dim")}>
                  <span className="font-mono">{k.kind}</span> <span className="text-dim">{k.premature}p·{k.justified}j</span>
                  {k.policy !== "default" && <span className="ml-1 uppercase tracking-wide font-semibold">→ {k.policy}</span>}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Hermes journal — a post-mortem per closed trade, and the rules that
          repeated often enough to become binding. */}
      {(data.skills?.length > 0 || (data.journal?.length > 0 && stats.n > 0)) && (
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
          {/* Post-mortems describe CLOSED trades, so they only ever show when the
              track record has some — this keeps the header count and this list from
              contradicting each other (e.g. after a reset clears the ledger). */}
          {data.journal?.length > 0 && stats.n > 0 && (
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
                {ledger.slice(0, 40).map((c) => {
                  const r = tradeR(c); // same R the header aggregates — never null
                  return (
                  <tr key={c.id} className="border-t border-line/40 hover:bg-accent/5">
                    <td className="py-1.5 font-semibold">
                      <Link to={chartHref(c, c.outcome)} className="hover:text-accent flex items-center gap-1">
                        {c.symbol} <LineChart className="w-3 h-3 text-dim" />
                      </Link>
                    </td>
                    <td className={c.side === "long" ? "text-up" : "text-down"}>{c.side}</td>
                    <td className="text-dim">{c.kind}</td>
                    <td className={cn(c.outcome === "target" ? "text-up" : c.outcome === "stop" || c.outcome === "liquidation" ? "text-down" : c.outcome === "invalidated" ? "text-warn" : "text-dim")}
                      title={c.outcome === "invalidated" ? "Setup thesis broke on a close — cut early, before the hard stop" : undefined}>{c.outcome}</td>
                    <td className={cn("text-right", r >= 0 ? "text-up" : "text-down")}>{r >= 0 ? "+" : ""}{r.toFixed(2)}</td>
                    <td className={cn("text-right", c.pnl >= 0 ? "text-up" : "text-down")}>{money(c.pnl)}</td>
                    <td className="text-right text-dim">{c.exitAt ? ago(c.exitAt) : ""}</td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p className="text-xs text-dim leading-relaxed">
        Argus scans several timeframes for technical setups, sizes each trade under a portfolio-heat
        risk model (10% total at risk, rising toward 20% when the open positions are uncorrelated;
        ~2% per trade, stop-defined), and paper-trades them. An
        event channel reads the live alt-data briefing — news, conflicts, disasters and shipping
        chokepoints — and proposes directional biases; a trade only opens when price confirms the
        catalyst, never on the spike itself. Every R-multiple and the win rate are shown honestly.
        Notify-only live mode comes later. Educational tool, not investment advice.
      </p>
    </div>
  );
}
