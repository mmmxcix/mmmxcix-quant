import { useState } from "react";
import { Play, Loader2, AlertTriangle, ListOrdered } from "lucide-react";
import Skeleton from "@/components/Skeleton";
import { fetchCandles } from "@/lib/data";
import { STOCK_UNIVERSE } from "@/lib/screener";
import { buildRankingRows, runMlRanking, RANK_FEATURES } from "@/lib/mlStudio";
import { cn, fmtPct, fmtNum } from "@/lib/utils";

// Cross-sectional ranking — the form of equity ML that actually has a track
// record: rank ~50 liquid names by expected RELATIVE next-month performance
// (momentum/vol/52w-high features), monthly rebalance, strict time split with
// a 1-month embargo. Headline metric is the rank IC — and the verdict says
// plainly when it's statistically noise.

function MetricCard({ label, value, sub, tone = "text-text" }) {
  return (
    <div className="rounded-xl border border-line lg-glass px-4 py-3">
      <p className="text-[11px] text-dim mb-1">{label}</p>
      <p className={cn("font-mono font-semibold text-lg", tone)}>{value}</p>
      {sub && <p className="text-xs text-dim mt-0.5">{sub}</p>}
    </div>
  );
}

function RankCurve({ curve, height = 220 }) {
  const [hov, setHov] = useState(null);
  const n = curve.months.length;
  if (n < 2) return null;
  const all = [...curve.top, ...curve.uni];
  const min = Math.min(...all), max = Math.max(...all), rng = max - min || 1;
  const W = 600, H = height;
  const X = (i) => (i / (n - 1)) * W;
  const Y = (v) => H - 6 - ((v - min) / rng) * (H - 16);
  const line = (arr) => arr.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    setHov(Math.round(frac * (n - 1)));
  };
  const hx = hov != null ? (hov / (n - 1)) * 100 : 0;
  return (
    <div className="relative" onPointerMove={onMove} onPointerLeave={() => setHov(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full block" style={{ height }} aria-hidden="true">
        <polyline points={line(curve.uni)} fill="none" stroke="var(--viz-blue)" strokeWidth="1.5" opacity="0.75"
          vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        <polyline points={line(curve.top)} fill="none" stroke="var(--viz-amber)" strokeWidth="2"
          vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      </svg>
      {hov != null && (
        <>
          <div className="absolute top-0 bottom-0 w-px bg-text/20 pointer-events-none" style={{ left: `${hx}%` }} />
          <div className="absolute top-1 pointer-events-none rounded-lg border border-line bg-bg/95 px-2.5 py-1.5 text-[11px] font-mono whitespace-nowrap"
            style={{ left: `${hx}%`, transform: hx > 55 ? "translateX(calc(-100% - 10px))" : "translateX(10px)" }}>
            <span style={{ color: "var(--viz-amber)" }}>top {((curve.top[hov] - 1) * 100).toFixed(1)}%</span>
            <span className="ml-2" style={{ color: "var(--viz-blue)" }}>universe {((curve.uni[hov] - 1) * 100).toFixed(1)}%</span>
            <span className="text-dim ml-2">{curve.months[hov]}</span>
          </div>
        </>
      )}
    </div>
  );
}

const NAME_OF = Object.fromEntries(STOCK_UNIVERSE.map((e) => [e[0], e[1]]));

export default function MLRanking() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [out, setOut] = useState(null);

  const run = async () => {
    if (status) return;
    setError(null);
    setOut(null);
    try {
      const symbols = STOCK_UNIVERSE.map((e) => e[0]);
      const bySym = {};
      let done = 0, failed = 0;
      // Modest concurrency so ~50 symbols don't hammer the proxy at once.
      const queue = [...symbols];
      const worker = async () => {
        while (queue.length) {
          const sym = queue.shift();
          try {
            const cs = await fetchCandles({ market: "stock", symbol: sym, interval: "1d", range: "5y" });
            if (cs.length >= 300) bySym[sym] = cs;
            else failed++;
          } catch { failed++; }
          done++;
          setStatus(`Loading history ${done}/${symbols.length}…`);
        }
      };
      setStatus(`Loading history 0/${symbols.length}…`);
      await Promise.all(Array.from({ length: 8 }, worker));
      const loaded = Object.keys(bySym).length;
      if (loaded < 25) throw new Error(`only ${loaded} symbols loaded — data source having a bad day, try again`);
      setStatus("Building monthly features…");
      const rows = buildRankingRows(bySym);
      const res = await runMlRanking(rows, setStatus);
      setOut({ ...res, loaded, failed });
    } catch (e) {
      setError(e.message);
    } finally {
      setStatus(null);
    }
  };

  const verdict = out && (
    Math.abs(out.icT) >= 2
      ? out.icMean > 0
        ? { tone: "text-up", text: `Mean rank IC ${out.icMean.toFixed(3)} over ${out.monthsTested} unseen months (t=${out.icT.toFixed(1)}) — a real, if modest, cross-sectional signal. Professional equity factors live around IC 0.02–0.06; costs and crowding eat part of it.` }
        : { tone: "text-down", text: `Mean rank IC ${out.icMean.toFixed(3)} (t=${out.icT.toFixed(1)}) — significantly NEGATIVE: the model ranks stocks the wrong way around out-of-sample.` }
      : { tone: "text-dim", text: `Mean rank IC ${out.icMean.toFixed(3)} over ${out.monthsTested} unseen months (t=${out.icT.toFixed(1)}) — statistically indistinguishable from noise on this window. Momentum factors go through long dead spells; that's the honest read.` }
  );

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-line lg-glass p-4 flex flex-wrap items-center gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold mb-0.5">Rank {STOCK_UNIVERSE.length} liquid US names by expected relative next-month performance</p>
          <p className="text-xs text-dim leading-relaxed">
            Features: 12-1/6-1/3/1-month momentum, 3-month volatility, distance to the 52-week high.
            Random Forest, monthly rebalance, trained on the first ~70% of months with a 1-month embargo —
            every reported number comes from months the model never saw.
          </p>
        </div>
        <button onClick={run} disabled={!!status} className="btn-accent flex items-center gap-2 disabled:opacity-50 shrink-0">
          {status ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
          {status || "Run ranking"}
        </button>
      </div>
      {error && (
        <p className="text-xs text-down flex items-start gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {error}
        </p>
      )}
      {status && !out && <Skeleton className="h-64 w-full rounded-xl" />}

      {out && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <MetricCard label="Mean rank IC" value={out.icMean.toFixed(3)}
              sub="pred vs realized rank corr. / month"
              tone={out.icT >= 2 && out.icMean > 0 ? "text-up" : "text-text"} />
            <MetricCard label="IC t-stat" value={out.icT.toFixed(2)} sub="≥ 2 ≈ statistically real" />
            <MetricCard label="Top − bottom spread" value={fmtPct(out.spread * 100)}
              sub="per month, frictionless" tone={out.spread > 0 ? "text-up" : "text-down"} />
            <MetricCard label="Window" value={`${out.monthsTested} mo`}
              sub={`test · ${out.loaded} symbols${out.failed ? ` · ${out.failed} failed` : ""}`} />
          </div>

          {verdict && (
            <div className="rounded-xl border border-line lg-glass p-4">
              <p className={cn("text-sm leading-relaxed", verdict.tone)}>{verdict.text}</p>
            </div>
          )}

          <div className="rounded-xl border border-line lg-glass p-4">
            <p className="text-sm font-semibold mb-2">Out-of-sample: top quintile vs equal-weight universe</p>
            <RankCurve curve={out.curve} />
            <p className="text-[11px] text-dim mt-2">
              <span style={{ color: "var(--viz-amber)" }}>■</span> top 20% by model rank, rebalanced monthly
              (frictionless) · <span style={{ color: "var(--viz-blue)" }}>■</span> whole universe equal-weight
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            <div className="rounded-xl border border-line lg-glass p-4">
              <div className="flex items-center gap-2 mb-2">
                <ListOrdered className="w-4 h-4 text-accent" />
                <p className="text-sm font-semibold">Current top 10 — model rank for {out.liveMonth}</p>
              </div>
              <table className="w-full text-sm">
                <tbody>
                  {out.picks.map((p, i) => (
                    <tr key={p.sym} className="border-b border-line/40 last:border-0">
                      <td className="py-1.5 text-xs text-dim font-mono w-6">{i + 1}</td>
                      <td className="py-1.5 font-mono font-semibold">{p.sym}
                        <span className="text-dim font-sans font-normal ml-2 hidden sm:inline text-xs">{NAME_OF[p.sym] || ""}</span>
                      </td>
                      <td className="py-1.5 text-right font-mono text-xs">{fmtPct(p.mom * 100)} <span className="text-dim">12-1m</span></td>
                      <td className={cn("py-1.5 text-right font-mono text-xs font-semibold", p.score >= 0 ? "text-up" : "text-down")}>
                        {fmtPct(p.score * 100)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-[11px] text-dim mt-2">Score = model's expected next-month return. A ranking signal, not investment advice.</p>
            </div>
            <div className="rounded-xl border border-line lg-glass p-4">
              <p className="text-sm font-semibold mb-3">What the ranking looks at</p>
              <div className="space-y-1.5">
                {RANK_FEATURES.map((name, i) => {
                  const val = out.importances[i] ?? 0;
                  const maxV = Math.max(...out.importances, 1e-9);
                  return (
                    <div key={name} className="flex items-center gap-2">
                      <span className="text-xs text-dim w-32 shrink-0">{name}</span>
                      <div className="flex-1 h-2 rounded-sm bg-line/40 overflow-hidden">
                        <div className="h-full rounded-sm" style={{ width: `${Math.max(2, (val / maxV) * 90)}%`, background: "var(--viz-purple)" }} />
                      </div>
                      <span className="text-[10px] text-dim font-mono w-10 text-right">{(val * 100).toFixed(1)}%</span>
                    </div>
                  );
                })}
              </div>
              <p className="text-[11px] text-dim mt-3 leading-relaxed">
                Trained on {out.monthsTrained} months. This is the classic momentum/quality factor family —
                the model mostly rediscovers 12-1 momentum, which is exactly what the literature predicts.
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
