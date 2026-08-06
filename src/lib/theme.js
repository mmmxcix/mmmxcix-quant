// theme.js — the theme MODE ("light" | "dark" | "system") shared by the shell
// toggle (Layout) and the Account appearance picker.
//
// Persistence model: the mode is a per-ACCOUNT preference (Better Auth
// updateUser → user.theme) mirrored into localStorage, which the before-paint
// script in index.html reads — so a signed-in account keeps its theme on every
// device and across reloads. Signed-out visitors keep a device-local mode.
// "system" resolves live via prefers-color-scheme.

export const THEME_MODES = ["light", "dark", "system"];

/** Resolve a mode to the concrete theme to render. */
export function resolveTheme(mode) {
  if (mode === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return mode === "dark" ? "dark" : "light";
}

/** Apply a mode to the document (what the CSS tokens key off). */
export function applyThemeMode(mode) {
  const theme = resolveTheme(mode);
  document.documentElement.dataset.theme = theme;
  // Keep the browser status-bar / chrome colour in step with the theme so a dark
  // app never shows a white bar at the top (and vice-versa).
  const mc = document.querySelector('meta[name="theme-color"]');
  if (mc) mc.setAttribute("content", theme === "dark" ? "#0b0d12" : "#f8fafc");
}

export function getThemeMode() {
  try {
    const m = localStorage.getItem("theme");
    return THEME_MODES.includes(m) ? m : "light";
  } catch {
    return "light";
  }
}

export function storeThemeMode(mode) {
  try { localStorage.setItem("theme", mode); } catch { /* private mode */ }
}
