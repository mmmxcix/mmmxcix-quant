// Brandmark — the MMMXCIX Quant logo. Two ascending candlesticks inside a corner
// "aperture" frame, all in the accent (Pewter Blue by default). Colour follows
// --c-accent (text-accent) so the mark stays in lockstep with the app's signal.
// The favicon is the frameless twin — there, the tile is the frame.

export function BrandGlyph({ className = "w-6 h-6" }) {
  return (
    <svg viewBox="0 0 64 64" fill="none" className={className} aria-hidden="true">
      <g stroke="currentColor" strokeWidth="3" strokeLinecap="round">
        <path d="M14 8H8V14" /><path d="M50 8H56V14" />
        <path d="M14 56H8V50" /><path d="M50 56H56V50" />
      </g>
      <line x1="26" y1="27" x2="26" y2="45" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
      <rect x="21.5" y="31" width="9" height="10" rx="2.2" fill="currentColor" />
      <line x1="39" y1="19" x2="39" y2="41" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
      <rect x="34.5" y="23" width="9" height="14" rx="2.2" fill="currentColor" />
    </svg>
  );
}

// Full lockup: glyph + stacked wordmark. `sub` renders the MMMXCIX kicker above
// "Quant"; drop it (sub={false}) for tight spots.
export default function Brandmark({ glyphClass = "w-8 h-8", sub = true, className = "" }) {
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <span className="text-accent shrink-0"><BrandGlyph className={glyphClass} /></span>
      <div className="leading-none">
        {sub && <p className="text-[10px] tracking-[0.3em] text-dim uppercase">MMMXCIX</p>}
        <p className="text-lg font-bold text-text tracking-tight -mt-0.5">Quant</p>
      </div>
    </div>
  );
}
