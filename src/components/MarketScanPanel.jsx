import { useMemo, useRef, useState } from "react";
import { Radar, Loader2, X } from "lucide-react";
import { cn, fmtNum } from "@/lib/utils";
import { runBacktest, compileStrategy } from "@/lib/backtest";
import { runPythonSignals, signalsToFn } from "@/lib/pyRunner";
import { fetchCandles, INTERVALS } from "@/lib/data";
import { SCAN_UNIVERSE, SCAN_CLASSES, SCAN_RANGE } from "@/lib/scanUniverse";

// "Find best market" — run the CURRENT strategy across a big universe (crypto,
// stocks, ETFs, forex — ~180 symbols) on the chosen timeframes and rank where it
// works best. Client-side (the same engine + Pyodide as a normal run), so it
// handles JS and Python; a bounded worker pool keeps fetches gentle and the tab
// responsive, and it's cancellable. Not every symbol × timeframe is valid (Yahoo
// has no 4h), so those are skipped.

const OBJECTIVES = {
  sharpe: { label: "Sharpe", get: (m) => m.sharpe },
  return: { label: "Total return", get: (m) => m.totalReturnPct },
  calmar: { label: "Calmar", get: (m) => (Number.isFinite(m.calmar) ? m.calmar : -99) },
  profitFactor: { label: "Profit factor", get: (m) => (Number.isFinite(m.profitFactor) ? m.profitFactor : 0) },
};

// The per-metric "best variant" summary — where the strategy did best on EACH
// dimension, not just the single Rank-by objective. Each card loads that market.
const BEST_METRICS = [
  { key: "sharpe", label: "Best Sharpe", get: (m) => m.sharpe, fmt: (v) => fmtNum(v, 2), dir: 1 },
  { key: "pf", label: "Best profit factor", get: (m) => (Number.isFinite(m.profitFactor) ? m.profitFactor : null), fmt: (v) => fmtNum(v, 2), dir: 1 },
  { key: "dd", label: "Smallest max DD", get: (m) => m.maxDrawdownPct, fmt: (v) => `-${fmtNum(v, 0)}%`, dir: -1 },
  { key: "ret", label: "Most total return", get: (m) => m.totalReturnPct, fmt: (v) => `${fmtNum(v, 0)}%`, dir: 1 },
];
function pickBests(list) {
  const bests = {};
  for (const bm of BEST_METRICS) {
    let row = null, wv = null;
    for (const r of list) {
      const v = bm.get(r.m);
      if (v == null || !Number.isFinite(v)) continue;
      if (row == null || (bm.dir > 0 ? v > wv : v < wv)) { row = r; wv = v; }
    }
    if (row) bests[bm.key] = { row, value: wv };
  }
  return bests;
}

const TF_CHOICES = ["1d", "4h", "1h", "15m"];

