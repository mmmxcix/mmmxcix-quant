import { Fragment, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Cpu, RefreshCw, Loader2, ChevronRight, Layers } from "lucide-react";
import { fmtPrice, cn } from "@/lib/utils";
import { strategyToCode } from "@/lib/strategyCode";
import CopyButton from "@/components/CopyButton";
import Skeleton from "@/components/Skeleton";

// LabStatus — live status of the local lab agent (the 24/7 process on the user's
// PC that pushes its state to /api/lab): research-loop counters, combined paper
// equity and the per-strategy table. It now lives on its own page (/lab) so the
// list of what the agent is ACTUALLY trading isn't buried inside the Paper tab.
//
// Two upgrades over the old embedded panel:
//   • Deduplication — the same strategy republished under a different name is
//     collapsed into ONE row (matched by generated CODE, not name), and flagged.
//   • Clickable rows — expand a strategy to see exactly when it bought and sold
//     (its trade log with entry/exit times), the same way Argus's trades open.

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

// Normalise generated code to a signature so two strategies with identical logic
// (the same strategy republished under a different name) collapse to one row.
// Comments and all whitespace are stripped so cosmetic edits don't hide a true
// duplicate; null when we have no source to compare (treated as unique).
function codeSig(code) {
  if (!code) return null;
  return String(code)
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/\/\/[^\n]*/g, "")       // line comments
    .replace(/\s+/g, "")              // all whitespace
    .toLowerCase();
}

