import { useState } from "react";
import { Sparkles, Loader2, Check, ShieldCheck, AlertTriangle, Grid3x3, Dices } from "lucide-react";
import { cn, fmtNum } from "@/lib/utils";
import { runBacktest } from "@/lib/backtest";
import { optimize, walkForward, parameterHeatmap, monteCarloParams, candidateValues } from "@/lib/optimizer";

// A spread of parameter sets across the space (coarse grid, sampled down) — so
// the Monte-Carlo runs on the whole family, not one optimised point.
function sampleParamSets(params, maxSets = 16) {
  let combos = [{}];
  for (const p of params) {
    const vals = candidateValues(p, 3);
    const next = [];
    for (const c of combos) for (const v of vals) next.push({ ...c, [p.key]: v });
    combos = next;
  }
  if (combos.length <= maxSets) return combos;
  const stride = combos.length / maxSets;
  return Array.from({ length: maxSets }, (_, i) => combos[Math.floor(i * stride)]);
}

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
// Verdicts for the parameter-stability map — a picture of over-fitting.
const HM_VERDICT = {
  robust: { cls: "text-up", label: "Robust plateau", hint: "good values cluster together — being a step off still works" },
  mixed: { cls: "text-accent", label: "Mixed", hint: "the peak has some slope around it — usable, but pick a value inside the good zone" },
  overfit: { cls: "text-down", label: "Overfit spike", hint: "the best cell is a lone island — those params are luck, not edge" },
  flat: { cls: "text-dim", label: "Flat", hint: "the objective barely changes across the grid — this pair isn't the sensitive one" },
  empty: { cls: "text-dim", label: "No valid cells", hint: "every combination was degenerate (too few trades)" },
};
// Score → colour. Red (worst) → amber → green (best), null cells greyed out.
function cellColor(v, min, max) {
  if (v == null) return "rgba(120,120,130,0.10)";
  const t = max > min ? (v - min) / (max - min) : 1; // 0..1
  const hue = 8 + t * 132; // 8=red, 140=green
  return `hsl(${hue} 70% ${18 + t * 22}%)`;
}

