import { useEffect, useMemo, useState } from "react";
import {
  Scale, TrendingUp, TrendingDown, MinusCircle, AlertTriangle, ShieldAlert,
  RefreshCw, Clock, Loader2,
} from "lucide-react";
import { computeBias, estimateHorizon } from "@/lib/tradeBias";
import { fetchCandles } from "@/lib/data";
import { cn, fmtPrice, fmtNum } from "@/lib/utils";

// Multi-timeframe, rule-based bias readout. Every timeframe is evaluated on
// the SAME fixed lookback (the last 300 candles of freshly fetched data), so
// the verdicts are comparable — the chart's own array (which can carry weeks
// of scrolled-in history) is deliberately NOT used. Timeframes may still
// legitimately disagree: a 15m pullback inside a 4h uptrend is real structure,
// and the confluence line says how aligned the picture is.

const LOOKBACK = 300;
const TF_SECONDS = { "1s": 1, "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "2h": 7200, "4h": 14400, "1d": 86400, "1w": 604800, "1M": 2592000 };
// Range that reliably yields ≥ LOOKBACK candles per interval and source.
const TF_RANGE = { "1s": "1h", "1m": "5d", "5m": "5d", "15m": "5d", "30m": "5d", "1h": "1mo", "2h": "1mo", "4h": "3mo", "1d": "1y", "1w": "5y", "1M": "max" };
const BASE_TFS = { crypto: ["15m", "1h", "4h", "1d"], stock: ["1h", "1d", "1w"] };

function fmtDur(sec) {
  if (sec < 3600) return `~${Math.max(1, Math.round(sec / 60))}m`;
  if (sec < 48 * 3600) return `~${Math.round(sec / 3600)}h`;
  return `~${Math.round(sec / 86400)}d`;
}

function VoteIcon({ vote }) {
  if (vote > 0) return <TrendingUp className="w-3.5 h-3.5 text-up shrink-0" />;
  if (vote < 0) return <TrendingDown className="w-3.5 h-3.5 text-down shrink-0" />;
  return <MinusCircle className="w-3.5 h-3.5 text-dim/70 shrink-0" />;
}

function VerdictChip({ verdict, score }) {
  const cls = verdict === "long" ? "text-up border-up/40 bg-up/10"
    : verdict === "short" ? "text-down border-down/40 bg-down/10"
    : "text-dim border-line bg-bg/40";
  const Icon = verdict === "long" ? TrendingUp : verdict === "short" ? TrendingDown : MinusCircle;
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide", cls)}>
      <Icon className="w-3 h-3" /> {verdict} {score > 0 ? `+${score}` : score}
    </span>
  );
}

