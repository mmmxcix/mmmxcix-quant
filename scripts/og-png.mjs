// og-png.mjs — render the 1200×630 social card to public/og.png. Painted on a
// canvas so the background can use the site's actual look: an 8×8 ordered-Bayer
// dither (same principle as the app's <Dither/> WebGL layer) over the near-white
// surface, graphite-ink text, and a green equity line (no area fill). Uses
// system Chrome via puppeteer-core. Run: npm run og
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import puppeteer from "puppeteer-core";

const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const html = `<!doctype html><meta charset="utf-8">
<style>*{margin:0}html,body{width:1200px;height:630px;overflow:hidden;background:#fafafb}</style>
<canvas id="c" width="2400" height="1260" style="width:1200px;height:630px"></canvas>
<script>
const cv = document.getElementById("c"), x = cv.getContext("2d");
x.scale(2, 2); // draw in 1200×630 logical space, 2× backing store for crispness
const W = 1200, H = 630;

// surface
x.fillStyle = "#fafafb"; x.fillRect(0, 0, W, H);

// 8×8 ordered-Bayer dither of a soft flowing field → graphite dots. Density
// follows the field; the field is faded out behind the headline so text stays
// crisp. This is the app's dither principle (ordered Bayer over smooth noise),
// not a uniform dot grid.
const B = [
  [0,32,8,40,2,34,10,42],[48,16,56,24,50,18,58,26],
  [12,44,4,36,14,46,6,38],[60,28,52,20,62,30,54,22],
  [3,35,11,43,1,33,9,41],[51,19,59,27,49,17,57,25],
  [15,47,7,39,13,45,5,37],[63,31,55,23,61,29,53,21],
];
x.fillStyle = "#0c0c0f";
for (let py = 0; py < H; py += 2) {
  for (let px = 0; px < W; px += 2) {
    const nx = px / W, ny = py / H;
    // soft flowing shapes, denser toward the corners, calm in the middle
    let f = 0.05
      + 0.06 * Math.sin(nx * 3.1 + ny * 2.2)
      + 0.05 * Math.cos(ny * 3.6 - nx * 1.7)
      + 0.09 * (Math.abs(nx - 0.5) + Math.abs(ny - 0.5)); // corners
    // fade the dither out where the text lives (top-left band)
    if (py < 360 && px < 1120) f *= 0.18 + 0.82 * Math.max(0, (py - 90) / 270) * 0.4;
    const t = (B[(py >> 1) & 7][(px >> 1) & 7] + 0.5) / 64;
    if (f > t) { x.globalAlpha = 0.55; x.fillRect(px, py, 1.4, 1.4); }
  }
}
x.globalAlpha = 1;

// hairline frame like the app's card borders
x.strokeStyle = "#e4e4e7"; x.lineWidth = 1; x.strokeRect(0.5, 0.5, W - 1, H - 1);

// green equity line (no fill), rising, sitting below the text
const pts = [[90,556],[200,536],[300,544],[400,500],[500,512],[600,470],[700,486],[800,430],[910,452],[1010,392],[1110,372]];
const grad = x.createLinearGradient(90, 556, 1110, 372);
grad.addColorStop(0, "#0b6e47"); grad.addColorStop(0.55, "#16a34a"); grad.addColorStop(1, "#4ade80");
x.strokeStyle = grad; x.lineWidth = 4; x.lineJoin = "round"; x.lineCap = "round";
x.beginPath(); pts.forEach(([px, py], i) => i ? x.lineTo(px, py) : x.moveTo(px, py)); x.stroke();
x.fillStyle = "#16a34a"; x.beginPath(); x.arc(1110, 372, 7, 0, Math.PI * 2); x.fill();

// text — high-contrast graphite ink
const SANS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
x.textBaseline = "alphabetic";
x.fillStyle = "#585860"; x.font = '600 24px ' + SANS;
x.save(); x.translate(90, 118); let lbl = "MMMXCIX QUANT"; let cx = 0;
for (const ch of lbl) { x.fillText(ch, cx, 0); cx += x.measureText(ch).width + 8; } x.restore();
x.fillStyle = "#0c0c0f"; x.font = '800 76px ' + SANS; x.fillText("Quant tools, honestly.", 88, 214);
x.fillStyle = "#3a3a44"; x.font = '500 31px ' + SANS; x.fillText("Backtesting · in-browser ML · pairs & HRP · live world map", 90, 286);
x.fillStyle = "#585860"; x.font = '400 24px ' + SANS; x.fillText("Free · private · every metric shown against its baseline", 90, 336);
x.fillStyle = "#585860"; x.font = '500 23px ' + SANS; x.fillText("quant.mmmxcix.com", 90, 600);
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
console.log("wrote public/og.png (2400×1260, dithered)");
