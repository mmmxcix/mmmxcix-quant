// Pure geometry + persistence helpers for interactive chart drawings.
// No React, no lightweight-charts imports — this module only deals with the
// data model ({ id, type, points, color, label }) and localStorage.
//
// A drawing:
//   { id: string, type: DrawingType, points: [{time, price}], color: string, label?: string }
//
// Coordinate meaning per type:
//   trendline  → 2 points (time+price each)
//   horizontal → 1 point, only `price` is used (full-width SL/TP line)
//   ray        → 2 points (line that visually extends past the 2nd point)
//   vertical   → 1 point, only `time` is used (full-height marker)
//   rectangle  → 2 points (opposite corners of a zone)
//   fib        → 2 points, price span is split into Fibonacci retracement levels

/** @typedef {"trendline"|"horizontal"|"ray"|"vertical"|"rectangle"|"fib"} DrawingType */

// How many clicks each tool needs before it commits.
export const POINTS_REQUIRED = {
  trendline: 2,
  horizontal: 1,
  ray: 2,
  vertical: 1,
  rectangle: 2,
  fib: 2,
};

// The 7 classic Fibonacci retracement ratios.
export const FIB_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0];

const KEY_PREFIX = "quant_draw_";

/** Generate a reasonably-unique id without external deps. */
export function newId() {
  return "d_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

/**
 * Fibonacci retracement levels between two points.
 * ratio 0 sits at p1's price, ratio 1 at p2's price; the rest interpolate.
 * @param {{price:number}} p1
 * @param {{price:number}} p2
 * @returns {{ratio:number, price:number, label:string}[]}
 */
export function fibLevels(p1, p2) {
  if (!p1 || !p2 || !isFinite(p1.price) || !isFinite(p2.price)) return [];
  const a = p1.price;
  const b = p2.price;
  const span = b - a;
  return FIB_RATIOS.map((ratio) => ({
    ratio,
    // ratio 0 → a (start), ratio 1 → b (end)
    price: a + span * ratio,
    label: ratio.toFixed(3).replace(/0+$/, "").replace(/\.$/, ""),
  }));
}

function storageKey(chartKey) {
  return KEY_PREFIX + String(chartKey ?? "default");
}

/**
 * Load persisted drawings for a chart. Never throws (safe in private mode
 * where localStorage access can raise). Returns [] on any problem.
 * @param {string} chartKey e.g. "crypto:BTCUSDT"
 * @returns {Array}
 */
export function loadDrawings(chartKey) {
  try {
    const raw = window.localStorage.getItem(storageKey(chartKey));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Basic shape guard so a corrupt payload can't crash the renderer.
    return parsed.filter(
      (d) => d && typeof d.type === "string" && Array.isArray(d.points)
    );
  } catch {
    return [];
  }
}

/**
 * Persist drawings for a chart. Never throws.
 * @param {string} chartKey
 * @param {Array} list
 */
export function saveDrawings(chartKey, list) {
  try {
    const safe = Array.isArray(list) ? list : [];
    window.localStorage.setItem(storageKey(chartKey), JSON.stringify(safe));
  } catch {
    /* private mode / quota — silently ignore, drawings stay in-memory */
  }
}
