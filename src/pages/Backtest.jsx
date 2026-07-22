import { useEffect, useMemo, useState } from "react";
import { Play, AlertTriangle, Sparkles, Copy, Check, KeyRound, Loader2, Boxes } from "lucide-react";
import { Link } from "react-router-dom";
import EquityChart from "@/components/EquityChart";
import CandleChart from "@/components/CandleChart";
import SymbolSearch from "@/components/SymbolSearch";
import MonteCarloPanel from "@/components/MonteCarloPanel";
import ValidationPanel from "@/components/ValidationPanel";
import { fetchCandles, MARKETS, INTERVALS, rangesFor, INTERVAL_SECONDS } from "@/lib/data";
import { fetchLseCandles } from "@/lib/lse";
import { runBacktest, compileStrategy, DEFAULT_STRATEGY_CODE, ORB_STRATEGY_CODE, BIAS_STRATEGY_CODE, BIAS_TREND_CODE } from "@/lib/backtest";
import { runPythonSignals, signalsToFn, PYTHON_TEMPLATE } from "@/lib/pyRunner";
import { useSession } from "@/lib/authClient";
import CountUp from "@/components/CountUp";
import { BUILT_IN_STRATEGIES } from "@/lib/strategies";
import { saveEntry } from "@/lib/registry";
import { cn, fmtNum, fmtPct } from "@/lib/utils";

const DEFAULT_SYMBOL = { crypto: "BTCUSDT", stock: "SPY" };

function MetricCard({ label, value, num, format, tone }) {
  return (
    <div className="rounded-xl border border-line lg-glass px-4 py-3 hover-lift">
      <p className="text-[10px] uppercase tracking-wide text-dim mb-1.5">{label}</p>
      <p className={cn("font-mono text-lg font-bold tabular-nums leading-none", tone)}>
        {num != null && Number.isFinite(num) ? <CountUp value={num} format={format} /> : value}
      </p>
    </div>
  );
}

