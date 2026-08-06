import { useEffect } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight, FlaskConical, Brain, LineChart, Landmark, Globe, ShieldCheck,
  Radar, Waypoints, Lock,
} from "lucide-react";
import Brandmark, { BrandGlyph } from "@/components/Brandmark";

export const WELCOMED_KEY = "quant_welcomed";

// A little candlestick figure that echoes the logo — mono ink candles with the
// last few in the accent, on a faint grid. Pure decoration, theme-aware.
function HeroChart() {
  const bars = [
    [30, 46, 50, 26, 0], [46, 40, 52, 36, 0], [40, 58, 62, 38, 0], [58, 52, 64, 48, 0],
    [52, 70, 74, 50, 0], [70, 62, 78, 58, 0], [62, 82, 86, 60, 1], [82, 74, 90, 70, 1],
    [74, 94, 100, 72, 1],
  ];
  const W = 380, H = 200, n = bars.length, cw = W / n, bw = cw * 0.46;
  const y = (v) => H - 12 - (v / 108) * (H - 30);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" aria-hidden="true">
      <defs>
        <linearGradient id="hg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="rgb(var(--c-accent))" stopOpacity="0.14" />
          <stop offset="1" stopColor="rgb(var(--c-accent))" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75].map((f) => (
        <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} stroke="rgb(var(--c-line))" strokeWidth="1" />
      ))}
      <polygon
        points={`0,${H} ${bars.map((b, i) => `${i * cw + cw / 2},${y(b[1])}`).join(" ")} ${W},${H}`}
        fill="url(#hg)" />
      {bars.map(([o, c, h, l, accent], i) => {
        const cx = i * cw + cw / 2;
        const col = accent ? "rgb(var(--c-accent))" : "rgb(var(--c-dim))";
        return (
          <g key={i}>
            <line x1={cx} x2={cx} y1={y(h)} y2={y(l)} stroke={col} strokeWidth="1.5" strokeLinecap="round" />
            <rect x={cx - bw / 2} y={y(Math.max(o, c))} width={bw}
              height={Math.max(2, Math.abs(y(o) - y(c)))} rx="1.5" fill={col} />
          </g>
        );
      })}
    </svg>
  );
}

const FEATURES = [
  { icon: FlaskConical, title: "Backtest honestly", body: "Deflated Sharpe, walk-forward and purged cross-validation — so an edge has to survive luck, not just fit the past." },
  { icon: Brain, title: "Research-grade ML", body: "Triple-barrier labels, meta-labeling and hierarchical risk parity, run entirely in your browser. No server, no upload." },
  { icon: LineChart, title: "Live markets", body: "Fast charts, a screener, options with Greeks and Monte-Carlo cones — the daily tools, done properly." },
  { icon: Landmark, title: "Macro & regimes", body: "Yield curves, an HMM regime model and correlation structure — the context most retail tools skip." },
  { icon: Globe, title: "A live world map", body: "Ships, flights, quakes, cables and breaking news on one map — the alt-data layer, watchable in real time." },
  { icon: Lock, title: "Private by default", body: "It runs in your browser and your positions stay on your device. Nothing to sell, nothing leaked." },
];

const PILLARS = [
  { k: "Deflated Sharpe", v: "adjusts for luck" },
  { k: "Walk-forward", v: "tested out of sample" },
  { k: "In-browser ML", v: "nothing uploaded" },
  { k: "Real track records", v: "losers shown too" },
];