export default function MarketScanPanel({ code, language, capital, feeBps, positionPct, leverage, onLoad, buildSignalFn, usesPyodide }) {
  // Whether the scan will actually run Pyodide (Python code, NOT a native preset).
  const pyodide = usesPyodide ?? (language === "python");
  const [classes, setClasses] = useState(["crypto", "stock", "etf", "forex"]);
  const [tfs, setTfs] = useState(["1d"]);
  const [obj, setObj] = useState("sharpe");
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [results, setResults] = useState([]);
  const [best, setBest] = useState(null); // per-metric winners across the scan
  const [diag, setDiag] = useState(null); // why symbols were dropped (no black box)
  const [scanned, setScanned] = useState(false); // a scan has finished (for the empty-state)
  const cancelRef = useRef(false);

  const tasks = useMemo(() => {
    const syms = SCAN_UNIVERSE.filter((s) => classes.includes(s.cls));
    const out = [];
    for (const s of syms) for (const tf of tfs) {
      const iv = INTERVALS.find((i) => i.id === tf);
      if (!iv) continue;
      if (s.market === "crypto" && !iv.binance) continue;
      if (s.market === "stock" && !iv.yahoo) continue;
      out.push({ s, tf });
    }
    return out;
  }, [classes, tfs]);

  const toggle = (arr, setArr, v) => setArr(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  async function scan() {
    if (!tasks.length || !code?.trim()) return;
    setRunning(true); cancelRef.current = false; setResults([]); setBest(null); setDiag(null); setScanned(false); setDone(0); setTotal(tasks.length);
    const get = OBJECTIVES[obj].get;
    const out = [];
    // Build the signal fn exactly the way the manual run does (an unedited preset
    // uses its native builder, not the compiled code string) — the fallback keeps
    // this component usable standalone.
    const makeFn = buildSignalFn || (async (cs) => (language === "python" ? signalsToFn(await runPythonSignals(code, cs)) : compileStrategy(code)));
    // Per-reason tally so a "no results" is never a mystery: we can SEE whether
    // symbols had no data, errored, liquidated, or just traded too little.
    const d = { noData: 0, errored: 0, liquidated: 0, fewTrades: 0, kept: 0, firstError: null };
    let idx = 0, finished = 0;
    const concurrency = pyodide ? 1 : 5; // Pyodide is single-threaded; native JS isn't
    const worker = async () => {
      while (idx < tasks.length && !cancelRef.current) {
        const { s, tf } = tasks[idx++];
        try {
          const candles = await fetchCandles({ market: s.market, symbol: s.symbol, interval: tf, range: SCAN_RANGE[tf] || "2y" });
          if (!candles || candles.length <= 60) {
            d.noData++;
          } else {
            const fn = await makeFn(candles);
            const r = runBacktest({ candles, signalFn: fn, initialCapital: capital, feeBps, positionPct, leverage });
            // A liquidation voids the equity curve (used to happen on every symbol
            // at high leverage → the whole scan filtered to nothing). Tally each
            // drop reason instead of silently swallowing it.
            if (r.warnings.some((w) => /liquidat/i.test(w))) d.liquidated++;
            else if (r.metrics.tradeCount < 3) d.fewTrades++;
            else { d.kept++; out.push({ ...s, interval: tf, m: r.metrics, warned: r.warnings.length > 0 }); }
          }
        } catch (e) {
          d.errored++;
          if (!d.firstError) d.firstError = (e && e.message ? e.message : String(e)).slice(0, 120);
        }
        finished++; setDone(finished);
        if (finished % 4 === 0) { out.sort((a, b) => get(b.m) - get(a.m)); setResults(out.slice(0, 40)); setBest(pickBests(out)); setDiag({ ...d }); }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    out.sort((a, b) => get(b.m) - get(a.m));
    setResults(out.slice(0, 40));
    setBest(pickBests(out));
    setDiag({ ...d });
    setScanned(true);
    setRunning(false);
  }

  return (
    <div className="rounded-xl border border-line lg-glass p-3 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Radar className="w-4 h-4 text-accent" />
        <p className="text-sm font-semibold">Find best market</p>
        <span className="text-[10px] text-dim">· runs this strategy across {tasks.length} symbol×timeframe combos and ranks them</span>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-dim uppercase tracking-wide">Markets</span>
          {SCAN_CLASSES.map((c) => (
            <button key={c.id} onClick={() => toggle(classes, setClasses, c.id)} disabled={running}
              className={cn("chip !text-[10px]", classes.includes(c.id) ? "chip-active" : "chip-idle")}>
              {c.label} <span className="opacity-60">{c.n}</span>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-dim uppercase tracking-wide">Timeframes</span>
          {TF_CHOICES.map((tf) => (
            <button key={tf} onClick={() => toggle(tfs, setTfs, tf)} disabled={running}
              className={cn("chip !text-[10px]", tfs.includes(tf) ? "chip-active" : "chip-idle")}>{tf}</button>
          ))}
          <span className="text-[9px] text-dim">(Yahoo has no 4h — skipped for stocks/ETF/forex)</span>
        </div>
        <label className="text-[10px] text-dim">Rank by
          <select value={obj} onChange={(e) => setObj(e.target.value)} disabled={running} className="input-base ml-1 !py-0.5 text-[10px]">
            {Object.entries(OBJECTIVES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </label>
        {!running ? (
          <button onClick={scan} disabled={!tasks.length}
            className="chip chip-idle !text-xs flex items-center gap-1.5 hover:text-accent ml-auto">
            <Radar className="w-3.5 h-3.5" /> Scan {tasks.length}
          </button>
        ) : (
          <button onClick={() => { cancelRef.current = true; }}
            className="chip chip-idle !text-xs flex items-center gap-1.5 hover:text-down ml-auto">
            <X className="w-3.5 h-3.5" /> Stop
          </button>
        )}
      </div>

      {running && (
        <div className="flex items-center gap-2 text-[10px] text-dim">
          <Loader2 className="w-3 h-3 animate-spin" />
          scanning {done}/{total}…
          <div className="flex-1 h-1 rounded-full bg-line overflow-hidden">
            <div className="h-full bg-accent" style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
          </div>
        </div>
      )}
      {pyodide && (
        <p className="text-[10px] text-dim">Python runs one symbol at a time (Pyodide) — a full 4-class · daily scan takes a few minutes. Narrow the markets/timeframes for a quicker pass.</p>
      )}

      {/* Diagnostic tally — where the tested combos went. Never a black box. */}
      {diag && (diag.kept + diag.fewTrades + diag.liquidated + diag.errored + diag.noData) > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] font-mono text-dim">
          <span className="text-up">{diag.kept} kept</span>
          {diag.fewTrades > 0 && <span>{diag.fewTrades} &lt;3 trades</span>}
          {diag.liquidated > 0 && <span className="text-warn">{diag.liquidated} liquidated ({leverage}x)</span>}
          {diag.errored > 0 && <span className="text-down">{diag.errored} errored</span>}
          {diag.noData > 0 && <span>{diag.noData} no data</span>}
        </div>
      )}
      {scanned && !running && results.length === 0 && (
        <p className="text-[11px] text-warn leading-relaxed">
          No market produced a usable result (≥3 trades, not liquidated).{" "}
          {diag?.errored > 0 && `${diag.errored} combos errored${diag.firstError ? ` (e.g. "${diag.firstError}")` : ""} — the code likely doesn't run on that data. `}
          {diag?.liquidated > 0 && `${diag.liquidated} liquidated at ${leverage}x — lower the leverage. `}
          {diag?.fewTrades > 0 && diag.errored === 0 && diag.liquidated === 0 && `The strategy just trades too rarely here (${diag.fewTrades} combos had <3 trades) — widen the markets/timeframes. `}
          {(!diag || (diag.errored === 0 && diag.liquidated === 0 && diag.fewTrades === 0)) && "Widen the markets/timeframes, or run it once in the backtester to see any warnings."}
        </p>
      )}
      {/* Per-metric winners — the best variant on EACH dimension, each loadable. */}
      {best && Object.keys(best).length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {BEST_METRICS.filter((bm) => best[bm.key]).map((bm) => {
            const { row, value } = best[bm.key];
            return (
              <button key={bm.key} onClick={() => onLoad({ market: row.market, symbol: row.symbol, interval: row.interval, range: SCAN_RANGE[row.interval] || "2y" })}
                title={`Load ${row.label} ${row.interval}`}
                className="rounded-lg border border-line bg-bg/40 p-2 text-left hover:border-accent/50 transition-colors">
                <p className="text-[9px] uppercase tracking-wide text-dim">{bm.label}</p>
                <p className="text-sm font-mono text-text">{bm.fmt(value)}</p>
                <p className="text-[10px] text-dim truncate">{row.label} <span className="text-dim/60">{row.interval}</span></p>
              </button>
            );
          })}
        </div>
      )}
      {results.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px] font-mono">
            <thead>
              <tr className="text-left text-dim border-b border-line">
                <th className="py-1 pr-3 font-sans font-medium">#</th>
                <th className="py-1 pr-3 font-sans font-medium">Market</th>
                <th className="py-1 pr-3 font-sans font-medium">TF</th>
                <th className="py-1 pr-3 font-sans font-medium text-right">Sharpe</th>
                <th className="py-1 pr-3 font-sans font-medium text-right">Return</th>
                <th className="py-1 pr-3 font-sans font-medium text-right">MaxDD</th>
                <th className="py-1 pr-3 font-sans font-medium text-right">PF</th>
                <th className="py-1 pr-3 font-sans font-medium text-right">Trades</th>
                <th className="py-1 font-sans font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {results.map((r, i) => (
                <tr key={`${r.symbol}-${r.interval}`} className="border-b border-line/40 last:border-0">
                  <td className="py-1 pr-3 text-dim">{i + 1}</td>
                  <td className="py-1 pr-3 text-text">{r.label} <span className="text-dim/60 text-[9px] uppercase">{r.cls}</span></td>
                  <td className="py-1 pr-3 text-dim">{r.interval}</td>
                  <td className="py-1 pr-3 text-right text-text">{fmtNum(r.m.sharpe, 2)}</td>
                  <td className={cn("py-1 pr-3 text-right", r.m.totalReturnPct >= 0 ? "text-up" : "text-down")}>{fmtNum(r.m.totalReturnPct, 0)}%</td>
                  <td className="py-1 pr-3 text-right text-down">{fmtNum(r.m.maxDrawdownPct, 0)}%</td>
                  <td className="py-1 pr-3 text-right text-dim">{fmtNum(r.m.profitFactor, 2)}</td>
                  <td className="py-1 pr-3 text-right text-dim">{r.m.tradeCount}</td>
                  <td className="py-1 text-right">
                    <button onClick={() => onLoad({ market: r.market, symbol: r.symbol, interval: r.interval, range: SCAN_RANGE[r.interval] || "2y" })}
                      className="chip chip-idle !text-[9px] hover:text-accent">Load</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
