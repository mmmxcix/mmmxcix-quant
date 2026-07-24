import { useMemo, useState } from "react";
import { Scale, RefreshCw } from "lucide-react";
import { simulateAS } from "@/lib/avellaneda";
import { cn, fmtNum } from "@/lib/utils";

// The Avellaneda-Stoikov market-making simulator — "don't quote the mid,
// quote your reservation price". One knob (risk aversion γ) tunes the whole
// book: raise it and inventory hugs zero, lower it and the book earns more
// spread while riding bigger positions. Move the slider and FEEL the
// control problem the 2008 paper solved.

const PANELS = [
  { key: "quotes", label: "Mid, bid & ask quotes" },
  { key: "inv", label: "Inventory (skew pulls it back to 0)" },
  { key: "pnl", label: "P&L (mark-to-market)" },
];

function Panel({ title, children, height = 110 }) {
  return (
    <div>
      <p className="text-[10px] font-medium text-dim mb-1">{title}</p>
      <div className="rounded-lg border border-line/60 bg-bg/30 overflow-hidden">{children}</div>
      <div style={{ height: 0 }} />
    </div>
  );
}

function LineSvg({ series, height = 110, zeroLine = false }) {
  // series: [{ data, color, width?, dash?, opacity? }]
  const W = 640, H = height;
  const all = series.flatMap((s) => s.data).filter(Number.isFinite);
  if (!all.length) return null;
  const min = Math.min(...all), max = Math.max(...all), rng = max - min || 1;
  const n = series[0].data.length;
  const X = (i) => (i / (n - 1)) * W;
  const Y = (v) => 6 + (1 - (v - min) / rng) * (H - 12);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full block" style={{ height }}>
      {zeroLine && min < 0 && max > 0 && (
        <line x1="0" x2={W} y1={Y(0)} y2={Y(0)} stroke="rgb(var(--c-line))" strokeDasharray="3 4" />
      )}
      {series.map((s, si) => (
        <polyline key={si}
          points={s.data.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ")}
          fill="none" stroke={s.color} strokeWidth={s.width || 1.3}
          strokeDasharray={s.dash || "none"} opacity={s.opacity ?? 0.95}
          vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      ))}
    </svg>
  );
}

