// themeSettings.js — the user's CUSTOM look: chart colours + background dither
// intensity. This is separate from the theme MODE (light/dark/system, see
// theme.js); it layers on top, overriding specific CSS tokens inline on <html>
// so it applies in whichever mode is active.
//
// Persisted device-locally under one JSON key. Applied before paint by a snippet
// in index.html (no flash) and re-applied live on change via subscribe().

const KEY = "quant_theme_prefs";

export const DITHER_LEVELS = [
  { id: "off", label: "Off" },
  { id: "subtle", label: "Subtle" },
  { id: "default", label: "Default" },
  { id: "full", label: "Full" },
];

// Explicit --dither-opacity per level. "default" is intentionally absent → we
// remove the override and let the responsive CSS default stand.
export const DITHER_OPACITY = { off: "0", subtle: "0.22", full: "0.85" };

// One-click chart palettes. `up`/`down` are the SEMANTIC tokens — they colour
// bullish/bearish text, map markers and sparklines app-wide, so both have to
// stay legible on the light AND the dark background.
//
// `candleUp`/`candleDown`/`ink`/`inkDark` are OPTIONAL and apply to candle
// bodies only. They exist because a palette can be right for candles and
// unusable as text: a white candle body is perfectly readable when it is drawn
// with a dark outline, but white *text* on a white card is simply gone. When an
// ink is set the candle series draws outlines and wicks in it, which is what
// lets the body colours be arbitrarily light or dark.
//
// The ink comes in a pair because it also draws the WICKS. A single near-black
// value looks right on the light theme and then erases every high and low on the
// dark one — the bodies survive on their own contrast, the thin wicks do not.
export const CHART_PRESETS = [
  { id: "classic", label: "Classic", up: "#12a150", down: "#e5484d" },
  // "Signature" = the candle chart from the reference clip. It is not a
  // green/red palette at all: bullish bodies are a dusty rose, bearish bodies
  // are HOLLOW WHITE, and every body and wick carries a near-black outline —
  // the outline is what makes the white ones readable, so it is not optional
  // here. Taken from the user's close-up of the chart; the downloadable video
  // is only 360×640 and its pastel filter washes the rose out by ~13% lightness,
  // which is why sampling the frames gave a paler pink than the source.
  {
    id: "pink", label: "Signature",
    up: "#b3607e", down: "#6b6165",           // legible text/marker tokens
    candleUp: "#dda3b2", candleDown: "#ffffff", ink: "#141013", inkDark: "#e6dee1",
  },
  // Ocean and Sunset were darkened just far enough to clear 3:1 against BOTH
  // backgrounds — #2dd4bf read at 1.78:1 on the light theme and #f59e0b at
  // 2.05:1, i.e. these palettes made every up/down figure on the page hard to
  // read for anyone who picked them. Hue and saturation are untouched; only
  // lightness moved, by the smallest step that reaches the bar.
  { id: "ocean", label: "Ocean", up: "#1f9c8c", down: "#f84663" },
  { id: "sunset", label: "Sunset", up: "#c07b07", down: "#8b5cf6" },
];

const DEFAULTS = {
  dither: "default", up: null, down: null, accent: null,
  candleUp: null, candleDown: null, ink: null, inkDark: null,
};

export function getThemePrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "{}");
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

// "#4c51b5" → "76 81 181" (the RGB-triplet form Tailwind's rgb(var(--c) / a)
// tokens need). Returns null for anything that isn't a 6-digit hex.
export function hexToTriplet(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? "").trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

// Push the prefs onto <html> as inline CSS-var overrides. Empty slots are
// REMOVED (not zeroed) so the stylesheet's own value takes back over.
export function applyThemePrefs(prefs = getThemePrefs()) {
  const root = document.documentElement;
  const setVar = (name, hex) => {
    const t = hexToTriplet(hex);
    if (t) root.style.setProperty(name, t);
    else root.style.removeProperty(name);
  };
  setVar("--c-up", prefs.up);
  setVar("--c-down", prefs.down);
  setVar("--c-accent", prefs.accent);
  // Candle-only overrides. Unset (the common case) means the chart falls back to
  // --c-up/--c-down, so nothing changes for palettes that don't need them.
  setVar("--c-candle-up", prefs.candleUp);
  setVar("--c-candle-down", prefs.candleDown);
  setVar("--c-candle-ink", prefs.ink);
  setVar("--c-candle-ink-dark", prefs.inkDark);

  const dop = DITHER_OPACITY[prefs.dither];
  if (dop != null) root.style.setProperty("--dither-opacity", dop);
  else root.style.removeProperty("--dither-opacity");
  root.dataset.dither = prefs.dither || "default"; // lets the canvas skip when off
}

const subs = new Set();
export function subscribe(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}
function persist(prefs) {
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* private mode */ }
  applyThemePrefs(prefs);
  for (const fn of subs) fn(prefs);
}

// Set one or several prefs at once (a preset sets up+down together).
export function setThemePrefs(patch) {
  persist({ ...getThemePrefs(), ...patch });
}

export function resetThemePrefs() {
  try { localStorage.removeItem(KEY); } catch { /* private mode */ }
  applyThemePrefs(DEFAULTS);
  for (const fn of subs) fn({ ...DEFAULTS });
}
