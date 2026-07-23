import { useEffect, useMemo, useRef, useState } from "react";
import { Waypoints, RefreshCw, TrendingUp, TrendingDown, Minus } from "lucide-react";
import { fetchCandles, MARKETS, INTERVALS } from "@/lib/data";
import { detectRegimes } from "@/lib/hmmRegime";
import { cn } from "@/lib/utils";
import Skeleton from "@/components/Skeleton";
import SymbolSearch from "@/components/SymbolSearch";

// Regimes — Hidden Markov Model regime detection, visualised. The market's true
// state (bull / bear / choppy) is hidden; the HMM infers it from returns and
// volatility, and shows the transition probabilities between states. This is
// the technique Baum built at Renaissance, here on our own data.

const REGIME_TONE = {
  Bull: { text: "text-up", bg: "bg-up", soft: "rgb(var(--c-up) / 0.14)", Icon: TrendingUp },
  Bear: { text: "text-down", bg: "bg-down", soft: "rgb(var(--c-down) / 0.16)", Icon: TrendingDown },
  Neutral: { text: "text-dim", bg: "bg-dim", soft: "rgb(var(--c-dim) / 0.12)", Icon: Minus },
};
const toneOf = (label) => REGIME_TONE[label] || REGIME_TONE.Neutral;

