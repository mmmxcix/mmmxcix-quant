import { Link } from "react-router-dom";
import { Check, Minus, ArrowRight, ShieldCheck, Sparkles, Lock } from "lucide-react";
import { cn } from "@/lib/utils";

// Honest pricing — Free while in alpha, a fair Pro tier planned for later. No
// invented prices, no dark patterns. Theme-aware (uses the app tokens).

const FREE = [
  "Honest backtesting — Deflated Sharpe, walk-forward, purged CV",
  "In-browser ML — triple-barrier, meta-labeling, HRP",
  "Charts, screener, options Greeks, Monte-Carlo cones",
  "Macro yields, HMM regimes, correlation structure",
  "The live world map — ships, flights, cables, news",
  "Private by default — your data never leaves the browser",
];

const PRO = [
  "Everything in Free, always",
  "Deep strategy generation (Cortex) — the heavy compute",
  "Hosted 24/7 research agents that run while you're away",
  "Daily digest email of what changed",
  "Higher limits · longer history · priority compute",
];

function Tier({ name, tag, price, sub, features, cta, highlight, muted }) {
  return (
    <div className={cn("relative rounded-2xl border p-6 sm:p-7 flex flex-col",
      highlight ? "border-accent/40 bg-accent/[0.04] lg-glass" : "border-line lg-glass")}>
      {tag && (
        <span className={cn("absolute -top-2.5 left-6 text-[10px] font-mono uppercase tracking-wider rounded-full px-2.5 py-1 border",
          highlight ? "border-accent/40 bg-bg text-accent" : "border-line bg-bg text-dim")}>{tag}</span>
      )}
      <h2 className="text-lg font-bold">{name}</h2>
      <div className="mt-3 flex items-baseline gap-1.5">
        <span className={cn("font-mono font-extrabold tracking-tight", muted ? "text-3xl text-dim" : "text-4xl")}>{price}</span>
        {sub && <span className="text-sm text-dim">{sub}</span>}
      </div>
      <ul className="mt-6 space-y-2.5 flex-1">
        {features.map((f, i) => (
          <li key={f} className="flex items-start gap-2.5 text-sm">
            {muted && i > 0
              ? <Minus className="w-4 h-4 mt-0.5 shrink-0 text-dim/60" />
              : <Check className="w-4 h-4 mt-0.5 shrink-0 text-accent" />}
            <span className={muted && i > 0 ? "text-dim" : "text-text"}>{f}</span>
          </li>
        ))}
      </ul>
      <div className="mt-7">{cta}</div>
    </div>
  );
}

export default function Pricing() {
  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <div className="text-center max-w-2xl mx-auto mb-10">
        <p className="text-[11px] font-mono uppercase tracking-[0.28em] text-accent mb-3">Pricing · honest by default</p>
        <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-balance">Free while it's alpha.<br className="hidden sm:block" /> Fair when it's not.</h1>
        <p className="mt-4 text-dim leading-relaxed">
          The whole research desk is free right now — no account, no card, no catch. A Pro
          tier will come later to fund the heavy compute; the core tools stay generous.
        </p>
      </div>

      <div className="grid md:grid-cols-2 gap-5 items-stretch">
        <Tier
          name="Free" tag="Available now" price="€0" sub="while in alpha" highlight
          features={FREE}
          cta={<Link to="/" className="btn-primary w-full inline-flex items-center justify-center gap-2">Open the desk <ArrowRight className="w-4 h-4" /></Link>}
        />
        <Tier
          name="Pro" tag="Planned" price="TBD" sub="fair, after alpha" muted
          features={PRO}
          cta={
            <div className="text-center">
              <button disabled className="btn-ghost w-full opacity-70 cursor-not-allowed inline-flex items-center justify-center gap-2">
                <Sparkles className="w-3.5 h-3.5" /> Coming after alpha
              </button>
              <p className="text-[11px] text-dim mt-2">Alpha users keep founding-member pricing.</p>
            </div>
          }
        />
      </div>

      {/* Honesty strip */}
      <div className="mt-6 rounded-2xl border border-line lg-glass p-6 grid sm:grid-cols-3 gap-5">
        {[
          [ShieldCheck, "No dark patterns", "No fake countdowns, no bait pricing, no surprise charges. Ever."],
          [Lock, "Your data isn't the product", "It never leaves your browser — there's nothing to sell."],
          [Check, "Free stays generous", "The core research tools remain free after alpha, not crippled."],
        ].map(([Icon, t, d]) => (
          <div key={t} className="flex flex-col gap-1.5">
            <span className="w-8 h-8 rounded-lg grid place-items-center bg-accent/10 text-accent"><Icon className="w-4 h-4" /></span>
            <p className="text-sm font-semibold mt-1">{t}</p>
            <p className="text-xs text-dim leading-relaxed">{d}</p>
          </div>
        ))}
      </div>

      {/* FAQ */}
      <div className="mt-10 max-w-2xl mx-auto">
        <h3 className="text-sm font-mono uppercase tracking-wider text-dim mb-3">Questions</h3>
        {[
          ["Is it really free right now?", "Yes — the entire desk, no account required. Alpha means things move fast and occasionally break; in exchange, it's free."],
          ["What will Pro cost?", "Not decided yet, and we won't pretend otherwise. It'll be fair, aimed at covering the heavy hosted compute — and alpha users lock in founding-member pricing."],
          ["Will you sell my data?", "No. Backtests and ML run in your browser and your positions stay on your device. There's literally nothing to sell."],
          ["Is this investment advice?", "No — it's an educational research desk. Every backtest is hypothetical and shown deflated and out-of-sample."],
        ].map(([q, a]) => (
          <details key={q} className="border-b border-line py-3 group">
            <summary className="cursor-pointer list-none flex items-center justify-between gap-4 font-medium text-sm">
              {q}<span className="text-accent font-mono transition-transform group-open:rotate-45">+</span>
            </summary>
            <p className="text-sm text-dim leading-relaxed mt-2">{a}</p>
          </details>
        ))}
      </div>

      <p className="text-center text-xs text-dim mt-10">Educational tools · not investment advice · hypothetical results guarantee nothing.</p>
    </div>
  );
}