export default function Landing() {
  useEffect(() => {
    try { localStorage.setItem(WELCOMED_KEY, "1"); } catch { /* private mode */ }
  }, []);

  return (
    <div className="min-h-screen relative text-text">
      <div className="ambient-bg" aria-hidden="true" />

      {/* Top bar */}
      <header className="relative z-10 max-w-6xl mx-auto flex items-center justify-between px-5 sm:px-8 h-16">
        <Brandmark glyphClass="w-7 h-7" />
        <div className="flex items-center gap-2">
          <Link to="/login" className="btn-ghost text-sm hidden sm:inline-flex">Sign in</Link>
          <Link to="/" className="btn-primary text-sm inline-flex items-center gap-1.5">
            Enter the desk <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      </header>

      {/* Hero */}
      <main className="relative z-10">
        <section className="max-w-6xl mx-auto px-5 sm:px-8 pt-10 pb-16 grid lg:grid-cols-[1.1fr_1fr] gap-10 items-center">
          <div>
            <p className="text-[11px] tracking-[0.32em] text-dim uppercase mb-4">MMMXCIX Quant</p>
            <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight leading-[1.05] text-balance">
              The honest<br />quant desk.
            </h1>
            <p className="mt-5 text-lg text-dim max-w-xl leading-relaxed">
              Institutional-grade backtesting, in-browser ML and live markets —
              private, in your browser. No black boxes, no hype.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link to="/" className="btn-primary inline-flex items-center gap-2">
                Enter the desk <ArrowRight className="w-4 h-4" />
              </Link>
              <a href="#features" className="btn-ghost">See the tools</a>
            </div>
            <p className="mt-4 text-xs text-dim">Free while in beta · educational, not investment advice</p>
          </div>

          <div className="rounded-2xl border border-line lg-glass p-5 sm:p-6">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs text-dim font-mono">SPY · daily · walk-forward</span>
              <span className="text-[11px] rounded-full px-2 py-0.5 font-mono font-semibold bg-accent/12 text-accent">signal</span>
            </div>
            <HeroChart />
          </div>
        </section>

        {/* Pillars */}
        <section className="max-w-6xl mx-auto px-5 sm:px-8 pb-16">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-px rounded-xl overflow-hidden border border-line bg-line">
            {PILLARS.map((p) => (
              <div key={p.k} className="bg-bg px-5 py-5">
                <p className="text-sm font-semibold">{p.k}</p>
                <p className="text-xs text-dim mt-0.5">{p.v}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Features */}
        <section id="features" className="max-w-6xl mx-auto px-5 sm:px-8 pb-16 scroll-mt-8">
          <h2 className="text-2xl font-bold tracking-tight mb-1">The desk institutions have</h2>
          <p className="text-dim mb-8">The same rigour the pros rely on — the tools a quant actually uses, now in your browser.</p>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {FEATURES.map(({ icon: Icon, title, body }) => (
              <div key={title} className="rounded-xl border border-line lg-glass p-5 hover-lift">
                <div className="w-9 h-9 rounded-lg grid place-items-center bg-accent/10 text-accent mb-3">
                  <Icon className="w-5 h-5" strokeWidth={1.75} />
                </div>
                <h3 className="font-semibold mb-1">{title}</h3>
                <p className="text-sm text-dim leading-relaxed">{body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Honesty */}
        <section className="max-w-6xl mx-auto px-5 sm:px-8 pb-16">
          <div className="rounded-2xl border border-line lg-glass p-7 sm:p-10 relative overflow-hidden">
            <span className="text-accent mb-4 inline-flex"><BrandGlyph className="w-9 h-9" /></span>
            <h2 className="text-2xl sm:text-3xl font-bold tracking-tight max-w-2xl text-balance">
              Most trading tools flatter you. This one won't.
            </h2>
            <p className="mt-4 text-dim max-w-2xl leading-relaxed">
              Every backtest is deflated for how many strategies you tried, tested out of
              sample, and shown with its real track record — the losers included. If an
              edge isn't real, the numbers say so. That honesty is the whole point.
            </p>
            <div className="mt-6 flex flex-wrap gap-2">
              {[["Deflated Sharpe", ShieldCheck], ["Walk-forward", Waypoints], ["Purged CV", Radar]].map(([t, Ic]) => (
                <span key={t} className="inline-flex items-center gap-1.5 text-xs rounded-full border border-line px-3 py-1.5 text-dim">
                  <Ic className="w-3.5 h-3.5 text-accent" /> {t}
                </span>
              ))}
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="max-w-6xl mx-auto px-5 sm:px-8 pb-20">
          <div className="rounded-2xl border border-accent/25 bg-accent/[0.06] p-8 sm:p-10 text-center">
            <h2 className="text-2xl sm:text-3xl font-bold tracking-tight">A quant desk in your browser</h2>
            <p className="text-dim mt-2 mb-6">No sign-up needed to look around — your work stays on your device.</p>
            <Link to="/" className="btn-primary inline-flex items-center gap-2 mx-auto">
              Enter MMMXCIX Quant <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="relative z-10 border-t border-line">
        <div className="max-w-6xl mx-auto px-5 sm:px-8 py-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-dim">
          <Brandmark glyphClass="w-6 h-6" sub={false} />
          <div className="flex items-center gap-4">
            <Link to="/nutzung" className="hover:text-text">Terms</Link>
            <Link to="/datenschutz" className="hover:text-text">Privacy</Link>
            <Link to="/impressum" className="hover:text-text">Imprint</Link>
          </div>
          <p className="text-center sm:text-right max-w-xs">Educational tools. Not investment advice; hypothetical results guarantee nothing.</p>
        </div>
      </footer>
    </div>
  );
}
