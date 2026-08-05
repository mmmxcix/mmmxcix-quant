import { useMemo, useState } from "react";
import { BrainCircuit, Play, Loader2, AlertTriangle } from "lucide-react";
import SymbolSearch from "@/components/SymbolSearch";
import Skeleton from "@/components/Skeleton";
import { MARKETS, fetchCandles } from "@/lib/data";
import { ML_MODELS, runMlForecast, runMlLabeled } from "@/lib/mlStudio";
import { garchFit } from "@/lib/garch";
import { cn, fmtPct } from "@/lib/utils";
import MLRanking from "@/pages/MLRanking";
import MLTrackRecord from "@/pages/MLTrackRecord";
import { logRun, logForecastPrediction } from "@/lib/mlMemory";

// ML Studio — in-browser price forecasting (Pyodide + scikit-learn), the
// site's answer to LSE's ML Studio. Everything is out-of-sample and shown
// against its naive baseline; the verdict says out loud when a result is
// statistically a coin flip.

const DEFAULT_SYMBOL = { crypto: "BTCUSDT", stock: "SPY" };

function MetricCard({ label, value, sub, tone = "text-text" }) {
  return (
    <div className="rounded-xl border border-line lg-glass px-4 py-3">
      <p className="text-[11px] text-dim mb-1">{label}</p>
      <p className={cn("font-mono font-semibold text-lg", tone)}>{value}</p>
      {sub && <p className="text-xs text-dim mt-0.5">{sub}</p>}
    </div>
  );
}

// Two-line comparison chart (strategy vs buy & hold), same visual language as
// the dashboard equity chart.
function CurveChart({ curve, height = 220 }) {
  const [hov, setHov] = useState(null);
  const n = curve.t.length;
  if (n < 2) return null;
  const hasDb = Array.isArray(curve.strat_db) && curve.strat_db.length === n;
  const all = [...curve.strat, ...curve.bh, ...(hasDb ? curve.strat_db : [])];
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
        <polyline points={line(curve.bh)} fill="none" stroke="var(--viz-blue)" strokeWidth="1.5" opacity="0.75"
          vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        <polyline points={line(curve.strat)} fill="none" stroke="var(--viz-amber)" strokeWidth="2"
          vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        {hasDb && (
          <polyline points={line(curve.strat_db)} fill="none" stroke="var(--viz-green, #34d399)" strokeWidth="1.75"
            vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeDasharray="4 3" />
        )}
      </svg>
      {hov != null && (
        <>
          <div className="absolute top-0 bottom-0 w-px bg-text/20 pointer-events-none" style={{ left: `${hx}%` }} />
          <div className="absolute top-1 pointer-events-none rounded-lg border border-line bg-bg/95 px-2.5 py-1.5 text-[11px] font-mono whitespace-nowrap"
            style={{ left: `${hx}%`, transform: hx > 55 ? "translateX(calc(-100% - 10px))" : "translateX(10px)" }}>
            <span style={{ color: "var(--viz-amber)" }}>model {((curve.strat[hov] - 1) * 100).toFixed(1)}%</span>
            <span className="ml-2" style={{ color: "var(--viz-blue)" }}>hold {((curve.bh[hov] - 1) * 100).toFixed(1)}%</span>
            <span className="text-dim ml-2">{new Date(curve.t[hov] * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "2-digit" })}</span>
          </div>
        </>
      )}
    </div>
  );
}

// Predicted vs actual scatter — the honest picture of how noisy this is.
function Scatter({ points, height = 220 }) {
  if (!points?.length) return null;
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  const lim = Math.max(...xs.map(Math.abs), ...ys.map(Math.abs), 1e-6);
  const W = 260, H = height;
  const X = (v) => ((v + lim) / (2 * lim)) * W;
  const Y = (v) => H - ((v + lim) / (2 * lim)) * H;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height }} aria-hidden="true">
      <line x1={X(0)} y1="0" x2={X(0)} y2={H} stroke="currentColor" className="text-line" strokeWidth="1" />
      <line x1="0" y1={Y(0)} x2={W} y2={Y(0)} stroke="currentColor" className="text-line" strokeWidth="1" />
      {points.map(([p, a], i) => (
        <circle key={i} cx={X(p)} cy={Y(a)} r="2"
          fill={Math.sign(p) === Math.sign(a) ? "var(--viz-teal)" : "var(--viz-pink)"} opacity="0.55" />
      ))}
    </svg>
  );
}

