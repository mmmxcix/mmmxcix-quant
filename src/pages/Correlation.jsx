import { useEffect, useMemo, useRef, useState } from "react";
import { Grid3x3, Plus, X, RefreshCw, Loader2, Shuffle } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DEFAULT_BASKET, detectMarket, fetchBasketReturns, correlationMatrix,
  seriationOrder, matrixInsights,
} from "@/lib/correlation";
import { fetchCandles } from "@/lib/data";
import { analyzePair } from "@/lib/pairs";
import Skeleton from "@/components/Skeleton";

// Cross-asset correlation matrix — stocks, ETFs, crypto and FX in one grid.
// Pairwise-complete daily log returns; greedy seriation groups correlated
// assets into visible blocks.

const LS_BASKET = "quant_corr_basket";
const LS_RANGE = "quant_corr_range";
const RANGE_OPTS = [
  { id: "3mo", label: "3M" },
  { id: "6mo", label: "6M" },
  { id: "1y", label: "1Y" },
  { id: "5y", label: "5Y" },
];

const loadBasket = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_BASKET) || "null");
    if (Array.isArray(raw) && raw.length >= 2 && raw.every((s) => typeof s === "string")) return raw;
  } catch { /* fall through */ }
  return DEFAULT_BASKET;
};

// Diverging cell fill: amber = positive, blue = negative, alpha = strength.
// Both hues come from the viz tokens, so light/dark theme stays consistent.
const cellStyle = (r) => {
  if (r === null) return {};
  const tone = r >= 0 ? "var(--viz-amber)" : "var(--viz-blue)";
  const pct = Math.round(Math.min(1, Math.abs(r)) * 78);
  return { backgroundColor: `color-mix(in srgb, ${tone} ${pct}%, transparent)` };
};

// Spread sparkline with the OU mean (μ) and ±2σ entry bands.
function SpreadSpark({ spread, mu, sigma, label }) {
  const W = 320, H = 88, pad = 4;
  const n = spread.length;
  if (!n) return null;
  const lo = Math.min(mu - 2.6 * sigma, ...spread);
  const hi = Math.max(mu + 2.6 * sigma, ...spread);
  const span = hi - lo || 1;
  const x = (i) => pad + (i / (n - 1)) * (W - 2 * pad);
  const y = (v) => pad + (1 - (v - lo) / span) * (H - 2 * pad);
  const path = spread.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-24" preserveAspectRatio="none">
      <line x1={pad} x2={W - pad} y1={y(mu)} y2={y(mu)} stroke="var(--c-dim)" strokeWidth="0.6" opacity="0.6" />
      <line x1={pad} x2={W - pad} y1={y(mu + 2 * sigma)} y2={y(mu + 2 * sigma)} stroke="var(--viz-pink)" strokeWidth="0.6" strokeDasharray="3 3" opacity="0.7" />
      <line x1={pad} x2={W - pad} y1={y(mu - 2 * sigma)} y2={y(mu - 2 * sigma)} stroke="var(--viz-teal)" strokeWidth="0.6" strokeDasharray="3 3" opacity="0.7" />
      <path d={path} fill="none" stroke="var(--c-accent)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      <title>{label}: spread with μ and ±2σ bands</title>
    </svg>
  );
}

