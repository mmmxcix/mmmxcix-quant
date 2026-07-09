import { useMemo, useState } from "react";
import { Dices, ShieldAlert } from "lucide-react";
import XYLineChart from "@/components/XYLineChart";
import { runMonteCarlo, breachProbabilityPct, histogram } from "@/lib/montecarlo";
import { cn, fmtNum, fmtPct } from "@/lib/utils";

// Reusable bootstrap-Monte-Carlo panel. Feed it per-trade fractional returns
// (from a real backtest or the Lab's expectancy playground) and it renders the
// outcome distribution: equity percentile fan, headline stats, the drawdown
// histogram, and a prop-firm-style loss-limit breach check.

// One teal family for the fan (one entity — the same strategy's equity),
// darker toward the extremes; the median is the solid accent line.
const BAND_STYLE = {
  0.05: { color: "#2dd4bf3a", label: "5%" },
  0.25: { color: "#2dd4bf80", label: "25%" },
  0.5:  { color: "#2dd4bf",   label: "Median" },
  0.75: { color: "#2dd4bf80", label: "75%" },
  0.95: { color: "#2dd4bf3a", label: "95%" },
};

function Stat({ label, value, tone = "text-text" }) {
  return (
    <div className="rounded-lg border border-line bg-bg/40 px-3 py-2">
      <p className="text-[10px] text-dim mb-0.5">{label}</p>
      <p className={cn("font-mono text-sm font-semibold", tone)}>{value}</p>
    </div>
  );
}