export default function Backtest() {
  const [market, setMarket] = useState("crypto");
  const [symbol, setSymbol] = useState(DEFAULT_SYMBOL.crypto);
  const [interval, setIntervalId] = useState("1d");
  const [range, setRange] = useState("5y");
  const [dataSrc, setDataSrc] = useState("yahoo"); // stock data: yahoo | london (LSE archive)
  // Custom test period — backtest exactly the window you pick (e.g. only the
  // 2022 bear market), instead of "the last N years".
  const [customPeriod, setCustomPeriod] = useState(false);
  const [fromDate, setFromDate] = useState("2020-01-01");
  const [toDate, setToDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [mode, setMode] = useState("builder"); // builder | code
  const [strategyId, setStrategyId] = useState(BUILT_IN_STRATEGIES[0].id);
  const [paramValues, setParamValues] = useState({});
  const [code, setCode] = useState(DEFAULT_STRATEGY_CODE);
  const [lang, setLang] = useState("js");        // js | python (code mode)
  const [pyCode, setPyCode] = useState(PYTHON_TEMPLATE);
  const [pyStatus, setPyStatus] = useState(null); // Pyodide loading/progress text
  const [capital, setCapital] = useState(10000);
  const [feeBps, setFeeBps] = useState(10);
  const [positionPct, setPositionPct] = useState(100);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [verdicts, setVerdicts] = useState({ wf: null, dsr: null, noise: null });
  const [saved, setSaved] = useState(false);

  // AI code generation: the provider keys never reach the browser — the Pages
  // Function /api/generate holds them server-side; access requires the signed-in
  // ADMIN (dev) session. The panel is simply hidden for everyone else.
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState(null);
  const [copied, setCopied] = useState(false);
  const { data: session } = useSession();
  const isDev = session?.user?.role === "admin";

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(lang === "python" ? pyCode : code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked */ }
  };

  const generateCode = async () => {
    const p = aiPrompt.trim();
    if (!p || aiLoading) return;
    setAiLoading(true);
    setAiError(null);
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: p, language: lang }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        throw new Error("Sign in with the dev account to use AI generation.");
      }
      if (res.status === 503) throw new Error("AI not configured yet (Cloudflare secrets missing).");
      if (res.status === 429) throw new Error("Rate limit reached — please wait a moment.");
      if (!res.ok || !data.code) throw new Error("Generation failed — please try again.");
      if (lang === "python") setPyCode(data.code); else setCode(data.code);
    } catch (e) {
      setAiError(e.message);
    } finally {
      setAiLoading(false);
    }
  };

  const strategy = useMemo(
    () => BUILT_IN_STRATEGIES.find((s) => s.id === strategyId),
    [strategyId]
  );

  // Only ranges that actually exist for the chosen interval (e.g. Yahoo has
  // no multi-year hourly data — it would silently degrade to monthly bars and
  // quietly wreck the test). Snap the range when the interval changes.
  const validRanges = useMemo(() => rangesFor(interval, market), [interval, market]);
  useEffect(() => {
    if (!validRanges.some((r) => r.id === range)) {
      setRange(validRanges[validRanges.length - 1].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interval, market]);

  const effectiveParams = useMemo(() => {
    const out = {};
    for (const p of strategy.params) out[p.key] = paramValues[p.key] ?? p.default;
    return out;
  }, [strategy, paramValues]);

  const switchMarket = (m) => {
    setMarket(m);
    setSymbol(DEFAULT_SYMBOL[m]);
    if (m === "stock" && !INTERVALS.find((i) => i.id === interval)?.markets.includes("stock")) {
      setIntervalId("1d");
    }
  };

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      // Python needs the candles first (it computes a vectorised signal array),
      // so fetch data before building the signal function in every mode.
      // Custom period → explicit unix window through whichever source is active.
      let from, to;
      if (customPeriod) {
        from = Math.floor(Date.parse(fromDate + "T00:00:00Z") / 1000);
        to = Math.floor(Date.parse(toDate + "T23:59:59Z") / 1000);
        if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
          throw new Error("Custom period: pick a valid from/to date range.");
        }
      }
      const candles = market === "stock" && dataSrc === "london"
        ? await fetchLseCandles({
            symbol: symbol.trim().toUpperCase(), interval,
            rangeDays: validRanges.find((r) => r.id === range)?.days ?? 365,
            from, to,
          })
        : await fetchCandles({ market, symbol: symbol.trim().toUpperCase(), interval, range, from, to });
      let signalFn;
      if (mode === "builder") {
        signalFn = strategy.build(effectiveParams);
      } else if (lang === "python") {
        const signals = await runPythonSignals(pyCode, candles, setPyStatus);
        setPyStatus(null);
        signalFn = signalsToFn(signals); // Python signals → same JS fill engine
      } else {
        signalFn = compileStrategy(code);
      }
      const res = runBacktest({ candles, signalFn, initialCapital: capital, feeBps, positionPct });
      // Data sanity: if the source silently delivered a coarser granularity
      // than requested (Yahoo does this for long intraday ranges), say so
      // loudly — indicator periods would mean something entirely different.
      // Zero trades is almost always a setup mismatch — say why instead of
      // showing a silent all-zero result.
      if (res.metrics.tradeCount === 0) {
        res.warnings.unshift(
          mode === "builder" && strategyId === "opening-range-breakout" && !["1s","1m","5m","15m","30m","1h","2h","4h"].includes(interval)
            ? "ORB needs an INTRADAY interval (e.g. 5m or 15m): on daily candles every bar starts a new day, so an opening range can never form — the strategy stays flat forever."
            : "No trades were made — the entry conditions never triggered on this data (check interval, range and parameters)."
        );
      }
      if (candles.length >= 3) {
        const spac = [];
        for (let i = 1; i < candles.length; i++) spac.push(candles[i].time - candles[i - 1].time);
        spac.sort((a, b) => a - b);
        const med = spac[Math.floor(spac.length / 2)];
        const want = INTERVAL_SECONDS[interval] || 0;
        if (want > 0 && med > want * 3) {
          res.warnings.unshift(
            `Data mismatch: you requested ${interval} candles but the source delivered ~${Math.round(med / 86400) >= 1 ? Math.round(med / 86400) + "-day" : Math.round(med / 3600) + "-hour"} bars for this range. Indicator periods now mean something else — pick a shorter range or a larger interval.`
          );
        }
      }
      setResult({ ...res, candles, symbol: symbol.trim().toUpperCase(), candleCount: candles.length });
      setVerdicts({ wf: null, dsr: null, noise: null });
      setSaved(false);
    } catch (e) {
      setError(e.message);
      setResult(null);
    } finally {
      setRunning(false);
      setPyStatus(null);
    }
  };

  const saveToRegistry = () => {
    if (!result) return;
    saveEntry({
      name: mode === "builder" ? strategy.name : "Code strategy",
      market, symbol: symbol.trim().toUpperCase(), interval, range,
      mode,
      strategyId: mode === "builder" ? strategyId : null,
      params: mode === "builder" ? effectiveParams : null,
      code: mode === "code" ? code : null,
      positionPct, feeBps,
      metrics: result.metrics,
      equity: result.equity,
      tradeReturns: result.trades.map((t) => t.pnlPct / 100),
      validation: verdicts,
      // A strategy that passed every run validation earns "validated" straight away.
      status: verdicts.wf === "pass" && verdicts.dsr === "pass" && verdicts.noise === "pass" ? "validated" : "factory",
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  const equitySeries = useMemo(() => {
    if (!result) return null;
    return [
      { label: "Strategy", color: "#2dd4bf", points: result.equity },
      { label: "Buy & Hold", color: "#64748b", points: result.buyHold },
    ];
  }, [result]);

  // Entry/exit arrows on the price chart — direction-aware so you can see
  // exactly where the strategy went long or short and how it got out.
  // lightweight-charts silently drops unsorted markers, so sort by time
  // (entries before exits on the same bar for readability).
  const tradeMarkers = useMemo(() => {
    if (!result?.trades) return [];
    const out = [];
    for (const t of result.trades) {
      const short = t.side === "short";
      out.push({ time: t.entryTime, side: short ? "sell" : "buy", text: short ? "Short" : "Long", order: 0 });
      out.push({ time: t.exitTime, side: short ? "buy" : "sell", text: short ? "Cover" : "Sell", order: 1 });
    }
    out.sort((a, b) => a.time - b.time || a.order - b.order);
    return out;
  }, [result]);

  const m = result?.metrics;

  return (
    <div>
      <p className="text-[10px] tracking-[0.3em] text-dim uppercase mb-1">Strategy Lab</p>
      <h1 className="text-2xl font-bold mb-6">Backtest</h1>

      <div className="grid lg:grid-cols-[340px_1fr] gap-6 [&>*]:min-w-0">
        {/* ── Settings column ─────────────────────────────────────────── */}
        <div className="space-y-4">
          <div className="rounded-xl border border-line lg-glass p-4 space-y-3">
            <p className="text-xs text-dim uppercase tracking-widest">Data</p>
            <div className="flex gap-1">
              {MARKETS.map((mk) => (
                <button key={mk.id} onClick={() => switchMarket(mk.id)}
                  className={cn("chip", market === mk.id ? "chip-active" : "chip-idle")}>
                  {mk.label}
                </button>
              ))}
            </div>
            <SymbolSearch
              market={market}
              value={symbol}
              onSelect={setSymbol}
              placeholder={market === "crypto" ? "e.g. Bitcoin or BTCUSDT" : "e.g. Apple or SPY"}
              className="w-full"
            />
            <div className="flex flex-wrap gap-1">
              {INTERVALS.filter((i) => i.markets.includes(market)).map((i) => (
                <button key={i.id} onClick={() => setIntervalId(i.id)}
                  className={cn("chip font-mono", interval === i.id ? "chip-active" : "chip-idle")}>
                  {i.label}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-1">
              {validRanges.map((r) => (
                <button key={r.id} onClick={() => { setRange(r.id); setCustomPeriod(false); }}
                  className={cn("chip font-mono", !customPeriod && range === r.id ? "chip-active" : "chip-idle")}>
                  {r.label}
                </button>
              ))}
              <button onClick={() => setCustomPeriod(true)}
                title="Backtest an exact period, e.g. only the 2022 bear market"
                className={cn("chip font-mono", customPeriod ? "chip-active" : "chip-idle")}>
                Custom
              </button>
            </div>
            {customPeriod && (
              <div className="flex flex-wrap items-end gap-2">
                <label className="text-xs text-dim">
                  From
                  <input type="date" value={fromDate} max={toDate}
                    onChange={(e) => setFromDate(e.target.value)}
                    className="input-base w-36 mt-1 font-mono block" />
                </label>
                <label className="text-xs text-dim">
                  To
                  <input type="date" value={toDate} min={fromDate} max={new Date().toISOString().slice(0, 10)}
                    onChange={(e) => setToDate(e.target.value)}
                    className="input-base w-36 mt-1 font-mono block" />
                </label>
              </div>
            )}
            {customPeriod && market === "stock" && dataSrc === "yahoo" && INTERVALS.find((i) => i.id === interval && !["1d", "1w", "1M"].includes(i.id)) && (
              <p className="text-[11px] text-dim">Yahoo serves intraday data only for recent weeks — for older periods use daily bars or the London source.</p>
            )}
            {market === "stock" && (
              <div className="flex items-center gap-1">
                <span className="text-[10px] text-dim uppercase tracking-wide mr-1">Source</span>
                {[["yahoo", "Yahoo"], ["london", "London"]].map(([id, label]) => (
                  <button key={id} onClick={() => setDataSrc(id)}
                    title={id === "london" ? "London Strategic Edge archive (133B ticks) — needs the LSE_API_KEY secret" : "Yahoo Finance via site proxy"}
                    className={cn("chip !text-[10px] !py-0.5", dataSrc === id ? "chip-active" : "chip-idle")}>
                    {label}
                  </button>
                ))}
              </div>
            )}
            <div className="grid grid-cols-3 gap-2">
              <label className="text-xs text-dim">
                Starting capital
                <input type="number" value={capital} min={100}
                  onChange={(e) => setCapital(+e.target.value || 10000)} className="input-base w-full mt-1 font-mono" />
              </label>
              <label className="text-xs text-dim">
                Fee (bps/side)
                <input type="number" value={feeBps} min={0} max={100}
                  onChange={(e) => setFeeBps(+e.target.value || 0)} className="input-base w-full mt-1 font-mono" />
              </label>
              <label className="text-xs text-dim" title="Percent of equity deployed per trade — drawdowns scale roughly with this">
                Position (%)
                <input type="number" value={positionPct} min={1} max={100} step={5}
                  onChange={(e) => setPositionPct(+e.target.value || 100)} className="input-base w-full mt-1 font-mono" />
              </label>
            </div>
          </div>

          <div className="rounded-xl border border-line lg-glass p-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs text-dim uppercase tracking-widest">Strategy</p>
              <div className="flex gap-1">
                <button onClick={() => setMode("builder")}
                  className={cn("chip", mode === "builder" ? "chip-active" : "chip-idle")}>Builder</button>
                <button onClick={() => setMode("code")}
                  className={cn("chip", mode === "code" ? "chip-active" : "chip-idle")}>Code</button>
              </div>
            </div>

            {mode === "builder" ? (
              <>
                <select value={strategyId} onChange={(e) => setStrategyId(e.target.value)}
                  className="input-base w-full">
                  {BUILT_IN_STRATEGIES.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
                <p className="text-xs text-dim leading-relaxed">{strategy.description}</p>
                <div className="grid grid-cols-2 gap-2">
                  {strategy.params.map((p) => (
                    <label key={p.key} className="text-xs text-dim">
                      {p.label}
                      <input
                        type="number"
                        value={paramValues[p.key] ?? p.default}
                        min={p.min} max={p.max} step={p.step}
                        onChange={(e) => setParamValues((v) => ({ ...v, [p.key]: +e.target.value }))}
                        className="input-base w-full mt-1 font-mono"
                      />
                    </label>
                  ))}
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1">
                    <button onClick={() => setLang("js")}
                      className={cn("chip !text-[10px] !py-0.5", lang === "js" ? "chip-active" : "chip-idle")}>JS</button>
                    <button onClick={() => setLang("python")}
                      className={cn("chip !text-[10px] !py-0.5", lang === "python" ? "chip-active" : "chip-idle")}>Python</button>
                  </div>
                  <div className="flex items-center gap-3">
                    {lang === "js" && (
                    <select
                      value=""
                      onChange={(e) => {
                        if (e.target.value === "sma") setCode(DEFAULT_STRATEGY_CODE);
                        else if (e.target.value === "orb") setCode(ORB_STRATEGY_CODE);
                        else if (e.target.value === "bias") setCode(BIAS_STRATEGY_CODE);
                        else if (e.target.value === "biastrend") setCode(BIAS_TREND_CODE);
                      }}
                      title="Insert an example (replaces the editor)"
                      className="bg-transparent text-[11px] text-dim hover:text-text transition-colors cursor-pointer outline-none"
                    >
                      <option value="">Examples…</option>
                      <option value="sma">SMA Crossover</option>
                      <option value="orb">Opening Range Breakout</option>
                      <option value="bias">Bias Score (raw — loses, educational)</option>
                      <option value="biastrend">Bias Trend Breakout (researched)</option>
                    </select>
                    )}
                    <button onClick={copyCode} title="Copy code"
                      className="flex items-center gap-1.5 text-[11px] text-dim hover:text-text transition-colors">
                      {copied ? <Check className="w-3.5 h-3.5 text-up" /> : <Copy className="w-3.5 h-3.5" />}
                      {copied ? "Copied!" : "Copy"}
                    </button>
                  </div>
                </div>
                <textarea
                  value={lang === "python" ? pyCode : code}
                  onChange={(e) => (lang === "python" ? setPyCode(e.target.value) : setCode(e.target.value))}
                  spellCheck={false}
                  rows={16}
                  className="input-base w-full font-mono text-xs leading-relaxed resize-y"
                />
                {lang === "python" ? (
                  <p className="text-[11px] text-dim leading-relaxed">
                    Define <code className="text-accent">def signals(df)</code> returning one value per bar:{" "}
                    <code className="text-accent">1</code> long, <code className="text-accent">0</code> flat,{" "}
                    <code className="text-accent">-1</code> short. <code>df</code> has columns{" "}
                    <code>open/high/low/close/volume</code>; <code>numpy</code> + <code>pandas</code> available.
                    Runs real CPython (Pyodide, ~6 MB, loads on first run) — the signals feed the same fill
                    engine as JS, so fees and no-look-ahead are identical. No intrabar brackets in Python yet.
                  </p>
                ) : (
                  <p className="text-[11px] text-dim leading-relaxed">
                    Define <code className="text-accent">function strategy(ctx)</code> and return{" "}
                    <code className="text-accent">"long"</code>, <code className="text-accent">"short"</code> or{" "}
                    <code className="text-accent">"flat"</code> — or{" "}
                    <code className="text-accent">{'{ signal, stop, target }'}</code> for bracket exits.
                    Available: <code>ctx.candles</code>, <code>ctx.index</code>, <code>ctx.open/high/low/close</code>,{" "}
                    <code>ctx.position</code>, <code>ctx.session</code> (UTC time, isNewDay),{" "}
                    <code>ctx.indicators</code> (sma, ema, rsi, roc, atr, bollinger, donchian, macd).
                  </p>
                )}
                {pyStatus && (
                  <p className="text-[11px] text-accent flex items-center gap-1.5">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> {pyStatus}
                  </p>
                )}

                {/* KI-Generator — dev-account only; hidden for everyone else */}
                {isDev && (
                  <div className="border-t border-line pt-3 space-y-2">
                    <p className="text-[11px] text-dim flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-accent" /> Generate strategy with AI
                    </p>
                    <textarea
                      value={aiPrompt}
                      onChange={(e) => setAiPrompt(e.target.value)}
                      placeholder="e.g. Buy when RSI drops below 30 and price is above the SMA 200…"
                      rows={3}
                      className="input-base w-full text-xs resize-y"
                    />
                    <button onClick={generateCode} disabled={aiLoading || !aiPrompt.trim()}
                      className="btn-accent w-full flex items-center justify-center gap-2 !py-1.5 text-xs">
                      {aiLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                      {aiLoading ? "Generating…" : "Generate (replaces the editor content)"}
                    </button>
                    {aiError && <p className="text-[11px] text-down">{aiError}</p>}
                  </div>
                )}
              </>
            )}
          </div>

          <button onClick={run} disabled={running} className="btn-accent w-full flex items-center justify-center gap-2">
            <Play className="w-4 h-4" />
            {running ? "Running…" : "Run backtest"}
          </button>

          {error && (
            <div className="rounded-xl border border-down/40 bg-down/10 p-3 text-sm text-down flex gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* ── Results column ──────────────────────────────────────────── */}
        <div className="space-y-4">
          {!result ? (
            <div className="rounded-xl border border-line lg-glass h-72 flex items-center justify-center text-sm text-dim px-8 text-center">
              Pick data and a strategy, then run the backtest — results appear here.
            </div>
          ) : (
            <>
              {result.warnings?.length > 0 && (
                <div className="rounded-xl border border-warn/40 bg-warn/10 p-3 text-xs text-warn">
                  Strategy warning: {result.warnings[0]}
                </div>
              )}

              <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3 stagger">
                <MetricCard label="Return" num={m.totalReturnPct} format={fmtPct}
                  tone={m.totalReturnPct >= 0 ? "text-up" : "text-down"} />
                <MetricCard label="Buy & Hold" num={m.buyHoldReturnPct} format={fmtPct}
                  tone={m.buyHoldReturnPct >= 0 ? "text-up" : "text-down"} />
                <MetricCard label="CAGR" num={m.cagrPct} format={fmtPct}
                  tone={m.cagrPct >= 0 ? "text-up" : "text-down"} />
                <MetricCard label="Sharpe" num={m.sharpe} format={fmtNum} tone="text-text" />
                <MetricCard label="Max drawdown" num={-Math.abs(m.maxDrawdownPct)} format={fmtPct} tone="text-down" />
                <MetricCard label="B&H max drawdown" num={-Math.abs(m.buyHoldMaxDrawdownPct ?? 0)} format={fmtPct} tone="text-down" />
                <MetricCard label="Win rate" num={m.winRatePct} format={(v) => fmtPct(v).replace("+", "")} tone="text-text" />
                <MetricCard label="Profit factor" num={Number.isFinite(m.profitFactor) ? m.profitFactor : null} format={fmtNum} tone="text-text" value={fmtNum(m.profitFactor)} />
                <MetricCard label="Trades · Exposure" value={`${m.tradeCount} · ${fmtNum(m.exposurePct, 0)}%`} tone="text-text" />
              </div>

              {/* Save to the Strategy Registry (the lab notebook) */}
              <div className="flex flex-wrap items-center gap-3">
                <button onClick={saveToRegistry} disabled={saved}
                  className={cn("flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm transition-colors",
                    saved ? "border-up/50 text-up bg-up/10" : "border-line text-dim hover:text-accent hover:border-accent/40")}>
                  {saved ? <Check className="w-4 h-4" /> : <Boxes className="w-4 h-4" />}
                  {saved ? "Saved to registry" : "Save to registry"}
                </button>
                <span className="text-[11px] text-dim">
                  Captures metrics {verdicts.wf || verdicts.dsr || verdicts.noise ? "+ the validation verdicts you've run" : "(run the validation below to also capture its verdicts)"} ·{" "}
                  <Link to="/registry" className="text-accent hover:underline">open Registry</Link>
                </span>
              </div>

              <div className="rounded-xl border border-line lg-glass p-3">
                <p className="text-xs text-dim px-2 pt-1 pb-2">
                  Price with entries/exits — <span className="text-up">▲ Buy</span>{" "}
                  <span className="text-down">▼ Sell</span> ({result.symbol})
                </p>
                <CandleChart candles={result.candles} markers={tradeMarkers} height={300} showVolume={false} fitAll />
              </div>

              <div className="rounded-xl border border-line lg-glass p-3">
                <p className="text-xs text-dim px-2 pt-1 pb-2">
                  Equity curve — <span className="text-accent">Strategy</span> vs.{" "}
                  <span className="text-text/70">Buy &amp; Hold</span> ({result.symbol}, {result.candleCount} candles)
                </p>
                <EquityChart series={equitySeries} />
              </div>

              {result.trades.length >= 10 && (
                <ValidationPanel
                  mode={mode}
                  strategy={strategy}
                  code={code}
                  compile={compileStrategy}
                  candles={result.candles}
                  feeBps={feeBps}
                  positionPct={positionPct}
                  result={result}
                  onVerdicts={setVerdicts}
                />
              )}

              {result.trades.length >= 10 && (
                <div className="rounded-xl border border-line lg-glass p-4">
                  <p className="text-xs text-dim uppercase tracking-widest pb-3">
                    Monte Carlo — is this result skill or ordering luck?
                  </p>
                  <MonteCarloPanel
                    returns={result.trades.map((t) => t.pnlPct / 100)}
                    initialCapital={capital}
                    defaultSteps={result.trades.length}
                    defaultLimitPct={20}
                    note="Each path resamples this backtest's own trades in random order. If P(end ≤ start) isn't near zero, the edge may be luck; the 95th-percentile drawdown — not the single backtest's — is the number to size against (a 50K prop account's $2,000 limit = 4%)."
                  />
                </div>
              )}

              {result.trades.length > 0 && (
                <div className="rounded-xl border border-line lg-glass overflow-hidden">
                  <p className="text-xs text-dim px-4 pt-3 pb-1">Recent trades ({Math.min(result.trades.length, 50)} of {result.trades.length})</p>
                  <div className="overflow-x-auto max-h-80 overflow-y-auto">
                    <table className="w-full text-xs font-mono">
                      <thead>
                        <tr className="text-left text-dim border-b border-line sticky top-0 bg-surface">
                          <th className="px-4 py-2 font-medium">Side</th>
                          <th className="px-4 py-2 font-medium">Entry</th>
                          <th className="px-4 py-2 font-medium">Exit</th>
                          <th className="px-4 py-2 font-medium">Reason</th>
                          <th className="px-4 py-2 font-medium text-right">Bars</th>
                          <th className="px-4 py-2 font-medium text-right">PnL %</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.trades.slice(-50).reverse().map((t, i) => (
                          <tr key={i} className="border-b border-line/40 last:border-0">
                            <td className={cn("px-4 py-1.5", t.side === "short" ? "text-down" : "text-up")}>
                              {t.side === "short" ? "Short" : "Long"}
                            </td>
                            <td className="px-4 py-1.5 text-dim">{new Date(t.entryTime * 1000).toLocaleDateString("de-CH")}</td>
                            <td className="px-4 py-1.5 text-dim">{new Date(t.exitTime * 1000).toLocaleDateString("de-CH")}</td>
                            <td className="px-4 py-1.5 text-dim">{t.reason || "signal"}</td>
                            <td className="px-4 py-1.5 text-right">{t.bars}</td>
                            <td className={cn("px-4 py-1.5 text-right", t.pnlPct >= 0 ? "text-up" : "text-down")}>
                              {fmtPct(t.pnlPct)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
