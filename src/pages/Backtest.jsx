import { useMemo, useState } from "react";
import { Play, AlertTriangle, Sparkles, Copy, Check, KeyRound, Loader2, Boxes } from "lucide-react";
import { Link } from "react-router-dom";
import EquityChart from "@/components/EquityChart";
import CandleChart from "@/components/CandleChart";
import SymbolSearch from "@/components/SymbolSearch";
import MonteCarloPanel from "@/components/MonteCarloPanel";
import ValidationPanel from "@/components/ValidationPanel";
import { fetchCandles, MARKETS, INTERVALS, RANGES } from "@/lib/data";
import { runBacktest, compileStrategy, DEFAULT_STRATEGY_CODE, ORB_STRATEGY_CODE, BIAS_STRATEGY_CODE, BIAS_TREND_CODE } from "@/lib/backtest";
import { BUILT_IN_STRATEGIES } from "@/lib/strategies";
import { saveEntry } from "@/lib/registry";
import { cn, fmtNum, fmtPct } from "@/lib/utils";

const DEFAULT_SYMBOL = { crypto: "BTCUSDT", stock: "SPY" };

function MetricCard({ label, value, tone }) {
  return (
    <div className="rounded-xl border border-line lg-glass px-4 py-3">
      <p className="text-[11px] text-dim mb-1">{label}</p>
      <p className={cn("font-mono font-semibold", tone)}>{value}</p>
    </div>
  );
}