export default function OptimizerPanel({ strategy, candles, capital, feeBps, positionPct, leverage, onApply }) {
  const [method, setMethod] = useState("bayesian");
  const [objective, setObjective] = useState("sharpe");
  const [running, setRunning] = useState(false);
  const [res, setRes] = useState(null);   // { method, results, best }
  const [wf, setWf] = useState(null);     // walk-forward verdict
  const [applied, setApplied] = useState(false);
  const [hm, setHm] = useState(null);     // parameter-stability heatmap
  const [hmRunning, setHmRunning] = useState(false);
  const [mc, setMc] = useState(null);     // Monte-Carlo across parameter sets
  const [mcRunning, setMcRunning] = useState(false);

  const params = strategy?.params || [];
  const score = OBJECTIVES[objective].get;
  // Default the two heatmap axes to the strategy's first two params.
  const [xKey, setXKey] = useState(params[0]?.key);
  const [yKey, setYKey] = useState(params[1]?.key ?? params[0]?.key);

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

  // Build the stability map for the two chosen axes, holding the other params at
  // their current builder values (so the picture is around the point you'd trade).
  const runHeatmap = () => {
    if (!xKey || !yKey || xKey === yKey) return;
    setHmRunning(true); setHm(null);
    setTimeout(() => {
      try {
        const base = Object.fromEntries(params.map((p) => [p.key, p.default]));
        setHm(parameterHeatmap({ params, xKey, yKey, evaluate: (p) => scoreSlice(p), base, cap: 9 }));
      } finally { setHmRunning(false); }
    }, 30);
  };

  // Monte-Carlo: for a spread of parameter sets, bootstrap each strategy's own
  // trade returns into a distribution, and report how many stay profitable at
  // the 5th percentile — the family's robustness, not a single point's luck.
  const runMonteCarlo = () => {
    setMcRunning(true); setMc(null);
    setTimeout(() => {
      try {
        const paramSets = sampleParamSets(params, 16);
        const backtest = (p) => {
          const r = runBacktest({ candles, signalFn: strategy.build(p), initialCapital: capital, feeBps, positionPct, leverage });
          if (r.metrics.tradeCount < 5) return null;
          return r.trades.map((t) => t.pnlPct / 100); // fractional per-trade returns
        };
        setMc(monteCarloParams({ paramSets, backtest, runs: 400 }));
      } finally { setMcRunning(false); }
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

      {/* Parameter-stability heatmap — sweep two params, see whether the good
          zone is a plateau (robust) or a lone spike (over-fit). */}
      {params.length >= 2 && (
        <div className="border-t border-line pt-3 space-y-2">
          <div className="flex flex-wrap items-end gap-3">
            <p className="text-xs font-semibold flex items-center gap-1.5 mr-1">
              <Grid3x3 className="w-3.5 h-3.5 text-accent" /> Stability map
            </p>
            <label className="text-xs text-dim">X axis
              <select value={xKey} onChange={(e) => setXKey(e.target.value)} className="input-base w-full mt-1">
                {params.map((p) => <option key={p.key} value={p.key}>{p.key}</option>)}
              </select>
            </label>
            <label className="text-xs text-dim">Y axis
              <select value={yKey} onChange={(e) => setYKey(e.target.value)} className="input-base w-full mt-1">
                {params.map((p) => <option key={p.key} value={p.key}>{p.key}</option>)}
              </select>
            </label>
            <button onClick={runHeatmap} disabled={hmRunning || xKey === yKey} className="btn-ghost text-xs flex items-center gap-2">
              {hmRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Grid3x3 className="w-4 h-4" />}
              {hmRunning ? "Mapping…" : "Map stability"}
            </button>
            {xKey === yKey && <span className="text-[10px] text-down">pick two different params</span>}
          </div>

          {hm?.best && (() => {
            const v = HM_VERDICT[hm.verdict] || HM_VERDICT.flat;
            return (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-xs">
                  <span className={cn("font-semibold", v.cls)}>{v.label}</span>
                  <span className="text-dim">— {v.hint}</span>
                  <span className="ml-auto text-dim">stability <span className="font-mono text-text">{Math.round(hm.robustness * 100)}%</span></span>
                </div>
                <div className="overflow-x-auto">
                  <table className="border-separate" style={{ borderSpacing: 2 }}>
                    <tbody>
                      {hm.cells.map((row, jj) => {
                        // Rows render top = highest Y, so reverse for a natural chart.
                        const j = hm.ys.length - 1 - jj;
                        return (
                          <tr key={j}>
                            <td className="text-[9px] text-dim font-mono pr-1 text-right align-middle">{fmtNum(hm.ys[j], 2)}</td>
                            {hm.cells[j].map((val, i) => {
                              const isBest = hm.best.i === i && hm.best.j === j;
                              return (
                                <td key={i}
                                  title={`${hm.xKey}=${hm.xs[i]} · ${hm.yKey}=${hm.ys[j]} → ${val == null ? "n/a" : fmtNum(val, 2)}`}
                                  className={cn("w-7 h-7 rounded-sm text-center align-middle", isBest && "ring-2 ring-white/80")}
                                  style={{ background: cellColor(val, hm.min, hm.max) }}>
                                  {isBest && <Check className="w-3 h-3 inline text-white" />}
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })}
                      <tr>
                        <td />
                        {hm.xs.map((xv, i) => (
                          <td key={i} className="text-[9px] text-dim font-mono text-center pt-1">{fmtNum(xv, 2)}</td>
                        ))}
                      </tr>
                    </tbody>
                  </table>
                </div>
                <p className="text-[10px] text-dim">
                  Colour = {OBJECTIVES[objective].label} (green best, red worst). X = <span className="font-mono">{hm.xKey}</span>,
                  Y = <span className="font-mono">{hm.yKey}</span>, other params at their defaults. The white cell is the peak — trade a value INSIDE the green zone, not on a lone bright cell.
                </p>
              </div>
            );
          })()}
          {hm && !hm.best && <p className="text-[11px] text-down">Every combination was degenerate (too few trades) — widen the ranges or use more data.</p>}
        </div>
      )}

      {/* Monte-Carlo across parameter sets — resample each set's own trades into a
          distribution, so "profitable" comes with a confidence, and judged across
          the whole family rather than one lucky optimised point. */}
      <div className="border-t border-line pt-3 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs font-semibold flex items-center gap-1.5">
            <Dices className="w-3.5 h-3.5 text-accent" /> Monte-Carlo robustness
          </p>
          <span className="text-[10px] text-dim">· bootstraps trades across a spread of parameter sets</span>
          <button onClick={runMonteCarlo} disabled={mcRunning} className="ml-auto btn-ghost text-xs flex items-center gap-2">
            {mcRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Dices className="w-4 h-4" />}
            {mcRunning ? "Resampling…" : "Run Monte-Carlo"}
          </button>
        </div>

        {mc && (() => {
          const v = VERDICT[mc.verdict] || VERDICT["n/a"];
          const rep = mc.representative?.mc;
          return (
            <div className={cn("rounded-lg border p-3 text-xs space-y-2", v.cls)}>
              <div className="flex items-center gap-2 font-semibold">
                <v.Icon className="w-4 h-4" /> Monte-Carlo: {mc.verdict}
                <span className="font-normal opacity-80">— {mc.robustCount}/{mc.valid} parameter sets profitable at the 5th percentile</span>
              </div>
              {rep ? (
                <div className="space-y-1 font-mono opacity-90">
                  <p>Typical set · {rep.trades} trades × {rep.runs} resamples:</p>
                  <p>
                    return <span className="text-down">P5 {fmtNum(rep.retP5, 0)}%</span> ·
                    <span className="text-text"> median {fmtNum(rep.retMed, 0)}%</span> ·
                    <span className="text-up"> P95 {fmtNum(rep.retP95, 0)}%</span>
                  </p>
                  <p>
                    worst-case drawdown <span className="text-down">P95 {fmtNum(rep.ddP95, 0)}%</span> ·
                    profitable in <span className={rep.pProfit >= 0.9 ? "text-up" : "text-down"}>{Math.round(rep.pProfit * 100)}%</span> of resamples
                  </p>
                </div>
              ) : <p className="font-mono opacity-80">No parameter set produced enough trades to resample — widen the ranges or use more data.</p>}
              <p className="opacity-75 text-[10px]">
                Each set's own trades are drawn with replacement 400× and compounded. A 5th-percentile return that's still positive across most sets = a real edge; a great median with a deeply negative P5 = sequence luck. Judging one optimised set here would flatter it — that's why it runs the whole family.
              </p>
            </div>
          );
        })()}
      </div>
    </div>
  );
}
