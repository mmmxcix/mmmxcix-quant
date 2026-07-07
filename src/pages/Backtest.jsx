import { useMemo, useState } from "react";
import { Play, AlertTriangle, Sparkles, Copy, Check, KeyRound, Loader2 } from "lucide-react";
import EquityChart from "@/components/EquityChart";
import CandleChart from "@/components/CandleChart";
import SymbolSearch from "@/components/SymbolSearch";
import { fetchCandles, MARKETS, INTERVALS, RANGES } from "@/lib/data";
import { runBacktest, compileStrategy, DEFAULT_STRATEGY_CODE } from "@/lib/backtest";
import { BUILT_IN_STRATEGIES } from "@/lib/strategies";
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
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

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
        throw new Error("Token ungültig — bitte neu eingeben.");
      }
      if (res.status === 503) throw new Error("KI noch nicht konfiguriert (Cloudflare-Secrets fehlen).");
      if (res.status === 429) throw new Error("Rate-Limit erreicht — kurz warten.");
      if (!res.ok || !data.code) throw new Error("Generierung fehlgeschlagen — nochmal versuchen.");
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
      const res = runBacktest({ candles, signalFn, initialCapital: capital, feeBps });
      setResult({ ...res, candles, symbol: symbol.trim().toUpperCase(), candleCount: candles.length });
    } catch (e) {
      setError(e.message);
      setResult(null);
    } finally {
      setRunning(false);
    }
  };

  const equitySeries = useMemo(() => {
    if (!result) return null;
    return [
      { label: "Strategie", color: "#2dd4bf", points: result.equity },
      { label: "Buy & Hold", color: "#64748b", points: result.buyHold },
    ];
  }, [result]);

  // Buy/sell arrows on the price chart — shows exactly where the strategy
  // entered and exited, so you can see how close each call was.
  const tradeMarkers = useMemo(() => {
    if (!result?.trades) return [];
    const out = [];
    for (const t of result.trades) {
      out.push({ time: t.entryTime, side: "buy", text: "Kauf" });
      out.push({ time: t.exitTime, side: "sell", text: "Verkauf" });
    }
    return out;
  }, [result]);

  const m = result?.metrics;

  return (
    <div>
      <p className="text-[10px] tracking-[0.3em] text-dim uppercase mb-1">Strategie-Labor</p>
      <h1 className="text-2xl font-bold mb-6">Backtest</h1>

      <div className="grid lg:grid-cols-[340px_1fr] gap-6">
        {/* ── Settings column ─────────────────────────────────────────── */}
        <div className="space-y-4">
          <div className="rounded-xl border border-line lg-glass p-4 space-y-3">
            <p className="text-xs text-dim uppercase tracking-widest">Daten</p>
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
              placeholder={market === "crypto" ? "z. B. Bitcoin oder BTCUSDT" : "z. B. Apple oder SPY"}
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
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs text-dim">
                Startkapital
                <input type="number" value={capital} min={100}
                  onChange={(e) => setCapital(+e.target.value || 10000)} className="input-base w-full mt-1 font-mono" />
              </label>
              <label className="text-xs text-dim">
                Gebühr (bps/Seite)
                <input type="number" value={feeBps} min={0} max={100}
                  onChange={(e) => setFeeBps(+e.target.value || 0)} className="input-base w-full mt-1 font-mono" />
              </label>
            </div>
          </div>

          <div className="rounded-xl border border-line lg-glass p-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs text-dim uppercase tracking-widest">Strategie</p>
              <div className="flex gap-1">
                <button onClick={() => setMode("builder")}
                  className={cn("chip", mode === "builder" ? "chip-active" : "chip-idle")}>Baukasten</button>
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
                  <p className="text-[11px] text-dim">JS-Editor</p>
                  <button onClick={copyCode} title="Code kopieren"
                    className="flex items-center gap-1.5 text-[11px] text-dim hover:text-text transition-colors">
                    {copied ? <Check className="w-3.5 h-3.5 text-up" /> : <Copy className="w-3.5 h-3.5" />}
                    {copied ? "Kopiert!" : "Kopieren"}
                  </button>
                </div>
                <textarea
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  spellCheck={false}
                  rows={16}
                  className="input-base w-full font-mono text-xs leading-relaxed resize-y"
                />
                <p className="text-[11px] text-dim leading-relaxed">
                  Definiere <code className="text-accent">function strategy(ctx)</code> und gib{" "}
                  <code className="text-accent">"long"</code> oder <code className="text-accent">"flat"</code> zurück.
                  Verfügbar: <code>ctx.candles</code>, <code>ctx.index</code>, <code>ctx.close</code>,{" "}
                  <code>ctx.position</code>, <code>ctx.indicators</code> (sma, ema, rsi, roc, atr, bollinger, donchian).
                </p>

                {/* KI-Generator */}
                <div className="border-t border-line pt-3 space-y-2">
                  <p className="text-[11px] text-dim flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-accent" /> Strategie mit KI generieren
                  </p>
                  {devToken ? (
                    <>
                      <textarea
                        value={aiPrompt}
                        onChange={(e) => setAiPrompt(e.target.value)}
                        placeholder="z. B. Kaufe, wenn der RSI unter 30 fällt und der Kurs über dem SMA 200 liegt…"
                        rows={3}
                        className="input-base w-full text-xs resize-y"
                      />
                      <button onClick={generateCode} disabled={aiLoading || !aiPrompt.trim()}
                        className="btn-accent w-full flex items-center justify-center gap-2 !py-1.5 text-xs">
                        {aiLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                        {aiLoading ? "Generiere…" : "Generieren (ersetzt den Editor-Inhalt)"}
                      </button>
                    </>
                  ) : (
                    <div className="flex gap-2">
                      <input
                        type="password"
                        value={tokenInput}
                        onChange={(e) => setTokenInput(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && saveToken()}
                        placeholder="Dev-Zugangstoken"
                        className="input-base flex-1 text-xs"
                      />
                      <button onClick={saveToken} className="btn-ghost flex items-center gap-1.5 text-xs">
                        <KeyRound className="w-3.5 h-3.5" /> Freischalten
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
            {running ? "Läuft…" : "Backtest starten"}
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
              Wähle Daten und Strategie, dann starte den Backtest — Ergebnisse erscheinen hier.
            </div>
          ) : (
            <>
              {result.warnings?.length > 0 && (
                <div className="rounded-xl border border-yellow-500/40 bg-yellow-500/10 p-3 text-xs text-yellow-400">
                  Strategie-Warnung: {result.warnings[0]}
                </div>
              )}

              <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3">
                <MetricCard label="Rendite" value={fmtPct(m.totalReturnPct)}
                  tone={m.totalReturnPct >= 0 ? "text-up" : "text-down"} />
                <MetricCard label="Buy & Hold" value={fmtPct(m.buyHoldReturnPct)}
                  tone={m.buyHoldReturnPct >= 0 ? "text-up" : "text-down"} />
                <MetricCard label="CAGR" value={fmtPct(m.cagrPct)}
                  tone={m.cagrPct >= 0 ? "text-up" : "text-down"} />
                <MetricCard label="Sharpe" value={fmtNum(m.sharpe)} tone="text-text" />
                <MetricCard label="Max. Drawdown" value={fmtPct(-Math.abs(m.maxDrawdownPct))} tone="text-down" />
                <MetricCard label="Winrate" value={fmtPct(m.winRatePct).replace("+", "")} tone="text-text" />
                <MetricCard label="Profit-Faktor" value={fmtNum(m.profitFactor)} tone="text-text" />
                <MetricCard label="Trades · Exposure" value={`${m.tradeCount} · ${fmtNum(m.exposurePct, 0)}%`} tone="text-text" />
              </div>

              <div className="rounded-xl border border-line lg-glass p-3">
                <p className="text-xs text-dim px-2 pt-1 pb-2">
                  Kursverlauf mit Ein-/Ausstiegen — <span className="text-up">▲ Kauf</span>{" "}
                  <span className="text-down">▼ Verkauf</span> ({result.symbol})
                </p>
                <CandleChart candles={result.candles} markers={tradeMarkers} height={300} showVolume={false} />
              </div>

              <div className="rounded-xl border border-line lg-glass p-3">
                <p className="text-xs text-dim px-2 pt-1 pb-2">
                  Equity-Kurve — <span className="text-accent">Strategie</span> vs.{" "}
                  <span className="text-text/70">Buy &amp; Hold</span> ({result.symbol}, {result.candleCount} Kerzen)
                </p>
                <EquityChart series={equitySeries} />
              </div>

              {result.trades.length > 0 && (
                <div className="rounded-xl border border-line lg-glass overflow-hidden">
                  <p className="text-xs text-dim px-4 pt-3 pb-1">Letzte Trades ({Math.min(result.trades.length, 50)} von {result.trades.length})</p>
                  <div className="overflow-x-auto max-h-80 overflow-y-auto">
                    <table className="w-full text-xs font-mono">
                      <thead>
                        <tr className="text-left text-dim border-b border-line sticky top-0 bg-surface">
                          <th className="px-4 py-2 font-medium">Einstieg</th>
                          <th className="px-4 py-2 font-medium">Ausstieg</th>
                          <th className="px-4 py-2 font-medium text-right">Bars</th>
                          <th className="px-4 py-2 font-medium text-right">PnL %</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.trades.slice(-50).reverse().map((t, i) => (
                          <tr key={i} className="border-b border-line/40 last:border-0">
                            <td className="px-4 py-1.5 text-dim">{new Date(t.entryTime * 1000).toLocaleDateString("de-CH")}</td>
                            <td className="px-4 py-1.5 text-dim">{new Date(t.exitTime * 1000).toLocaleDateString("de-CH")}</td>
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