export default function BiasPanel({ market, symbol, interval }) {
  // Timeframe set: the base ladder for this market plus the chart's own
  // interval, sorted ascending.
  const tfs = useMemo(() => {
    const set = new Set(BASE_TFS[market] || BASE_TFS.crypto);
    if (TF_RANGE[interval]) set.add(interval);
    return [...set].sort((a, b) => (TF_SECONDS[a] || 0) - (TF_SECONDS[b] || 0));
  }, [market, interval]);

  const [results, setResults] = useState({}); // tf -> { bias } | { error }
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(interval);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => { setSelected(TF_RANGE[interval] ? interval : tfs[0]); }, [interval, tfs]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setResults({});
    Promise.allSettled(
      tfs.map(async (tf) => {
        const candles = await fetchCandles({ market, symbol, interval: tf, range: TF_RANGE[tf] });
        return { tf, bias: computeBias(candles.slice(-LOOKBACK)) };
      })
    ).then((settled) => {
      if (!alive) return;
      const out = {};
      settled.forEach((r, i) => {
        out[tfs[i]] = r.status === "fulfilled" && r.value.bias ? { bias: r.value.bias } : { error: true };
      });
      setResults(out);
      setLoading(false);
    });
    return () => { alive = false; };
  }, [market, symbol, tfs, reloadKey]);

  const sel = results[selected]?.bias || null;

  // Confluence across timeframes.
  const confluence = useMemo(() => {
    const verdicts = tfs.map((tf) => results[tf]?.bias?.verdict).filter(Boolean);
    if (!verdicts.length) return null;
    const longs = verdicts.filter((v) => v === "long").length;
    const shorts = verdicts.filter((v) => v === "short").length;
    if (longs === verdicts.length) return { tone: "up", text: `All ${verdicts.length} timeframes lean long — aligned picture.` };
    if (shorts === verdicts.length) return { tone: "down", text: `All ${verdicts.length} timeframes lean short — aligned picture.` };
    if (longs > 0 && shorts > 0) return { tone: "mixed", text: `Timeframes disagree (${longs} long · ${shorts} short · ${verdicts.length - longs - shorts} neutral) — often a pullback on the lower timeframe inside the higher timeframe's trend. By the playbook: no trade without alignment.` };
    return { tone: "neutral", text: `Mostly neutral (${longs} long · ${shorts} short) — the rules see no clear edge right now.` };
  }, [results, tfs]);

  const tfSec = TF_SECONDS[selected] || 3600;
  const h1 = sel?.plan ? estimateHorizon(sel.plan.entry, sel.plan.tp1, sel.plan.atr, tfSec) : null;
  const h2 = sel?.plan ? estimateHorizon(sel.plan.entry, sel.plan.tp2, sel.plan.atr, tfSec) : null;

  return (
    <div className="rounded-xl border border-line lg-glass p-4">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <Scale className="w-4 h-4 text-accent" />
        <h2 className="text-sm font-semibold">Rule-based bias check</h2>
        <span className="text-[10px] text-dim uppercase tracking-wide">· mechanical, not AI · {symbol} · last {LOOKBACK} candles per timeframe</span>
        <button onClick={() => setReloadKey((k) => k + 1)} disabled={loading}
          className="ml-auto flex items-center gap-1.5 chip chip-idle !text-[11px]">
          {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />} Refresh
        </button>
      </div>

      {sel ? (
        <div className="grid lg:grid-cols-[210px_1fr_280px] gap-4">
          {/* Verdict card for the selected timeframe (the chart's by default) */}
          <div className={cn("rounded-lg border p-4 flex flex-col items-center justify-center text-center",
            sel.verdict === "long" ? "border-up/40 bg-up/10" : sel.verdict === "short" ? "border-down/40 bg-down/10" : "border-line bg-bg/40")}>
            {sel.verdict === "long" ? <TrendingUp className="w-8 h-8 mb-1 text-up" />
              : sel.verdict === "short" ? <TrendingDown className="w-8 h-8 mb-1 text-down" />
              : <MinusCircle className="w-8 h-8 mb-1 text-dim" />}
            <p className={cn("text-lg font-bold uppercase tracking-wide",
              sel.verdict === "long" ? "text-up" : sel.verdict === "short" ? "text-down" : "text-dim")}>
              {sel.verdict === "long" ? "Long bias" : sel.verdict === "short" ? "Short bias" : "Neutral"}
            </p>
            <p className="text-xs font-mono text-dim mt-1">score {sel.score > 0 ? "+" : ""}{sel.score} / ±{sel.maxScore}</p>
            <p className="text-[10px] text-dim uppercase tracking-widest mt-1.5">
              {selected} timeframe{selected === interval ? " (chart)" : ""}
            </p>
            {sel.verdict === "neutral" && (
              <p className="text-[11px] text-dim mt-2 leading-relaxed">The rules disagree — by this playbook that means: no trade.</p>
            )}
            {sel.caution && (
              <p className="flex items-start gap-1.5 text-[11px] text-warn mt-2 text-left leading-relaxed">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {sel.caution}
              </p>
            )}
          </div>

          {/* Rules for the selected timeframe */}
          <div className="rounded-lg border border-line bg-bg/30 p-3">
            <p className="text-[10px] text-dim uppercase tracking-widest mb-2">
              The rules (fixed if-then, each ±1)
            </p>
            <div className="grid sm:grid-cols-2 gap-x-4 gap-y-1.5">
              {sel.rules.map((r) => (
                <div key={r.id} className="flex items-start gap-2 text-xs">
                  <VoteIcon vote={r.vote} />
                  <div className="min-w-0">
                    <span className="text-text">{r.label}</span>
                    <span className="block text-[11px] text-dim truncate" title={r.detail}>{r.detail}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Plan + horizon for the selected timeframe */}
          <div className="rounded-lg border border-line bg-bg/30 p-3">
            <p className="text-[10px] text-dim uppercase tracking-widest mb-2">
              Suggested levels — {selected} structure
            </p>
            {sel.plan ? (
              <div className="space-y-1 text-xs font-mono">
                <div className="flex justify-between"><span className="text-dim">Entry (last)</span><span className="text-text">{fmtPrice(sel.plan.entry)}</span></div>
                <div className="flex justify-between"><span className="text-dim">Stop-loss</span><span className="text-down">{fmtPrice(sel.plan.stop)}</span></div>
                <div className="flex justify-between"><span className="text-dim">Target 1</span><span className="text-up">{fmtPrice(sel.plan.tp1)}</span></div>
                <div className="flex justify-between"><span className="text-dim">Target 2 (2R)</span><span className="text-up">{fmtPrice(sel.plan.tp2)}</span></div>
                <div className="flex justify-between border-t border-line/60 pt-1 mt-1">
                  <span className="text-dim">R:R to target 1</span>
                  <span className={sel.plan.rr1 >= 1.5 ? "text-up" : sel.plan.rr1 >= 1 ? "text-text" : "text-down"}>{fmtNum(sel.plan.rr1, 2)}</span>
                </div>
                <div className="flex justify-between"><span className="text-dim">ATR(14) / candle</span><span className="text-dim">{fmtPrice(sel.plan.atr)}</span></div>

                {h1 && (
                  <div className="border-t border-line/60 pt-1.5 mt-1.5">
                    <p className="flex items-center gap-1 text-[10px] text-dim uppercase tracking-wide font-sans mb-1">
                      <Clock className="w-3 h-3" /> Estimated time to hit (ATR math)
                    </p>
                    <div className="flex justify-between">
                      <span className="text-dim">Target 1 ({fmtNum(h1.k, 1)} ATR)</span>
                      <span className="text-text">{fmtDur(h1.fastSec)}–{fmtDur(h1.typicalSec)}</span>
                    </div>
                    {h2 && (
                      <div className="flex justify-between">
                        <span className="text-dim">Target 2 ({fmtNum(h2.k, 1)} ATR)</span>
                        <span className="text-text">{fmtDur(h2.fastSec)}–{fmtDur(h2.typicalSec)}</span>
                      </div>
                    )}
                    <p className="text-[10px] text-dim/80 font-sans leading-relaxed pt-1">
                      Fast end: price covering its typical per-candle range (ATR) in a straight line.
                      Slow end: random-walk scaling, where net distance grows with the square root of time (k ATR ≈ k² candles).
                      A statistical envelope, not a schedule.
                    </p>
                  </div>
                )}

                <p className="text-[10px] text-dim/80 font-sans leading-relaxed pt-1">
                  Stop: {sel.plan.stopBasis}. Target 1: {sel.plan.tpBasis}.
                  {sel.plan.rr1 < 1 && " R:R below 1 — by the playbook this setup is not worth taking."}
                </p>
              </div>
            ) : (
              <p className="text-xs text-dim leading-relaxed">
                No levels while the {selected} bias is neutral — stop and target only mean something once the rules agree on a direction.
              </p>
            )}
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-line bg-bg/30 p-4 text-sm text-dim">
          {loading ? "Crunching the timeframes…" : "Not enough data for this timeframe."}
        </div>
      )}

      {/* Compact multi-timeframe cross-check (click a chip to inspect it above) */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-line bg-bg/30 px-3 py-2 mt-3">
        <span className="text-[10px] text-dim uppercase tracking-widest">Cross-check</span>
        {tfs.map((tf) => {
          const r = results[tf];
          return (
            <button key={tf} onClick={() => setSelected(tf)}
              title={`Show the ${tf} breakdown above`}
              className={cn("flex items-center gap-1.5 rounded-md px-1.5 py-0.5 transition-colors",
                selected === tf ? "bg-accent/10" : "hover:bg-surface")}>
              <span className={cn("font-mono text-[11px]", selected === tf ? "text-accent" : "text-dim")}>{tf}</span>
              {r?.bias ? <VerdictChip verdict={r.bias.verdict} score={r.bias.score} />
                : r?.error ? <span className="text-[10px] text-dim">n/a</span>
                : <Loader2 className="w-3 h-3 animate-spin text-dim" />}
            </button>
          );
        })}
        {confluence && (
          <span className={cn("text-[11px] leading-relaxed",
            confluence.tone === "up" ? "text-up" : confluence.tone === "down" ? "text-down"
              : confluence.tone === "mixed" ? "text-warn" : "text-dim")}>
            {confluence.text}
          </span>
        )}
      </div>

      {/* Disclaimer — always visible, part of the feature */}
      <div className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/10 p-3 mt-3">
        <ShieldAlert className="w-4 h-4 text-warn shrink-0 mt-0.5" />
        <p className="text-[11px] text-text/80 leading-relaxed">
          <span className="font-semibold">This is not investment advice and not a recommendation to buy or sell.</span>{" "}
          It is a fixed, mechanical checklist applied to past price data for educational purposes. The rules know nothing about
          news, fundamentals, or your situation; timeframes can legitimately disagree; and past patterns do not predict future
          results. Any trade you place is your own decision and your own risk.
        </p>
      </div>
    </div>
  );
}
