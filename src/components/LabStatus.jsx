import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Cpu, RefreshCw, Loader2, AlertTriangle } from "lucide-react";
import { fmtPrice, cn } from "@/lib/utils";
import { strategyToCode } from "@/lib/strategyCode";
import CopyButton from "@/components/CopyButton";
import Skeleton from "@/components/Skeleton";

// LabStatus — live status of the local lab agent (the 24/7 process on the user's
// PC that pushes its state to /api/lab): research-loop counters, combined paper
// equity and the per-strategy table. Extracted from the Coach page so it can live
// in the Cortex hub, where the rest of the research system is.

function dayPnl(combined) {
  const hist = combined?.history;
  if (!Array.isArray(hist) || hist.length < 2) return null;
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  let base = null;
  for (const p of hist) {
    if (p.t < midnight) base = p.v; // carry forward the last pre-midnight value
    else break;
  }
  const partial = base == null; // no snapshot before today → measuring from first bar today
  if (partial) base = hist[0].v;
  const cur = combined.equity ?? hist[hist.length - 1].v;
  if (!(base > 0)) return null;
  return { abs: cur - base, pct: ((cur - base) / base) * 100, partial };
}

// Live status of the local lab agent (the 24/7 process on the user's PC that
// pushes its state to /api/lab). Private: reads with the dev token.
function LabStatus() {
  const [data, setData] = useState(undefined); // undefined=loading, null=none
  const [busy, setBusy] = useState(false);
  // id -> published strategy entry (carries code / builder id), so every program
  // the agent runs is copyable. The state summaries don't carry the source, so
  // we pull the published list alongside and match by id.
  const [published, setPublished] = useState({});

  // silent=true for the background poll: refreshes the numbers (incl. today's
  // P/L) without flipping the Refresh button into its spinning state.
  const load = async (silent = false) => {
    if (!silent) setBusy(true);
    try {
      // Auth is the admin session cookie — sent automatically on same-origin.
      const [stateRes, stratRes] = await Promise.all([
        fetch("/api/lab"),
        fetch("/api/lab?what=strategies"),
      ]);
      const stateOut = await stateRes.json();
      setData(stateRes.ok ? stateOut.state : null);
      const stratOut = await stratRes.json().catch(() => ({}));
      const map = {};
      for (const s of stratOut?.strategies?.items || []) if (s && s.id) map[s.id] = s;
      setPublished(map);
    } catch {
      setData(null);
    } finally {
      if (!silent) setBusy(false);
    }
  };
  useEffect(() => {
    load();
    // Live: poll every 60s so the Portfolio HQ (and its today's P/L) stays current.
    const id = setInterval(() => { if (!document.hidden) load(true); }, 60000);
    return () => clearInterval(id);
  }, []);

  const age = data?.receivedAt ? Math.round((Date.now() - data.receivedAt) / 60000) : null;
  const online = age !== null && age < 45; // fresh within ~3 schedule ticks

  return (
    <div className="rounded-xl border border-line lg-glass p-4 mb-6">
      <div className="flex items-center gap-2 mb-2">
        <Cpu className="w-4 h-4 text-accent" />
        <p className="text-sm font-semibold">Lab agent (your PC)</p>
        {data !== undefined && (
          <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
            online ? "border-up/40 bg-up/10 text-up" : "border-line bg-bg text-dim"}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${online ? "bg-up" : "bg-dim/50"}`} />
            {online ? "online" : "offline"}
          </span>
        )}
        <button onClick={load} disabled={busy} className="ml-auto flex items-center gap-1.5 chip chip-idle !text-[11px]">
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />} Refresh
        </button>
      </div>
      {data === undefined ? (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            <Skeleton className="h-3 w-28" /><Skeleton className="h-3 w-20" /><Skeleton className="h-3 w-24" />
          </div>
          <Skeleton className="h-20 w-full rounded-lg" />
        </div>
      ) : data === null ? (
        <p className="text-xs text-dim leading-relaxed">
          No state received yet. Set up the local agent (n8n + Node) using the tutorial in the repo
          (<span className="font-mono">docs/LAB_AGENT_TUTORIAL.md</span>) — once it pushes, its status appears here.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs font-mono">
            <span className="text-dim">last push <span className="text-text">{age === 0 ? "just now" : `${age}m ago`}</span></span>
            <span className="text-dim">mode <span className="text-text">{data.mode || "–"}</span></span>
            <span className="text-dim">strategies <span className="text-text">{data.strategies?.length ?? 0}</span></span>
            {data.prices && Object.entries(data.prices).slice(0, 3).map(([s, p]) => (
              <span key={s} className="text-dim">{s.replace("USDT", "")} <span className="text-text">{fmtPrice(p)}</span></span>
            ))}
            {data.note && <span className="text-dim italic font-sans w-full">“{data.note}”</span>}
          </div>

          {/* Research loop stats (autonomous paper→strategy pipeline) */}
          {data.research && (
            <div className="mt-3 border-t border-line pt-3">
              <p className="text-[10px] text-dim font-medium mb-1.5">Research loop</p>
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs font-mono">
                <span className="text-dim">papers read <span className="text-text">{data.research.papersRead}</span></span>
                <span className="text-dim">strategies tried <span className="text-text">{data.research.attempts}</span></span>
                <span className="text-dim">graveyard <span className="text-down">{data.research.graveyard}</span></span>
                <span className="text-dim">candidates <span className="text-up">{data.research.candidates}</span></span>
                {data.research.autoPromoted > 0 && (
                  <span className="text-dim">auto-promoted <span className="text-accent">{data.research.autoPromoted}</span></span>
                )}
                {/* why attempts > papers: every improve-iteration and every
                    mined anomaly is its own attempt — variants, not re-tests */}
                {data.research.improved > 0 && (
                  <span className="text-dim" title="Improve loop: near-misses iterated with the failure fed back — each try is a NEW variant and counts as one attempt">
                    improved <span className="text-text">{data.research.improved}</span>
                  </span>
                )}
                {data.research.mined > 0 && (
                  <span className="text-dim" title="Data-mining channel: anomalies found in our own market data — each counts as one attempt">
                    mined <span className="text-text">{data.research.mined}</span>
                  </span>
                )}
              </div>
              {/* Per-source yield: a feed that quietly went dead shows up here
                  instead of only in the 3am log. */}
              {data.research.sourceYield && (
                <p className="text-[10px] text-dim/80 mt-1.5">
                  last harvest: {Object.entries(data.research.sourceYield).map(([s, n]) => `${s} ${n}`).join(" · ")}
                  {data.research.fullTextRate != null && (
                    <span className="text-dim"> · full text on {data.research.fullTextRate}%</span>
                  )}
                </p>
              )}
              {data.research.lastGraveyard?.length > 0 && (
                <p className="text-[10px] text-dim/80 mt-1.5 leading-relaxed">
                  latest burials: {data.research.lastGraveyard.map((g) => `"${g.title.slice(0, 40)}…" (${g.reason})`).join(" · ")}
                </p>
              )}
              {data.research.candidates > 0 && (
                <p className="text-[11px] text-up mt-1">
                  → survivors wait in the <Link to="/registry" className="underline">Registry</Link> under “Agent research candidates”.
                </p>
              )}
            </div>
          )}

          {/* Daytime re-validation — the half that promotes without you */}
          {data.revalidate && (
            <div className="mt-3 border-t border-line pt-3">
              <p className="text-[10px] text-dim font-medium mb-1.5">Re-validation (daytime)</p>
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs font-mono">
                <span className="text-dim">checked <span className="text-text">{data.revalidate.checked}</span></span>
                <span className="text-dim">held up <span className="text-up">{data.revalidate.survived}</span></span>
                <span className="text-dim">decayed <span className="text-down">{data.revalidate.decayed}</span></span>
                <span className="text-dim">promoted <span className="text-accent">{data.revalidate.promoted}</span></span>
              </div>
              {data.revalidate.held?.length > 0 && (
                <p className="text-[10px] text-dim/80 mt-1.5">held by RiskGate: {data.revalidate.held.join(" · ")}</p>
              )}
              {data.revalidate.lastDecayed?.length > 0 && (
                <p className="text-[10px] text-dim/80 mt-1.5 leading-relaxed">
                  decayed: {data.revalidate.lastDecayed.map((d) => `"${d.title.slice(0, 36)}…" (${d.reason})`).join(" · ")}
                </p>
              )}
            </div>
          )}

          {/* Portfolio HQ — paper strategies executed by the agent */}
          {data.mode === "paper" && data.strategies?.length > 0 && (
            <div className="mt-3 border-t border-line pt-3">
              {data.combined && (
                <div className="flex flex-wrap items-center gap-x-6 gap-y-1 mb-2 text-sm font-mono">
                  <span className="text-dim text-xs font-medium font-sans">Combined equity</span>
                  <span className="text-text font-semibold">{fmtPrice(data.combined.equity)}</span>
                  <span className={data.combined.returnPct >= 0 ? "text-up" : "text-down"}>
                    {data.combined.returnPct >= 0 ? "+" : ""}{data.combined.returnPct}% <span className="text-dim">all-time</span>
                  </span>
                  {(() => {
                    const d = dayPnl(data.combined);
                    if (!d) return null;
                    const up = d.abs >= 0;
                    return (
                      <span
                        className={up ? "text-up" : "text-down"}
                        title={d.partial ? "Since the first snapshot today (history doesn't reach back to midnight yet)" : "Change since the start of today (your local time)"}
                      >
                        {up ? "+" : "−"}{fmtPrice(Math.abs(d.abs))} ({up ? "+" : ""}{d.pct.toFixed(2)}%) <span className="text-dim">today{d.partial ? "*" : ""}</span>
                      </span>
                    );
                  })()}
                  <span className="text-[10px] text-dim font-sans">virtual money · paper trading</span>
                </div>
              )}
              <div className="overflow-x-auto">
                <table className="w-full text-xs font-mono">
                  <thead>
                    <tr className="text-left text-dim border-b border-line">
                      <th className="py-1.5 pr-3 font-medium font-sans">Strategy</th>
                      <th className="py-1.5 pr-3 font-medium font-sans">Symbol</th>
                      <th className="py-1.5 pr-3 font-medium font-sans">Incubation</th>
                      <th className="py-1.5 pr-3 font-medium font-sans">Position</th>
                      <th className="py-1.5 pr-3 font-medium font-sans text-right">Equity</th>
                      <th className="py-1.5 pr-3 font-medium font-sans text-right">Return</th>
                      <th className="py-1.5 pr-3 font-medium font-sans text-right">Trades</th>
                      <th className="py-1.5 font-medium font-sans text-right">Code</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.strategies.map((s) => {
                      const entry = published[s.id];
                      const code = entry ? strategyToCode(entry) : null;
                      const pyCode = entry ? strategyToCode(entry, "python") : null;
                      return (
                      <tr key={s.id} className="border-b border-line/40 last:border-0">
                        <td className="py-1.5 pr-3 text-text">{s.name}</td>
                        <td className="py-1.5 pr-3 text-dim">
                          <div>{s.symbol} · {s.interval}</div>
                          {(s.regime || s.volTarget) && (
                            <div className="mt-0.5 flex items-center gap-1.5 text-[10px]">
                              {s.regime && (
                                <span
                                  className={
                                    s.regime === "Bull" ? "text-up" : s.regime === "Bear" ? "text-down" : "text-dim"
                                  }
                                  title="HMM market regime (which way)"
                                >
                                  {s.regime}
                                </span>
                              )}
                              {s.volTarget && (
                                <span className="text-dim" title="GARCH vol-target sizing (how much)">
                                  vol ×{s.volTarget.weight} · {s.volTarget.sizedPct}%
                                </span>
                              )}
                              {s.rotation && s.rotation.weight < 1 && (
                                <span className="text-warn" title={`Regime rotation: losing in the current ${s.rotation.regime} regime on its own live history (${s.rotation.samples} samples) — de-risked`}>
                                  rot ×{s.rotation.weight}
                                </span>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="py-1.5 pr-3">
                          {/* Incubation verdict — live paper vs backtest expectation */}
                          {s.incubation ? (
                            <span
                              title={`${s.incubation.reason}${s.incubation.expDdPct != null ? ` · dd ${s.incubation.liveDdPct}% (budget from backtest ${s.incubation.expDdPct}%)` : ""}`}
                              className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${
                                s.incubation.verdict === "confirmed" ? "bg-up/10 text-up"
                                : s.incubation.verdict === "diverged" ? "bg-down/10 text-down"
                                : s.incubation.verdict === "watch" ? "bg-accent/10 text-accent"
                                : "bg-line/50 text-dim"
                              }`}
                            >
                              {s.incubation.verdict === "diverged" ? "quarantined" : s.incubation.verdict}
                            </span>
                          ) : <span className="text-dim/40 text-[10px]">—</span>}
                        </td>
                        <td className="py-1.5 pr-3">
                          {s.error
                            ? <span className="text-down" title={s.error}>error</span>
                            : <span className={s.position === "long" ? "text-up" : s.position === "short" ? "text-down" : "text-dim"}>{s.position}</span>}
                        </td>
                        <td className="py-1.5 pr-3 text-right text-text">{s.error ? "–" : fmtPrice(s.equity)}</td>
                        <td className={`py-1.5 pr-3 text-right ${s.returnPct >= 0 ? "text-up" : "text-down"}`}>
                          {s.error ? "–" : `${s.returnPct >= 0 ? "+" : ""}${s.returnPct}%`}
                        </td>
                        <td className="py-1.5 pr-3 text-right text-dim">{s.error ? "–" : s.tradeCount}</td>
                        <td className="py-1.5 text-right">
                          {code ? (
                            <span className="inline-flex items-center gap-1">
                              <CopyButton text={code} label={entry?.language === "python" ? "PY" : "Copy"} />
                              {pyCode && pyCode !== code && <CopyButton text={pyCode} label="PY" />}
                            </span>
                          ) : <span className="text-dim/40 text-[10px]">—</span>}
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}


export default LabStatus;
