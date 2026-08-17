import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Telescope, Scale, FileSearch, TrendingDown, Waypoints, Mountain, Box,
  RefreshCw, AlertTriangle,
} from "lucide-react";
import XYLineChart from "@/components/XYLineChart";
import Surface3D from "@/components/Surface3D";
import Heatmap from "@/components/Heatmap";
import { runBAB, scanAccruals, scanShortInterest, FACTOR_UNIVERSE } from "@/lib/factors";
import { computeRegimes } from "@/lib/regimes";
import { simulateDrawdownTopology, histogram } from "@/lib/montecarlo";
import { blackScholesGreeks } from "@/lib/options";
import { cn, fmtNum } from "@/lib/utils";

// Anomalies — six classic quant modules on live data or fair simulation:
// three documented return anomalies (Betting Against Beta, Sloan's accruals,
// short interest) computed over a small liquid universe, plus three pieces of
// risk geometry (correlation regimes, drawdown topology, the Greeks manifold).
// Every module says out loud how well its edge has survived publication.

// Fixed categorical order (never cycled): accent leads, then blue/orange/pink.
// The accent is the app's brand token; all series are also direct-labeled in a
// legend, so identity never rides on color alone.
const C1 = "#2dd4bf", C2 = "#3b82f6", C3 = "#ea580c", C4 = "#ec4899";
const UP = "#10b981", DOWN = "#ef4444";

const fmtDate = (v) =>
  new Date(v * 1000).toLocaleDateString("en-US", { month: "short", year: "2-digit" });
const fmtMoney = (v) => {
  if (v == null || Number.isNaN(v)) return "–";
  const a = Math.abs(v);
  const s = v < 0 ? "−" : "";
  if (a >= 1e12) return `${s}$${(a / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(0)}M`;
  return `${s}$${a.toLocaleString("en-US")}`;
};

