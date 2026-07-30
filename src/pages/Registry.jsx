import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Boxes, Trash2, Skull, ShieldCheck, FlaskConical, Rocket, Grid3x3, Info, Send, Loader2, Check, Scale, Wrench, Search } from "lucide-react";
import {
  getEntries, subscribeRegistry, setStatus, removeEntry, STATUS_META, correlationMatrix, saveEntry, syncFromServer,
} from "@/lib/registry";
import { cn, fmtPct, fmtNum } from "@/lib/utils";
import { PROFILES } from "@/lib/profiles";
import { byId, costFor, describeMarkets } from "@/lib/markets";
import { INTERVAL_SECONDS } from "@/lib/data";
import { strategyToCode } from "@/lib/strategyCode";
import { hasPineSource } from "@/lib/pinescript";
import { findComplementaryPairs } from "@/lib/combine";
import CopyButton from "@/components/CopyButton";

const PROFILE_LABEL = Object.fromEntries(Object.entries(PROFILES).map(([id, p]) => [id, p.label]));

// The exact backtest window each research market used (markets.js `range`/`bars`).
// This is what a registry number was measured over — a 10y TSLA return is a very
// different thing from a 5y one, so we surface it and let a click reproduce it.
const RANGE_DAYS = { "5d": 5, "1mo": 30, "3mo": 90, "6mo": 180, "1y": 365, "2y": 730, "5y": 1825, "10y": 3652, max: 36500 };
function windowFor(mk) {
  if (!mk) return null;
  if (mk.range) return { days: RANGE_DAYS[mk.range] ?? 3652, label: mk.range };
  if (mk.bars) {
    const days = Math.round((mk.bars * (INTERVAL_SECONDS[mk.interval] || 3600)) / 86400);
    return { days, label: days >= 365 ? `${(days / 365).toFixed(days >= 1000 ? 0 : 1)}y` : `${days}d` };
  }
  return null;
}

