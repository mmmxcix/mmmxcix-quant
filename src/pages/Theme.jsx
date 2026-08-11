import { useEffect, useState } from "react";
import { Palette, Waves, RotateCcw, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  getThemePrefs, setThemePrefs, resetThemePrefs, subscribe as subThemePrefs,
  DITHER_LEVELS, CHART_PRESETS,
} from "@/lib/themeSettings";

// A mini candlestick + sparkline that reads the live --c-up / --c-down / --c-accent
// tokens, so it recolours the instant a picker moves. Fixed data — it's a swatch,
// not real prices.
const CANDLES = [
  { o: 30, c: 46, h: 50, l: 26 }, { o: 46, c: 40, h: 52, l: 36 },
  { o: 40, c: 58, h: 62, l: 38 }, { o: 58, c: 52, h: 64, l: 48 },
  { o: 52, c: 70, h: 74, l: 50 }, { o: 70, c: 62, h: 76, l: 58 },
  { o: 62, c: 80, h: 86, l: 60 },
];
function Preview() {
  const W = 260, H = 120, n = CANDLES.length, cw = W / n, bw = cw * 0.5;
  const y = (v) => H - 8 - (v / 100) * (H - 20);
  return (
    <div className="rounded-lg border border-line bg-bg/50 p-3">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 120 }} aria-label="Colour preview">
        {CANDLES.map((k, i) => {
          const up = k.c >= k.o;
          // Same fallback chain the real chart uses: candle override → semantic
          // token. The outline falls back to the body colour, so it is invisible
          // for palettes without an ink and a true outline for those with one.
          const body = up ? "var(--c-candle-up, var(--c-up))" : "var(--c-candle-down, var(--c-down))";
          const col = `rgb(${body})`;
          const line = `rgb(var(--c-candle-ink-active, ${body}))`;
          const cx = i * cw + cw / 2;
          return (
            <g key={i}>
              <line x1={cx} x2={cx} y1={y(k.h)} y2={y(k.l)} style={{ stroke: line }} strokeWidth="1.5" />
              <rect x={cx - bw / 2} y={y(Math.max(k.o, k.c))} width={bw}
                height={Math.max(2, Math.abs(y(k.o) - y(k.c)))}
                style={{ fill: col, stroke: line }} strokeWidth="1" rx="1" />
            </g>
          );
        })}
      </svg>
      <div className="flex items-center gap-2 mt-2">
        <span className="text-[11px] rounded-full px-2 py-0.5 font-mono font-semibold bg-up/15 text-up">▲ +2.4%</span>
        <span className="text-[11px] rounded-full px-2 py-0.5 font-mono font-semibold bg-down/15 text-down">▼ −1.1%</span>
        <button className="ml-auto text-[11px] rounded-md px-2.5 py-1 font-medium bg-accent/15 text-accent">Accent</button>
      </div>
    </div>
  );
}

// One colour slot: swatch + native picker + hex, plus a clear-to-default control.
function ColorControl({ label, value, fallback, onChange, onClear }) {
  const hex = value || fallback;
  return (
    <div className="flex items-center gap-3">
      <label className="relative w-9 h-9 rounded-lg border border-line overflow-hidden shrink-0 cursor-pointer" title={`Pick ${label}`}>
        <span className="absolute inset-0" style={{ background: hex }} />
        <input type="color" value={hex} onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 opacity-0 cursor-pointer" aria-label={label} />
      </label>
      <div className="min-w-0">
        <p className="text-sm font-medium leading-tight">{label}</p>
        <p className="text-[11px] font-mono text-dim">{value ? value.toUpperCase() : `default · ${fallback.toUpperCase()}`}</p>
      </div>
      {value && (
        <button onClick={onClear} className="ml-auto text-[11px] text-dim hover:text-fg hover:underline shrink-0">reset</button>
      )}
    </div>
  );
}

