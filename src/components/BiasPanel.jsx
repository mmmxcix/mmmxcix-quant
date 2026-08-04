import {
  AlertTriangle, TrendingUp, TrendingDown, MinusCircle, RefreshCw, Clock, Loader2,
} from "lucide-react";
import { estimateHorizon } from "@/lib/tradeBias";
import { cn, fmtPrice, fmtNum } from "@/lib/utils";

// Detailed rule-based readout for ONE (the selected) timeframe. The multi-timeframe
// data and the selector now live in BiasSection's shared timeframe row (each chip
// carries its verdict), so this is a pure renderer of the chosen timeframe's bias.

const TF_SECONDS = { "1s": 1, "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "2h": 7200, "4h": 14400, "1d": 86400, "1w": 604800, "1M": 2592000 };

function fmtDur(sec) {
  if (sec < 3600) return `~${Math.max(1, Math.round(sec / 60))}m`;
  if (sec < 48 * 3600) return `~${Math.round(sec / 3600)}h`;
  return `~${Math.round(sec / 86400)}d`;
}

function VoteIcon({ vote }) {
  if (vote > 0) return <TrendingUp className="w-3.5 h-3.5 text-up shrink-0" />;
  if (vote < 0) return <TrendingDown className="w-3.5 h-3.5 text-down shrink-0" />;
  return <MinusCircle className="w-3.5 h-3.5 text-dim shrink-0" />;
}

export default function BiasPanel({ selected, bias, loading, reload }) {
  const sel = bias || null;
  const tfSec = TF_SECONDS[selected] || 3600;
  const h1 = sel?.plan ? estimateHorizon(sel.plan.entry, sel.plan.tp1, sel.plan.atr, tfSec) : null;
  const h2 = sel?.plan ? estimateHorizon(sel.plan.entry, sel.plan.tp2, sel.plan.atr, tfSec) : null;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <span className="text-[10px] text-dim uppercase tracking-wide">mechanical, not AI · last 300 candles on the {selected} timeframe</span>
        <button onClick={reload} disabled={loading} className="ml-auto flex items-center gap-1.5 chip chip-idle !text-[11px]">
          {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />} Refresh
        </button>
      </div>

      {sel ? (
        <div className="grid lg:grid-cols-[210px_1fr_280px] gap-4">
          {/* Verdict card for the selected timeframe */}
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
            <p className="text-[10px] text-dim font-medium mt-1.5">{selected} timeframe</p>
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
            <p className="text-[10px] text-dim font-medium mb-2">The rules (fixed if-then, each ±1)</p>
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
            <p className="text-[10px] text-dim font-medium mb-2">Suggested levels — {selected} structure</p>
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
          {loading ? "Crunching the timeframe…" : "Not enough data for this timeframe."}
        </div>
      )}
    </div>
  );
}
