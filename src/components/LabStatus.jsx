import { Fragment, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Cpu, RefreshCw, Loader2, ChevronRight, Layers, Briefcase, Shield, LineChart } from "lucide-react";
import { fmtPrice, cn } from "@/lib/utils";
import { strategyToCode } from "@/lib/strategyCode";
import { PROFILE_IDS, getProfile, DEFAULT_PROFILE } from "@/lib/profiles";
import CopyButton from "@/components/CopyButton";
import Skeleton from "@/components/Skeleton";

// LabStatus — live status of the local lab agent (the 24/7 process on the user's
// PC that pushes its state to /api/lab): research-loop counters, combined paper
// equity and the per-strategy tables. It lives on its own Cortex tab (/lab) so
// the list of what the agent is ACTUALLY trading isn't buried under Paper.
//
// Three things the panel does beyond a flat list:
//   • Two books — strategies are split into the PRIVATE and the PROP-FIRM
//     portfolios, each with its own equity, so you see the two mandates apart.
//   • Deduplication — the same strategy republished under a different name is
//     collapsed into ONE row per book (matched by generated CODE, not name).
//   • Clickable rows — expand a strategy to see exactly when it bought and sold
//     (its trade log with entry/exit times), the same way Argus's trades open.

const START_EQUITY = 10000; // per-strategy paper start (mirrors lab-agent START_EQUITY)

// Book order + look: private first (the main mandate), then prop firm.
const BOOKS = [
  { id: "private", icon: Briefcase },
  { id: "prop", icon: Shield },
].filter((b) => PROFILE_IDS.includes(b.id));

// Change since local midnight, measured entirely within the equity history so
// base and cur share one scale. Comparing history against combined.equity is a
// bug: the live figure grows when a paper strategy is onboarded (fresh capital),
// so a same-day onboarding printed absurd "+299% today" next to a flat all-time.
// We require a genuine pre-midnight snapshot; if there is none, there is no
// honest "today" to show (return null) rather than faking one from the first bar.
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
  if (!(base > 0)) return null; // no pre-midnight baseline → don't invent a "today"
  const cur = hist[hist.length - 1].v; // same series as base — no scale mismatch
  if (!(cur > 0)) return null;
  const pct = ((cur - base) / base) * 100;
  // A diversified paper book can't move tens of percent in a day from trading —
  // that magnitude is a capital/scale artifact, not P&L. Suppress rather than lie.
  if (!Number.isFinite(pct) || Math.abs(pct) > 40) return null;
  return { abs: cur - base, pct, partial: false };
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

// Build a Charts deep-link for a strategy: its symbol + timeframe, plus its full
// trade log (tTrades = [{a,x,s,e,p}] in unix SECONDS) so Charts draws a buy/sell
// arrow at every entry and exit — exactly when it longed/shorted and closed.
function chartHrefFor(s) {
  const sym = String(s.symbol || "");
  const market = /USDT$|USDC$/.test(sym.toUpperCase()) ? "crypto" : "stock";
  const secs = (ms) => (ms ? Math.round(ms / 1000) : null);
  const trades = (s.trades || []).map((t) => ({
    a: secs(t.openedAt), x: secs(t.closedAt), s: t.side, e: t.entryPrice, p: t.exitPrice,
  }));
  if (s.open?.openedAt) trades.push({ a: secs(s.open.openedAt), s: s.open.position, e: s.open.entryPrice });
  const p = new URLSearchParams({ market, symbol: sym, interval: s.interval || "1d" });
  if (s.name) p.set("tName", s.name);
  if (trades.length) p.set("tTrades", JSON.stringify(trades));
  return `/charts?${p.toString()}`;
}

// Group a book's strategies by generated CODE (same symbol+interval+logic), so a
// republished duplicate shows once. Returns [{ key, rep, members }] with the rep
// = the longest-lived copy (most trades). `published` maps id → registry entry.
function dedupe(strategies, published) {
  const groups = [];
  const byKey = new Map();
  for (const s of strategies) {
    if (s.error) { groups.push({ key: s.id, rep: s, members: [s] }); continue; }
    const entry = published[s.id];
    // Native-language source (js twin is "" for Python) so Python strats aren't all
    // collapsed to one empty signature in the unique-strategy count.
    const sig = entry ? codeSig(strategyToCode(entry, entry.language === "python" ? "python" : "js")) : null;
    const key = sig ? `${s.symbol}|${s.interval}|${sig}` : `id:${s.id}`;
    let g = byKey.get(key);
    if (!g) { g = { key, rep: s, members: [] }; byKey.set(key, g); groups.push(g); }
    g.members.push(s);
    if ((s.tradeCount || 0) > (g.rep.tradeCount || 0)) g.rep = s;
  }
  return groups;
}