export default function Theme() {
  const [prefs, setPrefs] = useState(getThemePrefs);
  useEffect(() => subThemePrefs((p) => setPrefs(p)), []);

  // Theme-default fallbacks shown when a slot has no override. These mirror the
  // light-mode tokens in index.css (the picker needs a concrete hex to seed).
  const FALLBACK = { up: "#0b6e47", down: "#be2830", accent: "#4a648c" };

  const activePreset = CHART_PRESETS.find((p) => p.up === prefs.up && p.down === prefs.down);
  const dirty = prefs.up || prefs.down || prefs.accent || prefs.dither !== "default";

  // A preset may carry candle-only body colours (see CHART_PRESETS). Picking one
  // must also CLEAR those slots when the new preset has none, or Signature's
  // white bodies would survive a switch to Classic. Choosing a colour by hand
  // clears the matching override for the same reason — otherwise the picked
  // colour would show everywhere except in the candles it was picked for.
  const applyPreset = (p) => setThemePrefs({
    up: p.up, down: p.down,
    candleUp: p.candleUp ?? null, candleDown: p.candleDown ?? null,
    ink: p.ink ?? null, inkDark: p.inkDark ?? null,
  });

  return (
    <div className="max-w-2xl mx-auto px-4 py-6">
      <div className="flex items-center gap-2 mb-1">
        <Palette className="w-5 h-5 text-accent" />
        <h1 className="text-xl font-bold">Theme</h1>
      </div>
      <p className="text-sm text-dim mb-6">
        Make it yours — chart colours and the background texture. Saved on this device and
        applied in both light and dark. For the light/dark switch itself, see{" "}
        <span className="text-fg">Account → Appearance</span>.
      </p>

      {/* Chart colours */}
      <div className="rounded-xl border border-line lg-glass p-5 mb-4">
        <h2 className="font-semibold mb-1">Chart colours</h2>
        <p className="text-sm text-dim mb-4">
          Bull and bear drive candles, sparklines and every up/down figure. Pick your own
          signature, or start from a preset.
        </p>

        <div className="grid sm:grid-cols-2 gap-4 items-start">
          <div className="flex flex-col gap-4">
            <ColorControl label="Bull / up" value={prefs.candleUp || prefs.up} fallback={FALLBACK.up}
              onChange={(v) => setThemePrefs({ up: v, candleUp: null, ink: null, inkDark: null })}
              onClear={() => setThemePrefs({ up: null, candleUp: null, ink: null, inkDark: null })} />
            <ColorControl label="Bear / down" value={prefs.candleDown || prefs.down} fallback={FALLBACK.down}
              onChange={(v) => setThemePrefs({ down: v, candleDown: null, ink: null, inkDark: null })}
              onClear={() => setThemePrefs({ down: null, candleDown: null, ink: null, inkDark: null })} />
            <ColorControl label="Accent" value={prefs.accent} fallback={FALLBACK.accent}
              onChange={(v) => setThemePrefs({ accent: v })} onClear={() => setThemePrefs({ accent: null })} />
          </div>
          <Preview />
        </div>

        <div className="mt-4 pt-4 border-t border-line">
          <p className="text-[11px] uppercase tracking-wide text-dim mb-2">Presets</p>
          <div className="flex flex-wrap gap-2">
            {CHART_PRESETS.map((p) => (
              <button key={p.id} onClick={() => applyPreset(p)}
                className={cn("chip flex items-center gap-1.5", activePreset?.id === p.id ? "chip-active" : "chip-idle")}>
                {/* Swatches show the CANDLE colours where a preset defines them, with
                    the ink outline — otherwise Signature's dot would read as plain white. */}
                <span className="w-2.5 h-2.5 rounded-full"
                  style={{ background: p.candleUp || p.up, border: p.ink ? `1px solid ${p.ink}` : undefined }} />
                <span className="w-2.5 h-2.5 rounded-full -ml-1"
                  style={{ background: p.candleDown || p.down, border: p.ink ? `1px solid ${p.ink}` : undefined }} />
                {p.label}
                {activePreset?.id === p.id && <Check className="w-3 h-3" />}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Background dither */}
      <div className="rounded-xl border border-line lg-glass p-5 mb-4">
        <div className="flex items-center gap-2 mb-1">
          <Waves className="w-4 h-4 text-accent" />
          <h2 className="font-semibold">Background texture</h2>
        </div>
        <p className="text-sm text-dim mb-4">
          The animated dither behind the app. Turn it down if it distracts on your screen,
          or off entirely — the ambient wash still carries the background.
        </p>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Dither level">
          {DITHER_LEVELS.map((d) => (
            <button key={d.id} role="radio" aria-checked={prefs.dither === d.id}
              onClick={() => setThemePrefs({ dither: d.id })}
              className={cn("chip", prefs.dither === d.id ? "chip-active" : "chip-idle")}>
              {d.label}
            </button>
          ))}
        </div>
      </div>

      {dirty && (
        <button onClick={resetThemePrefs}
          className="btn-ghost text-sm flex items-center gap-1.5">
          <RotateCcw className="w-3.5 h-3.5" /> Reset everything to defaults
        </button>
      )}
    </div>
  );
}
