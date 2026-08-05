import { useMemo, useState } from "react";
import { Sparkles, Loader2, Check, Grid3x3 } from "lucide-react";
import { cn, fmtNum } from "@/lib/utils";
import { runBacktest, compileStrategy } from "@/lib/backtest";
import { runPythonSignals, signalsToFn } from "@/lib/pyRunner";
import { codeParamSpace, substituteConstants, candidateValues } from "@/lib/optimizer";
import MonteCarloPanel from "@/components/MonteCarloPanel";

// Optimizer for HAND-WRITTEN strategies (custom code, JS or Python) — the same
// idea as the builder OptimizerPanel, but it works on the UPPER_CASE constants it
// detects in your code, and it runs ASYNC because Python signals are computed per
// candle set through Pyodide. One grid sweep powers all three views: the best
// params, a stability heatmap, and a Monte-Carlo over the whole param family.

const OBJECTIVES = {
  sharpe: { label: "Sharpe", get: (m) => m.sharpe },
  sortino: { label: "Sortino", get: (m) => (Number.isFinite(m.sortino) ? m.sortino : 5) },
  calmar: { label: "Calmar", get: (m) => (Number.isFinite(m.calmar) ? m.calmar : 5) },
  return: { label: "Total return", get: (m) => m.totalReturnPct },
  profitFactor: { label: "Profit factor", get: (m) => (Number.isFinite(m.profitFactor) ? Math.min(m.profitFactor, 10) : 0) },
};

// Full grid of param combos, capped so a Python sweep stays tractable.
function gridCombos(params, cap, maxCombos) {
  let combos = [{}];
  for (const p of params) {
    const vals = candidateValues(p, cap);
    const next = [];
    for (const c of combos) for (const v of vals) next.push({ ...c, [p.key]: v });
    combos = next;
  }
  if (combos.length > maxCombos) {
    const stride = combos.length / maxCombos;
    combos = Array.from({ length: maxCombos }, (_, i) => combos[Math.floor(i * stride)]);
  }
  return combos;
}

function heatColor(t) {
  // t in [0,1] → red(low) → yellow → green(high)
  if (t == null || Number.isNaN(t)) return "rgba(100,116,139,0.15)";
  const r = t < 0.5 ? 239 : Math.round(239 - (t - 0.5) * 2 * (239 - 45));
  const g = t < 0.5 ? Math.round(68 + t * 2 * (200 - 68)) : 200;
  return `rgba(${r},${g},${t < 0.5 ? 68 : 90},0.85)`;
}

