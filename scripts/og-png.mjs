// og-png.mjs — render the 1200×630 social card to public/og.png. Painted on a
// canvas so the background matches the app: the Ink & Signal look — a cool ink
// ground, a faint ordered-Bayer dither, the two-candle brand mark + wordmark,
// the "The honest quant desk." headline, and a Pewter candlestick figure.
// Uses system Chrome via puppeteer-core. Run: npm run og
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import puppeteer from "puppeteer-core";

const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const html = `<!doctype html><meta charset="utf-8">
<style>*{margin:0}html,body{width:1200px;height:630px;overflow:hidden;background:#0b0d12}</style>
<canvas id="c" width="2400" height="1260" style="width:1200px;height:630px"></canvas>
<script>
const cv = document.getElementById("c"), x = cv.getContext("2d");
x.scale(2, 2);
const W = 1200, H = 630;
const INK = "#0b0d12", TEXT = "#f0f3f8", DIM = "#949ba8", LINE = "#262b34";
const PEWTER = "#5f7fa8", PEWTER_HI = "#7f9cc4";
const SANS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

// ground
x.fillStyle = INK; x.fillRect(0, 0, W, H);

// 8×8 ordered-Bayer dither — faint near-white dots, denser toward the corners,
// faded out where the headline sits (left band).
const B = [
  [0,32,8,40,2,34,10,42],[48,16,56,24,50,18,58,26],
  [12,44,4,36,14,46,6,38],[60,28,52,20,62,30,54,22],
  [3,35,11,43,1,33,9,41],[51,19,59,27,49,17,57,25],
  [15,47,7,39,13,45,5,37],[63,31,55,23,61,29,53,21],
];
x.fillStyle = "#e8ecf4";
for (let py = 0; py < H; py += 2) {
  for (let px = 0; px < W; px += 2) {
    const nx = px / W, ny = py / H;
    let f = 0.05 + 0.05 * Math.sin(nx * 3.1 + ny * 2.2) + 0.04 * Math.cos(ny * 3.6 - nx * 1.7)
      + 0.08 * (Math.abs(nx - 0.5) + Math.abs(ny - 0.5));
    if (px < 700 && py < 470) f *= 0.16; // keep the text band clean
    const t = (B[(py >> 1) & 7][(px >> 1) & 7] + 0.5) / 64;
    if (f > t) { x.globalAlpha = 0.06; x.fillRect(px, py, 1.4, 1.4); }
  }
}
x.globalAlpha = 1;

// hairline frame like the app's cards
x.strokeStyle = LINE; x.lineWidth = 1; x.strokeRect(0.5, 0.5, W - 1, H - 1);

// ── right-side candlestick figure ───────────────────────────────────────────
(function chart() {
  const px0 = 712, py0 = 150, pw = 400, ph = 300, n = 9;
  const bars = [[30,46,50,26,0],[46,40,52,36,0],[40,58,62,38,0],[58,52,64,48,0],
    [52,70,74,50,0],[70,62,78,58,0],[62,82,86,60,1],[82,74,90,70,1],[74,94,100,72,1]];
  const cw = pw / n, bw = cw * 0.42;
  const Y = (v) => py0 + ph - 14 - (v / 108) * (ph - 28);
  x.strokeStyle = LINE; x.lineWidth = 1;
  for (const gy of [0.25, 0.5, 0.75]) { x.beginPath(); x.moveTo(px0, py0 + ph * gy); x.lineTo(px0 + pw, py0 + ph * gy); x.stroke(); }
  // area under the closes
  const grad = x.createLinearGradient(0, py0, 0, py0 + ph);
  grad.addColorStop(0, "rgba(95,127,168,0.20)"); grad.addColorStop(1, "rgba(95,127,168,0)");
  x.fillStyle = grad; x.beginPath(); x.moveTo(px0, py0 + ph);
  bars.forEach((b, i) => x.lineTo(px0 + i * cw + cw / 2, Y(b[1])));
  x.lineTo(px0 + pw, py0 + ph); x.closePath(); x.fill();
  // candles
  x.lineCap = "round";
  bars.forEach(([o, c, h, l, accent], i) => {
    const cx = px0 + i * cw + cw / 2;
    x.strokeStyle = x.fillStyle = accent ? PEWTER : "#5b6675";
    x.lineWidth = 2;
    x.beginPath(); x.moveTo(cx, Y(h)); x.lineTo(cx, Y(l)); x.stroke();
    const top = Y(Math.max(o, c)), hgt = Math.max(3, Math.abs(Y(o) - Y(c)));
    x.beginPath(); x.roundRect(cx - bw / 2, top, bw, hgt, 3); x.fill();
  });
})();

// ── brand mark (frame + two candles, Pewter) ────────────────────────────────
(function mark(ox, oy, s) {
  const u = s / 64, X = (v) => ox + v * u, YY = (v) => oy + v * u;
  x.strokeStyle = PEWTER; x.fillStyle = PEWTER; x.lineCap = "round"; x.lineJoin = "round";
  x.lineWidth = 3 * u;
  x.beginPath();
  x.moveTo(X(14), YY(8)); x.lineTo(X(8), YY(8)); x.lineTo(X(8), YY(14));
  x.moveTo(X(50), YY(8)); x.lineTo(X(56), YY(8)); x.lineTo(X(56), YY(14));
  x.moveTo(X(14), YY(56)); x.lineTo(X(8), YY(56)); x.lineTo(X(8), YY(50));
  x.moveTo(X(50), YY(56)); x.lineTo(X(56), YY(56)); x.lineTo(X(56), YY(50));
  x.stroke();
  x.lineWidth = 2.8 * u;
  x.beginPath(); x.moveTo(X(26), YY(27)); x.lineTo(X(26), YY(45)); x.stroke();
  x.beginPath(); x.roundRect(X(21.5), YY(31), 9 * u, 10 * u, 2.2 * u); x.fill();
  x.beginPath(); x.moveTo(X(39), YY(19)); x.lineTo(X(39), YY(41)); x.stroke();
  x.beginPath(); x.roundRect(X(34.5), YY(23), 9 * u, 14 * u, 2.2 * u); x.fill();
})(90, 66, 50);

// ── text ────────────────────────────────────────────────────────────────────
x.textBaseline = "alphabetic";
// eyebrow next to the mark
x.fillStyle = DIM; x.font = '600 22px ' + SANS;
x.save(); x.translate(156, 99); let cx = 0;
for (const ch of "MMMXCIX QUANT") { x.fillText(ch, cx, 0); cx += x.measureText(ch).width + 7; } x.restore();

// headline
x.fillStyle = TEXT; x.font = '800 86px ' + SANS;
x.fillText("The honest", 88, 268);
x.fillText("quant desk.", 88, 356);

// support lines
x.fillStyle = "#c2c8d2"; x.font = '500 30px ' + SANS;
x.fillText("Institutional-grade backtesting · in-browser ML · live markets", 90, 424);
x.fillStyle = DIM; x.font = '400 26px ' + SANS;
x.fillText("Private, in your browser — no black boxes, no hype.", 90, 462);

// footer
x.fillStyle = PEWTER; x.font = '600 23px ' + SANS;
x.fillText("quant.mmmxcix.com", 90, 574);

window.__done = true;
</script>`;

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new" });
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: "networkidle0" });
await page.waitForFunction("window.__done === true", { timeout: 10000 });
const canvas = await page.$("#c");
await canvas.screenshot({ path: join(root, "public", "og.png"), type: "png" });
await browser.close();
console.log("wrote public/og.png (2400×1260, Ink & Signal)");
