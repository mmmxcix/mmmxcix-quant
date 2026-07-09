import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { FlaskConical, Sigma, GraduationCap, ChevronRight } from "lucide-react";
import MonteCarloPanel from "@/components/MonteCarloPanel";
import { buildPlaygroundReturns, expectancyR } from "@/lib/montecarlo";
import { cn, fmtNum } from "@/lib/utils";

// Lab — the experimentation page: what does an edge (win rate + R-multiples +
// risk per trade) actually FEEL like across a thousand alternate histories?
// Complements the Backtest page, whose results feed the same Monte Carlo panel.

function Field({ label, value, onChange, min, max, step = 1, suffix }) {
  return (
    <label className="text-xs text-dim">
      {label}
      <div className="flex items-center gap-1 mt-1">
        <input
          type="number" value={value} min={min} max={max} step={step}
          onChange={(e) => onChange(+e.target.value)}
          className="input-base w-full font-mono"
        />
        {suffix && <span className="text-dim font-mono text-xs shrink-0">{suffix}</span>}
      </div>
    </label>
  );
}

export default function Lab() {
  const [winRate, setWinRate] = useState(45);
  const [avgWinR, setAvgWinR] = useState(1.3);
  const [avgLossR, setAvgLossR] = useState(1.0);
  const [riskPct, setRiskPct] = useState(1.0);

  const clamped = {
    winRate: Math.min(95, Math.max(5, winRate || 0)),
    avgWinR: Math.min(20, Math.max(0.1, avgWinR || 0.1)),
    avgLossR: Math.min(20, Math.max(0.1, avgLossR || 0.1)),
    riskPct: Math.min(10, Math.max(0.1, riskPct || 0.1)),
  };

  const exp = expectancyR(clamped);
  const returns = useMemo(
    () => buildPlaygroundReturns({ ...clamped, trades: 200 }),
    [clamped.winRate, clamped.avgWinR, clamped.avgLossR, clamped.riskPct] // eslint-disable-line react-hooks/exhaustive-deps
  );

  return (
    <div className="max-w-5xl">
      <p className="text-[10px] tracking-[0.3em] text-dim uppercase mb-1">Experiment</p>
      <div className="flex items-center gap-2 mb-2">
        <FlaskConical className="w-6 h-6 text-accent" />
        <h1 className="text-xl sm:text-2xl font-bold">Lab — Monte Carlo playground</h1>
      </div>
      <p className="text-sm text-dim mb-6 max-w-2xl">
        Define an edge as numbers — win rate, average win/loss in R, risk per trade — and watch a
        thousand alternate futures of that same edge unfold. This is how professionals size
        strategies: not by the one backtest they got, but by the distribution it comes from.
      </p>

      <div className="grid lg:grid-cols-[300px_1fr] gap-6">
        {/* ── Edge definition ─────────────────────────────────────────── */}
        <div className="space-y-4">
          <div className="rounded-xl border border-line lg-glass p-4 space-y-3">
            <p className="text-xs text-dim uppercase tracking-widest">Your edge</p>
            <Field label="Win rate" value={winRate} onChange={setWinRate} min={5} max={95} suffix="%" />
            <div className="grid grid-cols-2 gap-2">
              <Field label="Avg win" value={avgWinR} onChange={setAvgWinR} min={0.1} max={20} step={0.1} suffix="R" />
              <Field label="Avg loss" value={avgLossR} onChange={setAvgLossR} min={0.1} max={20} step={0.1} suffix="R" />
            </div>
            <Field label="Risk per trade (1R)" value={riskPct} onChange={setRiskPct} min={0.1} max={10} step={0.1} suffix="% equity" />

            <div className={cn("rounded-lg border p-3", exp > 0 ? "border-up/40 bg-up/10" : "border-down/40 bg-down/10")}>
              <p className="text-[10px] text-dim mb-0.5">Expectancy per trade</p>
              <p className={cn("font-mono text-lg font-bold", exp > 0 ? "text-up" : "text-down")}>
                {exp > 0 ? "+" : ""}{fmtNum(exp, 3)} R
              </p>
              <p className="text-[11px] text-dim mt-1 leading-relaxed">
                = {clamped.winRate}% × {fmtNum(clamped.avgWinR, 1)}R − {100 - clamped.winRate}% × {fmtNum(clamped.avgLossR, 1)}R
                {exp > 0
                  ? " — a real edge. The fan shows how bumpy its road still is."
                  : " — negative: no position size or luck fixes this. Improve the edge first."}
              </p>
            </div>
          </div>

          {/* Presets */}
          <div className="rounded-xl border border-line lg-glass p-4 space-y-2">
            <p className="text-xs text-dim uppercase tracking-widest">Presets</p>
            {[
              { name: "Realistic intraday edge", note: "45% · 1.3R/1R · 1% risk", v: [45, 1.3, 1.0, 1.0] },
              { name: "High win rate, bad R", note: "85% · 0.3R/1.5R — looks great, isn't", v: [85, 0.3, 1.5, 1.0] },
              { name: "Trend follower", note: "35% · 2.5R/1R — few wins, big ones", v: [35, 2.5, 1.0, 1.0] },
              { name: "Oversized gambler", note: "Same edge, 5% risk — watch the DDs", v: [45, 1.3, 1.0, 5.0] },
            ].map((p) => (
              <button key={p.name}
                onClick={() => { setWinRate(p.v[0]); setAvgWinR(p.v[1]); setAvgLossR(p.v[2]); setRiskPct(p.v[3]); }}
                className="w-full text-left rounded-lg border border-line hover:border-accent/40 px-3 py-2 transition-colors">
                <p className="text-sm text-text">{p.name}</p>
                <p className="text-[11px] text-dim font-mono">{p.note}</p>
              </button>
            ))}
          </div>

          <div className="rounded-xl border border-line lg-glass p-4">
            <p className="flex items-center gap-1.5 text-xs text-dim uppercase tracking-widest mb-2">
              <GraduationCap className="w-4 h-4" /> Learn the method
            </p>
            <div className="flex flex-col gap-1.5">
              <Link to="/academy?c=futures-prop&l=fp-validation-toolkit" className="text-sm text-accent hover:underline inline-flex items-center gap-1">
                The validation toolkit <ChevronRight className="w-3.5 h-3.5" />
              </Link>
              <Link to="/academy?c=futures-prop&l=fp-expectancy-r" className="text-sm text-accent hover:underline inline-flex items-center gap-1">
                Expectancy &amp; R-multiples <ChevronRight className="w-3.5 h-3.5" />
              </Link>
              <Link to="/backtest" className="text-sm text-accent hover:underline inline-flex items-center gap-1">
                Run it on a real backtest <ChevronRight className="w-3.5 h-3.5" />
              </Link>
            </div>
          </div>
        </div>

        {/* ── Simulation ──────────────────────────────────────────────── */}
        <div className="rounded-xl border border-line lg-glass p-4">
          <p className="flex items-center gap-1.5 text-xs text-dim uppercase tracking-widest mb-3">
            <Sigma className="w-4 h-4" /> Monte Carlo — 1000 alternate histories of this edge
          </p>
          <MonteCarloPanel
            returns={returns}
            initialCapital={10000}
            defaultSteps={200}
            defaultLimitPct={4}
            note="Default loss limit is 4% — a 50K prop account's $2,000 trailing drawdown. Every path resamples the same edge; the spread between the 5% and 95% lines is pure ordering luck. If the red share is meaningful, the edge is fine but the SIZE is wrong."
          />
        </div>
      </div>
    </div>
  );
}