export default function Backtest() {
  const [market, setMarket] = useState("crypto");
  const [symbol, setSymbol] = useState(DEFAULT_SYMBOL.crypto);
  const [interval, setIntervalId] = useState("1d");
  const [range, setRange] = useState("5y");
  const [mode, setMode] = useState("builder"); // builder | code
  const [strategyId, setStrategyId] = useState(BUILT_IN_STRATEGIES[0].id);
  const [paramValues, setParamValues] = useState({});
  const [code, setCode] = useState(DEFAULT_STRATEGY_CODE);
  const [capital, setCapital] = useState(10000);
  const [feeBps, setFeeBps] = useState(10);
  const [positionPct, setPositionPct] = useState(100);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [verdicts, setVerdicts] = useState({ wf: null, dsr: null, noise: null });
  const [saved, setSaved] = useState(false);

  // AI code generation: the Anthropic key never reaches the browser — the
  // Pages Function /api/generate holds it server-side; access requires the
  // dev token (stored once per browser in localStorage).
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState(null);
  const [copied, setCopied] = useState(false);
  const [devToken, setDevToken] = useState(() => {
    try { return localStorage.getItem("quant_dev_token") || ""; } catch { return ""; }
  });
  const [tokenInput, setTokenInput] = useState("");

  const saveToken = () => {
    const t = tokenInput.trim();
    if (!t) return;
    try { localStorage.setItem("quant_dev_token", t); } catch { /* private mode */ }
    setDevToken(t);
    setTokenInput("");
    setAiError(null);
    window.dispatchEvent(new Event("quant-dev-token")); // reveal the Coach nav entry
  };

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code);
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
        body: JSON.stringify({ prompt: p, token: devToken }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        setDevToken("");
        try { localStorage.removeItem("quant_dev_token"); } catch { /* ignore */ }
        throw new Error("Invalid token — please re-enter.");
      }
      if (res.status === 503) throw new Error("AI not configured yet (Cloudflare secrets missing).");
      if (res.status === 429) throw new Error("Rate limit reached — please wait a moment.");
      if (!res.ok || !data.code) throw new Error("Generation failed — please try again.");
      setCode(data.code);
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
      const signalFn = mode === "builder" ? strategy.build(effectiveParams) : compileStrategy(code);
      const candles = await fetchCandles({ market, symbol: symbol.trim().toUpperCase(), interval, range });
      const res = runBacktest({ candles, signalFn, initialCapital: capital, feeBps, positionPct });
      setResult({ ...res, candles, symbol: symbol.trim().toUpperCase(), candleCount: candles.length });
      setVerdicts({ wf: null, dsr: null, noise: null });
      setSaved(false);
    } catch (e) {
      setError(e.message);
      setResult(null);
    } finally {
      setRunning(false);
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

      <div className="grid lg:grid-cols-[340px_1fr] gap-6">
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
              {RANGES.map((r) => (
                <button key={r.id} onClick={() => setRange(r.id)}
                  className={cn("chip font-mono", range === r.id ? "chip-active" : "chip-idle")}>
                  {r.label}
                </button>
              ))}
            </div>
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
                  <p className="text-[11px] text-dim">JS editor</p>
                  <div className="flex items-center gap-3">
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
                    <button onClick={copyCode} title="Copy code"
                      className="flex items-center gap-1.5 text-[11px] text-dim hover:text-text transition-colors">
                      {copied ? <Check className="w-3.5 h-3.5 text-up" /> : <Copy className="w-3.5 h-3.5" />}
                      {copied ? "Copied!" : "Copy"}
                    </button>
                  </div>
                </div>
                <textarea
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  spellCheck={false}
                  rows={16}
                  className="input-base w-full font-mono text-xs leading-relaxed resize-y"
                />
                <p className="text-[11px] text-dim leading-relaxed">
                  Define <code className="text-accent">function strategy(ctx)</code> and return{" "}
                  <code className="text-accent">"long"</code>, <code className="text-accent">"short"</code> or{" "}
                  <code className="text-accent">"flat"</code> — or{" "}
                  <code className="text-accent">{'{ signal, stop, target }'}</code> for bracket exits.
                  Available: <code>ctx.candles</code>, <code>ctx.index</code>, <code>ctx.open/high/low/close</code>,{" "}
                  <code>ctx.position</code>, <code>ctx.session</code> (UTC time, isNewDay),{" "}
                  <code>ctx.indicators</code> (sma, ema, rsi, roc, atr, bollinger, donchian, macd).
                </p>

                {/* KI-Generator */}
                <div className="border-t border-line pt-3 space-y-2">
                  <p className="text-[11px] text-dim flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-accent" /> Generate strategy with AI
                  </p>
                  {devToken ? (
                    <>
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
                    </>
                  ) : (
                    <div className="flex gap-2">
                      <input
                        type="password"
                        value={tokenInput}
                        onChange={(e) => setTokenInput(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && saveToken()}
                        placeholder="Dev access token"
                        className="input-base flex-1 text-xs"
                      />
                      <button onClick={saveToken} className="btn-ghost flex items-center gap-1.5 text-xs">
                        <KeyRound className="w-3.5 h-3.5" /> Unlock
                      </button>
                    </div>
                  )}
                  {aiError && <p className="text-[11px] text-down">{aiError}</p>}
                </div>
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
                <div className="rounded-xl border border-yellow-500/40 bg-yellow-500/10 p-3 text-xs text-yellow-400">
                  Strategy warning: {result.warnings[0]}
                </div>
              )}

              <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3">
                <MetricCard label="Return" value={fmtPct(m.totalReturnPct)}
                  tone={m.totalReturnPct >= 0 ? "text-up" : "text-down"} />
                <MetricCard label="Buy & Hold" value={fmtPct(m.buyHoldReturnPct)}
                  tone={m.buyHoldReturnPct >= 0 ? "text-up" : "text-down"} />
                <MetricCard label="CAGR" value={fmtPct(m.cagrPct)}
                  tone={m.cagrPct >= 0 ? "text-up" : "text-down"} />
                <MetricCard label="Sharpe" value={fmtNum(m.sharpe)} tone="text-text" />
                <MetricCard label="Max drawdown" value={fmtPct(-Math.abs(m.maxDrawdownPct))} tone="text-down" />
                <MetricCard label="Win rate" value={fmtPct(m.winRatePct).replace("+", "")} tone="text-text" />
                <MetricCard label="Profit factor" value={fmtNum(m.profitFactor)} tone="text-text" />
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