// Expanded detail for one strategy: its currently-open leg (if any) and the
// recent closed trades with the exact times it bought and sold.
function TradeLog({ strat, members }) {
  const trades = [...(strat.trades || [])].reverse(); // newest first
  const open = strat.open;
  const aliases = members.filter((m) => m.id !== strat.id);
  return (
    <div className="px-3 py-3 bg-bg/40 text-xs">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[10px] text-dim">{strat.symbol} · {strat.interval}</span>
        <Link
          to={chartHrefFor(strat)}
          onClick={(e) => e.stopPropagation()}
          className="ml-auto inline-flex items-center gap-1 text-[11px] text-accent hover:underline"
          title="Open this strategy on the chart — every entry and exit marked"
        >
          <LineChart className="w-3 h-3" /> Open in Charts →
        </Link>
      </div>
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

// One portfolio book (private OR prop): a header with the book's equity, then the
// de-duplicated strategy table. Rows expand to their trade log.
function StrategyBook({ id, icon: Icon, strategies, published, openRow, setOpenRow }) {
  const label = getProfile(id).label;
  const groups = dedupe(strategies, published);
  const live = groups.filter((g) => !g.rep.error);
  const dupCount = groups.reduce((a, g) => a + Math.max(0, g.members.length - 1), 0);
  const bookEquity = live.reduce((a, g) => a + (g.rep.equity || 0), 0);
  const bookStart = live.length * START_EQUITY;
  const bookRet = bookStart > 0 ? ((bookEquity / bookStart) - 1) * 100 : 0;

  return (
    <div className="rounded-lg border border-line/60 bg-bg/20 p-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-2">
        <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-text">
          {Icon && <Icon className="w-3.5 h-3.5 text-accent" />}{label}
        </span>
        {live.length > 0 && (
          <span className="font-mono text-sm">
            <span className="text-text font-semibold">{fmtPrice(bookEquity)}</span>{" "}
            <span className={bookRet >= 0 ? "text-up" : "text-down"}>
              {bookRet >= 0 ? "+" : ""}{bookRet.toFixed(2)}%
            </span>
          </span>
        )}
        <span className="inline-flex items-center gap-1.5 text-[10px] text-dim">
          <Layers className="w-3 h-3" />
          {live.length} unique {live.length === 1 ? "strategy" : "strategies"}
        </span>
        {dupCount > 0 && (
          <span className="text-[10px] text-warn" title="The same strategy is published more than once in this book under different names. Each duplicate runs its own paper book — the agent now un-publishes the extras automatically; the collapsed count shows what's pending.">
            {dupCount} duplicate {dupCount === 1 ? "copy" : "copies"} collapsed
          </span>
        )}
        <span className="text-[10px] text-dim/80 ml-auto">click a row for its trade log</span>
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
              // Copy in the strat's NATIVE language — forcing "js" returned "" for a
              // Python strategy, so its Copy button vanished (most paper strats are Python).
              const code = entry ? strategyToCode(entry, entry.language === "python" ? "python" : "js") : null;
              const pyCode = entry ? strategyToCode(entry, "python") : null;
              const rowKey = `${id}:${g.key}`;
              const isOpen = openRow === rowKey;
              const dup = g.members.length > 1;
              return (
                <Fragment key={rowKey}>
                  <tr
                    onClick={() => setOpenRow(isOpen ? null : rowKey)}
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
                      ) : <span className="text-dim/55 text-[10px]">—</span>}
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
                      ) : <span className="text-dim/55 text-[10px]">—</span>}
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
}

