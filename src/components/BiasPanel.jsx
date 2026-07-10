import { useMemo } from "react";
import { Scale, TrendingUp, TrendingDown, MinusCircle, AlertTriangle, ShieldAlert } from "lucide-react";
import { computeBias } from "@/lib/tradeBias";
import { cn, fmtPrice, fmtNum } from "@/lib/utils";

// Rule-based bias readout for the Charts page: fixed if-then rules vote long
// or short, and the auto-detected structure supplies stop/target suggestions.
// Deliberately mechanical and fully auditable — every rule shows its vote and
// reasoning. The disclaimer is part of the component, not optional chrome.

function VoteIcon({ vote }) {
  if (vote > 0) return <TrendingUp className="w-3.5 h-3.5 text-up shrink-0" />;
  if (vote < 0) return <TrendingDown className="w-3.5 h-3.5 text-down shrink-0" />;
  return <MinusCircle className="w-3.5 h-3.5 text-dim/50 shrink-0" />;
}

export default function BiasPanel({ candles, symbol }) {
  const bias = useMemo(() => (candles ? computeBias(candles) : null), [candles]);

  if (!bias) {
    return (
      <div className="rounded-xl border border-line lg-glass p-4 text-sm text-dim">
        Not enough data for the rule check (needs ≥ 60 candles).
      </div>
    );
  }

  const { verdict, score, maxScore, rules, plan, caution } = bias;
  const vColor = verdict === "long" ? "text-up" : verdict === "short" ? "text-down" : "text-dim";
  const vBorder = verdict === "long" ? "border-up/40 bg-up/10" : verdict === "short" ? "border-down/40 bg-down/10" : "border-line bg-bg/40";

  return (
    <div className="rounded-xl border border-line lg-glass p-4">
      <div className="flex items-center gap-2 mb-3">
        <Scale className="w-4 h-4 text-accent" />
        <h2 className="text-sm font-semibold">Rule-based bias check</h2>
        <span className="text-[10px] text-dim uppercase tracking-wide">· mechanical, not AI · {symbol}</span>
      </div>

      <div className="grid lg:grid-cols-[220px_1fr_260px] gap-4">
        {/* Verdict */}
        <div className={cn("rounded-lg border p-4 flex flex-col items-center justify-center text-center", vBorder)}>
          {verdict === "long" ? <TrendingUp className={cn("w-8 h-8 mb-1", vColor)} />
            : verdict === "short" ? <TrendingDown className={cn("w-8 h-8 mb-1", vColor)} />
            : <MinusCircle className={cn("w-8 h-8 mb-1", vColor)} />}
          <p className={cn("text-lg font-bold uppercase tracking-wide", vColor)}>
            {verdict === "long" ? "Long bias" : verdict === "short" ? "Short bias" : "Neutral"}
          </p>
          <p className="text-xs font-mono text-dim mt-1">score {score > 0 ? "+" : ""}{score} / ±{maxScore}</p>
          {verdict === "neutral" && (
            <p className="text-[11px] text-dim mt-2 leading-relaxed">
              The rules disagree — by this playbook that means: no trade.
            </p>
          )}
          {caution && (
            <p className="flex items-start gap-1.5 text-[11px] text-yellow-400 mt-2 text-left leading-relaxed">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {caution}
            </p>
          )}
        </div>

        {/* Rules — every vote with its reasoning */}
        <div className="rounded-lg border border-line bg-bg/30 p-3">
          <p className="text-[10px] text-dim uppercase tracking-widest mb-2">The rules (fixed if-then, each ±1)</p>
          <div className="grid sm:grid-cols-2 gap-x-4 gap-y-1.5">
            {rules.map((r) => (
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

        {/* Structure-based plan */}
        <div className="rounded-lg border border-line bg-bg/30 p-3">
          <p className="text-[10px] text-dim uppercase tracking-widest mb-2">Suggested levels (from detected structure)</p>
          {plan ? (
            <div className="space-y-1 text-xs font-mono">
              <div className="flex justify-between"><span className="text-dim">Entry (last)</span><span className="text-text">{fmtPrice(plan.entry)}</span></div>
              <div className="flex justify-between"><span className="text-dim">Stop-loss</span><span className="text-down">{fmtPrice(plan.stop)}</span></div>
              <div className="flex justify-between"><span className="text-dim">Target 1</span><span className="text-up">{fmtPrice(plan.tp1)}</span></div>
              <div className="flex justify-between"><span className="text-dim">Target 2 (2R)</span><span className="text-up">{fmtPrice(plan.tp2)}</span></div>
              <div className="flex justify-between border-t border-line/60 pt-1 mt-1">
                <span className="text-dim">R:R to target 1</span>
                <span className={plan.rr1 >= 1.5 ? "text-up" : plan.rr1 >= 1 ? "text-text" : "text-down"}>
                  {fmtNum(plan.rr1, 2)}
                </span>
              </div>
              <div className="flex justify-between"><span className="text-dim">ATR(14)</span><span className="text-dim">{fmtPrice(plan.atr)}</span></div>
              <p className="text-[10px] text-dim/80 font-sans leading-relaxed pt-1">
                Stop: {plan.stopBasis}. Target 1: {plan.tpBasis}.
                {plan.rr1 < 1 && " R:R below 1 — by the playbook this setup is not worth taking."}
              </p>
            </div>
          ) : (
            <p className="text-xs text-dim leading-relaxed">
              No levels suggested while the bias is neutral — a stop and target only mean something once the rules agree on a direction.
            </p>
          )}
        </div>
      </div>

      {/* Disclaimer — always visible, part of the feature */}
      <div className="flex items-start gap-2 rounded-lg border border-yellow-500/40 bg-yellow-500/10 p-3 mt-3">
        <ShieldAlert className="w-4 h-4 text-yellow-400 shrink-0 mt-0.5" />
        <p className="text-[11px] text-yellow-200/90 leading-relaxed">
          <span className="font-semibold">This is not investment advice and not a recommendation to buy or sell.</span>{" "}
          It is a fixed, mechanical checklist applied to past price data for educational purposes. The rules know nothing about
          news, fundamentals, or your situation, and past patterns do not predict future results. Any trade you place is your
          own decision and your own risk.
        </p>
      </div>
    </div>
  );
}