export default function MLStudio() {
  const [studioMode, setStudioMode] = useState("forecast"); // forecast | ranking
  const [market, setMarket] = useState("crypto");
  const [symbol, setSymbol] = useState(DEFAULT_SYMBOL.crypto);
  const [range, setRange] = useState("5y");
  const [modelId, setModelId] = useState("rf");
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [out, setOut] = useState(null);
  const [labOut, setLabOut] = useState(null);
  const [garch, setGarch] = useState(null);
  const [ranFor, setRanFor] = useState(null);

  const model = useMemo(() => ML_MODELS.find((m) => m.id === modelId), [modelId]);

  const run = async () => {
    if (status) return;
    setError(null);
    setOut(null);
    setLabOut(null);
    setGarch(null);
    const sym = symbol.trim().toUpperCase();
    try {
      setStatus("Loading candles…");
      const candles = await fetchCandles({ market, symbol: sym, interval: "1d", range });
      // GARCH(1,1) volatility regime from the same candles — cheap, always shown.
      try {
        const cl = candles.map((c) => c.close).filter((x) => x > 0);
        const rets = [];
        for (let i = 1; i < cl.length; i++) rets.push(Math.log(cl[i] / cl[i - 1]));
        setGarch(garchFit(rets));
      } catch { /* vol card simply hidden */ }
      if (studioMode === "barrier") {
        const res = await runMlLabeled(candles, {}, setStatus);
        setLabOut(res);
        setRanFor(`${sym} · triple-barrier`);
        logRun({
          mode: "barrier", label: `Triple-barrier ${sym} · ${range}`,
          metric: res.accMean, metricLabel: "acc", detail: `${res.folds} purged folds · base ${(res.baseRate * 100).toFixed(0)}%`,
        });
        return;
      }
      const res = await runMlForecast(candles, modelId, setStatus);
      setOut(res);
      setRanFor(`${sym} · ${model.label}`);
      // Memory: remember the run, and put tomorrow's forecast on the ledger —
      // reality grades it once the next bar exists.
      const last = candles[candles.length - 1];
      logRun({
        mode: "forecast", label: `Forecast ${sym} · ${model.label} · ${range}`,
        metric: res.hit, metricLabel: "hit", detail: `${res.nTest} test days · z=${res.z.toFixed(1)}`,
      });
      logForecastPrediction({
        symbol: sym, market, model: model.label, predRet: res.tomorrow,
        lastBarTime: last.time, lastClose: last.close, interval: "1d",
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setStatus(null);
    }
  };

  // Verdict: is the hit rate distinguishable from a coin flip? |z| ≥ 2 ≈ 95%.
  const verdict = out && (
    Math.abs(out.z) >= 2
      ? out.hit > 0.5
        ? { tone: "text-up", text: `Direction accuracy ${(out.hit * 100).toFixed(1)}% over ${out.nTest} unseen days (z=${out.z.toFixed(1)}) — better than chance, but frictionless: fees and slippage would eat part of it.` }
        : { tone: "text-down", text: `Direction accuracy ${(out.hit * 100).toFixed(1)}% — significantly WORSE than a coin flip (z=${out.z.toFixed(1)}). The model found patterns that don't generalize.` }
      : { tone: "text-dim", text: `Direction accuracy ${(out.hit * 100).toFixed(1)}% over ${out.nTest} unseen days (z=${out.z.toFixed(1)}) — statistically indistinguishable from a coin flip. That's the normal result for daily price forecasting.` }
  );

  return (
    <div>
      {/* Two very different ML jobs: single-asset next-bar forecasting (mostly
          a coin flip — shown honestly) and cross-sectional ranking (where
          equity ML actually has a track record). */}
      <div className="flex gap-1 mb-5">
        {[["forecast", "Forecast (single asset)"], ["barrier", "Triple-barrier"], ["ranking", "Ranking (cross-sectional)"], ["record", "Track record"]].map(([id, label]) => (
          <button key={id} onClick={() => setStudioMode(id)}
            className={cn("chip", studioMode === id ? "chip-active" : "chip-idle")}>
            {label}
          </button>
        ))}
      </div>
      {studioMode === "record" ? <MLTrackRecord /> : studioMode === "ranking" ? <MLRanking /> : (
      <div className="grid lg:grid-cols-[340px_1fr] gap-6 [&>*]:min-w-0">
        {/* controls */}
        <div className="space-y-4">
          <div className="rounded-xl border border-line lg-glass p-4 space-y-3">
            <p className="text-xs text-dim font-medium">Data</p>
            <div className="flex gap-1">
              {MARKETS.map((mk) => (
                <button key={mk.id} onClick={() => { setMarket(mk.id); setSymbol(DEFAULT_SYMBOL[mk.id]); }}
                  className={cn("chip", market === mk.id ? "chip-active" : "chip-idle")}>
                  {mk.label}
                </button>
              ))}
            </div>
            <SymbolSearch market={market} value={symbol} onSelect={(s) => setSymbol(s.toUpperCase())}
              placeholder={market === "crypto" ? "e.g. BTCUSDT" : "e.g. SPY"} className="w-full" />
            <div className="flex gap-1">
              {["2y", "5y", "max"].map((r) => (
                <button key={r} onClick={() => setRange(r)}
                  className={cn("chip font-mono", range === r ? "chip-active" : "chip-idle")}>
                  {r === "max" ? "Max" : r.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          {studioMode === "barrier" ? (
            <div className="rounded-xl border border-line lg-glass p-4 space-y-2">
              <p className="text-xs text-dim font-medium">Method</p>
              <p className="text-sm font-semibold">Triple-barrier + meta-labeling</p>
              <p className="text-[11px] text-dim leading-relaxed">
                Each bar is labeled by which barrier it hits first — a volatility-scaled
                profit-take (+1.5σ), stop-loss (−1.0σ), or a 10-bar time limit. A trend rule
                proposes the side; a second "meta" model learns when to actually take the bet.
                Scored with purged, embargoed walk-forward folds so overlapping labels can't leak.
              </p>
              <p className="text-[11px] text-dim leading-relaxed pt-1">
                The López de Prado / Jansen labeling that serious equity ML uses — instead of the
                fragile "will the next bar be up?".
              </p>
            </div>
          ) : (
          <div className="rounded-xl border border-line lg-glass p-4 space-y-2">
            <p className="text-xs text-dim font-medium">Model</p>
            {ML_MODELS.map((m) => (
              <button key={m.id} onClick={() => setModelId(m.id)}
                className={cn("w-full text-left rounded-lg border px-3 py-2 transition-colors",
                  modelId === m.id ? "border-accent/50 bg-accent/5" : "border-line hover:bg-bg/40")}>
                <p className="text-sm font-semibold">{m.label}</p>
                <p className="text-[11px] text-dim">{m.desc}</p>
              </button>
            ))}
            <p className="text-[11px] text-dim leading-relaxed pt-1">
              Runs entirely in your browser (Python via WASM). LSTM/XGBoost aren't available in
              WASM — these are the models that genuinely run here.
            </p>
          </div>
          )}

          <button onClick={run} disabled={!!status} className="btn-accent w-full flex items-center justify-center gap-2 disabled:opacity-50">
            {status ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            {status || "Train & evaluate"}
          </button>
          {error && (
            <p className="text-xs text-down flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {error}
            </p>
          )}
        </div>

        {/* results */}
        <div className="space-y-4">
          {!out && !labOut && !status && (
            <div className="rounded-xl border border-line lg-glass p-10 text-center">
              <BrainCircuit className="w-8 h-8 text-dim mx-auto mb-3" />
              {studioMode === "barrier" ? (
                <>
                  <p className="font-semibold mb-1">Label by barriers, not next-bar sign</p>
                  <p className="text-sm text-dim max-w-lg mx-auto leading-relaxed">
                    Each bar is labeled by which happens first — a volatility-scaled profit-take,
                    stop-loss, or time limit — then validated with purged walk-forward folds and a
                    meta-model that gates the bets. Honest: on daily data most of this stays near
                    the base rate, and the folds will show it.
                  </p>
                </>
              ) : (
                <>
                  <p className="font-semibold mb-1">Forecast the next bar — honestly</p>
                  <p className="text-sm text-dim max-w-lg mx-auto leading-relaxed">
                    Trains on the first 75% of history, evaluated only on the unseen last 25%.
                    Every number is shown against its naive baseline. Most daily forecasts are
                    coin flips — when that's the result, this page will say so.
                  </p>
                </>
              )}
            </div>
          )}
          {status && !out && !labOut && <Skeleton className="h-64 w-full rounded-xl" />}

          {garch && (out || labOut) && (
            <div className="rounded-xl border border-line lg-glass p-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm font-semibold">Volatility regime · GARCH(1,1)</p>
                <p className="text-[11px] text-dim font-mono">persistence α+β = {garch.persistence.toFixed(3)}</p>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <MetricCard label="Current vol (ann.)" value={`${garch.currentVol.toFixed(1)}%`}
                  sub={`long-run ${garch.uncondVol.toFixed(1)}%`}
                  tone={garch.currentVol > garch.uncondVol ? "text-down" : "text-up"} />
                <MetricCard label="Forecast +1d" value={`${garch.fwd1.toFixed(1)}%`}
                  sub="annualized" />
                <MetricCard label="Forecast +10d" value={`${garch.fwd10.toFixed(1)}%`}
                  sub="annualized, mean-reverting" />
                <MetricCard label="Shock reaction α" value={garch.alpha.toFixed(2)}
                  sub={`memory β=${garch.beta.toFixed(2)}`} />
              </div>
              <p className="text-[11px] text-dim mt-2 leading-relaxed">
                {garch.currentVol > garch.uncondVol * 1.15
                  ? "Elevated regime — conditional vol sits above its long-run mean; the forecast decays back toward it."
                  : garch.currentVol < garch.uncondVol * 0.85
                    ? "Calm regime — vol is below its long-run mean; a shock would pull the forecast up."
                    : "Near the long-run mean. High α+β means shocks fade slowly (vol clustering)."}
              </p>
            </div>
          )}

          {labOut && studioMode === "barrier" && (
            <>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <MetricCard label="Purged-CV accuracy" value={`${(labOut.accMean * 100).toFixed(1)}%`}
                  sub={`${labOut.folds} folds ±${(labOut.accStd * 100).toFixed(1)} · base ${(labOut.baseRate * 100).toFixed(1)}%`}
                  tone={labOut.accMean > labOut.baseRate + labOut.accStd ? "text-up" : "text-text"} />
                <MetricCard label="Rank IC (prob vs label)" value={labOut.icMean.toFixed(3)}
                  sub="1 = perfect ranking · 0 = noise" tone={labOut.icMean > 0.03 ? "text-up" : "text-text"} />
                <MetricCard label="Meta precision" value={`${(labOut.metaPrecision * 100).toFixed(1)}%`}
                  sub={`when it says take it · base ${(labOut.metaBase * 100).toFixed(1)}% · covers ${(labOut.metaCoverage * 100).toFixed(0)}%`}
                  tone={labOut.metaPrecision > labOut.metaBase + 0.02 ? "text-up" : "text-text"} />
                <MetricCard label="Next-bet lean"
                  value={labOut.pUp >= labOut.pDown ? `${(labOut.pUp * 100).toFixed(0)}% up` : `${(labOut.pDown * 100).toFixed(0)}% down`}
                  sub="P(hits profit-take first)" tone={labOut.pUp >= labOut.pDown ? "text-up" : "text-down"} />
              </div>

              <div className="rounded-xl border border-line lg-glass p-4">
                <p className={cn("text-sm leading-relaxed",
                  labOut.accMean > labOut.baseRate + labOut.accStd ? "text-up"
                    : labOut.accMean < labOut.baseRate - labOut.accStd ? "text-down" : "text-dim")}>
                  {labOut.accMean > labOut.baseRate + labOut.accStd
                    ? `The primary model reads the barriers at ${(labOut.accMean * 100).toFixed(1)}% across ${labOut.folds} purged folds — above the ${(labOut.baseRate * 100).toFixed(1)}% base rate by more than a fold's spread. The meta-model then keeps the ${(labOut.metaCoverage * 100).toFixed(0)}% of bets it trusts at ${(labOut.metaPrecision * 100).toFixed(1)}% precision.`
                    : `Across ${labOut.folds} purged, embargoed folds the accuracy (${(labOut.accMean * 100).toFixed(1)}%) sits within a fold's spread of the ${(labOut.baseRate * 100).toFixed(1)}% base rate — no reliable edge on this asset. That's the honest, common result; the meta-model still tells you which bets are least bad.`}
                </p>
                <p className="text-[11px] text-dim font-mono mt-2">{ranFor}</p>
              </div>

              <div className="grid md:grid-cols-2 gap-4">
                <div className="rounded-xl border border-line lg-glass p-4">
                  <p className="text-sm font-semibold mb-3">What the model looks at</p>
                  <div className="space-y-1.5">
                    {labOut.importances.map(([name, val]) => (
                      <div key={name} className="flex items-center gap-2">
                        <span className="text-xs text-dim w-28 shrink-0">{name}</span>
                        <div className="flex-1 h-2 rounded-sm bg-line/40 overflow-hidden">
                          <div className="h-full rounded-sm" style={{ width: `${Math.max(2, val * 100 / (labOut.importances[0][1] || 1) * 0.9)}%`, background: "var(--viz-purple)" }} />
                        </div>
                        <span className="text-[10px] text-dim font-mono w-10 text-right">{(val * 100).toFixed(1)}%</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="rounded-xl border border-line lg-glass p-4">
                  <p className="text-sm font-semibold mb-3">Barrier setup &amp; label balance</p>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs font-mono">
                    <span className="text-dim">Profit-take</span><span className="text-right text-up">+{labOut.ptMult}σ</span>
                    <span className="text-dim">Stop-loss</span><span className="text-right text-down">−{labOut.slMult}σ</span>
                    <span className="text-dim">Time limit</span><span className="text-right">{labOut.horizon} bars</span>
                    <span className="text-dim">Usable bars</span><span className="text-right">{labOut.nUsable}</span>
                  </div>
                  <div className="mt-3 flex h-3 rounded-sm overflow-hidden">
                    <div style={{ width: `${100 * labOut.labelUp / (labOut.labelUp + labOut.labelDown + labOut.labelFlat || 1)}%`, background: "var(--viz-teal)" }} title="profit-take first" />
                    <div style={{ width: `${100 * labOut.labelDown / (labOut.labelUp + labOut.labelDown + labOut.labelFlat || 1)}%`, background: "var(--viz-pink)" }} title="stop-loss first" />
                  </div>
                  <p className="text-[10px] text-dim mt-1.5">
                    <span style={{ color: "var(--viz-teal)" }}>■</span> {labOut.labelUp} up ·{" "}
                    <span style={{ color: "var(--viz-pink)" }}>■</span> {labOut.labelDown} down
                  </p>
                </div>
              </div>

              <p className="text-xs text-dim leading-relaxed">
                Triple-barrier labeling, meta-labeling, and purged walk-forward CV with an embargo
                (López de Prado / Jansen). Barriers scale with EWM volatility, so the target adapts
                to each regime. Educational tool — not investment advice.
              </p>
            </>
          )}
          {out && studioMode !== "barrier" && (
            <>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <MetricCard label="Direction accuracy" value={`${(out.hit * 100).toFixed(1)}%`}
                  sub={`${out.nTest} unseen days · z=${out.z.toFixed(1)}`}
                  tone={Math.abs(out.z) >= 2 && out.hit > 0.5 ? "text-up" : "text-text"} />
                <MetricCard label="MAE vs naive" value={`${(out.mae * 100).toFixed(3)}%`}
                  sub={`naive (always 0): ${(out.maeNaive * 100).toFixed(3)}%`}
                  tone={out.mae < out.maeNaive ? "text-up" : "text-down"} />
                <MetricCard label="Information Coefficient" value={out.corr.toFixed(3)}
                  sub={out.rankIc != null ? `rank IC ${out.rankIc.toFixed(3)} · desk's skill metric` : "1 = clairvoyant · 0 = noise"}
                  tone={Math.abs(out.corr) >= 0.03 ? "text-up" : "text-text"} />
                <MetricCard label="Next-bar forecast" value={fmtPct(out.tomorrow * 100)}
                  sub="model's guess for tomorrow" tone={out.tomorrow >= 0 ? "text-up" : "text-down"} />
              </div>

              {verdict && (
                <div className="rounded-xl border border-line lg-glass p-4">
                  <p className={cn("text-sm leading-relaxed", verdict.tone)}>{verdict.text}</p>
                </div>
              )}

              <div className="rounded-xl border border-line lg-glass p-4">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-sm font-semibold">Out-of-sample: trade the sign vs buy &amp; hold</p>
                  <p className="text-[11px] text-dim font-mono">{ranFor}</p>
                </div>
                <CurveChart curve={out.curve} />
                <p className="text-[11px] text-dim mt-2">
                  <span style={{ color: "var(--viz-amber)" }}>■</span> model (frictionless — an upper bound, not a tradable result) ·{" "}
                  <span style={{ color: "var(--viz-blue)" }}>■</span> buy &amp; hold
                  {out.deadband && (<> ·{" "}
                    <span style={{ color: "var(--viz-green, #34d399)" }}>▦</span> deadband — only the top-conviction signals
                    (<span className="font-mono">{(out.deadband.exposure * 100).toFixed(0)}%</span> of bars traded,{" "}
                    <span className="font-mono">{(out.deadband.hit * 100).toFixed(0)}%</span> right)
                  </>)}
                </p>
              </div>

              <div className="grid md:grid-cols-2 gap-4">
                <div className="rounded-xl border border-line lg-glass p-4">
                  <p className="text-sm font-semibold mb-3">What the model looks at</p>
                  <div className="space-y-1.5">
                    {out.importances.map(([name, val]) => (
                      <div key={name} className="flex items-center gap-2">
                        <span className="text-xs text-dim w-28 shrink-0">{name}</span>
                        <div className="flex-1 h-2 rounded-sm bg-line/40 overflow-hidden">
                          <div className="h-full rounded-sm" style={{ width: `${Math.max(2, val * 100 / (out.importances[0][1] || 1) * 0.9)}%`, background: "var(--viz-purple)" }} />
                        </div>
                        <span className="text-[10px] text-dim font-mono w-10 text-right">{(val * 100).toFixed(1)}%</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="rounded-xl border border-line lg-glass p-4">
                  <p className="text-sm font-semibold mb-1">Predicted vs actual</p>
                  <p className="text-[11px] text-dim mb-2">
                    <span style={{ color: "var(--viz-teal)" }}>●</span> direction right ·{" "}
                    <span style={{ color: "var(--viz-pink)" }}>●</span> direction wrong — a tight diagonal would mean real predictive power
                  </p>
                  <Scatter points={out.scatter} />
                </div>
              </div>

              <p className="text-xs text-dim leading-relaxed">
                Trained on {out.nTrain} bars, evaluated on the {out.nTest} most recent — the model never saw them.
                Features: lagged returns, realized volatility, RSI, SMA distances, volume z-score, weekday.
                Educational tool — not investment advice.
              </p>
            </>
          )}
        </div>
      </div>
      )}
    </div>
  );
}
