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

// One-click chart palettes. up = bull, down = bear. A single hex each so it reads
// the same in light and dark; null in a slot means "keep the theme default".
export const CHART_PRESETS = [
  { id: "classic", label: "Classic", up: "#12a150", down: "#e5484d" },
  { id: "pink", label: "Signature", up: "#f472b6", down: "#64748b" },
  { id: "ocean", label: "Ocean", up: "#2dd4bf", down: "#fb7185" },
  { id: "sunset", label: "Sunset", up: "#f59e0b", down: "#8b5cf6" },
];

const DEFAULTS = { dither: "default", up: null, down: null, accent: null };

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