// Live status of the local lab agent (the 24/7 process on the user's PC that
// pushes its state to /api/lab). Private: reads with the dev token / admin cookie.
function LabStatus() {
  const [data, setData] = useState(undefined); // undefined=loading, null=none
  const [busy, setBusy] = useState(false);
  const [openRow, setOpenRow] = useState(null); // "<profile>:<groupKey>" of the expanded strategy
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

          {/* Ensemble book — the level the quant-grade bars apply to (Tier 1).
              A single rule realistically carries Sharpe 0.2–0.5; the BOOK of
              low-correlation rules is what has to clear Sharpe 1 and beat
              holding the universe. See docs/CORTEX_BENCHMARK.md. */}
          {data.research?.ensemble && (
            <div className="mt-3 border-t border-line pt-3">
              <p className="text-[10px] text-dim font-medium mb-1.5">
                Ensemble book
                <span
                  className={`ml-2 px-1.5 py-0.5 rounded text-[9px] ${
                    data.research.ensemble.quantGrade ? "bg-up/15 text-up" : "bg-line text-dim"
                  }`}
                  title="The hard bars (Sharpe ≥ 1 AND beating the universe risk-adjusted) are judged on the combined book, not on any single rule"
                >
                  {data.research.ensemble.quantGrade ? "quant-grade" : "building"}
                </span>
              </p>
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs font-mono">
                <span className="text-dim" title="Rules admitted to the book — each must be uncorrelated with the others (|ρ| ≤ 0.7) and must not drag the combined Sharpe">
                  rules <span className="text-text">{data.research.ensemble.rules}</span>
                </span>
                <span className="text-dim">
                  Sharpe{" "}
                  <span className={data.research.ensemble.sharpe >= 1 ? "text-up" : "text-text"}>
                    {data.research.ensemble.sharpe?.toFixed?.(2) ?? data.research.ensemble.sharpe}
                  </span>
                  {data.research.ensemble.bhSharpe != null && (
                    <span className="text-dim/70"> vs hold {data.research.ensemble.bhSharpe}</span>
                  )}
                </span>
                <span className="text-dim">drawdown <span className="text-down">{data.research.ensemble.ddPct}%</span></span>
                <span className="text-dim">return <span className="text-text">{data.research.ensemble.retPct}%</span></span>
                <span className="text-dim" title="Pooled daily observations behind the book's statistics">
                  obs <span className="text-text">{data.research.ensemble.obsDays}</span>
                </span>
              </div>
              {data.research.ensemble.members?.length > 0 && (
                <p className="text-[10px] text-dim/80 mt-1.5">
                  members: {data.research.ensemble.members
                    .map((m) => `${m.name} (${m.sharpe}${m.profiles?.length ? " · " + m.profiles.join("/") : ""})`)
                    .join(" · ")}
                </p>
              )}
            </div>
          )}

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
                {data.research.intraday > 0 && (
                  <span className="text-dim" title="Intraday-template channel: classic short-timeframe archetypes (opening-range breakout, ADX trend, VWAP, RSI-2, Supertrend, Donchian) run through the gauntlet — each counts as one attempt">
                    intraday <span className="text-text">{data.research.intraday}</span>
                  </span>
                )}
                {data.research.polished > 0 && (
                  <span className="text-dim" title="Polish loop: Cortex re-opens current strategies and tries to find a strictly better version">
                    polished <span className="text-text">{data.research.polished}</span>
                  </span>
                )}
                {data.research.maxed > 0 && (
                  <span className="text-dim" title="Maxed out 👑 — candidates Cortex couldn't improve further; they're the best version and left alone">
                    maxed <span className="text-yellow-400">👑 {data.research.maxed}</span>
                  </span>
                )}
              </div>
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

          {/* Portfolio HQ — two books (private + prop firm), each de-duplicated by
              code and expandable to each strategy's trade log */}
          {data.mode === "paper" && data.strategies?.length > 0 && (
            <div className="mt-3 border-t border-line pt-3 space-y-4">
              {data.combined && (
                <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm font-mono">
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
                  <span className="text-[10px] text-dim font-sans">virtual money · paper trading · two books</span>
                </div>
              )}
              {BOOKS.map((b) => {
                const strats = data.strategies.filter((s) => (s.profile || DEFAULT_PROFILE) === b.id);
                if (!strats.length) return null;
                return (
                  <StrategyBook
                    key={b.id} id={b.id} icon={b.icon}
                    strategies={strats} published={published}
                    openRow={openRow} setOpenRow={setOpenRow}
                  />
                );
              })}
              {/* strategies with an unknown profile (older pushes) — fold under a catch-all */}
              {(() => {
                const known = new Set(BOOKS.map((b) => b.id));
                const orphans = data.strategies.filter((s) => !known.has(s.profile || DEFAULT_PROFILE));
                if (!orphans.length) return null;
                return (
                  <StrategyBook
                    key="other" id={DEFAULT_PROFILE} icon={Briefcase}
                    strategies={orphans} published={published}
                    openRow={openRow} setOpenRow={setOpenRow}
                  />
                );
              })()}
            </div>
          )}
        </>
      )}
    </div>
  );
}


export default LabStatus;