export default function CodeOptimizerPanel({ code, language, candles, capital, feeBps, positionPct, leverage, onApply }) {
  const params = useMemo(() => codeParamSpace(code), [code]);
  const [obj, setObj] = useState("sharpe");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [results, setResults] = useState(null); // sorted desc by score
  const [applied, setApplied] = useState(false);
  const [xKey, setXKey] = useState(params[0]?.key);
  const [yKey, setYKey] = useState(params[1]?.key ?? params[0]?.key);
  const [sweepLev, setSweepLev] = useState(false); // also search for the best leverage

  // Leverage is not a code constant, so it's swept separately: each param combo
  // is re-run at each of these multipliers and the best (params × leverage) wins.
  const LEV_GRID = [1, 2, 3, 5, 10, 20];

  if (!params.length) {
    return (
      <div className="rounded-xl border border-line lg-glass p-3">
        <div className="flex items-center gap-2 mb-1">
          <Sparkles className="w-4 h-4 text-accent" />
          <p className="text-sm font-semibold">Optimize parameters</p>
        </div>
        <p className="text-[11px] text-dim">
          No tunable constants detected. Declare numeric constants at the top of your code
          (e.g. <span className="font-mono">const lookback = 50</span>, <span className="font-mono">LOOKBACK = 50</span>, or <span className="font-mono">a, b, c = 1, 2, 3</span>) and they'll be optimizable here.
        </p>
      </div>
    );
  }

  async function run() {
    setRunning(true); setResults(null); setApplied(false); setProgress(0);
    const combos = gridCombos(params, 5, language === "python" ? 48 : 220);
    const levs = sweepLev ? LEV_GRID : [leverage];
    const get = OBJECTIVES[obj].get;
    const out = [];
    for (let i = 0; i < combos.length; i++) {
      const src = substituteConstants(code, combos[i]);
      let fn = null;
      try {
        // Compile the signals ONCE per param combo, then sweep leverage cheaply —
        // leverage only changes the fill engine's sizing, not the signals.
        fn = language === "python" ? signalsToFn(await runPythonSignals(src, candles)) : compileStrategy(src);
      } catch { setProgress((i + 1) / combos.length); continue; }
      for (const lev of levs) {
        try {
          const r = runBacktest({ candles, signalFn: fn, initialCapital: capital, feeBps, positionPct, leverage: lev });
          // Keep usable runs only — a liquidation voids the equity curve (common at
          // high leverage), but a stray non-fatal warning shouldn't drop the combo.
          const liquidated = r.warnings.some((w) => /liquidat/i.test(w));
          if (!liquidated && r.metrics.tradeCount > 0) {
            out.push({ params: combos[i], lev, m: r.metrics, score: get(r.metrics), returns: r.trades.map((t) => t.pnlPct / 100) });
          }
        } catch { /* skip a broken combo */ }
      }
      setProgress((i + 1) / combos.length);
      // Yield so the progress bar paints and the tab stays responsive.
      if (i % 4 === 0) await new Promise((res) => setTimeout(res, 0));
    }
    out.sort((a, b) => b.score - a.score);
    setResults(out);
    setRunning(false);
  }

  const best = results?.[0];
  // Pool returns from the top param sets for the family Monte-Carlo.
  const pooledReturns = useMemo(() => {
    if (!results?.length) return [];
    return results.slice(0, 16).flatMap((r) => r.returns);
  }, [results]);

  // Stability heatmap: max score per (xKey, yKey) cell across the sweep.
  const heat = useMemo(() => {
    if (!results?.length || !xKey || !yKey) return null;
    const xs = [...new Set(results.map((r) => r.params[xKey]))].sort((a, b) => a - b);
    const ys = [...new Set(results.map((r) => r.params[yKey]))].sort((a, b) => a - b);
    if (xs.length < 2 && ys.length < 2) return null;
    const cell = new Map();
    let lo = Infinity, hi = -Infinity;
    for (const r of results) {
      const k = `${r.params[xKey]}|${r.params[yKey]}`;
      const cur = cell.get(k);
      if (cur == null || r.score > cur) cell.set(k, r.score);
    }
    for (const v of cell.values()) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    return { xs, ys, cell, lo, hi };
  }, [results, xKey, yKey]);

  return (
    <div className="rounded-xl border border-line lg-glass p-3 space-y-4">
      {/* Optimize */}
      <div>
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <Sparkles className="w-4 h-4 text-accent" />
          <p className="text-sm font-semibold">Optimize parameters</p>
          <span className="text-[10px] text-dim">
            · {params.length} detected ({params.map((p) => p.key).join(", ")}) · {language === "python" ? "Python (Pyodide)" : "JS"}
          </span>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-[10px] text-dim">Maximize
            <select value={obj} onChange={(e) => setObj(e.target.value)} className="input-base block mt-0.5 !py-1 text-xs">
              {Object.entries(OBJECTIVES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-[10px] text-dim cursor-pointer" title="Also search 1× / 2× / 3× / 5× / 10× / 20× and report the best leverage for each param set">
            <input type="checkbox" checked={sweepLev} onChange={(e) => setSweepLev(e.target.checked)} className="accent-current" />
            also find best leverage
          </label>
          <button onClick={run} disabled={running || !candles?.length}
            className="chip chip-idle !text-xs flex items-center gap-1.5 hover:text-accent">
            {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            {running ? `Optimizing… ${Math.round(progress * 100)}%` : "Optimize"}
          </button>
          {language === "python" && <span className="text-[10px] text-dim">Python sweeps are capped at 48 sets (Pyodide).</span>}
        </div>
      </div>

      {best && (
        <div className="rounded-lg border border-up/40 bg-up/5 p-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            <span className="text-up font-semibold">Best {OBJECTIVES[obj].label}: {fmtNum(best.score, 2)}</span>
            <span className="font-mono text-dim">
              {Object.entries(best.params).map(([k, v]) => `${k}=${v}`).join(" · ")}
              {sweepLev && <span className="text-accent"> · {best.lev}x</span>}
            </span>
            <span className="text-dim">ret {fmtNum(best.m.totalReturnPct, 0)}% · maxDD {fmtNum(best.m.maxDrawdownPct, 0)}% · PF {fmtNum(best.m.profitFactor, 2)} · {best.m.tradeCount} trades</span>
            <button
              onClick={() => { onApply(substituteConstants(code, best.params), sweepLev ? best.lev : undefined); setApplied(true); }}
              title={sweepLev ? `Apply the params and set leverage to ${best.lev}x` : "Apply the best params to your code"}
              className="chip chip-idle !text-[10px] ml-auto flex items-center gap-1 hover:text-accent">
              {applied ? <Check className="w-3 h-3 text-up" /> : null} {applied ? "Applied" : sweepLev ? `Apply (+ ${best.lev}x)` : "Apply to code"}
            </button>
          </div>
        </div>
      )}

      {results && results.length > 1 && (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px] font-mono">
            <thead>
              <tr className="text-left text-dim border-b border-line">
                <th className="py-1 pr-3 font-sans font-medium">Params</th>
                {sweepLev && <th className="py-1 pr-3 font-sans font-medium text-right">Lev</th>}
                <th className="py-1 pr-3 font-sans font-medium text-right">{OBJECTIVES[obj].label}</th>
                <th className="py-1 pr-3 font-sans font-medium text-right">Return</th>
                <th className="py-1 pr-3 font-sans font-medium text-right">MaxDD</th>
                <th className="py-1 font-sans font-medium text-right">Trades</th>
              </tr>
            </thead>
            <tbody>
              {results.slice(0, 6).map((r, i) => (
                <tr key={i} className="border-b border-line/40 last:border-0">
                  <td className="py-1 pr-3 text-dim">{Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join(" · ")}</td>
                  {sweepLev && <td className="py-1 pr-3 text-right text-accent">{r.lev}x</td>}
                  <td className="py-1 pr-3 text-right text-text">{fmtNum(r.score, 2)}</td>
                  <td className={cn("py-1 pr-3 text-right", r.m.totalReturnPct >= 0 ? "text-up" : "text-down")}>{fmtNum(r.m.totalReturnPct, 0)}%</td>
                  <td className="py-1 pr-3 text-right text-down">{fmtNum(r.m.maxDrawdownPct, 0)}%</td>
                  <td className="py-1 text-right text-dim">{r.m.tradeCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Stability map */}
      {results && params.length >= 1 && (
        <div className="border-t border-line pt-3">
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <Grid3x3 className="w-4 h-4 text-dim" />
            <p className="text-xs font-semibold">Stability map</p>
            <label className="text-[10px] text-dim ml-2">X
              <select value={xKey} onChange={(e) => setXKey(e.target.value)} className="input-base ml-1 !py-0.5 text-[10px]">
                {params.map((p) => <option key={p.key} value={p.key}>{p.key}</option>)}
              </select>
            </label>
            <label className="text-[10px] text-dim">Y
              <select value={yKey} onChange={(e) => setYKey(e.target.value)} className="input-base ml-1 !py-0.5 text-[10px]">
                {params.map((p) => <option key={p.key} value={p.key}>{p.key}</option>)}
              </select>
            </label>
            <span className="text-[10px] text-dim">— a lone bright cell = luck; a bright neighbourhood = real edge</span>
          </div>
          {heat ? (
            <div className="overflow-x-auto">
              <table className="border-collapse">
                <tbody>
                  {heat.ys.map((y) => (
                    <tr key={y}>
                      <td className="text-[9px] text-dim font-mono pr-1 text-right">{y}</td>
                      {heat.xs.map((x) => {
                        const v = heat.cell.get(`${x}|${y}`);
                        const t = v == null ? null : heat.hi > heat.lo ? (v - heat.lo) / (heat.hi - heat.lo) : 0.5;
                        return <td key={x} title={`${xKey}=${x}, ${yKey}=${y} → ${v == null ? "—" : fmtNum(v, 2)}`}
                          style={{ background: heatColor(t) }} className="w-5 h-5 border border-bg/40" />;
                      })}
                    </tr>
                  ))}
                  <tr><td /> {heat.xs.map((x) => <td key={x} className="text-[9px] text-dim font-mono text-center">{x}</td>)}</tr>
                </tbody>
              </table>
            </div>
          ) : <p className="text-[11px] text-dim">Run the optimizer with ≥2 values on an axis to map stability.</p>}
        </div>
      )}

      {/* Monte-Carlo across the whole param family */}
      {pooledReturns.length >= 10 && (
        <div className="border-t border-line pt-3">
          <p className="text-xs font-semibold mb-2">Monte-Carlo robustness <span className="text-[10px] text-dim font-normal">· resamples trades pooled across the top param sets</span></p>
          <MonteCarloPanel
            returns={pooledReturns}
            initialCapital={capital}
            defaultSteps={Math.min(pooledReturns.length, best?.m.tradeCount || pooledReturns.length)}
            defaultLimitPct={20}
            note="Bootstraps trades pooled from the best parameter sets — if the edge only survives one exact combo, this exposes it. Size against the 95th-percentile drawdown, not the single backtest's."
          />
        </div>
      )}
    </div>
  );
}
