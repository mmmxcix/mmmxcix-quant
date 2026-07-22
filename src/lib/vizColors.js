// vizColors.js — theme-aware data-viz series colors for canvas chart libs.
// CSS can read var(--viz-*) directly; canvas libraries (lightweight-charts,
// hand-rolled SVG) need the resolved string, so read it at build time here.
// Values live in src/index.css (deeper on the light theme, bright pastels on
// dark). Series built before a theme flip keep their color until the next
// rebuild — chart data polls frequently, so that corrects within seconds.

const FALLBACK = {
  blue: "#38bdf8",
  amber: "#f59e0b",
  purple: "#a78bfa",
  pink: "#f472b6",
  teal: "#2dd4bf",
};

/** Resolved color string for a viz series (e.g. vizColor("purple")). */
export function vizColor(name) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(`--viz-${name}`).trim();
    return v || FALLBACK[name] || "#888888";
  } catch {
    return FALLBACK[name] || "#888888";
  }
}
