// Runs before paint (loaded synchronously in <head>). Kept as an external file
// rather than an inline <script> because our CSP has no 'unsafe-inline' — an
// inline block would be blocked, bringing back the flash-of-wrong-theme.
(function () {
  // Theme MODE ("light" | "dark" | "system"). Signed-in accounts mirror their
  // choice into localStorage, so it survives reloads on every device.
  try {
    var m = localStorage.getItem("theme") || "light";
    if (m === "system") m = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    var dark = m === "dark";
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    // Match the browser status-bar / chrome to the theme (no white bar on dark).
    var mc = document.querySelector('meta[name="theme-color"]');
    if (mc) mc.setAttribute("content", dark ? "#0b0d12" : "#f8fafc");
  } catch (e) { document.documentElement.dataset.theme = "light"; }

  // Custom look (chart colours + dither level, see lib/themeSettings.js) so a
  // saved palette doesn't flash the defaults first.
  try {
    var p = JSON.parse(localStorage.getItem("quant_theme_prefs") || "{}");
    var root = document.documentElement;
    var toTrip = function (h) { var mm = /^#?([0-9a-f]{6})$/i.exec((h || "").trim()); if (!mm) return null; var n = parseInt(mm[1], 16); return ((n >> 16) & 255) + " " + ((n >> 8) & 255) + " " + (n & 255); };
    [["--c-up", p.up], ["--c-down", p.down], ["--c-accent", p.accent],
     ["--c-candle-up", p.candleUp], ["--c-candle-down", p.candleDown],
     ["--c-candle-ink", p.ink], ["--c-candle-ink-dark", p.inkDark],
    ].forEach(function (kv) { var t = kv[1] && toTrip(kv[1]); if (t) root.style.setProperty(kv[0], t); });
    var dop = { off: "0", subtle: "0.22", full: "0.85" }[p.dither];
    if (dop != null) root.style.setProperty("--dither-opacity", dop);
    root.dataset.dither = p.dither || "default";
  } catch (e) { /* defaults stand */ }
})();