// Drawdown histogram: thin rounded bars in one hue, hover readout per bar,
// with the loss limit drawn as a reference line.
function DrawdownHistogram({ maxDDs, limitPct, height = 150 }) {
  const [hover, setHover] = useState(null);
  const bins = useMemo(() => histogram(maxDDs.map((d) => d * 100), 24), [maxDDs]);
  if (!bins.length) return null;
  const maxCount = Math.max(...bins.map((b) => b.count));
  const w = 640, padL = 8, padR = 8, padT = 8, padB = 20;
  const iw = w - padL - padR, ih = height - padT - padB;
  const xLo = bins[0].x0, xHi = bins[bins.length - 1].x1;
  const sx = (x) => padL + ((x - xLo) / (xHi - xLo || 1)) * iw;
  const barW = Math.max(2, iw / bins.length - 2); // 2px surface gap between bars

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${w} ${height}`} className="w-full" preserveAspectRatio="none" style={{ height }}>
        {bins.map((b, i) => {
          const h = maxCount ? (b.count / maxCount) * ih : 0;
          const breach = limitPct > 0 && b.x0 >= limitPct;
          return (
            <rect
              key={i}
              x={sx(b.x0) + 1}
              y={padT + ih - h}
              width={barW}
              height={Math.max(b.count > 0 ? 2 : 0, h)}
              rx="2"
              fill={breach ? "#ef4444" : "#2dd4bf"}
              opacity={hover === i ? 1 : 0.75}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            />
          );
        })}
        {limitPct > 0 && limitPct >= xLo && limitPct <= xHi && (
          <g>
            <line x1={sx(limitPct)} y1={padT} x2={sx(limitPct)} y2={padT + ih} stroke="#ef4444" strokeDasharray="3 3" />
            <text x={sx(limitPct) + 4} y={padT + 10} fontSize="9" fill="#ef4444" fontFamily="monospace">limit</text>
          </g>
        )}
        {/* x labels: lo / mid / hi */}
        {[xLo, (xLo + xHi) / 2, xHi].map((t, i) => (
          <text key={i} x={sx(t)} y={height - 6} fontSize="10" fill="#64748b" fontFamily="monospace"
            textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"}>
            -{fmtNum(t, 1)}%
          </text>
        ))}
      </svg>
      {hover !== null && bins[hover] && (
        <div className="absolute top-1 right-2 rounded-lg border border-line bg-surface/90 backdrop-blur px-2.5 py-1.5 text-[11px] font-mono pointer-events-none">
          <div className="text-dim">DD −{fmtNum(bins[hover].x0, 1)}% to −{fmtNum(bins[hover].x1, 1)}%</div>
          <div className="text-text">{bins[hover].count} paths ({fmtNum((bins[hover].count / maxDDs.length) * 100, 1)}%)</div>
        </div>
      )}
    </div>
  );
}

export default function MonteCarloPanel({
  returns,
  initialCapital = 10000,
  defaultSteps,
  defaultLimitPct = 20,
  note,
}) {
  const [paths, setPaths] = useState(1000);
  const [steps, setSteps] = useState(defaultSteps || returns.length);
  const [limitPct, setLimitPct] = useState(defaultLimitPct);
  const [seed, setSeed] = useState(1);

  const mc = useMemo(
    () => runMonteCarlo({ returns, paths, steps, initialCapital, seed }),
    [returns, paths, steps, initialCapital, seed]
  );

  const fanSeries = useMemo(() => {
    if (!mc.bands.length) return [];
    // Draw outer bands first so the median renders on top.
    const order = [0.05, 0.95, 0.25, 0.75, 0.5];
    return order.map((q) => {
      const band = mc.bands.find((b) => b.q === q);
      return {
        label: BAND_STYLE[q].label,
        color: BAND_STYLE[q].color,
        points: band.values.map((v, i) => ({ x: i, y: v })),
      };
    });
  }, [mc]);

  const breach = breachProbabilityPct(mc.maxDDs, limitPct);
  const s = mc.stats;

  if (!returns.length) return null;

  return (
    <div className="space-y-3">
      {/* Controls */}
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-dim">
          Paths
          <select value={paths} onChange={(e) => setPaths(+e.target.value)} className="input-base w-full mt-1 font-mono">
            {[500, 1000, 2000].map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        <label className="text-xs text-dim">
          Trades per path
          <input type="number" min={10} max={5000} value={steps}
            onChange={(e) => setSteps(Math.max(10, +e.target.value || 10))}
            className="input-base w-full mt-1 font-mono" style={{ maxWidth: 110 }} />
        </label>
        <label className="text-xs text-dim">
          Loss limit (% of capital)
          <input type="number" min={1} max={99} step={0.5} value={limitPct}
            onChange={(e) => setLimitPct(Math.max(0, +e.target.value || 0))}
            className="input-base w-full mt-1 font-mono" style={{ maxWidth: 110 }} />
        </label>
        <button onClick={() => setSeed((x) => x + 1)} className="btn-ghost flex items-center gap-1.5 text-xs !py-2">
          <Dices className="w-3.5 h-3.5" /> Re-roll
        </button>
      </div>

      {/* Headline stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
        <Stat label="P(end ≤ start)" value={fmtPct(s.pLossPct).replace("+", "")}
          tone={s.pLossPct > 5 ? "text-down" : "text-up"} />
        <Stat label="Median return" value={fmtPct(s.medianReturnPct)}
          tone={s.medianReturnPct >= 0 ? "text-up" : "text-down"} />
        <Stat label="5%–95% return" value={`${fmtPct(s.p5ReturnPct)} … ${fmtPct(s.p95ReturnPct)}`} tone="text-text" />
        <Stat label="Median max DD" value={`-${fmtNum(s.medianMaxDDPct, 1)}%`} tone="text-down" />
        <Stat label="95th pct max DD" value={`-${fmtNum(s.p95MaxDDPct, 1)}%`} tone="text-down" />
      </div>

      {/* Loss-limit verdict */}
      <div className={cn("flex items-start gap-2 rounded-lg border p-3",
        breach > 10 ? "border-down/40 bg-down/10" : breach > 2 ? "border-yellow-500/40 bg-yellow-500/10" : "border-up/40 bg-up/10")}>
        <ShieldAlert className={cn("w-4 h-4 shrink-0 mt-0.5", breach > 10 ? "text-down" : breach > 2 ? "text-yellow-400" : "text-up")} />
        <p className="text-xs leading-relaxed text-text/90">
          <span className="font-mono font-semibold">{fmtNum(breach, 1)}%</span> of simulated paths hit a{" "}
          <span className="font-mono">−{fmtNum(limitPct, 1)}%</span> drawdown at some point.
          {breach > 10
            ? " At a prop firm with this loss limit, this size would likely blow the account — reduce size or improve the edge."
            : breach > 2
              ? " Survivable, but a normal unlucky streak can still end the account — consider a size buffer."
              : " The loss limit is rarely reached at this size — a healthy buffer."}
        </p>
      </div>

      {/* Equity fan */}
      <div>
        <div className="flex items-center justify-between px-1 pb-1">
          <p className="text-xs text-dim">Equity paths — percentile fan ({fmtNum(mc.finals.length, 0)} bootstrapped paths)</p>
          <div className="flex items-center gap-3 text-[10px] font-mono">
            <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 rounded" style={{ background: "#2dd4bf" }} /> <span className="text-dim">median</span></span>
            <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 rounded" style={{ background: "#2dd4bf80" }} /> <span className="text-dim">25–75%</span></span>
            <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 rounded" style={{ background: "#2dd4bf3a" }} /> <span className="text-dim">5–95%</span></span>
          </div>
        </div>
        <XYLineChart
          series={fanSeries}
          height={260}
          zeroLine={false}
          fmtX={(v) => `#${Math.round(v)}`}
          fmtY={(v) => (Math.abs(v) >= 10000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v)))}
        />
      </div>

      {/* Drawdown distribution */}
      <div>
        <p className="text-xs text-dim px-1 pb-1">Max-drawdown distribution across paths (red = beyond your loss limit)</p>
        <DrawdownHistogram maxDDs={mc.maxDDs} limitPct={limitPct} />
      </div>

      {note && <p className="text-[11px] text-dim/80 leading-relaxed">{note}</p>}
    </div>
  );
}