// Survivors of the autonomous research loop (pushed by the PC's research
// agent into lab:candidates). Private: only renders when the dev token exists.
function AgentCandidates() {
  const [items, setItems] = useState(undefined); // undefined = loading
  const [imported, setImported] = useState({});
  const navigate = useNavigate();
  // Auto-promotion settings live in localStorage so the choice survives reloads.
  const [autoPromote, setAutoPromote] = useState(() => localStorage.getItem("quant_auto_promote") !== "0"); // default ON
  const [autoDsr, setAutoDsr] = useState(() => +(localStorage.getItem("quant_auto_promote_dsr") || 60));
  const [autoNote, setAutoNote] = useState(null);
  useEffect(() => { localStorage.setItem("quant_auto_promote", autoPromote ? "1" : "0"); }, [autoPromote]);
  useEffect(() => { localStorage.setItem("quant_auto_promote_dsr", String(autoDsr)); }, [autoDsr]);

  // Reproduce a candidate's exact number: hand the Backtest page the SAME market,
  // interval, window (as a custom from/to period — the research ranges like "10y"
  // aren't in the Backtest dropdown), fee and code, then jump there.
  const openInBacktest = (c, mid) => {
    const mk = mid ? byId(mid) : (c.markets?.[0] ? byId(c.markets[0]) : null);
    if (!mk) return;
    const win = windowFor(mk);
    const to = new Date();
    const from = new Date(to.getTime() - (win?.days ?? 3652) * 86_400_000);
    const iso = (d) => d.toISOString().slice(0, 10);
    const handoff = {
      market: mk.asset === "crypto" ? "crypto" : "stock",
      symbol: mk.symbol, interval: mk.interval,
      customPeriod: true, fromDate: iso(from), toDate: iso(to),
      feeBps: costFor(mk), positionPct: 100,
      mode: "code", code: c.code, lang: c.language || "js",
    };
    try { sessionStorage.setItem("backtest_handoff", JSON.stringify(handoff)); } catch { /* quota */ }
    navigate("/backtest?load=1");
  };

  // Admin session cookie gates this server-side (the page itself only renders
  // inside the RequireAdmin-guarded Cortex hub). The research agent pushes new
  // candidates around the clock, so this POLLS instead of fetching once — a stale
  // list that only refreshed on a hard reload was the annoying part.
  useEffect(() => {
    let alive = true;
    const load = () => {
      fetch("/api/lab?what=candidates")
        .then((r) => (r.ok ? r.json() : null))
        .then((out) => { if (alive) setItems(out?.candidates?.items || []); })
        .catch(() => { if (alive) setItems([]); });
    };
    load();
    const id = setInterval(() => { if (!document.hidden) load(); }, 60_000);
    const onFocus = () => { if (!document.hidden) load(); }; // instant on tab return
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  // Import into the market the strategy was actually validated on — importing
  // everything as BTC 4h (as this used to) would silently misrepresent a rule
  // that only ever worked on, say, EUR/USD daily.
  const importOne = (c, status = "factory") => {
    const mid = c.bestMarket || (c.markets || [])[0];
    const mk = mid ? byId(mid) : null;
    const row = (c.byMarket?.[mid]) || Object.values(c.byMarket || {})[0] || {};
    saveEntry({
      name: c.name.slice(0, 60), // clean name; the "Cortex" badge marks the source
      market: mk ? (mk.asset === "crypto" ? "crypto" : "stock") : "crypto",
      symbol: mk?.symbol || "BTCUSDT",
      interval: mk?.interval || "4h",
      range: mk?.range || "max", // record the actual window it was validated on
      mode: "code", code: c.code, language: c.language || "js", positionPct: 100,
      feeBps: mk ? costFor(mk) : 10,
      metrics: { totalReturnPct: row.ret ?? 0, profitFactor: row.pf ?? 0, maxDrawdownPct: row.dd ?? 0, tradeCount: row.n ?? 0 },
      equity: [],
      validation: { wf: "pass", dsr: "pass", noise: "pass" }, // it survived the agent's gauntlet
      status,
      candidateId: c.id,
      // Carry the full research context so the library card shows the thesis,
      // committee verdict, DSR, markets and source — the old feed's richness.
      research: {
        thesis: c.thesis || null, committee: c.committee || null,
        dsr: c.dsr ?? null, revalidatedDsr: c.revalidatedDsr ?? null,
        profiles: c.profiles || [], markets: c.markets || [], byMarket: c.byMarket || {},
        marketsTested: c.marketsTested ?? null,
        source: c.source || null, paper: c.paper || null, kind: c.kind || null, readFullText: !!c.readFullText,
      },
    });
    setImported((s) => ({ ...s, [c.id]: true }));
  };

  // ── Auto-promotion ────────────────────────────────────────────────────────
  // The mechanical steps (import → factory → validated → paper) carry no
  // judgement: the agent's gauntlet already decided these are worth looking at.
  // So a fresh candidate clearing the DSR bar auto-enters the LIBRARY at Factory
  // — the first stage every strategy starts in — instead of needing a manual
  // import click. Progression from there (Factory → Validated → Paper) and the
  // hand-off to the live agent stay deliberate.
  useEffect(() => {
    if (!autoPromote || !Array.isArray(items) || !items.length) return;
    const known = new Set(getEntries().map((e) => e.candidateId).filter(Boolean));
    const fresh = items.filter((c) => c.code && !known.has(c.id) && (c.revalidatedDsr ?? c.dsr ?? 0) >= autoDsr);
    if (!fresh.length) return;
    for (const c of fresh) importOne(c, "factory");
    setAutoNote(`${fresh.length} candidate${fresh.length > 1 ? "s" : ""} added to the library (Factory · DSR ≥ ${autoDsr}%)`);
    setTimeout(() => setAutoNote(null), 6000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, autoPromote, autoDsr]);

  // The candidate FEED is gone — new finds auto-import into the library below.
  // This renders only the small ingestion control (auto-add + DSR bar).
  return (
    <div className="flex flex-wrap items-center gap-3 mb-6 rounded-xl border border-line lg-glass px-3 py-2">
      <FlaskConical className="w-4 h-4 text-accent shrink-0" />
      <label className="flex items-center gap-2 text-[11px] text-dim cursor-pointer">
        <input type="checkbox" checked={autoPromote} onChange={(e) => setAutoPromote(e.target.checked)} className="accent-current" />
        <span className="text-text">Auto-add Cortex research finds to the library (<span className="font-medium">Factory</span>)</span>
      </label>
      <label className="flex items-center gap-1.5 text-[11px] text-dim">
        min DSR
        <input type="number" value={autoDsr} min={0} max={100} step={5}
          onChange={(e) => setAutoDsr(Math.min(100, Math.max(0, +e.target.value || 0)))}
          className="input-base w-16 !py-0.5 font-mono text-[11px]" />
        %
      </label>
      <span className="text-[10px] text-dim">They land in Factory and progress as they're re-tested. Publish to agent stays manual.</span>
      {autoNote && <span className="text-[10px] text-up ml-auto">{autoNote}</span>}
    </div>
  );
}

const COLS = [
  { id: "factory", icon: FlaskConical, tone: "text-accent" },
  { id: "validated", icon: ShieldCheck, tone: "text-up" },
  { id: "paper", icon: Rocket, tone: "text-blue-400" },
  { id: "improve", icon: Wrench, tone: "text-amber-400" },
  { id: "graveyard", icon: Skull, tone: "text-dim" },
];

// Short labels for the time-window profile (src/lib/windowProfile.js).
const WP_LABEL = {
  consistent: "consistent across time",
  "good-early": "good early · decayed",
  "good-late": "weak early · strong now",
  unprofitable: "unprofitable throughout",
  erratic: "erratic across time",
};

// Where each status can move next (forward promote · sideline to improve · bury).
const MOVES = {
  factory: [["validated", "Promote"], ["improve", "Needs work"], ["graveyard", "Bury"]],
  validated: [["paper", "Go paper"], ["improve", "Needs work"], ["graveyard", "Bury"]],
  paper: [["validated", "Pause"], ["graveyard", "Bury"]],
  improve: [["factory", "Back to Factory"], ["graveyard", "Bury"]],
  graveyard: [["improve", "Revive to fix"], ["factory", "Revive"]],
};

function verdictDot(v) {
  if (v === "pass") return "bg-up";
  if (v === "fail") return "bg-down";
  return "bg-line";
}

function Card({ e, rich = false }) {
  const m = e.metrics;
  const val = e.validation || {};
  const r = e.research || null;
  const navigate = useNavigate();

  // Reproduce this strategy in the Backtester — its own market/window/code (or a
  // specific research market when a chip is clicked). Handed off via sessionStorage.
  const openInBacktest = (mid) => {
    const mk = mid ? byId(mid) : null;
    const days = RANGE_DAYS[(mk?.range) || e.range] ?? 3652;
    const to = new Date(), from = new Date(to.getTime() - days * 86_400_000);
    const iso = (d) => d.toISOString().slice(0, 10);
    const codeBits = e.code ? { code: e.code } : { strategyId: e.strategyId || undefined, params: e.params || undefined };
    const handoff = mk
      ? { market: mk.asset === "crypto" ? "crypto" : "stock", symbol: mk.symbol, interval: mk.interval, customPeriod: true, fromDate: iso(from), toDate: iso(to), feeBps: costFor(mk), positionPct: 100, ...codeBits }
      : { market: e.market, symbol: e.symbol, interval: e.interval, customPeriod: true, fromDate: iso(from), toDate: iso(to), feeBps: e.feeBps, positionPct: e.positionPct, ...codeBits };
    try { sessionStorage.setItem("backtest_handoff", JSON.stringify(handoff)); } catch { /* quota */ }
    navigate("/backtest?load=1");
  };

  return (
    <div className="rounded-lg border border-line bg-bg/40 p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            {/* Where it came from — your own backtest, or a Cortex research find. */}
            <span className={cn("text-[8px] uppercase tracking-wide font-semibold px-1 py-px rounded shrink-0",
              e.candidateId ? "bg-accent/15 text-accent" : "bg-up/15 text-up")}>
              {e.candidateId ? "Cortex" : "You"}
            </span>
            <p className="text-sm font-medium text-text truncate">{e.name}</p>
            {rich && r?.dsr != null && (
              <span className="text-[10px] font-mono text-dim ml-1">
                DSR {r.dsr}%{r.revalidatedDsr != null && r.revalidatedDsr !== r.dsr && <span className={r.revalidatedDsr >= r.dsr ? "text-up" : "text-dim"}> → {r.revalidatedDsr}%</span>}
              </span>
            )}
            {rich && (r?.profiles || []).map((p) => (
              <span key={p} className={cn("text-[9px] uppercase tracking-wide rounded px-1.5 py-0.5 font-semibold", p === "prop" ? "bg-accent/15 text-accent" : "bg-up/10 text-up")}>{PROFILE_LABEL[p] || p}</span>
            ))}
          </div>
          <p className="text-[10px] text-dim font-mono">{e.symbol} · {e.interval} · {e.mode}{e.positionPct != null ? ` · ${e.positionPct}%` : ""}</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <CopyButton text={strategyToCode(e)} label="" />
                {strategyToCode(e, "python") && strategyToCode(e, "python") !== strategyToCode(e) && (
                  <CopyButton text={strategyToCode(e, "python")} label="PY" />
                )}
                {hasPineSource(e) && <CopyButton text={strategyToCode(e, "pine")} label="Pine" />}
          <button onClick={() => removeEntry(e.id)} title="Delete" className="text-dim hover:text-down transition-colors">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {m && (
        <div className="grid grid-cols-3 gap-x-2 gap-y-0.5 text-[11px] font-mono">
          <span className="text-dim">ret</span><span className={cn("col-span-2 text-right", m.totalReturnPct >= 0 ? "text-up" : "text-down")}>{fmtPct(m.totalReturnPct)}</span>
          <span className="text-dim">PF</span><span className="col-span-2 text-right text-text">{fmtNum(m.profitFactor, 2)}</span>
          <span className="text-dim">maxDD</span><span className="col-span-2 text-right text-down">-{fmtNum(m.maxDrawdownPct, 0)}%</span>
          <span className="text-dim">trades</span><span className="col-span-2 text-right text-text">{m.tradeCount}</span>
        </div>
      )}

      {/* Markets it was validated on (Cortex) — each opens in the Backtester. */}
      {rich && (r?.markets || []).length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {r.markets.map((mid) => {
            const row = r.byMarket?.[mid] || {}; const mk = byId(mid); const win = windowFor(mk);
            return (
              <button key={mid} type="button" onClick={() => openInBacktest(mid)}
                title={`Open in Backtester — ${mk?.symbol} ${mk?.interval} over ${win?.label || "?"} · return ${row.ret ?? "?"}% · maxDD ${row.dd ?? "?"}%`}
                className="group text-[10px] font-mono rounded border border-up/30 bg-up/5 text-up px-1.5 py-0.5 hover:bg-up/15 hover:border-up/50 transition-colors">
                {mk?.label || mid}{win && <span className="text-dim/60"> {win.label}</span>}{row.ret != null && <span className="text-dim/90"> {row.ret}%</span>}<span className="text-dim/40 group-hover:text-accent"> ↗</span>
              </button>
            );
          })}
          {r.marketsTested > (r.markets?.length || 0) && <span className="text-[10px] text-dim">of {r.marketsTested} tested</span>}
        </div>
      )}

      {/* Thesis (Cortex) — edge / works / breaks. */}
      {rich && r?.thesis && (r.thesis.edge || r.thesis.works || r.thesis.breaks) && (
        <div className="space-y-0.5 text-[11px]">
          {r.thesis.edge && <p className="text-dim"><span className="text-up font-semibold">Edge</span> — {r.thesis.edge}</p>}
          {r.thesis.works && <p className="text-dim"><span className="text-accent font-semibold">Works</span> — {r.thesis.works}</p>}
          {r.thesis.breaks && <p className="text-dim"><span className="text-down font-semibold">Breaks</span> — {r.thesis.breaks}</p>}
        </div>
      )}

      {/* The actual rules — collapsed so the card stays scannable. */}
      {rich && e.code && (
        <details>
          <summary className="text-[10px] text-dim cursor-pointer hover:text-accent select-none">Show the actual rules ({e.language === "python" ? "Python" : "JS"})</summary>
          <pre className="mt-1.5 max-h-64 overflow-auto rounded-lg border border-line bg-bg/60 p-2.5 text-[10px] font-mono leading-snug text-dim whitespace-pre-wrap">{e.code}</pre>
        </details>
      )}

      {/* Committee verdict (Cortex) — the qualitative debate on top of the maths. */}
      {rich && r?.committee && (
        <details className="rounded-lg border border-line bg-bg/40 p-2 text-[11px]">
          <summary className="flex items-center gap-2 cursor-pointer select-none">
            <Scale className="w-3.5 h-3.5 text-accent" /><span className="font-semibold text-text">Committee verdict</span>
            {r.committee.confidence != null && <span className={cn("font-mono px-1.5 py-0.5 rounded text-[10px]", r.committee.confidence >= 60 ? "bg-up/10 text-up" : r.committee.confidence >= 35 ? "bg-accent/10 text-accent" : "bg-down/10 text-down")}>conf {r.committee.confidence}%</span>}
          </summary>
          <div className="mt-1.5 space-y-1">
            {r.committee.bull && <p className="text-dim"><span className="text-up font-semibold">Bull</span> — {r.committee.bull}</p>}
            {r.committee.bear && <p className="text-dim"><span className="text-down font-semibold">Bear</span> — {r.committee.bear}</p>}
            {(r.committee.invalidations || []).length > 0 && (
              <div className="text-dim/80"><span className="font-semibold">Pull it if:</span><ul className="list-disc list-inside mt-0.5">{r.committee.invalidations.map((inv, i) => <li key={i}>{inv}</li>)}</ul></div>
            )}
          </div>
        </details>
      )}

      {/* Time-window profile — where the money was made across the backtest. */}
      {e.windowProfile?.segments && (
        <div>
          <div className="flex items-center gap-1 mb-0.5" title={e.windowProfile.summary}>
            {e.windowProfile.segments.map((s, i) => (
              <div key={i} className={cn("h-1.5 flex-1 rounded-sm", s.ret > 0.02 ? "bg-up/70" : s.ret < -0.02 ? "bg-down/70" : "bg-line")} />
            ))}
          </div>
          <p className="text-[9px] uppercase tracking-wide text-dim">
            {WP_LABEL[e.windowProfile.profile] || e.windowProfile.profile}
          </p>
        </div>
      )}

      {/* validation verdict dots */}
      <div className="flex items-center gap-3 text-[10px] text-dim">
        <span className="flex items-center gap-1" title="Walk-forward / k-fold"><span className={cn("w-1.5 h-1.5 rounded-full", verdictDot(val.wf))} /> WF</span>
        <span className="flex items-center gap-1" title="Deflated Sharpe Ratio"><span className={cn("w-1.5 h-1.5 rounded-full", verdictDot(val.dsr))} /> DSR</span>
        <span className="flex items-center gap-1" title="Price-noise robustness"><span className={cn("w-1.5 h-1.5 rounded-full", verdictDot(val.noise))} /> Noise</span>
      </div>

      {e.note && <p className="text-[10px] text-dim italic leading-snug">“{e.note}”</p>}

      {/* Why it stalled — the flaw Cortex (or you) recorded, so a salvageable
          strategy carries its known problem into the Improve bucket. */}
      {e.failureReason && (
        <p className={cn("text-[10px] leading-snug rounded px-1.5 py-1",
          e.status === "graveyard" ? "text-dim bg-bg" : "text-amber-400/90 bg-amber-400/5")}>
          {e.failureReason}
        </p>
      )}

      {/* Source + open in the Backtester (rich cards). */}
      {rich && (
        <div className="flex items-center gap-2 text-[10px] text-dim">
          {r?.source && <span>{r.source}{r.kind && r.kind !== "paper" ? ` · ${r.kind}` : ""}{r.readFullText ? " · full text" : r.source ? " · abstract" : ""}</span>}
          {r?.paper && <a href={r.paper} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">source</a>}
          <button onClick={() => openInBacktest()} className="ml-auto text-accent hover:underline">Open in Backtest ↗</button>
        </div>
      )}

      <div className="flex flex-wrap gap-1 pt-0.5">
        {(MOVES[e.status] || []).map(([to, label]) => (
          <button key={to} onClick={() => setStatus(e.id, to)}
            className={cn("chip !text-[10px] !py-0.5", to === "graveyard" ? "chip-idle hover:text-down" : "chip-idle hover:text-accent")}>
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

// Correlation heatmap for the paper/validated set — the diversification check.
function CorrMatrix({ entries }) {
  const { names, matrix } = useMemo(() => correlationMatrix(entries), [entries]);
  if (entries.length < 2) {
    return <p className="text-xs text-dim">Add at least two validated/paper strategies to see how correlated they are.</p>;
  }
  const color = (v) => {
    if (v == null) return "rgba(100,116,139,0.15)";
    const t = Math.min(1, Math.abs(v));
    return v >= 0 ? `rgba(239,68,68,${0.15 + t * 0.6})` : `rgba(45,212,191,${0.15 + t * 0.6})`;
  };
  return (
    <div className="overflow-x-auto">
      <table className="text-[10px] font-mono border-separate" style={{ borderSpacing: 2 }}>
        <thead>
          <tr>
            <th />
            {names.map((n, i) => (
              <th key={i} className="text-dim font-normal px-1 max-w-[60px] truncate" title={n}>{n.slice(0, 8)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {matrix.map((row, i) => (
            <tr key={i}>
              <td className="text-dim pr-1 text-right max-w-[80px] truncate" title={names[i]}>{names[i].slice(0, 10)}</td>
              {row.map((v, j) => (
                <td key={j} className="text-center w-9 h-7 rounded text-text/90"
                  style={{ background: color(v) }} title={v == null ? "not enough overlap" : v.toFixed(2)}>
                  {v == null ? "·" : v.toFixed(1)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="flex items-center gap-1.5 text-[10px] text-dim mt-2">
        <Info className="w-3 h-3" />
        <span className="text-accent">Teal = uncorrelated/opposite</span> (good — diversified),{" "}
        <span className="text-down">red = move together</span> (cluster risk: they lose on the same days).
      </p>
    </div>
  );
}

// Publish the paper-status strategies to the site's KV so the local lab agent
// (the user's PC) can fetch and execute them. Needs the dev token.
function PublishToAgent({ entries }) {
  const paper = entries.filter((e) => e.status === "paper");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const publish = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const payload = paper.map((e) => ({
        id: e.id, name: e.name, market: e.market, symbol: e.symbol, interval: e.interval,
        mode: e.mode, strategyId: e.strategyId, params: e.params, code: e.code,
        positionPct: e.positionPct ?? 100, feeBps: e.feeBps ?? 10,
      }));
      // Auth = the admin session cookie (sent automatically, same origin).
      const res = await fetch("/api/lab", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ strategies: payload }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok || !out.ok) throw new Error(out.error || `HTTP ${res.status}`);
      setMsg({ err: false, text: `${out.published} strategies published — the agent picks them up on its next run (≤15 min).` });
    } catch (e) {
      setMsg({ err: true, text: `Publish failed: ${e.message}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line lg-glass px-4 py-3 mb-6">
      <Rocket className="w-4 h-4 text-blue-400" />
      <p className="text-sm text-text">
        Paper trading: <span className="font-mono text-blue-400">{paper.length}</span> strategies in Paper status
      </p>
      <button onClick={publish} disabled={busy || paper.length === 0}
        className={cn("flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm transition-colors",
          paper.length === 0 ? "border-line text-dim" : "border-blue-400/40 text-blue-400 hover:bg-blue-400/10")}>
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
        Publish to agent
      </button>
      {msg && (
        <span className={cn("flex items-center gap-1 text-xs", msg.err ? "text-down" : "text-up")}>
          {!msg.err && <Check className="w-3.5 h-3.5" />} {msg.text}
        </span>
      )}
      <span className="text-[11px] text-dim w-full sm:w-auto">
        Your PC's lab agent executes published strategies with virtual money and reports equity to the Coach page.
      </span>
    </div>
  );
}

export default function Registry() {
  const [entries, setEntries] = useState(getEntries());
  useEffect(() => subscribeRegistry(() => setEntries(getEntries())), []);
  // Pull the shared server library on mount so the same strategies show on every
  // device (self-found + Cortex-found), then keep syncing while the tab is open.
  useEffect(() => {
    syncFromServer();
    const id = setInterval(() => { if (!document.hidden) syncFromServer(); }, 60_000);
    return () => clearInterval(id);
  }, []);
  const [query, setQuery] = useState("");
  const [showGraveyard, setShowGraveyard] = useState(false); // buried strats are hidden until asked for
  const [sourceFilter, setSourceFilter] = useState("all");   // all | you | cortex
  const [stageFilter, setStageFilter] = useState("all");     // all | factory | validated | paper | improve

  const matches = (e) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (e.name || "").toLowerCase().includes(q) || (e.symbol || "").toLowerCase().includes(q);
  };

  // The LIBRARY view (top) — every strategy, own + Cortex, with real filters.
  // Graveyard stays out unless you toggle it on or filter to it explicitly.
  const library = useMemo(() => entries.filter((e) => {
    if (e.status === "graveyard" && !showGraveyard) return false;
    if (stageFilter !== "all" && e.status !== stageFilter) return false;
    if (sourceFilter === "you" && e.candidateId) return false;
    if (sourceFilter === "cortex" && !e.candidateId) return false;
    return matches(e);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [entries, query, sourceFilter, stageFilter, showGraveyard]);

  const byStatus = useMemo(() => {
    const g = { factory: [], validated: [], paper: [], improve: [], graveyard: [] };
    for (const e of entries) if (matches(e)) (g[e.status] || g.factory).push(e);
    return g;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, query]);

  const graveyardCount = useMemo(() => entries.filter((e) => e.status === "graveyard").length, [entries]);
  // The living library = everything that isn't buried; graveyard is opt-in.
  const activeCols = COLS.filter((c) => c.id !== "graveyard");

  const corrSet = useMemo(
    () => entries.filter((e) => e.status === "paper" || e.status === "validated"),
    [entries]
  );

  // Complementary pairs — a decayed (good-early) + an improving (good-late) that
  // blend into something consistent. Computed from the stored window profiles.
  const combos = useMemo(() => findComplementaryPairs(entries).slice(0, 6), [entries]);

  return (
    <div className="max-w-6xl">
      <p className="text-[10px] tracking-[0.3em] text-dim uppercase mb-1">Strategy Lab</p>
      <div className="flex items-center gap-2 mb-2">
        <Boxes className="w-6 h-6 text-accent" />
        <h1 className="text-xl sm:text-2xl font-bold">Registry</h1>
      </div>
      <p className="text-sm text-dim mb-6 max-w-2xl">
        Your strategy library — both the ones you found (saved from the{" "}
        <Link to="/backtest" className="text-accent hover:underline">Backtest</Link> page) and the ones Cortex found.
        Every strategy flows through its lifecycle: <span className="text-accent">Factory</span> → <span className="text-up">Validated</span> → <span className="text-blue-400">Paper</span> as it's
        re-tested, side-lined to <span className="text-amber-400">Improve</span> when it has a fixable flaw,
        or buried in the <span className="text-dim">Graveyard</span>. Stored in this browser.
      </p>

      {entries.length === 0 ? (
        <>
          <AgentCandidates />
          <div className="rounded-xl border border-line lg-glass p-8 text-center text-sm text-dim">
            No strategies yet. Run a backtest and click <span className="text-accent">“Save to registry”</span> under the result —
            it lands here in the library. Cortex's own finds show up automatically.
          </div>
        </>
      ) : (
        <>
          <PublishToAgent entries={entries} />

          {/* ── THE LIBRARY (top) — every strategy, own + Cortex, filterable ── */}
          <div className="rounded-xl border border-line lg-glass p-4 mb-6">
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <Boxes className="w-4 h-4 text-accent" />
              <p className="text-sm font-semibold">Library</p>
              <span className="text-[11px] text-dim">· {library.length} shown · {entries.length - graveyardCount} total</span>
              <div className="relative ml-auto min-w-[12rem]">
                <Search className="w-3.5 h-3.5 text-dim absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input value={query} onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search name or symbol…" className="input-base w-full text-xs !pl-8" />
              </div>
            </div>
            {/* Filters: source · stage · graveyard */}
            <div className="flex flex-wrap items-center gap-1.5 mb-3">
              <span className="text-[10px] text-dim uppercase tracking-wide mr-1">Source</span>
              {[["all", "All"], ["you", "You"], ["cortex", "Cortex"]].map(([id, label]) => (
                <button key={id} onClick={() => setSourceFilter(id)}
                  className={cn("chip !text-[10px]", sourceFilter === id ? "chip-active" : "chip-idle")}>{label}</button>
              ))}
              <span className="text-[10px] text-dim uppercase tracking-wide mx-1 ml-3">Stage</span>
              {[["all", "All"], ...activeCols.map((c) => [c.id, STATUS_META[c.id].label])].map(([id, label]) => (
                <button key={id} onClick={() => setStageFilter(id)}
                  className={cn("chip !text-[10px]", stageFilter === id ? "chip-active" : "chip-idle")}>{label}</button>
              ))}
              <button onClick={() => setShowGraveyard((v) => !v)}
                className={cn("chip !text-[10px] ml-auto flex items-center gap-1", showGraveyard ? "chip-active" : "chip-idle")}>
                <Skull className="w-3 h-3" /> Graveyard {graveyardCount}
              </button>
            </div>
            {library.length === 0 ? (
              <p className="text-[11px] text-dim py-6 text-center">No strategy matches these filters.</p>
            ) : (
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {library.map((e) => <Card key={e.id} e={e} rich />)}
              </div>
            )}
          </div>

          {/* ── THE PIPELINE (below) — where each strategy is in its lifecycle ── */}
          <div className="flex items-center gap-2 mb-2">
            <p className="text-xs font-semibold text-dim uppercase tracking-wide">Pipeline · where each strategy is</p>
          </div>
          <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-4 mb-6">
            {activeCols.map((col) => {
              const Icon = col.icon;
              const list = byStatus[col.id];
              return (
                <div key={col.id} className="rounded-xl border border-line lg-glass p-3">
                  <div className="flex items-center gap-2 mb-3 px-1">
                    <Icon className={cn("w-4 h-4", col.tone)} />
                    <p className={cn("text-sm font-semibold", col.tone)}>{STATUS_META[col.id].label}</p>
                    <span className="text-xs font-mono text-dim ml-auto">{list.length}</span>
                  </div>
                  <p className="text-[10px] text-dim px-1 mb-2">{STATUS_META[col.id].hint}</p>
                  <div className="space-y-2">
                    {list.length === 0
                      ? <p className="text-[11px] text-dim px-1 py-4 text-center">{query ? "no match" : "empty"}</p>
                      : list.map((e) => <Card key={e.id} e={e} />)}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Graveyard — opt-in. Buried strategies (too weak, decayed, etc.) are
              kept as a record but stay out of the library/pipeline by default. */}
          {showGraveyard && (
            <div className="rounded-xl border border-line lg-glass p-3 mb-8">
              <div className="flex items-center gap-2 mb-3 px-1">
                <Skull className="w-4 h-4 text-dim" />
                <p className="text-sm font-semibold text-dim">Graveyard</p>
                <span className="text-[10px] text-dim">— buried, kept as a record of what failed</span>
                <span className="text-xs font-mono text-dim ml-auto">{byStatus.graveyard.length}</span>
              </div>
              {byStatus.graveyard.length === 0
                ? <p className="text-[11px] text-dim px-1 py-4 text-center">{query ? "no match" : "empty"}</p>
                : <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-2">{byStatus.graveyard.map((e) => <Card key={e.id} e={e} />)}</div>}
            </div>
          )}

          {/* Suggested combinations — a decayed (good-early) + an improving
              (good-late) strategy that BLEND into something consistent. Computed
              from the stored window profiles; one carries the years the other bleeds. */}
          {combos.length > 0 && (
            <div className="rounded-xl border border-line lg-glass p-4 mb-6">
              <div className="flex items-center gap-2 mb-1">
                <Wrench className="w-4 h-4 text-accent" />
                <p className="text-sm font-semibold">Suggested combinations</p>
                <span className="text-[10px] text-dim">· complementary pairs that smooth into a consistent whole</span>
              </div>
              <p className="text-[11px] text-dim mb-3">A strategy that decayed and one that only came good recently can, blended 50/50, cover each other's weak years. Cortex found these from the time-window profiles — worth building and testing as one.</p>
              <div className="grid md:grid-cols-2 gap-2">
                {combos.map(({ a, b, blend }) => (
                  <div key={`${a.id}_${b.id}`} className="rounded-lg border border-up/25 bg-up/5 p-3 space-y-1.5">
                    <div className="text-[11px] text-text flex items-center gap-1 flex-wrap">
                      <span className="font-medium truncate max-w-[45%]" title={a.name}>{a.name}</span>
                      <span className="text-dim">+</span>
                      <span className="font-medium truncate max-w-[45%]" title={b.name}>{b.name}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-1 flex-1">
                        {blend.returns.map((r, i) => (
                          <div key={i} className={cn("h-1.5 flex-1 rounded-sm", r > 0.02 ? "bg-up/70" : r < -0.02 ? "bg-down/70" : "bg-line")} />
                        ))}
                      </div>
                      <span className="text-[9px] uppercase tracking-wide text-up font-semibold">consistent blend</span>
                    </div>
                    <p className="text-[10px] text-dim leading-snug">{blend.summary}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Incoming raw research finds — import them into the library above. */}
          <AgentCandidates />

          <div className="rounded-xl border border-line lg-glass p-4">
            <div className="flex items-center gap-2 mb-3">
              <Grid3x3 className="w-4 h-4 text-accent" />
              <p className="text-sm font-semibold">Correlation matrix — validated + paper</p>
              <span className="text-[10px] text-dim">daily returns, shared days</span>
            </div>
            <CorrMatrix entries={corrSet} />
          </div>
        </>
      )}
    </div>
  );
}
