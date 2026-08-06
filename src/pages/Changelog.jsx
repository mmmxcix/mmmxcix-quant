import { Link } from "react-router-dom";

// Changelog — a plain, honest record of what shipped. Newest first. Theme-aware.

const RELEASES = [
  {
    date: "Aug 2026", tag: "Trust & onboarding",
    items: [
      "Honest pricing page — free while in beta, a fair Pro tier planned (no invented prices, no dark patterns).",
      "A dismissible “Start here” strip for new visitors, and this changelog + an About/Methodology page.",
    ],
  },
  {
    date: "Aug 2026", tag: "Installable & mobile",
    items: [
      "Add MMMXCIX Quant to your home screen (PWA) — it runs standalone with its own icon.",
      "A thumb-friendly mobile bottom bar and notch/safe-area handling.",
    ],
  },
  {
    date: "Aug 2026", tag: "Brand — Ink & Signal",
    items: [
      "New identity: a cool-ink palette with a single Pewter accent, a two-candle aperture logo, and the tagline “The honest quant desk.”",
      "A rebuilt landing page with a live market hero, real product screenshots and a monospace “instrument” look.",
    ],
  },
  {
    date: "Aug 2026", tag: "Argus day-trader",
    items: [
      "Readiness is gated on growing the paper book to $20k, not a trade count — Argus keeps learning until then.",
      "Learns faster from failure: setups it repeatedly enters and gets invalidated on are down-weighted and eventually skipped.",
      "A one-click reset that returns the paper book to $10k while keeping the learned skills.",
    ],
  },
  {
    date: "Aug 2026", tag: "Data fixes & polish",
    items: [
      "Fixed the macro yield curve (no more real/TIPS V-shape), news headline decoding, and the Cortex “today” figure.",
      "Watchlist sparklines now match their own trend; a shared glossary adds hover definitions to Argus/Cortex metrics.",
      "Contrast lifted toward WCAG, a calmer background-dither default, and a theme page for custom chart colours.",
    ],
  },
];

export default function Changelog() {
  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <p className="text-[11px] font-mono uppercase tracking-[0.28em] text-accent mb-3">Changelog</p>
      <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight">What's new</h1>
      <p className="mt-4 text-dim leading-relaxed">A running record of what's shipped. Built in the open — newest first.</p>

      <div className="mt-8 space-y-6">
        {RELEASES.map((r, i) => (
          <div key={i} className="relative pl-6">
            <span className="absolute left-0 top-1.5 w-2.5 h-2.5 rounded-full bg-accent" />
            {i < RELEASES.length - 1 && <span className="absolute left-[4.5px] top-4 bottom-[-24px] w-px bg-line" />}
            <div className="flex items-center gap-2.5 mb-2">
              <span className="text-sm font-mono text-dim">{r.date}</span>
              <span className="text-[10px] font-mono uppercase tracking-wider rounded-full border border-line px-2 py-0.5 text-accent">{r.tag}</span>
            </div>
            <ul className="space-y-1.5">
              {r.items.map((it, j) => (
                <li key={j} className="text-sm text-dim leading-relaxed flex gap-2">
                  <span className="text-accent mt-0.5 shrink-0">·</span><span>{it}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="mt-10 flex flex-wrap gap-3">
        <Link to="/" className="btn-primary">Open the desk →</Link>
        <Link to="/about" className="btn-ghost">About &amp; methodology</Link>
      </div>
    </div>
  );
}