export default function Correlation() {
  const [basket, setBasket] = useState(loadBasket);
  const [range, setRange] = useState(() => localStorage.getItem(LS_RANGE) || "1y");
  const [input, setInput] = useState("");
  const [data, setData] = useState(undefined); // undefined=loading, else {series, failed}
  const [clustered, setClustered] = useState(true);
  const [hover, setHover] = useState(null); // {i, j} in display coordinates
  const runId = useRef(0);

  useEffect(() => { localStorage.setItem(LS_BASKET, JSON.stringify(basket)); }, [basket]);
  useEffect(() => { localStorage.setItem(LS_RANGE, range); }, [range]);

  const load = async () => {
    const id = ++runId.current;
    setData(undefined);
    const out = await fetchBasketReturns(basket, range);
    if (id === runId.current) setData(out);
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [basket, range]);

  const computed = useMemo(() => {
    if (!data || Object.keys(data.series).length < 2) return null;
    const m = correlationMatrix(data.series);
    const order = clustered ? seriationOrder(m) : m.symbols.map((_, i) => i);
    return { ...m, order, insights: matrixInsights(m) };
  }, [data, clustered]);

  // ── Pairs mean-reversion (OU / Kalman) ────────────────────────────────────
  const [pairA, setPairA] = useState("");
  const [pairB, setPairB] = useState("");
  const [pair, setPair] = useState(null);      // { ...analyzePair, a, b } | { error }
  const [pairBusy, setPairBusy] = useState(false);
  useEffect(() => {
    // Default the two pickers to the least-correlated pair (the best hedge).
    if (computed?.insights?.lo && !pairA && !pairB) {
      setPairA(computed.insights.lo.a); setPairB(computed.insights.lo.b);
    }
  }, [computed, pairA, pairB]);

  const analyze = async () => {
    if (pairBusy || !pairA || !pairB || pairA === pairB) return;
    setPairBusy(true); setPair(null);
    try {
      const [ca, cb] = await Promise.all([
        fetchCandles({ market: detectMarket(pairA), symbol: pairA, interval: "1d", range: "2y" }),
        fetchCandles({ market: detectMarket(pairB), symbol: pairB, interval: "1d", range: "2y" }),
      ]);
      // Align on shared timestamps so weekends/holidays don't misalign the pair.
      const mapB = new Map(cb.map((c) => [c.time, c.close]));
      const A = [], B = [];
      for (const c of ca) {
        const b = mapB.get(c.time);
        if (b > 0 && c.close > 0) { A.push(c.close); B.push(b); }
      }
      if (A.length < 60) { setPair({ error: "Not enough overlapping history for this pair." }); return; }
      const res = analyzePair(A, B);
      setPair(res ? { ...res, a: pairA, b: pairB } : { error: "Analysis failed." });
    } catch (e) {
      setPair({ error: String(e.message || e).slice(0, 120) });
    } finally {
      setPairBusy(false);
    }
  };

  const addSymbol = () => {
    const sym = input.trim().toUpperCase();
    if (!sym || basket.includes(sym) || basket.length >= 16) return;
    setBasket((b) => [...b, sym]);
    setInput("");
  };
  const removeSymbol = (sym) => {
    if (basket.length <= 2) return;
    setBasket((b) => b.filter((s) => s !== sym));
  };

  return (
    <div>
      {/* controls */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {RANGE_OPTS.map((r) => (
          <button key={r.id} onClick={() => setRange(r.id)}
            className={cn("chip font-mono", range === r.id ? "chip-active" : "chip-idle")}>
            {r.label}
          </button>
        ))}
        <span className="w-px h-4 bg-line mx-1" />
        <button onClick={() => setClustered((c) => !c)}
          title="Reorder so correlated assets sit next to each other"
          className={cn("chip flex items-center gap-1.5", clustered ? "chip-active" : "chip-idle")}>
          <Shuffle className="w-3 h-3" /> Cluster
        </button>
        <button onClick={load} className="chip chip-idle flex items-center gap-1.5">
          {data === undefined ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />} Refresh
        </button>
      </div>

      {/* basket editor */}
      <div className="flex flex-wrap items-center gap-1.5 mb-5">
        {basket.map((sym) => (
          <span key={sym} className="inline-flex items-center gap-1 rounded-lg border border-line bg-bg/40 pl-2 pr-1 py-0.5 text-xs font-mono">
            {sym}
            <span className="text-[9px] text-dim/70 uppercase">{detectMarket(sym) === "crypto" ? "cx" : ""}</span>
            <button onClick={() => removeSymbol(sym)} disabled={basket.length <= 2}
              aria-label={`Remove ${sym}`}
              className="p-0.5 rounded text-dim hover:text-down disabled:opacity-30">
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
        <div className="inline-flex items-center gap-1">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addSymbol()}
            placeholder="AAPL · BTCUSDT · EURUSD=X"
            className="input-base !py-1 !px-2 w-44 text-xs font-mono"
          />
          <button onClick={addSymbol} disabled={!input.trim() || basket.length >= 16}
            className="chip chip-idle !px-2 disabled:opacity-40" aria-label="Add symbol">
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {data?.failed?.length > 0 && (
        <p className="text-xs text-down mb-3">
          No usable data for: {data.failed.join(", ")} — check the ticker (crypto ends in USDT, FX ends in =X).
        </p>
      )}

      {/* matrix */}
      {data === undefined ? (
        <Skeleton className="h-96 w-full rounded-xl" />
      ) : !computed ? (
        <p className="text-sm text-dim">Need at least two symbols with data to build a matrix.</p>
      ) : (
        <>
          <div className="rounded-xl border border-line lg-glass p-4 overflow-x-auto">
            <table className="border-separate" style={{ borderSpacing: 2 }} onMouseLeave={() => setHover(null)}>
              <thead>
                <tr>
                  <th />
                  {computed.order.map((oi, j) => (
                    <th key={computed.symbols[oi]}
                      className={cn("text-[10px] font-mono font-semibold px-1 pb-1 whitespace-nowrap",
                        hover?.j === j ? "text-accent" : "text-dim")}>
                      {computed.symbols[oi].replace("=X", "").replace("USDT", "")}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {computed.order.map((oi, i) => (
                  <tr key={computed.symbols[oi]}>
                    <td className={cn("text-[10px] font-mono font-semibold pr-2 whitespace-nowrap text-right",
                      hover?.i === i ? "text-accent" : "text-dim")}>
                      {computed.symbols[oi].replace("=X", "").replace("USDT", "")}
                    </td>
                    {computed.order.map((oj, j) => {
                      const r = computed.matrix[oi][oj];
                      const n = computed.counts[oi][oj];
                      const dim = hover && hover.i !== i && hover.j !== j;
                      return (
                        <td key={computed.symbols[oj]}
                          onMouseEnter={() => setHover({ i, j })}
                          title={oi === oj ? `${computed.symbols[oi]} · ${n} trading days`
                            : r === null ? "not enough overlapping days"
                            : `${computed.symbols[oi]} × ${computed.symbols[oj]} — r=${r.toFixed(3)} over ${n} days`}
                          style={cellStyle(oi === oj ? null : r)}
                          className={cn(
                            "w-11 h-9 text-center align-middle text-[10px] font-mono rounded transition-opacity",
                            oi === oj ? "text-dim/50 bg-bg/40" : "text-text",
                            dim && "opacity-30"
                          )}>
                          {oi === oj ? "—" : r === null ? "·" : r.toFixed(2)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* insights */}
          <div className="grid sm:grid-cols-3 gap-3 mt-4">
            {computed.insights.hi && (
              <div className="rounded-xl border border-line lg-glass p-3">
                <p className="text-[10px] text-dim uppercase tracking-widest mb-1">Most correlated</p>
                <p className="text-sm font-mono">{computed.insights.hi.a} × {computed.insights.hi.b}
                  <span className="text-up font-semibold ml-2">{computed.insights.hi.r.toFixed(2)}</span></p>
                <p className="text-[11px] text-dim mt-1">Holding both ≈ one position, doubled.</p>
              </div>
            )}
            {computed.insights.lo && (
              <div className="rounded-xl border border-line lg-glass p-3">
                <p className="text-[10px] text-dim uppercase tracking-widest mb-1">Least correlated</p>
                <p className="text-sm font-mono">{computed.insights.lo.a} × {computed.insights.lo.b}
                  <span className="text-accent font-semibold ml-2">{computed.insights.lo.r.toFixed(2)}</span></p>
                <p className="text-[11px] text-dim mt-1">The strongest hedge pair in this basket.</p>
              </div>
            )}
            {computed.insights.diversifier && (
              <div className="rounded-xl border border-line lg-glass p-3">
                <p className="text-[10px] text-dim uppercase tracking-widest mb-1">Best diversifier</p>
                <p className="text-sm font-mono">{computed.insights.diversifier.sym}
                  <span className="text-text font-semibold ml-2">⌀ |r| {computed.insights.diversifier.avg.toFixed(2)}</span></p>
                <p className="text-[11px] text-dim mt-1">Moves most independently of the rest.</p>
              </div>
            )}
          </div>

          {/* Pairs mean-reversion (OU / Kalman) */}
          <div className="rounded-xl border border-line lg-glass p-4 mt-4">
            <div className="flex flex-wrap items-center gap-2 mb-1">
              <p className="text-xs text-dim uppercase tracking-widest mr-auto">Pairs mean-reversion · OU / Kalman</p>
              <select value={pairA} onChange={(e) => setPairA(e.target.value)}
                className="rounded-lg border border-line bg-bg px-2 py-1 text-xs font-mono">
                {computed.symbols.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <span className="text-dim text-xs">vs</span>
              <select value={pairB} onChange={(e) => setPairB(e.target.value)}
                className="rounded-lg border border-line bg-bg px-2 py-1 text-xs font-mono">
                {computed.symbols.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <button onClick={analyze} disabled={pairBusy || pairA === pairB}
                className="chip chip-idle flex items-center gap-1.5 !text-[11px] disabled:opacity-50">
                {pairBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : null}{pairBusy ? "Analyzing…" : "Analyze"}
              </button>
            </div>
            <p className="text-[11px] text-dim mb-3 leading-relaxed">
              Fits a hedge ratio (OLS, with a Kalman drift check) and an Ornstein-Uhlenbeck model of
              the spread. Half-life = bars to close half the gap; a pair is only tradeable if the
              spread actually mean-reverts. 2y daily. Educational, not advice.
            </p>
            {pair?.error && <p className="text-xs text-down">{pair.error}</p>}
            {pair && !pair.error && (
              <div className="grid md:grid-cols-[auto_1fr] gap-4 items-center">
                <div className="grid grid-cols-2 gap-x-5 gap-y-1.5 text-xs font-mono">
                  <span className="text-dim">Hedge ratio β</span><span className="text-right">{pair.beta.toFixed(3)}</span>
                  <span className="text-dim">Half-life</span><span className="text-right">{Number.isFinite(pair.halfLife) ? `${pair.halfLife.toFixed(0)} bars` : "∞"}</span>
                  <span className="text-dim">Spread z-score</span><span className={cn("text-right", Math.abs(pair.z) >= 2 ? "text-accent font-semibold" : "")}>{pair.z >= 0 ? "+" : ""}{pair.z.toFixed(2)}σ</span>
                  <span className="text-dim">Signal</span>
                  <span className={cn("text-right font-semibold", pair.signal === "long spread" ? "text-up" : pair.signal === "short spread" ? "text-down" : "text-dim")}>
                    {pair.signal}
                  </span>
                  <span className="text-dim">Tradeable</span>
                  <span className={cn("text-right", pair.tradeable ? "text-up" : "text-dim")}>{pair.tradeable ? "yes" : "no — weak reversion"}</span>
                </div>
                <SpreadSpark spread={pair.spread} mu={pair.mu} sigma={pair.sigmaEq} label={`${pair.a} − ${pair.beta.toFixed(2)}·${pair.b}`} />
              </div>
            )}
          </div>

          <p className="text-xs text-dim mt-4 leading-relaxed">
            Pearson correlation of daily log returns, {RANGE_OPTS.find((r) => r.id === range)?.label} window,
            pairwise-complete (each pair uses only days both assets traded — crypto weekends don't dilute
            stock pairs). <span className="font-mono">amber</span> = move together,{" "}
            <span className="font-mono">blue</span> = move opposite. Correlations are regime-dependent:
            in a crash, most of this grid goes amber.
          </p>
        </>
      )}
    </div>
  );
}