// Sequential ramp for density surfaces: dark → deep teal → accent → pale.
function seqColor(t) {
  const stops = [
    [11, 18, 32], [15, 118, 110], [45, 212, 191], [204, 251, 241],
  ];
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const k = x - i;
  const c = stops[i].map((a, j) => Math.round(a + (stops[i + 1][j] - a) * k));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

// Diverging ramp for P&L surfaces: red ← neutral dark → green (0.5 = zero).
function divColor(t) {
  const k = Math.max(0, Math.min(1, t));
  const neutral = [31, 41, 55];
  const to = k >= 0.5 ? [16, 185, 129] : [239, 68, 68];
  const s = Math.abs(k - 0.5) * 2;
  const c = neutral.map((a, j) => Math.round(a + (to[j] - a) * s));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

// ── Shared UI ────────────────────────────────────────────────────────────────

function useLiveData(loadFn) {
  const [state, setState] = useState({ loading: true, data: null, error: null, progress: null });
  const run = () => {
    setState({ loading: true, data: null, error: null, progress: null });
    loadFn((done, total) => setState((s) => (s.loading ? { ...s, progress: { done, total } } : s)))
      .then((data) => setState({ loading: false, data, error: null, progress: null }))
      .catch((e) => setState({ loading: false, data: null, error: e?.message || String(e), progress: null }));
  };
  useEffect(run, []); // eslint-disable-line react-hooks/exhaustive-deps
  return { ...state, retry: run };
}

function Loading({ progress, what }) {
  const pct = progress?.total ? Math.round((progress.done / progress.total) * 100) : null;
  return (
    <div className="rounded-xl border border-line lg-glass p-8 text-center">
      <RefreshCw className="w-5 h-5 text-accent animate-spin mx-auto mb-3" />
      <p className="text-sm text-dim">
        Loading {what}…{pct !== null && ` ${progress.done}/${progress.total} symbols (${pct}%)`}
      </p>
      {pct !== null && (
        <div className="mt-3 mx-auto max-w-xs h-1 rounded bg-surface overflow-hidden">
          <div className="h-full bg-accent transition-all" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

function ErrorNote({ error, onRetry }) {
  return (
    <div className="rounded-xl border border-down/40 bg-down/10 p-4 flex items-start gap-3">
      <AlertTriangle className="w-4 h-4 text-down shrink-0 mt-0.5" />
      <div>
        <p className="text-sm text-text">{error}</p>
        <button onClick={onRetry} className="mt-2 text-xs text-accent hover:underline">Retry</button>
      </div>
    </div>
  );
}

function Chip({ label, value, tone }) {
  return (
    <div className="rounded-lg border border-line lg-glass px-3 py-2 min-w-[7.5rem]">
      <p className="text-[10px] text-dim">{label}</p>
      <p className={cn("font-mono text-sm font-bold", tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-text")}>
        {value}
      </p>
    </div>
  );
}

function Legend({ items }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 mb-2">
      {items.map((it) => (
        <span key={it.label} className="inline-flex items-center gap-1.5 text-[11px] text-dim">
          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: it.color }} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

function Explainer({ research, reality }) {
  return (
    <div className="grid sm:grid-cols-2 gap-3">
      <div className="rounded-xl border border-line lg-glass p-4">
        <p className="text-[10px] text-dim font-medium mb-1.5">The research</p>
        <p className="text-[13px] text-dim leading-relaxed">{research}</p>
      </div>
      <div className="rounded-xl border border-warn/30 bg-warn/5 p-4">
        <p className="text-[10px] text-warn/90 font-medium mb-1.5">Reality check</p>
        <p className="text-[13px] text-dim leading-relaxed">{reality}</p>
      </div>
    </div>
  );
}

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

function QuintileChip({ q, goodIsLow }) {
  const good = goodIsLow ? q <= 2 : q >= 4;
  const bad = goodIsLow ? q >= 4 : q <= 2;
  return (
    <span className={cn(
      "inline-block rounded px-1.5 py-0.5 text-[10px] font-mono border",
      good ? "border-up/40 text-up bg-up/10" : bad ? "border-down/40 text-down bg-down/10" : "border-line text-dim"
    )}>
      Q{q}
    </span>
  );
}

// Signed mini-bar around a centered zero axis (accruals) or one-sided (short%).
function MiniBar({ value, max, centered = false, color }) {
  const k = Math.min(1, Math.abs(value) / (max || 1));
  const col = color || (value >= 0 ? DOWN : UP);
  return (
    <div className="relative h-2 w-24 rounded bg-surface overflow-hidden shrink-0">
      {centered ? (
        <>
          <div className="absolute inset-y-0 left-1/2 w-px bg-line" />
          <div
            className="absolute inset-y-0"
            style={{
              left: value < 0 ? `${50 - k * 50}%` : "50%",
              width: `${k * 50}%`,
              background: col,
              opacity: 0.85,
            }}
          />
        </>
      ) : (
        <div className="absolute inset-y-0 left-0" style={{ width: `${k * 100}%`, background: col, opacity: 0.85 }} />
      )}
    </div>
  );
}

// ── 1. Betting Against Beta ──────────────────────────────────────────────────

function BabTab() {
  const { data, error, loading, progress, retry } = useLiveData((onProgress) => runBAB({ onProgress }));
  if (loading) return <Loading what="5y of daily prices" progress={progress} />;
  if (error) return <ErrorNote error={error} onRetry={retry} />;

  const { curves, stats, snapshot, scatter, meta } = data;
  const legend = [
    { label: "BAB (long low-β / short high-β)", color: C1 },
    { label: "S&P 500 (SPY)", color: C2 },
    { label: "Low-β leg", color: C3 },
    { label: "High-β leg", color: C4 },
  ];
  const low = snapshot.filter((s) => s.bucket === "low");
  const high = snapshot.filter((s) => s.bucket === "high");

  return (
    <div className="space-y-4">
      <Explainer
        research="Frazzini & Pedersen (2014): leverage-constrained investors overpay for high-beta stocks, so risk-adjusted returns FALL as beta rises. BAB buys the low-beta bucket levered to β≈1, shorts the high-beta bucket delevered to β≈1, and rebalances monthly. 1926–2012 the US factor ran a 0.78 Sharpe — roughly twice the value factor."
        reality="The edge has faded since ~2020: crowding into low-vol, expensive financing for the leverage the long leg needs, and compressed beta dispersion. Novy-Marx & Velikov (2022) showed the original construction also overweights illiquid small caps. On this liquid mega-cap universe you see the MECHANICS, not an investable product — and no trading costs are charged."
      />

      {/* A factor sort is a statement about a UNIVERSE. When part of that
          universe could not be fetched, the ranking is a different measurement
          from the one the page claims to be showing — and it used to say
          nothing at all: a rate-limited load ranked a third of the names and
          printed the result as if it were whole. */}
      {meta.unreachable?.length > 0 && (
        <div className="rounded-xl border border-warn/40 bg-warn/5 px-4 py-2.5 text-[12px] leading-relaxed text-warn">
          <b>Partial universe — read the numbers with that in mind.</b>{" "}
          <span className="text-dim">
            {meta.unreachable.length} of {meta.universeSize} symbols could not be loaded
            ({meta.unreachable.slice(0, 8).join(", ")}{meta.unreachable.length > 8 ? "…" : ""}),
            so the sort ranks {meta.nSymbols} names instead of the full set. Usually a rate limit
            on the data proxy — reloading in a minute normally fixes it.
          </span>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Chip label="BAB Sharpe" value={fmtNum(stats.bab.sharpe, 2)} tone={stats.bab.sharpe > 0 ? "up" : "down"} />
        <Chip label="BAB ann. return" value={`${fmtNum(stats.bab.annRetPct, 1)}%`} tone={stats.bab.annRetPct > 0 ? "up" : "down"} />
        <Chip label="BAB max DD" value={`−${fmtNum(stats.bab.maxDDPct, 1)}%`} tone="down" />
        <Chip label="SPY Sharpe" value={fmtNum(stats.market.sharpe, 2)} />
        <Chip label="Leg leverage" value={`${fmtNum(meta.wLong, 2)}× / ${fmtNum(meta.wShort, 2)}×`} />
      </div>

      <div className="rounded-xl border border-line lg-glass p-4">
        <p className="text-xs text-dim font-medium mb-2">
          Growth of 100 — monthly rebalance, {meta.nSymbols} stocks, β window 252d
        </p>
        <Legend items={legend} />
        <XYLineChart
          series={legend.map((l, i) => ({
            label: l.label.split(" (")[0],
            color: l.color,
            points: [curves.bab, curves.market, curves.lowLeg, curves.highLeg][i],
          }))}
          height={320}
          fmtX={fmtDate}
          fmtY={(v) => fmtNum(v, 0)}
          zeroLine={false}
        />
      </div>

      <div className="grid lg:grid-cols-[1fr_320px] gap-4 [&>*]:min-w-0">
        <div className="rounded-xl border border-line lg-glass p-4">
          <p className="text-xs text-dim font-medium mb-1">
            The flat security market line
          </p>
          <p className="text-[11px] text-dim mb-2">
            Full-sample β vs realized return per stock. CAPM says this cloud should slope up steeply — the anomaly is that it usually doesn't.
          </p>
          <XYLineChart
            series={[{ label: "Stocks", color: C2, scatter: true, points: scatter.map((p) => ({ x: p.beta, y: p.annRetPct })) }]}
            height={260}
            fmtX={(v) => `β ${fmtNum(v, 2)}`}
            fmtY={(v) => `${fmtNum(v, 0)}%`}
          />
        </div>
        <div className="rounded-xl border border-line lg-glass p-4 space-y-3">
          <div>
            <p className="text-xs text-dim font-medium mb-1.5">Long today (low β)</p>
            {low.map((s) => (
              <div key={s.symbol} className="flex items-center justify-between text-sm py-0.5">
                <span className="text-text">{s.symbol} <span className="text-dim text-xs">{s.name}</span></span>
                <span className="font-mono text-up">β {fmtNum(s.beta, 2)}</span>
              </div>
            ))}
          </div>
          <div className="border-t border-line pt-2">
            <p className="text-xs text-dim font-medium mb-1.5">Short today (high β)</p>
            {high.map((s) => (
              <div key={s.symbol} className="flex items-center justify-between text-sm py-0.5">
                <span className="text-text">{s.symbol} <span className="text-dim text-xs">{s.name}</span></span>
                <span className="font-mono text-down">β {fmtNum(s.beta, 2)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── 2. Accruals ──────────────────────────────────────────────────────────────

function AccrualsTab() {
  const { data, error, loading, progress, retry } = useLiveData((onProgress) => scanAccruals({ onProgress }));
  if (loading) return <Loading what="annual fundamentals" progress={progress} />;
  if (error) return <ErrorNote error={error} onRetry={retry} />;

  const rows = data.rows;
  if (!rows.length) return <ErrorNote error="No fundamentals available right now." onRetry={retry} />;
  const maxAbs = Math.max(...rows.map((r) => Math.abs(r.accrualsPct)));
  const median = rows[Math.floor(rows.length / 2)].accrualsPct;

  return (
    <div className="space-y-4">
      <Explainer
        research="Sloan (1996): earnings = cash flow + accruals, and the accrual part is less persistent and easier to massage. Firms whose earnings are mostly paper (high accruals) went on to underperform firms whose earnings are cash-backed (low accruals) by ~10%/yr for decades. Score: (net income − operating cash flow) / avg total assets, latest fiscal year."
        reality="This is the textbook case of an arbitraged-away anomaly: returns were unreliable after ~2002 as hedge-fund capital piled in and analysts started publishing cash-flow forecasts. What survives lives in small caps with ugly trading costs. Treat this screen as an earnings-quality lens, not a signal."
      />

      <div className="flex flex-wrap gap-2">
        <Chip label="Universe median" value={`${fmtNum(median, 1)}% of assets`} />
        <Chip label="Most cash-backed" value={`${rows[0].symbol} ${fmtNum(rows[0].accrualsPct, 1)}%`} tone="up" />
        <Chip label="Most paper earnings" value={`${rows[rows.length - 1].symbol} +${fmtNum(rows[rows.length - 1].accrualsPct, 1)}%`} tone="down" />
      </div>

      <div className="rounded-xl border border-line lg-glass p-4 overflow-x-auto">
        <p className="text-xs text-dim font-medium mb-2">
          Ranked by accruals — low (cash-backed) first · latest fiscal year
        </p>
        <table className="w-full text-sm min-w-[640px]">
          <thead>
            <tr className="text-[11px] text-dim uppercase tracking-wider text-left">
              <th className="py-1.5 pr-2 font-medium">#</th>
              <th className="py-1.5 pr-2 font-medium">Symbol</th>
              <th className="py-1.5 pr-2 font-medium text-right">Net income</th>
              <th className="py-1.5 pr-2 font-medium text-right">Op. cash flow</th>
              <th className="py-1.5 pr-2 font-medium text-right">Accruals / assets</th>
              <th className="py-1.5 pr-2 font-medium"></th>
              <th className="py-1.5 font-medium">Bucket</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.symbol} className="border-t border-line/60">
                <td className="py-1.5 pr-2 font-mono text-dim text-xs">{i + 1}</td>
                <td className="py-1.5 pr-2">
                  <span className="text-text font-medium">{r.symbol}</span>{" "}
                  <span className="text-dim text-xs">{r.name}</span>
                  <span className="text-dim text-[10px] font-mono ml-1">FY{r.fiscalYear}</span>
                </td>
                <td className="py-1.5 pr-2 text-right font-mono text-dim">{fmtMoney(r.netIncome)}</td>
                <td className="py-1.5 pr-2 text-right font-mono text-dim">{fmtMoney(r.cfo)}</td>
                <td className={cn("py-1.5 pr-2 text-right font-mono", r.accrualsPct <= 0 ? "text-up" : "text-down")}>
                  {r.accrualsPct > 0 ? "+" : ""}{fmtNum(r.accrualsPct, 1)}%
                </td>
                <td className="py-1.5 pr-2"><MiniBar value={r.accrualsPct} max={maxAbs} centered /></td>
                <td className="py-1.5"><QuintileChip q={r.quintile} goodIsLow /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.missing.length > 0 && (
          <p className="text-[11px] text-dim mt-2">No usable fundamentals: {data.missing.join(", ")}</p>
        )}
      </div>
    </div>
  );
}

// ── 3. Short interest ────────────────────────────────────────────────────────

function ShortTab() {
  const { data, error, loading, progress, retry } = useLiveData((onProgress) => scanShortInterest({ onProgress }));
  if (loading) return <Loading what="short-interest stats" progress={progress} />;
  if (error) return <ErrorNote error={error} onRetry={retry} />;

  const rows = data.rows;
  if (!rows.length) return <ErrorNote error="No short-interest data available right now." onRetry={retry} />;
  const maxPct = Math.max(...rows.map((r) => r.shortPctFloat));
  const median = rows[Math.floor(rows.length / 2)].shortPctFloat;

  return (
    <div className="space-y-4">
      <Explainer
        research="Short sellers are informed traders, but borrow costs and constraints keep their information from being priced in immediately — so heavily shorted stocks have historically UNDERPERFORMED, by up to ~2% per month in the most constrained names. The data (exchange short interest) has been public for decades."
        reality="Still one of the more robust anomalies, but the effect concentrates in speculative-grade names — in liquid mega caps like these it is weak. And harvesting it means shorting exactly where borrow is expensive and squeezes happen (GameStop). Long-only use: treat crowded shorts as a caution flag, not a target."
      />

      <div className="flex flex-wrap gap-2">
        <Chip label="Universe median" value={`${fmtNum(median, 1)}% of float`} />
        <Chip label="Most shorted" value={`${rows[0].symbol} ${fmtNum(rows[0].shortPctFloat, 1)}%`} tone="down" />
        <Chip label="Crowded (>5% float)" value={String(rows.filter((r) => r.shortPctFloat > 5).length)} />
      </div>

      <div className="rounded-xl border border-line lg-glass p-4 overflow-x-auto">
        <p className="text-xs text-dim font-medium mb-2">
          Ranked by short % of float — most shorted first
        </p>
        <table className="w-full text-sm min-w-[640px]">
          <thead>
            <tr className="text-[11px] text-dim uppercase tracking-wider text-left">
              <th className="py-1.5 pr-2 font-medium">#</th>
              <th className="py-1.5 pr-2 font-medium">Symbol</th>
              <th className="py-1.5 pr-2 font-medium text-right">Short % float</th>
              <th className="py-1.5 pr-2 font-medium"></th>
              <th className="py-1.5 pr-2 font-medium text-right">Days to cover</th>
              <th className="py-1.5 pr-2 font-medium text-right">Δ vs prior month</th>
              <th className="py-1.5 font-medium">Bucket</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.symbol} className="border-t border-line/60">
                <td className="py-1.5 pr-2 font-mono text-dim text-xs">{i + 1}</td>
                <td className="py-1.5 pr-2">
                  <span className="text-text font-medium">{r.symbol}</span>{" "}
                  <span className="text-dim text-xs">{r.name}</span>
                  {r.shortPctFloat > 5 && (
                    <span className="ml-1.5 rounded px-1 py-px text-[9px] font-mono border border-down/40 text-down bg-down/10">crowded</span>
                  )}
                </td>
                <td className="py-1.5 pr-2 text-right font-mono text-text">{fmtNum(r.shortPctFloat, 1)}%</td>
                <td className="py-1.5 pr-2"><MiniBar value={r.shortPctFloat} max={maxPct} color={DOWN} /></td>
                <td className="py-1.5 pr-2 text-right font-mono text-dim">{r.daysToCover != null ? fmtNum(r.daysToCover, 1) : "–"}</td>
                <td className={cn("py-1.5 pr-2 text-right font-mono", (r.momChangePct ?? 0) > 0 ? "text-down" : "text-up")}>
                  {r.momChangePct != null ? `${r.momChangePct > 0 ? "+" : ""}${fmtNum(r.momChangePct, 1)}%` : "–"}
                </td>
                <td className="py-1.5"><QuintileChip q={r.quintile} goodIsLow={false} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.missing.length > 0 && (
          <p className="text-[11px] text-dim mt-2">No short data: {data.missing.join(", ")}</p>
        )}
      </div>
    </div>
  );
}

// ── 4. Correlation regimes ───────────────────────────────────────────────────

function RegimesTab() {
  const { data, error, loading, progress, retry } = useLiveData((onProgress) => computeRegimes({ onProgress }));
  if (loading) return <Loading what="cross-asset history" progress={progress} />;
  if (error) return <ErrorNote error={error} onRetry={retry} />;

  const { labels, avgCorr, vol, stressBands, calmMatrix, stressMatrix, stats } = data;
  const bands = stressBands.map((b) => ({ ...b, color: DOWN, opacity: 0.09 }));

  return (
    <div className="space-y-4">
      <Explainer
        research="Asset correlations are regime-dependent: in calm markets a stocks/bonds/gold/crypto basket diversifies, but in stress (2008, March 2020) forced selling and margin calls push correlations toward 1 — diversification fails exactly when it's needed. Regime-switching models capture this; static mean-variance math does not."
        reality="This one is not a return anomaly but a risk fact, and it has NOT decayed — it is structural. Practical use: size positions for the stress-regime correlation matrix, not the calm one, and treat rising average correlation as an early de-risking signal."
      />

      <div className="flex flex-wrap gap-2">
        <Chip label="Avg corr — calm" value={fmtNum(stats.corrCalm, 2)} tone="up" />
        <Chip label="Avg corr — stress" value={fmtNum(stats.corrStress, 2)} tone="down" />
        <Chip label="Diversification ratio calm → stress" value={`${fmtNum(stats.divCalm, 2)} → ${fmtNum(stats.divStress, 2)}`} />
        <Chip label="Time in stress" value={`${fmtNum(stats.stressSharePct, 0)}%`} />
      </div>

      <div className="rounded-xl border border-line lg-glass p-4">
        <p className="text-xs text-dim font-medium mb-2">
          Rolling 30d average pairwise correlation — shaded = high-correlation regime
        </p>
        <Legend items={[{ label: "Avg pairwise correlation (6 assets)", color: C1 }, { label: "Stress regime", color: DOWN }]} />
        <XYLineChart
          series={[{ label: "Avg corr", color: C1, points: avgCorr }]}
          height={240}
          bands={bands}
          fmtX={fmtDate}
          fmtY={(v) => fmtNum(v, 2)}
          zeroLine
        />
      </div>

      <div className="rounded-xl border border-line lg-glass p-4">
        <p className="text-xs text-dim font-medium mb-2">
          Rolling 30d annualized volatility — S&P 500 · same stress shading
        </p>
        <Legend items={[{ label: "SPY realized vol (ann.)", color: C2 }, { label: "Stress regime", color: DOWN }]} />
        <XYLineChart
          series={[{ label: "Vol", color: C2, points: vol }]}
          height={200}
          bands={bands}
          fmtX={fmtDate}
          fmtY={(v) => `${fmtNum(v, 0)}%`}
          zeroLine={false}
        />
      </div>

      <div className="rounded-xl border border-line lg-glass p-4">
        <div className="grid md:grid-cols-2 gap-6">
          <Heatmap labels={labels} matrix={calmMatrix} title="Correlations — calm days" />
          <Heatmap labels={labels} matrix={stressMatrix} title="Correlations — stress days" />
        </div>
        <p className="text-[11px] text-dim mt-3">
          Same assets, same period — only the regime differs. Watch the off-diagonal cells brighten under stress.
        </p>
      </div>
    </div>
  );
}

// ── 5. Drawdown topology ─────────────────────────────────────────────────────

function DrawdownTab() {
  const [mu, setMu] = useState(12);
  const [sigma, setSigma] = useState(22);
  const [days, setDays] = useState(252);
  const [fatProb, setFatProb] = useState(5);
  const [fatScale, setFatScale] = useState(4);

  const sim = useMemo(
    () => simulateDrawdownTopology({
      muPct: Math.max(-50, Math.min(50, mu || 0)),
      sigmaPct: Math.max(1, Math.min(120, sigma || 1)),
      days: Math.max(30, Math.min(1260, days || 252)),
      fatProb: Math.max(0, Math.min(30, fatProb || 0)) / 100,
      fatScale: Math.max(1, Math.min(10, fatScale || 1)),
      paths: 2000,
    }),
    [mu, sigma, days, fatProb, fatScale]
  );

  // Surface rows run 0%→deep DD; flip so "no drawdown" forms the near ridge.
  const grid = sim.surface;
  const bins = useMemo(() => histogram(sim.finals.map((f) => (f - 1) * 100), 28), [sim]);
  const maxCount = Math.max(...bins.map((b) => b.count), 1);

  return (
    <div className="space-y-4">
      <Explainer
        research="Expected return and volatility hide what a strategy feels like to hold. Simulating thousands of fat-tailed paths and mapping the DISTRIBUTION of drawdowns over time shows the real object: a topology where the median path dips a little and the 5% worst paths fall off a cliff."
        reality="This is a model, not a forecast — GBM plus a crude fat-tail mixture. Its value is calibration: if the p95 max drawdown of your assumed edge already breaches your pain threshold (or a prop firm's limit), position size is wrong before you ever trade. Pair with the Lab's per-trade Monte Carlo."
      />

      <div className="grid lg:grid-cols-[260px_1fr] gap-4 [&>*]:min-w-0">
        <div className="rounded-xl border border-line lg-glass p-4 space-y-3 h-fit">
          <p className="text-xs text-dim font-medium">Assumptions</p>
          <Field label="Annual drift" value={mu} onChange={setMu} min={-50} max={50} suffix="%" />
          <Field label="Annual vol" value={sigma} onChange={setSigma} min={1} max={120} suffix="%" />
          <Field label="Horizon" value={days} onChange={setDays} min={30} max={1260} suffix="days" />
          <div className="grid grid-cols-2 gap-2">
            <Field label="Fat-tail prob" value={fatProb} onChange={setFatProb} min={0} max={30} step={0.5} suffix="%" />
            <Field label="Fat scale" value={fatScale} onChange={setFatScale} min={1} max={10} step={0.5} suffix="×" />
          </div>
          <div className="pt-1 space-y-1.5">
            <Chip label="Median max drawdown" value={`−${fmtNum(sim.stats.medianMaxDDPct, 1)}%`} />
            <Chip label="p95 max drawdown" value={`−${fmtNum(sim.stats.p95MaxDDPct, 1)}%`} tone="down" />
            <Chip label="VaR 95 (horizon)" value={`${fmtNum(sim.stats.var95Pct, 1)}%`} tone="down" />
            <Chip label="P(DD ≥ 20%)" value={`${fmtNum(sim.stats.pDD20Pct, 0)}%`} />
            <Chip label="Median terminal" value={`${sim.stats.medianTerminalPct > 0 ? "+" : ""}${fmtNum(sim.stats.medianTerminalPct, 1)}%`} tone={sim.stats.medianTerminalPct > 0 ? "up" : "down"} />
          </div>
        </div>

        <div className="space-y-4 min-w-0">
          <div className="rounded-xl border border-line lg-glass p-4">
            <p className="text-xs text-dim font-medium mb-1">
              Drawdown topology — 2,000 paths · height = path density
            </p>
            <p className="text-[11px] text-dim mb-2">
              Near edge = shallow drawdowns, far edge = −{fmtNum(sim.ddMax * 100, 0)}%. The ridge along "0%" is where most paths live; the shelf sliding away is the fat tail.
            </p>
            <Surface3D grid={grid} colorFor={seqColor} height={320} xLabel="trading days →" yLabel="drawdown depth →" />
          </div>

          <div className="rounded-xl border border-line lg-glass p-4">
            <p className="text-xs text-dim font-medium mb-2">Drawdown quantiles over time</p>
            <Legend items={[{ label: "Median drawdown", color: C1 }, { label: "p95 drawdown", color: DOWN }]} />
            <XYLineChart
              series={[
                { label: "Median", color: C1, points: sim.medianDD },
                { label: "p95", color: DOWN, points: sim.p95DD },
              ]}
              height={200}
              fmtX={(v) => `d${Math.round(v)}`}
              fmtY={(v) => `−${fmtNum(v, 0)}%`}
              zeroLine={false}
            />
          </div>

          <div className="rounded-xl border border-line lg-glass p-4">
            <p className="text-xs text-dim font-medium mb-2">Terminal value distribution</p>
            <div className="flex items-end gap-px h-24">
              {bins.map((b, i) => (
                <div
                  key={i}
                  className="flex-1 rounded-t"
                  title={`${fmtNum(b.x0, 0)}% … ${fmtNum(b.x1, 0)}%: ${b.count} paths`}
                  style={{
                    height: `${(b.count / maxCount) * 100}%`,
                    background: b.x1 <= 0 ? DOWN : b.x0 >= 0 ? UP : "#64748b",
                    opacity: 0.8,
                  }}
                />
              ))}
            </div>
            <div className="flex justify-between text-[10px] text-dim font-mono mt-1">
              <span>{fmtNum(bins[0]?.x0 ?? 0, 0)}%</span>
              <span>0%</span>
              <span>{fmtNum(bins[bins.length - 1]?.x1 ?? 0, 0)}%</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── 6. Greeks manifold ───────────────────────────────────────────────────────

const GREEK_METRICS = [
  { id: "pnl", label: "P&L", diverging: true },
  { id: "gamma", label: "Gamma", diverging: false },
  { id: "theta", label: "Theta", diverging: true },
];

function GreeksTab() {
  const [type, setType] = useState("call"); // call | put | straddle
  const [K, setK] = useState(100);
  const [iv, setIv] = useState(25);
  const [r, setR] = useState(4.3);
  const [daysToExp, setDaysToExp] = useState(90);
  const [metric, setMetric] = useState("pnl");

  const model = useMemo(() => {
    const strike = Math.max(1, K || 100);
    const sigma = Math.max(1, Math.min(300, iv || 25)) / 100;
    const rf = Math.max(0, Math.min(20, r || 0)) / 100;
    const D = Math.max(5, Math.min(730, daysToExp || 90));
    const S0 = strike; // buy ATM at t0
    const T0 = D / 365;

    const legs = type === "straddle" ? ["call", "put"] : [type];
    const cost = legs.reduce((a, lt) => a + (blackScholesGreeks({ S: S0, K: strike, T: T0, sigma, r: rf, type: lt }).price || 0), 0);

    const ROWS = 36, COLS = 48;
    const sLo = strike * 0.6, sHi = strike * 1.4;
    const make = () => Array.from({ length: ROWS }, () => new Array(COLS).fill(0));
    const pnl = make(), gamma = make(), theta = make();
    for (let ri = 0; ri < ROWS; ri++) {
      // Row 0 = purchase date (full time), last row = expiry.
      const daysLeft = D * (1 - ri / (ROWS - 1));
      const T = Math.max(daysLeft, 0.25) / 365;
      for (let ci = 0; ci < COLS; ci++) {
        const S = sLo + ((sHi - sLo) * ci) / (COLS - 1);
        let v = 0, g = 0, th = 0;
        for (const lt of legs) {
          const bs = blackScholesGreeks({ S, K: strike, T, sigma, r: rf, type: lt });
          v += bs.price || 0; g += bs.gamma || 0; th += bs.theta || 0;
        }
        pnl[ri][ci] = v - cost;
        gamma[ri][ci] = g;
        theta[ri][ci] = th;
      }
    }

    // Normalize each metric grid to 0..1 for the surface (symmetric for
    // diverging metrics so 0 sits at the color midpoint).
    const norm = (m, diverging) => {
      let lo = Infinity, hi = -Infinity;
      for (const row of m) for (const v of row) { if (v < lo) lo = v; if (v > hi) hi = v; }
      if (diverging) {
        const a = Math.max(Math.abs(lo), Math.abs(hi)) || 1;
        return m.map((row) => row.map((v) => 0.5 + v / (2 * a)));
      }
      const span = hi - lo || 1;
      return m.map((row) => row.map((v) => (v - lo) / span));
    };

    const now = blackScholesGreeks({ S: S0, K: strike, T: T0, sigma, r: rf, type: legs[0] });
    const nowAgg = legs.length === 1 ? now : (() => {
      const p = blackScholesGreeks({ S: S0, K: strike, T: T0, sigma, r: rf, type: "put" });
      return { delta: (now.delta || 0) + (p.delta || 0), gamma: (now.gamma || 0) + (p.gamma || 0), theta: (now.theta || 0) + (p.theta || 0), vega: (now.vega || 0) + (p.vega || 0) };
    })();

    return {
      cost,
      S0,
      grids: {
        pnl: norm(pnl, true),
        gamma: norm(gamma, false),
        theta: norm(theta, true),
      },
      raw: { pnl, gamma, theta },
      greeksNow: nowAgg,
      sLo, sHi, D,
    };
  }, [type, K, iv, r, daysToExp]);

  const active = GREEK_METRICS.find((m) => m.id === metric);
  const colorFn = active.diverging ? divColor : seqColor;

  return (
    <div className="space-y-4">
      <Explainer
        research="An option position is a surface, not a number: value depends jointly on spot and time. Delta is the slope along spot, gamma the curvature (it explodes near the strike close to expiry), theta the slide along the time axis. Traders manage the SURFACE — the Greeks are just its partial derivatives."
        reality="Pure Black-Scholes with flat vol — real chains carry skew and term structure (see the Options page for live IV). Still, every mechanic you can lose money to as an option buyer is visible here: the gamma ridge you pay for, and the theta trench that pays for it."
      />

      <div className="grid lg:grid-cols-[260px_1fr] gap-4 [&>*]:min-w-0">
        <div className="rounded-xl border border-line lg-glass p-4 space-y-3 h-fit">
          <p className="text-xs text-dim font-medium">Position</p>
          <div className="flex gap-1.5">
            {["call", "put", "straddle"].map((t) => (
              <button key={t} onClick={() => setType(t)}
                className={cn("flex-1 rounded-lg border px-2 py-1.5 text-xs capitalize transition-colors",
                  type === t ? "border-accent/60 text-accent bg-accent/10" : "border-line text-dim hover:text-text")}>
                {t}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Strike (=spot)" value={K} onChange={setK} min={1} max={10000} suffix="$" />
            <Field label="Implied vol" value={iv} onChange={setIv} min={1} max={300} suffix="%" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Risk-free" value={r} onChange={setR} min={0} max={20} step={0.1} suffix="%" />
            <Field label="Expiry" value={daysToExp} onChange={setDaysToExp} min={5} max={730} suffix="days" />
          </div>
          <div className="pt-1 space-y-1.5">
            <Chip label="Position cost (per share)" value={`$${fmtNum(model.cost, 2)}`} />
            <Chip label="Delta now" value={fmtNum(model.greeksNow.delta, 2)} />
            <Chip label="Gamma now" value={fmtNum(model.greeksNow.gamma, 4)} />
            <Chip label="Theta now ($/day)" value={fmtNum(model.greeksNow.theta, 3)} tone="down" />
            <Chip label="Vega now ($/1% IV)" value={fmtNum(model.greeksNow.vega, 3)} />
          </div>
        </div>

        <div className="rounded-xl border border-line lg-glass p-4 min-w-0">
          <div className="flex items-center justify-between flex-wrap gap-2 mb-1">
            <p className="text-xs text-dim font-medium">
              {active.label} manifold — long {type}, K = {fmtNum(Math.max(1, K || 100), 0)}
            </p>
            <div className="flex gap-1.5">
              {GREEK_METRICS.map((m) => (
                <button key={m.id} onClick={() => setMetric(m.id)}
                  className={cn("rounded-lg border px-2.5 py-1 text-xs transition-colors",
                    metric === m.id ? "border-accent/60 text-accent bg-accent/10" : "border-line text-dim hover:text-text")}>
                  {m.label}
                </button>
              ))}
            </div>
          </div>
          <p className="text-[11px] text-dim mb-2">
            Spot {fmtNum(model.sLo, 0)} → {fmtNum(model.sHi, 0)} across · purchase date (far) → expiry (near) along.
            {metric === "pnl" && " Green = profit vs premium paid, red = loss."}
            {metric === "gamma" && " The bright ridge at the strike near expiry is pin risk."}
            {metric === "theta" && " The red trench is the daily bleed an option buyer finances."}
          </p>
          <Surface3D
            grid={model.grids[metric]}
            colorFor={colorFn}
            height={360}
            xLabel="spot →"
            yLabel="→ expiry"
            zScale={0.5}
          />
        </div>
      </div>
    </div>
  );
}

// ── Page shell ───────────────────────────────────────────────────────────────

const TABS = [
  { id: "bab", label: "Betting Against Beta", icon: Scale, el: <BabTab />, tag: "live backtest" },
  { id: "accruals", label: "Accruals", icon: FileSearch, el: <AccrualsTab />, tag: "live screen" },
  { id: "short", label: "Short Interest", icon: TrendingDown, el: <ShortTab />, tag: "live screen" },
  { id: "regimes", label: "Correlation Regimes", icon: Waypoints, el: <RegimesTab />, tag: "live data" },
  { id: "drawdown", label: "Drawdown Topology", icon: Mountain, el: <DrawdownTab />, tag: "simulation" },
  { id: "greeks", label: "Greeks Manifold", icon: Box, el: <GreeksTab />, tag: "simulation" },
];

export default function Anomalies() {
  const [tab, setTab] = useState("bab");
  const active = TABS.find((t) => t.id === tab) || TABS[0];

  return (
    <div className="max-w-6xl">
      <p className="text-[10px] tracking-[0.3em] text-dim uppercase mb-1">Documented edges</p>
      <div className="flex items-center gap-2 mb-2">
        <Telescope className="w-6 h-6 text-accent" />
        <h1 className="text-xl sm:text-2xl font-bold">Anomalies</h1>
      </div>
      <p className="text-sm text-dim mb-4 max-w-3xl">
        Six classic quant results, recomputed live instead of retold: three published return anomalies
        over a {FACTOR_UNIVERSE.length}-stock liquid universe, and three pieces of risk geometry.
        Each module states how well its edge survived publication — most edges shrink once everyone knows.
        The theory behind every tab lives in the{" "}
        <Link to="/academy?c=anomalies-factors" className="text-accent hover:underline">
          Anomalies &amp; Factor Investing course
        </Link>.
      </p>

      <div className="flex gap-1.5 overflow-x-auto pb-2 mb-4 -mx-1 px-1">
        {TABS.map(({ id, label, icon: Icon, tag }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={cn(
              "shrink-0 rounded-lg border px-3 py-2 text-left transition-colors",
              tab === id ? "border-accent/60 bg-accent/10" : "border-line hover:border-accent/30"
            )}
          >
            <span className={cn("flex items-center gap-1.5 text-sm", tab === id ? "text-accent" : "text-text")}>
              <Icon className="w-4 h-4" /> {label}
            </span>
            <span className="block text-[10px] text-dim font-mono mt-0.5">{tag}</span>
          </button>
        ))}
      </div>

      {active.el}

      <p className="text-[11px] text-dim mt-6 max-w-3xl leading-relaxed">
        Education, not investment advice. Live modules use delayed Yahoo Finance data over a small
        mega-cap universe with no transaction costs, borrow fees, or slippage — academic factors use
        thousands of stocks and decades of history. Results here demonstrate mechanics, not tradability.
      </p>
    </div>
  );
}
