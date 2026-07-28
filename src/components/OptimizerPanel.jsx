import { useState } from "react";
import { Sparkles, Loader2, Check, ShieldCheck, AlertTriangle } from "lucide-react";
import { cn, fmtNum } from "@/lib/utils";
import { runBacktest } from "@/lib/backtest";
import { optimize, walkForward } from "@/lib/optimizer";

// Parameter optimizer for a built-in (builder-mode) strategy: sweep its params
// with Grid / Bayesian / Genetic search against a selectable objective, then
// (optionally) walk-forward to check the winning params aren't just over-fit.
// Runs on the candles the last backtest loaded — no refetch.

const OBJECTIVES = {
  sharpe: { label: "Sharpe", get: (m) => m.sharpe },
  sortino: { label: "Sortino", get: (m) => (Number.isFinite(m.sortino) ? m.sortino : 5) },
  calmar: { label: "Calmar", get: (m) => (Number.isFinite(m.calmar) ? m.calmar : 5) },
  return: { label: "Total return", get: (m) => m.totalReturnPct },
  profitFactor: { label: "Profit factor", get: (m) => (Number.isFinite(m.profitFactor) ? Math.min(m.profitFactor, 10) : 0) },
};
const METHODS = { bayesian: "Bayesian", grid: "Grid", genetic: "Genetic" };
const VERDICT = {
  robust: { cls: "border-up/40 bg-up/10 text-up", Icon: ShieldCheck, hint: "out-of-sample held up" },
  fragile: { cls: "border-accent/40 bg-accent/10 text-accent", Icon: AlertTriangle, hint: "weaker out-of-sample" },
  overfit: { cls: "border-down/40 bg-down/10 text-down", Icon: AlertTriangle, hint: "edge vanished out-of-sample" },
  inconclusive: { cls: "border-line bg-bg text-dim", Icon: AlertTriangle, hint: "too few out-of-sample trades — use a longer/intraday history" },
  "n/a": { cls: "border-line bg-bg text-dim", Icon: AlertTriangle, hint: "not enough data" },
};

export default function OptimizerPanel({ strategy, candles, capital, feeBps, positionPct, leverage, onApply }) {
  const [method, setMethod] = useState("bayesian");
  const [objective, setObjective] = useState("sharpe");
  const [running, setRunning] = useState(false);
  const [res, setRes] = useState(null);   // { method, results, best }
  const [wf, setWf] = useState(null);     // walk-forward verdict
  const [applied, setApplied] = useState(false);

  const params = strategy?.params || [];
  const score = OBJECTIVES[objective].get;

  // Score a candle slice for a param set; penalise degenerate (too few trades).
  const scoreSlice = (p, from, to) => {
    const slice = from === undefined ? candles : candles.slice(from, to);
    const r = runBacktest({ candles: slice, signalFn: strategy.build(p), initialCapital: capital, feeBps, positionPct, leverage });
    if (r.metrics.tradeCount < 5) return -Infinity;
    return score(r.metrics);
  };

  const run = (withWalkForward) => {
    if (!params.length) return;
    setRunning(true); setApplied(false); setRes(null); setWf(null);
    // Yield once so the spinner paints before the (blocking) search loop.
    setTimeout(() => {
      try {
        const out = optimize({ method, params, evaluate: (p) => scoreSlice(p), budget: method === "grid" ? 500 : method === "genetic" ? 240 : 140 });
        setRes(out);
        if (withWalkForward) {
          setWf(walkForward({ params, scoreSlice, n: candles.length, method, folds: 4, budget: 50 }));
        }
      } finally { setRunning(false); }
    }, 30);
  };

  if (!params.length) return null;

  return (
    <div className="rounded-xl border border-accent/30 lg-glass p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Sparkles className="w-4 h-4 text-accent" />
        <p className="text-sm font-semibold">Optimize parameters</p>
        <span className="text-[10px] text-dim">· sweeps {params.length} param{params.length > 1 ? "s" : ""} on the loaded data</span>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-dim">Method
          <select value={method} onChange={(e) => setMethod(e.target.value)} className="input-base w-full mt-1">
            {Object.entries(METHODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label className="text-xs text-dim">Maximize
          <select value={objective} onChange={(e) => setObjective(e.target.value)} className="input-base w-full mt-1">
            {Object.entries(OBJECTIVES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </label>
        <button onClick={() => run(false)} disabled={running} className="btn-accent flex items-center gap-2">
          {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
          {running ? "Optimizing…" : "Optimize"}
        </button>
        <button onClick={() => run(true)} disabled={running} title="Optimize in-sample and score out-of-sample across rolling windows"
          className="btn-ghost text-xs">+ Walk-forward</button>
      </div>

      {res?.best && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-dim">Best ({METHODS[res.method]}, {res.evals} evals):</span>
            <span className="font-mono text-text">
              {params.map((p) => `${p.key}=${res.best.params[p.key]}`).join(" · ")}
            </span>
            <span className="font-mono text-up">{OBJECTIVES[objective].label} {fmtNum(res.best.score, 2)}</span>
            <button
              onClick={() => { onApply?.(res.best.params); setApplied(true); }}
              className="ml-auto btn-ghost text-xs flex items-center gap-1">
              {applied ? <><Check className="w-3.5 h-3.5 text-up" /> applied</> : "Apply to builder"}
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-dim text-[10px] uppercase tracking-wide">
                  {params.map((p) => <th key={p.key} className="text-left font-medium pb-1 pr-3">{p.key}</th>)}
                  <th className="text-right font-medium">{OBJECTIVES[objective].label}</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {res.results.slice(0, 8).map((r, i) => (
                  <tr key={i} className={cn("border-t border-line/40", i === 0 && "text-up")}>
                    {params.map((p) => <td key={p.key} className="py-1 pr-3">{r.params[p.key]}</td>)}
                    <td className="text-right">{fmtNum(r.score, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[10px] text-dim">Grid is the most exhaustive but most over-fit-prone; Bayesian balances; Genetic suits rugged spaces. Always re-check the winner with walk-forward.</p>
        </div>
      )}

      {wf && (() => {
        const v = VERDICT[wf.verdict] || VERDICT["n/a"];
        return (
          <div className={cn("rounded-lg border p-3 text-xs space-y-1.5", v.cls)}>
            <div className="flex items-center gap-2 font-semibold">
              <v.Icon className="w-4 h-4" /> Walk-forward: {wf.verdict}
              <span className="font-normal opacity-80">— {v.hint}</span>
            </div>
            <p className="font-mono opacity-90">
              in-sample {fmtNum(wf.avgIS, 2)} → out-of-sample {fmtNum(wf.avgOOS, 2)} · retention {Math.round(wf.degradation * 100)}% · {wf.validFolds}/{wf.folds.length} folds
            </p>
            <p className="opacity-75 text-[10px]">Params are re-optimized on each in-sample window and scored on the untouched next window. High retention = the edge generalizes; a collapse = the optimizer fit noise.</p>
          </div>
        );
      })()}
    </div>
  );
}
