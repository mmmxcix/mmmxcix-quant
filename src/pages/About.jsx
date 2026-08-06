import { Link } from "react-router-dom";
import { ShieldCheck, Waypoints, Radar, Layers, Lock, Skull, ArrowRight } from "lucide-react";

// About + Methodology — the trust page. Who's behind it, and the honest rules
// every number on the desk is held to. Theme-aware (app tokens).

const METHODS = [
  { icon: ShieldCheck, title: "Deflated Sharpe", body: "Every Sharpe is discounted for how many strategies were tried. Test enough ideas and one looks brilliant by luck — deflation strips that out so a number you see is a number that survived the search." },
  { icon: Waypoints, title: "Walk-forward, out of sample", body: "Strategies are fit on the past and judged on data they never saw. In-sample results flatter; out-of-sample is the only kind that pays." },
  { icon: Radar, title: "Purged cross-validation", body: "Overlapping samples leak the future into the past. Purged, embargoed CV removes that leakage so the score isn't quietly cheating." },
  { icon: Layers, title: "Triple-barrier & meta-labeling", body: "Labels come from realistic profit/stop/time barriers, then a meta-model decides when to actually act — the López-de-Prado way, not naïve next-bar returns." },
  { icon: Skull, title: "The losers are shown too", body: "Failed strategies go to a visible graveyard, not the memory hole. Real, imperfect track records — including drawdowns and buried ideas — are the whole point." },
  { icon: Lock, title: "Private by default", body: "Backtests and ML run in your browser; your watchlist and positions stay on your device. There's nothing to upload and nothing to sell." },
];

export default function About() {
  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <p className="text-[11px] font-mono uppercase tracking-[0.28em] text-accent mb-3">About · Methodology</p>
      <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-balance">Built in the open. Graded honestly.</h1>
      <p className="mt-4 text-dim leading-relaxed">
        MMMXCIX Quant is an independent research desk — no fund behind it, no product to pump, no
        incentive to flatter the numbers. The entire pitch is honesty, so the methodology is the
        product. Here's exactly what every figure on the desk is held to.
      </p>

      <div className="mt-8 grid sm:grid-cols-2 gap-4">
        {METHODS.map(({ icon: Icon, title, body }) => (
          <div key={title} className="rounded-xl border border-line lg-glass p-5">
            <div className="w-9 h-9 rounded-lg grid place-items-center bg-accent/10 text-accent mb-3"><Icon className="w-5 h-5" strokeWidth={1.75} /></div>
            <h2 className="font-semibold mb-1">{title}</h2>
            <p className="text-sm text-dim leading-relaxed">{body}</p>
          </div>
        ))}
      </div>

      {/* Who */}
      <div className="mt-6 rounded-2xl border border-line lg-glass p-6 sm:p-7">
        <h2 className="font-semibold mb-2">Who's behind it</h2>
        <p className="text-sm text-dim leading-relaxed">
          Built by an independent quant, in public. No fund affiliation, no paid signals, no
          conflict of interest — the tools are free while in beta and stay generous after. If a
          result can't survive deflation, walk-forward and a real sample, it doesn't ship.
        </p>
        <p className="text-sm mt-3 font-mono text-dim">— MMMXCIX</p>
      </div>

      <div className="mt-8 flex flex-wrap items-center gap-3">
        <Link to="/" className="btn-primary inline-flex items-center gap-2">Open the desk <ArrowRight className="w-4 h-4" /></Link>
        <Link to="/changelog" className="btn-ghost">What's new →</Link>
        <Link to="/pricing" className="btn-ghost">Pricing</Link>
      </div>

      <p className="text-xs text-dim mt-10">Educational tools · not investment advice · backtests are hypothetical and past performance guarantees nothing.</p>
    </div>
  );
}