function fmtWhen(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

// Expanded detail for one strategy: its currently-open leg (if any) and the
// recent closed trades with the exact times it bought and sold.
function TradeLog({ strat, members }) {
  const trades = [...(strat.trades || [])].reverse(); // newest first
  const open = strat.open;
  const aliases = members.filter((m) => m.id !== strat.id);
  return (
    <div className="px-3 py-3 bg-bg/40 text-xs">
      {aliases.length > 0 && (
        <p className="text-[10px] text-warn mb-2">
          Also published as: {aliases.map((a) => a.name).join(", ")} — identical code, separate paper books.
        </p>
      )}
      {open && (
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono">
          <span className={cn("font-semibold uppercase", open.position === "long" ? "text-up" : "text-down")}>
            {open.position}
          </span>
          <span className="text-dim">open since <span className="text-text">{fmtWhen(open.openedAt)}</span></span>
          <span className="text-dim">entry <span className="text-text">{fmtPrice(open.entryPrice)}</span></span>
          {open.markEquity != null && (
            <span className="text-dim">mark <span className="text-text">{fmtPrice(open.markEquity)}</span></span>
          )}
          <span className="text-[10px] text-accent">still open</span>
        </div>
      )}
      {trades.length === 0 ? (
        <p className="text-dim">{open ? "First position — no closed trades yet." : "No trades yet."}</p>
      ) : (
        <table className="w-full font-mono">
          <thead>
            <tr className="text-left text-dim border-b border-line/60">
              <th className="py-1 pr-3 font-medium font-sans">Side</th>
              <th className="py-1 pr-3 font-medium font-sans">Bought</th>
              <th className="py-1 pr-3 font-medium font-sans">Sold</th>
              <th className="py-1 pr-3 font-medium font-sans text-right">Entry → Exit</th>
              <th className="py-1 font-medium font-sans text-right">P/L</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((t, i) => (
              <tr key={i} className="border-b border-line/30 last:border-0">
                <td className={cn("py-1 pr-3 uppercase", t.side === "long" ? "text-up" : "text-down")}>{t.side}</td>
                <td className="py-1 pr-3 text-dim">{fmtWhen(t.openedAt)}</td>
                <td className="py-1 pr-3 text-dim">{fmtWhen(t.closedAt)}</td>
                <td className="py-1 pr-3 text-right text-text">{fmtPrice(t.entryPrice)} → {fmtPrice(t.exitPrice)}</td>
                <td className={cn("py-1 text-right", t.pnlPct >= 0 ? "text-up" : "text-down")}>
                  {t.pnlPct >= 0 ? "+" : ""}{t.pnlPct}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// Live status of the local lab agent (the 24/7 process on the user's PC that
// pushes its state to /api/lab). Private: reads with the dev token / admin cookie.
function LabStatus() {
  const [data, setData] = useState(undefined); // undefined=loading, null=none
  const [busy, setBusy] = useState(false);
  const [openRow, setOpenRow] = useState(null); // group key of the expanded strategy
  // id -> published strategy entry (carries code / builder id), so every program
  // the agent runs is copyable AND comparable for de-duplication. The state
  // summaries don't carry the source, so we pull the published list and match by id.
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
        <button onClick={() => load()} disabled={busy} className="ml-auto flex items-center gap-1.5 chip chip-idle !text-[11px]">
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

          {/* Portfolio HQ — paper strategies actually executed by the agent,
              de-duplicated by generated code and expandable to their trade logs */}
          {data.mode === "paper" && data.strategies?.length > 0 && (() => {
            // Collapse strategies whose generated CODE is identical (same symbol +
            // interval + logic) into one row so a republished duplicate shows once.
            const groups = [];
            const byKey = new Map();
            for (const s of data.strategies) {
              if (s.error) { groups.push({ key: s.id, rep: s, members: [s] }); continue; }
              const entry = published[s.id];
              const sig = entry ? codeSig(strategyToCode(entry)) : null;
              const key = sig ? `${s.symbol}|${s.interval}|${sig}` : `id:${s.id}`;
              let g = byKey.get(key);
              if (!g) { g = { key, rep: s, members: [] }; byKey.set(key, g); groups.push(g); }
              g.members.push(s);
              // representative = the copy with the longest-lived book (most trades)
              if ((s.tradeCount || 0) > (g.rep.tradeCount || 0)) g.rep = s;
            }
            const dupCount = groups.reduce((a, g) => a + Math.max(0, g.members.length - 1), 0);
            return (
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
                <div className="flex items-center gap-2 mb-1.5 text-[10px]">
                  <Layers className="w-3 h-3 text-dim" />
                  <span className="text-dim">
                    {groups.length} unique {groups.length === 1 ? "strategy" : "strategies"} actually trading
                  </span>
                  {dupCount > 0 && (
                    <span className="text-warn" title="The same strategy is published more than once under different names. Each duplicate runs its own paper book — un-publish the extras in the Registry to stop double-trading.">
                      · {dupCount} duplicate {dupCount === 1 ? "copy" : "copies"} collapsed
                    </span>
                  )}
                  <span className="text-dim/60 ml-auto">click a row for its trade log</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs font-mono">
                    <thead>
                      <tr className="text-left text-dim border-b border-line">
                        <th className="py-1.5 pr-2 w-4"></th>
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
                      {groups.map((g) => {
                        const s = g.rep;
                        const entry = published[s.id];
                        const code = entry ? strategyToCode(entry) : null;
                        const pyCode = entry ? strategyToCode(entry, "python") : null;
                        const isOpen = openRow === g.key;
                        const dup = g.members.length > 1;
                        return (
                        <Fragment key={g.key}>
                          <tr
                            onClick={() => setOpenRow(isOpen ? null : g.key)}
                            className="border-b border-line/40 last:border-0 cursor-pointer hover:bg-bg/40"
                          >
                            <td className="py-1.5 pr-2">
                              <ChevronRight className={cn("w-3 h-3 text-dim transition-transform", isOpen && "rotate-90")} />
                            </td>
                            <td className="py-1.5 pr-3 text-text">
                              {s.name}
                              {dup && (
                                <span
                                  className="ml-1.5 inline-flex items-center rounded-full bg-warn/10 text-warn px-1.5 py-0.5 text-[9px] font-semibold"
                                  title={`Identical code, also published as: ${g.members.filter((m) => m.id !== s.id).map((m) => m.name).join(", ")}`}
                                >
                                  ⧉ ×{g.members.length}
                                </span>
                              )}
                            </td>
                            <td className="py-1.5 pr-3 text-dim">
                              <div>{s.symbol} · {s.interval}</div>
                              {(s.regime || s.volTarget) && (
                                <div className="mt-0.5 flex items-center gap-1.5 text-[10px]">
                                  {s.regime && (
                                    <span
                                      className={s.regime === "Bull" ? "text-up" : s.regime === "Bear" ? "text-down" : "text-dim"}
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
                            <td className="py-1.5 text-right" onClick={(e) => e.stopPropagation()}>
                              {code ? (
                                <span className="inline-flex items-center gap-1">
                                  <CopyButton text={code} label={entry?.language === "python" ? "PY" : "Copy"} />
                                  {pyCode && pyCode !== code && <CopyButton text={pyCode} label="PY" />}
                                </span>
                              ) : <span className="text-dim/40 text-[10px]">—</span>}
                            </td>
                          </tr>
                          {isOpen && !s.error && (
                            <tr className="border-b border-line/40">
                              <td colSpan={9} className="p-0">
                                <TradeLog strat={s} members={g.members} />
                              </td>
                            </tr>
                          )}
                        </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })()}
        </>
      )}
    </div>
  );
}


export default LabStatus;
