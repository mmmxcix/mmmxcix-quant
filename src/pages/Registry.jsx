import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Boxes, Trash2, Skull, ShieldCheck, FlaskConical, Rocket, Grid3x3, Info, Send, Loader2, Check } from "lucide-react";
import {
  getEntries, subscribeRegistry, setStatus, removeEntry, STATUS_META, correlationMatrix, saveEntry,
} from "@/lib/registry";
import { cn, fmtPct, fmtNum } from "@/lib/utils";
import { PROFILES } from "@/lib/profiles";
import { byId, costFor, describeMarkets } from "@/lib/markets";
import CopyButton from "@/components/CopyButton";

const PROFILE_LABEL = Object.fromEntries(Object.entries(PROFILES).map(([id, p]) => [id, p.label]));

// Survivors of the autonomous research loop (pushed by the PC's research
// agent into lab:candidates). Private: only renders when the dev token exists.
function AgentCandidates() {
  const [items, setItems] = useState(undefined); // undefined = loading/no token
  const [imported, setImported] = useState({});
  const token = (() => { try { return localStorage.getItem("quant_dev_token") || ""; } catch { return ""; } })();

  useEffect(() => {
    if (!token) { setItems(null); return; }
    fetch("/api/lab?what=candidates", { headers: { "x-lab-token": token } })
      .then((r) => (r.ok ? r.json() : null))
      .then((out) => setItems(out?.candidates?.items || []))
      .catch(() => setItems([]));
  }, [token]);

  if (!token || items === null || items === undefined || items.length === 0) return null;

  // Import into the market the strategy was actually validated on — importing
  // everything as BTC 4h (as this used to) would silently misrepresent a rule
  // that only ever worked on, say, EUR/USD daily.
  const importOne = (c) => {
    const mid = c.bestMarket || (c.markets || [])[0];
    const mk = mid ? byId(mid) : null;
    const row = (c.byMarket?.[mid]) || Object.values(c.byMarket || {})[0] || {};
    saveEntry({
      name: `[research] ${c.name.slice(0, 46)}${mk ? ` · ${mk.label}` : ""}`,
      market: mk ? (mk.asset === "crypto" ? "crypto" : "stock") : "crypto",
      symbol: mk?.symbol || "BTCUSDT",
      interval: mk?.interval || "4h",
      range: "max",
      mode: "code", code: c.code, positionPct: 100,
      feeBps: mk ? costFor(mk) : 10,
      metrics: { totalReturnPct: row.ret ?? 0, profitFactor: row.pf ?? 0, maxDrawdownPct: row.dd ?? 0, tradeCount: row.n ?? 0 },
      equity: [],
      validation: { wf: "pass", dsr: "pass", noise: "pass" }, // it survived the agent's gauntlet
      status: "factory", // still: re-run it yourself before trusting it
    });
    setImported((s) => ({ ...s, [c.id]: true }));
  };

  return (
    <div className="rounded-xl border border-accent/30 lg-glass p-4 mb-6">
      <div className="flex items-center gap-2 mb-1">
        <FlaskConical className="w-4 h-4 text-accent" />
        <p className="text-sm font-semibold">Agent research candidates</p>
        <span className="text-[10px] text-dim uppercase tracking-wide">· found &amp; validated by your research agent · private</span>
      </div>
      <p className="text-[11px] text-dim mb-3">
        Each survived: profitable on BTC 4h AND SPY 1d after costs, k-fold, noise test, and the Deflated Sharpe hurdle
        at the agent's cumulative trial count — then re-checked on fresh data by the daytime re-validator. The badge
        shows which account regime it qualified for. Copy the code, or import it to re-run in the Backtest yourself.
      </p>
      <div className="space-y-2">
        {items.map((c) => (
          <div key={c.id} className="rounded-lg border border-line bg-bg/40 px-3 py-2">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="text-sm text-text flex-1 min-w-[200px]">{c.name}</span>
              {(c.profiles || []).map((p) => (
                <span key={p} className={cn(
                  "text-[9px] uppercase tracking-wide rounded px-1.5 py-0.5 font-semibold",
                  p === "prop" ? "bg-accent/15 text-accent" : "bg-up/10 text-up"
                )}>{PROFILE_LABEL[p] || p}</span>
              ))}
              <span className="text-[11px] font-mono text-dim">
                DSR {c.dsr}%
                {c.revalidatedDsr != null && c.revalidatedDsr !== c.dsr && (
                  <span className={c.revalidatedDsr >= c.dsr ? "text-up" : "text-dim"}> → {c.revalidatedDsr}%</span>
                )}
              </span>
            </div>

            {/* Where it works. A strategy is not good in the abstract — it is
                good on a venue, and burying that would misrepresent it. */}
            {(c.markets || []).length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                {c.markets.map((mid) => {
                  const row = c.byMarket?.[mid] || {};
                  const mk = byId(mid);
                  return (
                    <span key={mid}
                      title={`${row.ret ?? "?"}% · PF ${row.pf ?? "?"} · dd ${row.dd ?? "?"}% · n=${row.n ?? "?"}`}
                      className="text-[10px] font-mono rounded border border-up/30 bg-up/5 text-up px-1.5 py-0.5">
                      {mk?.label || mid}
                      {row.ret != null && <span className="text-dim/80"> {row.ret}%</span>}
                    </span>
                  );
                })}
                {c.marketsTested > (c.markets?.length || 0) && (
                  <span className="text-[10px] text-dim/60">
                    of {c.marketsTested} tested · {describeMarkets(c.markets)}
                  </span>
                )}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 mt-1.5">
              <span className="text-[10px] text-dim/70">
                {c.source}{c.kind && c.kind !== "paper" ? ` · ${c.kind}` : ""}
                {c.readFullText ? " · full text" : " · abstract only"}
              </span>
              {c.paper && <a href={c.paper} target="_blank" rel="noopener noreferrer" className="text-[11px] text-accent hover:underline">source</a>}
              <span className="flex-1" />
              <CopyButton text={c.code} label="Copy code" />
              <button onClick={() => importOne(c)} disabled={imported[c.id]}
                className={cn("chip !text-[11px]", imported[c.id] ? "chip-idle text-up" : "chip-idle hover:text-accent")}>
                {imported[c.id] ? "✓ imported" : "Import to Registry"}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const COLS = [
  { id: "factory", icon: FlaskConical, tone: "text-accent" },
  { id: "validated", icon: ShieldCheck, tone: "text-up" },
  { id: "paper", icon: Rocket, tone: "text-blue-400" },
  { id: "graveyard", icon: Skull, tone: "text-dim" },
];

// Where each status can move next (forward promote + bury).
const MOVES = {
  factory: [["validated", "Promote"], ["graveyard", "Bury"]],
  validated: [["paper", "Go paper"], ["graveyard", "Bury"]],
  paper: [["validated", "Pause"], ["graveyard", "Bury"]],
  graveyard: [["factory", "Revive"]],
};

function verdictDot(v) {
  if (v === "pass") return "bg-up";
  if (v === "fail") return "bg-down";
  return "bg-line";
}

function Card({ e }) {
  const m = e.metrics;
  const val = e.validation || {};
  return (
    <div className="rounded-lg border border-line bg-bg/40 p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-text truncate">{e.name}</p>
          <p className="text-[10px] text-dim font-mono">{e.symbol} · {e.interval} · {e.mode}{e.positionPct != null ? ` · ${e.positionPct}%` : ""}</p>
        </div>
        <button onClick={() => removeEntry(e.id)} title="Delete" className="text-dim/50 hover:text-down transition-colors shrink-0">
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {m && (
        <div className="grid grid-cols-3 gap-x-2 gap-y-0.5 text-[11px] font-mono">
          <span className="text-dim">ret</span><span className={cn("col-span-2 text-right", m.totalReturnPct >= 0 ? "text-up" : "text-down")}>{fmtPct(m.totalReturnPct)}</span>
          <span className="text-dim">PF</span><span className="col-span-2 text-right text-text">{fmtNum(m.profitFactor, 2)}</span>
          <span className="text-dim">maxDD</span><span className="col-span-2 text-right text-down">-{fmtNum(m.maxDrawdownPct, 0)}%</span>
          <span className="text-dim">trades</span><span className="col-span-2 text-right text-text">{m.tradeCount}</span>
        </div>
      )}

      {/* validation verdict dots */}
      <div className="flex items-center gap-3 text-[10px] text-dim">
        <span className="flex items-center gap-1" title="Walk-forward / k-fold"><span className={cn("w-1.5 h-1.5 rounded-full", verdictDot(val.wf))} /> WF</span>
        <span className="flex items-center gap-1" title="Deflated Sharpe Ratio"><span className={cn("w-1.5 h-1.5 rounded-full", verdictDot(val.dsr))} /> DSR</span>
        <span className="flex items-center gap-1" title="Price-noise robustness"><span className={cn("w-1.5 h-1.5 rounded-full", verdictDot(val.noise))} /> Noise</span>
      </div>

      {e.note && <p className="text-[10px] text-dim italic leading-snug">“{e.note}”</p>}

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
    const token = (() => { try { return localStorage.getItem("quant_dev_token") || ""; } catch { return ""; } })();
    if (!token) { setMsg({ err: true, text: "Dev token missing — unlock the Coach page once in this browser first." }); return; }
    setBusy(true);
    setMsg(null);
    try {
      const payload = paper.map((e) => ({
        id: e.id, name: e.name, market: e.market, symbol: e.symbol, interval: e.interval,
        mode: e.mode, strategyId: e.strategyId, params: e.params, code: e.code,
        positionPct: e.positionPct ?? 100, feeBps: e.feeBps ?? 10,
      }));
      const res = await fetch("/api/lab", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, strategies: payload }),
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
          paper.length === 0 ? "border-line text-dim/50" : "border-blue-400/40 text-blue-400 hover:bg-blue-400/10")}>
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

  const byStatus = useMemo(() => {
    const g = { factory: [], validated: [], paper: [], graveyard: [] };
    for (const e of entries) (g[e.status] || g.factory).push(e);
    return g;
  }, [entries]);

  const corrSet = useMemo(
    () => entries.filter((e) => e.status === "paper" || e.status === "validated"),
    [entries]
  );

  return (
    <div className="max-w-6xl">
      <p className="text-[10px] tracking-[0.3em] text-dim uppercase mb-1">Strategy Lab</p>
      <div className="flex items-center gap-2 mb-2">
        <Boxes className="w-6 h-6 text-accent" />
        <h1 className="text-xl sm:text-2xl font-bold">Registry</h1>
      </div>
      <p className="text-sm text-dim mb-6 max-w-2xl">
        Your strategy notebook. Save a backtest from the{" "}
        <Link to="/backtest" className="text-accent hover:underline">Backtest</Link> page, then move each idea
        through its lifecycle: <span className="text-accent">Factory</span> → <span className="text-up">Validated</span> → <span className="text-blue-400">Paper</span>,
        or bury the failures in the <span className="text-dim">Graveyard</span>. Stored in this browser.
      </p>

      <AgentCandidates />

      {entries.length === 0 ? (
        <div className="rounded-xl border border-line lg-glass p-8 text-center text-sm text-dim">
          No strategies yet. Run a backtest and click <span className="text-accent">“Save to registry”</span> under the result.
        </div>
      ) : (
        <>
          <PublishToAgent entries={entries} />
          <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-4 mb-8">
            {COLS.map((col) => {
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
                      ? <p className="text-[11px] text-dim/60 px-1 py-4 text-center">empty</p>
                      : list.map((e) => <Card key={e.id} e={e} />)}
                  </div>
                </div>
              );
            })}
          </div>

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