export default function Regimes() {
  const [market, setMarket] = useState("stock");
  const [symbol, setSymbol] = useState("SPY");
  const [interval, setIntervalId] = useState("1d");
  const [K, setK] = useState(3);
  const [state, setState] = useState({ loading: true, error: null, candles: null, regimes: null });

  const run = () => {
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    const range = (interval === "1d" || interval === "1w") ? "max" : interval === "15m" ? "1mo" : "6mo";
    fetchCandles({ market, symbol, interval, range })
      .then((candles) => {
        if (!alive) return;
        if (!candles || candles.length < 200) throw new Error("not enough data for this symbol/interval");
        const regimes = detectRegimes(candles, { K, volWindow: 20, iters: 40, interval });
        if (!regimes.ok) throw new Error(regimes.reason || "regime fit failed");
        setState({ loading: false, error: null, candles, regimes });
      })
      .catch((e) => alive && setState({ loading: false, error: e.message, candles: null, regimes: null }));
    return () => { alive = false; };
  };
  useEffect(run, [market, symbol, interval, K]); // eslint-disable-line react-hooks/exhaustive-deps

  const { loading, error, candles, regimes } = state;

  return (
    <div className="view-in">
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <Waypoints className="w-6 h-6 text-accent" />
        <h1 className="text-2xl font-bold">Market Regimes</h1>
        <span className="text-xs text-dim">Hidden Markov Model · returns + volatility</span>
        <button onClick={run} disabled={loading}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-xs text-dim hover:text-text disabled:opacity-50">
          <RefreshCw className={cn("w-3.5 h-3.5", loading && "animate-spin")} /> Refit
        </button>
      </div>

      {/* controls */}
      <div className="flex flex-wrap items-end gap-3 mb-6">
        <label className="text-xs text-dim">
          <span className="block mb-1">Market</span>
          <select
            value={market}
            onChange={(e) => {
              const m = e.target.value;
              setMarket(m);
              // Symbols don't cross markets — snap to a sensible default.
              setSymbol(m === "crypto" ? "BTCUSDT" : "SPY");
            }}
            className="rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-text">
            {MARKETS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </label>
        <label className="text-xs text-dim">
          <span className="block mb-1">Symbol</span>
          <SymbolSearch
            market={market}
            value={symbol}
            onSelect={(s) => setSymbol(String(s).toUpperCase())}
            placeholder={market === "crypto" ? "e.g. BTCUSDT" : "e.g. SPY"}
            className="w-36"
          />
        </label>
        <label className="text-xs text-dim">
          <span className="block mb-1">Interval</span>
          <select value={interval} onChange={(e) => setIntervalId(e.target.value)}
            className="rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-text">
            {INTERVALS.filter((i) => ["15m", "1h", "4h", "1d", "1w"].includes(i.id)).map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}
          </select>
        </label>
        <label className="text-xs text-dim">
          <span className="block mb-1">Regimes (K)</span>
          <select value={K} onChange={(e) => setK(+e.target.value)}
            className="rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-text">
            <option value={2}>2 · Bull/Bear</option>
            <option value={3}>3 · Bull/Neutral/Bear</option>
          </select>
        </label>
      </div>

      {loading && (
        <div className="rounded-xl border border-line lg-glass p-5 space-y-3">
          <p className="text-xs text-dim">Fitting HMM…</p>
          <Skeleton className="h-40 w-full rounded-lg" />
          <div className="flex gap-3"><Skeleton className="h-3 w-24" /><Skeleton className="h-3 w-32" /><Skeleton className="h-3 w-20" /></div>
        </div>
      )}
      {error && <div className="rounded-xl border border-down/30 bg-down/5 p-5 text-sm text-down">Couldn’t build regimes: {error}</div>}

      {!loading && !error && regimes && (
        <div className="space-y-6 stagger">
          {/* current regime */}
          <CurrentRegime regimes={regimes} symbol={symbol} />

          {/* price chart coloured by regime */}
          <section className="rounded-xl border border-line lg-glass p-5 hover-lift">
            <h2 className="font-semibold mb-3">Price, coloured by detected regime</h2>
            <RegimeChart candles={candles} regimes={regimes} />
            <div className="flex flex-wrap gap-4 mt-3 text-[11px]">
              {regimes.labels.map((lab) => (
                <span key={lab} className="inline-flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-sm" style={{ background: toneOf(lab).soft, outline: "1px solid rgb(var(--c-line))" }} />
                  <span className="text-dim">{lab}</span>
                </span>
              ))}
            </div>
          </section>

          <div className="grid lg:grid-cols-2 gap-6">
            {/* regime stats */}
            <section className="rounded-xl border border-line lg-glass p-5 hover-lift">
              <h2 className="font-semibold mb-3">Regime statistics</h2>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wide text-dim border-b border-line">
                    <th className="text-left py-1.5">Regime</th>
                    <th className="text-right">Time</th>
                    <th className="text-right">Mean/bar</th>
                    <th className="text-right">Ann. vol</th>
                    <th className="text-right">Avg run</th>
                  </tr>
                </thead>
                <tbody>
                  {[...regimes.states].reverse().map((s) => {
                    const t = toneOf(s.label);
                    return (
                      <tr key={s.label} className="border-b border-line/50 last:border-0">
                        <td className="py-1.5 font-medium"><span className={cn("inline-flex items-center gap-1.5", t.text)}><span className={cn("w-2 h-2 rounded-full", t.bg)} />{s.label}</span></td>
                        <td className="text-right font-mono text-dim">{s.sharePct}%</td>
                        <td className={cn("text-right font-mono", s.meanRetPct >= 0 ? "text-up" : "text-down")}>{s.meanRetPct >= 0 ? "+" : ""}{s.meanRetPct}%</td>
                        <td className="text-right font-mono text-dim">{s.volPct}%</td>
                        <td className="text-right font-mono text-dim">{s.avgDurationBars}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="text-[11px] text-dim/70 mt-3 leading-relaxed">
                States are found unsupervised, then sorted by mean return. A healthy fit puts high volatility on the Bear
                state and long runs on Bull — persistence is what makes a regime tradeable.
              </p>
            </section>

            {/* transition matrix */}
            <section className="rounded-xl border border-line lg-glass p-5 hover-lift">
              <h2 className="font-semibold mb-3">Transition probabilities</h2>
              <TransitionMatrix regimes={regimes} />
              <p className="text-[11px] text-dim/70 mt-3 leading-relaxed">
                Row → column = P(next bar’s regime | this bar’s regime). Strong diagonals mean regimes persist;
                the off-diagonals are the early-warning signal of a regime change.
              </p>
            </section>
          </div>

          {/* live vs hindsight — the honest panel */}
          <LiveVsHindsight candles={candles} regimes={regimes} />
        </div>
      )}
    </div>
  );
}

function CurrentRegime({ regimes, symbol }) {
  const t = toneOf(regimes.current.label);
  const { Icon } = t;
  return (
    <section className="rounded-xl border border-line lg-glass p-5 hover-lift">
      <div className="flex flex-wrap items-center gap-4">
        <div className={cn("inline-flex items-center gap-2 rounded-xl border px-4 py-3", t.text)} style={{ borderColor: "rgb(var(--c-line))", background: t.soft }}>
          <Icon className="w-6 h-6" />
          <div>
            <p className="text-[10px] uppercase tracking-wide text-dim">Current regime · {symbol}</p>
            <p className="text-xl font-bold leading-tight">{regimes.current.label}</p>
          </div>
        </div>
        <div className="flex-1 min-w-[220px]">
          <p className="text-[10px] uppercase tracking-wide text-dim mb-1.5">Confidence (posterior)</p>
          <div className="space-y-1.5">
            {regimes.labels.map((lab, rank) => {
              const p = regimes.current.probs[rank] ?? 0;
              const tt = toneOf(lab);
              return (
                <div key={lab} className="flex items-center gap-2 text-xs">
                  <span className="w-14 text-dim">{lab}</span>
                  <div className="flex-1 h-2 rounded-full bg-line overflow-hidden">
                    <div className={cn("h-full rounded-full", tt.bg)} style={{ width: `${Math.round(p * 100)}%` }} />
                  </div>
                  <span className="w-10 text-right font-mono text-dim">{Math.round(p * 100)}%</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

function TransitionMatrix({ regimes }) {
  const { labels, transition } = regimes;
  return (
    <div className="overflow-x-auto">
      <table className="text-sm font-mono">
        <thead>
          <tr>
            <th className="p-1.5" />
            {labels.map((l) => <th key={l} className="p-1.5 text-[10px] text-dim font-normal">{l}</th>)}
          </tr>
        </thead>
        <tbody>
          {transition.map((row, i) => (
            <tr key={i}>
              <td className="p-1.5 text-[10px] text-dim text-right pr-2">{labels[i]}</td>
              {row.map((v, j) => (
                <td key={j} className="p-1">
                  <div className="w-14 h-9 rounded flex items-center justify-center text-xs"
                    style={{ background: `rgb(var(--c-accent) / ${(0.06 + v * 0.5).toFixed(3)})`, color: v > 0.5 ? "rgb(var(--c-bg))" : "rgb(var(--c-text))" }}>
                    {(v * 100).toFixed(0)}%
                  </div>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// SVG price line with regime background bands. No chart lib — full control over
// the per-segment colouring, and it stays inside its own scroll box.
function RegimeChart({ candles, regimes }) {
  const wrapRef = useRef(null);
  const [w, setW] = useState(800);
  const H = 260, PAD = 8;
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(320, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { pts, bands, min, max } = useMemo(() => {
    const closes = candles.map((c) => c.close);
    let min = Infinity, max = -Infinity;
    for (const c of closes) { if (c < min) min = c; if (c > max) max = c; }
    const n = closes.length;
    const x = (i) => PAD + (i / (n - 1)) * (w - 2 * PAD);
    const y = (v) => PAD + (1 - (v - min) / (max - min || 1)) * (H - 2 * PAD);
    const pts = closes.map((c, i) => `${x(i).toFixed(1)},${y(c).toFixed(1)}`).join(" ");
    // contiguous regime bands from perCandle labels
    const bands = [];
    let startI = 0, cur = regimes.perCandle[0];
    for (let i = 1; i < n; i++) {
      if (regimes.perCandle[i] !== cur) {
        if (cur) bands.push({ x0: x(startI), x1: x(i), label: cur });
        startI = i; cur = regimes.perCandle[i];
      }
    }
    if (cur) bands.push({ x0: x(startI), x1: x(n - 1), label: cur });
    return { pts, bands, min, max };
  }, [candles, regimes, w]);

  return (
    <div ref={wrapRef} className="w-full overflow-x-auto">
      <svg width={w} height={H} className="block">
        {bands.map((b, i) => (
          <rect key={i} x={b.x0} y={0} width={Math.max(0.5, b.x1 - b.x0)} height={H} fill={toneOf(b.label).soft} />
        ))}
        <polyline points={pts} fill="none" stroke="rgb(var(--c-text))" strokeWidth="1.2" strokeLinejoin="round" opacity="0.85" />
      </svg>
    </div>
  );
}

// Live vs hindsight — the honest panel. Everything above is SMOOTHED: the
// model labelled the past with the benefit of having seen the whole series.
// A live system only has the forward pass — later and noisier. Showing both,
// with the measured lag, is the difference between a demo and a tool.
function LiveVsHindsight({ candles, regimes }) {
  const wrapRef = useRef(null);
  const [w, setW] = useState(800);
  const STRIP = 16, GAP = 22, H_PROB = 110, PAD = 8;
  const H = GAP * 2 + STRIP * 2 + H_PROB + 18;
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(320, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { hindBands, liveBands, probPts } = useMemo(() => {
    const n = candles.length;
    const x = (i) => PAD + (i / (n - 1)) * (w - 2 * PAD);
    const mkBands = (labels) => {
      const bands = [];
      let startI = 0, cur = labels[0];
      for (let i = 1; i < n; i++) {
        if (labels[i] !== cur) {
          if (cur) bands.push({ x0: x(startI), x1: x(i), label: cur });
          startI = i; cur = labels[i];
        }
      }
      if (cur) bands.push({ x0: x(startI), x1: x(n - 1), label: cur });
      return bands;
    };
    const probTop = GAP * 2 + STRIP * 2 + 8;
    const probPts = [];
    for (let i = 0; i < n; i++) {
      const p = regimes.perCandleBearProb?.[i];
      if (p == null) continue;
      probPts.push(`${x(i).toFixed(1)},${(probTop + (1 - p) * H_PROB).toFixed(1)}`);
    }
    return { hindBands: mkBands(regimes.perCandle), liveBands: mkBands(regimes.perCandleLive || []), probPts: probPts.join(" ") };
  }, [candles, regimes, w]);

  const h = regimes.honesty || {};
  const b = regimes.belief;
  const probTop = GAP * 2 + STRIP * 2 + 8;

  return (
    <section className="rounded-xl border border-line lg-glass p-5 hover-lift">
      <h2 className="font-semibold mb-1">Live belief vs hindsight</h2>
      <p className="text-[11px] text-dim mb-3 leading-relaxed">
        The chart above is <em>smoothed</em> — the model labelled the past knowing the whole series.
        Live, it only has the data so far. This is what that honestly looks like:
      </p>
      <div ref={wrapRef} className="w-full overflow-x-auto">
        <svg width={w} height={H} className="block">
          <text x={PAD} y={GAP - 8} className="fill-current text-dim" fontSize="9">HINDSIGHT (smoothed — has seen the future)</text>
          {hindBands.map((bd, i) => (
            <rect key={`h${i}`} x={bd.x0} y={GAP} width={Math.max(0.5, bd.x1 - bd.x0)} height={STRIP} fill={toneOf(bd.label).soft} />
          ))}
          <text x={PAD} y={GAP + STRIP + GAP - 8} className="fill-current text-dim" fontSize="9">LIVE (filtered — only the data so far)</text>
          {liveBands.map((bd, i) => (
            <rect key={`l${i}`} x={bd.x0} y={GAP + STRIP + GAP} width={Math.max(0.5, bd.x1 - bd.x0)} height={STRIP} fill={toneOf(bd.label).soft} />
          ))}
          {/* filtered P(bear) */}
          <line x1={PAD} x2={w - PAD} y1={probTop + H_PROB / 2} y2={probTop + H_PROB / 2}
            stroke="rgb(var(--c-line))" strokeDasharray="3 4" />
          <text x={w - PAD - 2} y={probTop + 9} textAnchor="end" className="fill-current text-dim" fontSize="9">P(Bear | data so far)</text>
          <polyline points={probPts} fill="none" stroke="rgb(var(--c-down))" strokeWidth="1.3" strokeLinejoin="round" opacity="0.9" />
        </svg>
      </div>

      {/* measured honesty */}
      <div className="flex flex-wrap gap-x-6 gap-y-1 mt-3 text-xs font-mono">
        {h.avgLagBars != null && (
          <span className="text-dim">live confirms a change <span className="text-warn font-semibold">{h.avgLagBars} bars late</span> on average ({h.changesMeasured} changes measured)</span>
        )}
        <span className="text-dim">flips: live <span className="text-text">{h.liveFlips ?? "–"}</span> vs hindsight <span className="text-text">{h.smoothFlips ?? "–"}</span></span>
      </div>

      {/* prior × likelihood = posterior, current bar */}
      {b && (
        <div className="mt-4 border-t border-line/60 pt-3">
          <p className="text-[10px] uppercase tracking-widest text-dim mb-2">Current bar: prior × likelihood = posterior</p>
          <div className="flex flex-wrap items-end gap-4">
            {[["Prior", b.prior, "×"], ["Likelihood", b.likelihood, "="], ["Posterior", b.posterior, null]].map(([name, vals, op]) => (
              <div key={name} className="flex items-end gap-4">
                <div>
                  <div className="flex items-end gap-1.5 h-16">
                    {regimes.labels.map((lab, rank) => (
                      <div key={lab} className="w-7 flex flex-col items-center justify-end h-full" title={`${lab}: ${((vals[rank] ?? 0) * 100).toFixed(1)}%`}>
                        <div className={cn("w-full rounded-t", toneOf(lab).bg)} style={{ height: `${Math.max(2, (vals[rank] ?? 0) * 100)}%`, opacity: 0.85 }} />
                      </div>
                    ))}
                  </div>
                  <p className="text-[10px] text-dim text-center mt-1">{name}</p>
                </div>
                {op && <span className="text-dim text-lg pb-5">{op}</span>}
              </div>
            ))}
            <p className="text-[11px] text-dim/80 leading-relaxed max-w-xs pb-1">
              Where the model's belief comes from: what it expected after the last bar (prior),
              what this bar's return/vol look like per regime (likelihood), and the resulting belief.
            </p>
          </div>
        </div>
      )}

      <p className="text-[11px] text-dim/70 mt-3 leading-relaxed">
        Why this matters: regime models look clairvoyant in backtests because smoothing has seen the future.
        The lag and flicker above are what you actually trade on — it's why the paper agent's regime gate
        uses the causal (live) estimate, and why regime signals are filters here, not entries.
      </p>
    </section>
  );
}
