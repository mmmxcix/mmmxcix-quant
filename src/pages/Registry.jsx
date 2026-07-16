import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Boxes, Trash2, ChevronRight, Skull, ShieldCheck, FlaskConical, Rocket, Grid3x3, Info } from "lucide-react";
import {
  getEntries, subscribeRegistry, setStatus, removeEntry, STATUS_META, correlationMatrix,
} from "@/lib/registry";
import { cn, fmtPct, fmtNum } from "@/lib/utils";

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
        <span className="text-[#2dd4bf]">Teal = uncorrelated/opposite</span> (good — diversified),{" "}
        <span className="text-down">red = move together</span> (cluster risk: they lose on the same days).
      </p>
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

      {entries.length === 0 ? (
        <div className="rounded-xl border border-line lg-glass p-8 text-center text-sm text-dim">
          No strategies yet. Run a backtest and click <span className="text-accent">“Save to registry”</span> under the result.
        </div>
      ) : (
        <>
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