export default function MMSim() {
  const [gamma, setGamma] = useState(0.1);
  const [k, setK] = useState(1.5);
  const [sigma, setSigma] = useState(2);
  const [seed, setSeed] = useState(7);

  const sim = useMemo(() => simulateAS({ gamma, k, sigma, seed }), [gamma, k, sigma, seed]);
  // Same seed, γ at the extremes — so the tradeoff is visible side by side.
  const cmp = useMemo(() => ({
    tight: simulateAS({ gamma: 0.5, k, sigma, seed }).summary,
    loose: simulateAS({ gamma: 0.02, k, sigma, seed }).summary,
  }), [k, sigma, seed]);

  const s = sim.summary;

  return (
    <div>
      <div className="grid lg:grid-cols-[320px_1fr] gap-6 [&>*]:min-w-0">
        {/* controls */}
        <div className="space-y-4">
          <div className="rounded-xl border border-line lg-glass p-4 space-y-4">
            <p className="text-xs text-dim font-medium">Avellaneda-Stoikov</p>
            <label className="block text-xs text-dim">
              <div className="flex justify-between mb-1">
                <span>Risk aversion γ — <em>the</em> knob</span>
                <span className="font-mono text-accent">{gamma.toFixed(3)}</span>
              </div>
              <input type="range" min={-2} max={0} step={0.02} value={Math.log10(gamma)}
                onChange={(e) => setGamma(+(10 ** +e.target.value).toFixed(3))}
                className="w-full accent-current" />
              <div className="flex justify-between text-[10px] text-dim mt-0.5">
                <span>0.01 · earn spread, ride swings</span><span>1.0 · hug flat inventory</span>
              </div>
            </label>
            <label className="block text-xs text-dim">
              <div className="flex justify-between mb-1">
                <span>Order-arrival decay k</span>
                <span className="font-mono">{k.toFixed(1)}</span>
              </div>
              <input type="range" min={0.3} max={5} step={0.1} value={k}
                onChange={(e) => setK(+e.target.value)} className="w-full accent-current" />
              <p className="text-[10px] text-dim mt-0.5">how fast fills die off as you quote away from the mid</p>
            </label>
            <label className="block text-xs text-dim">
              <div className="flex justify-between mb-1">
                <span>Volatility σ ($/√day)</span>
                <span className="font-mono">{sigma.toFixed(1)}</span>
              </div>
              <input type="range" min={0.5} max={6} step={0.1} value={sigma}
                onChange={(e) => setSigma(+e.target.value)} className="w-full accent-current" />
            </label>
            <button onClick={() => setSeed((x) => x + 1)} className="chip chip-idle flex items-center gap-1.5">
              <RefreshCw className="w-3 h-3" /> New random day (seed {seed})
            </button>
          </div>

          {/* metrics */}
          <div className="rounded-xl border border-line lg-glass p-4">
            <p className="text-xs text-dim font-medium mb-2">This session</p>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs font-mono">
              <span className="text-dim">Final P&L</span>
              <span className={cn("text-right font-semibold", s.finalPnl >= 0 ? "text-up" : "text-down")}>{s.finalPnl >= 0 ? "+" : ""}{fmtNum(s.finalPnl, 2)}</span>
              <span className="text-dim">Fills</span><span className="text-right">{s.fills}</span>
              <span className="text-dim">Max |inventory|</span><span className="text-right">{s.maxAbsInv}</span>
              <span className="text-dim">End inventory</span><span className="text-right">{s.endInv}</span>
              <span className="text-dim">Avg total spread</span><span className="text-right">{s.avgSpread}</span>
            </div>
          </div>

          {/* the tradeoff, quantified */}
          <div className="rounded-xl border border-line lg-glass p-4">
            <div className="flex items-center gap-2 mb-2">
              <Scale className="w-4 h-4 text-accent" />
              <p className="text-xs text-dim font-medium">Same day, two temperaments</p>
            </div>
            <table className="w-full text-xs font-mono">
              <tbody>
                <tr className="border-b border-line/40">
                  <td className="py-1 text-dim font-sans">γ = 0.02 (greedy)</td>
                  <td className={cn("text-right", cmp.loose.finalPnl >= 0 ? "text-up" : "text-down")}>{cmp.loose.finalPnl >= 0 ? "+" : ""}{fmtNum(cmp.loose.finalPnl, 0)}</td>
                  <td className="text-right text-dim">max inv {cmp.loose.maxAbsInv}</td>
                </tr>
                <tr>
                  <td className="py-1 text-dim font-sans">γ = 0.50 (careful)</td>
                  <td className={cn("text-right", cmp.tight.finalPnl >= 0 ? "text-up" : "text-down")}>{cmp.tight.finalPnl >= 0 ? "+" : ""}{fmtNum(cmp.tight.finalPnl, 0)}</td>
                  <td className="text-right text-dim">max inv {cmp.tight.maxAbsInv}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* charts */}
        <div className="rounded-xl border border-line lg-glass p-4 space-y-4">
          <Panel title="Mid (grey), reservation price (amber), bid & ask (teal)">
            <LineSvg height={150} series={[
              { data: sim.mid, color: "rgb(var(--c-dim))", opacity: 0.8 },
              { data: sim.resv, color: "var(--viz-amber)", width: 1.6 },
              { data: sim.bid, color: "var(--viz-teal)", opacity: 0.6 },
              { data: sim.ask, color: "var(--viz-teal)", opacity: 0.6 },
            ]} />
          </Panel>
          <Panel title="Inventory — the skew's whole job is pulling this to zero">
            <LineSvg height={110} zeroLine series={[{ data: sim.inv, color: "var(--viz-purple)", width: 1.6 }]} />
          </Panel>
          <Panel title="P&L, mark-to-market">
            <LineSvg height={110} zeroLine series={[{ data: sim.pnl, color: "rgb(var(--c-up))", width: 1.6 }]} />
          </Panel>
          <p className="text-[11px] text-dim leading-relaxed">
            Watch the amber reservation price detach from the grey mid whenever inventory builds —
            long inventory pushes quotes DOWN to attract sellers' counterparties, short pushes them up.
            That skew, not the spread, is the paper's whole point.
          </p>
        </div>
      </div>

      <p className="text-xs text-dim mt-4 leading-relaxed max-w-3xl">
        Faithful to Avellaneda-Stoikov (2008): r = s − qγσ²(T−t), total spread γσ²(T−t) + (2/γ)ln(1+γ/k),
        Poisson fills λ(δ) = A·e^(−kδ). What the model assumes away — and why real market making is
        harder: σ is known here (it isn't), fills are independent of WHO trades (adverse selection is
        the real killer), and there's no queue position, no fees, no other market makers. Educational
        simulator — the L3 order-book archive in Macro is the real-world data to test these ideas on.
      </p>
    </div>
  );
}
