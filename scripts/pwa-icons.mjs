// pwa-icons.mjs — render the PWA/home-screen icons from the brand mark (two
// candles on a Pewter tile) at the sizes a manifest + iOS need. Full-bleed so
// the OS can round/mask it; candles sit in the maskable safe zone.
// Uses system Chrome via puppeteer-core. Run: node scripts/pwa-icons.mjs
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";

const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "public", "icons");
mkdirSync(outDir, { recursive: true });

// Full-bleed Pewter tile + two ascending near-ink candles, centred (within the
// maskable safe zone). `bleed` controls corner rounding for standalone use.
const svg = (round) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="${round}" fill="#5f7fa8"/>
  <line x1="26" y1="24" x2="26" y2="45" stroke="#0b0d12" stroke-width="2.8" stroke-linecap="round"/>
  <rect x="21.5" y="29" width="9" height="12" rx="2.4" fill="#0b0d12"/>
  <line x1="39" y1="17" x2="39" y2="41" stroke="#0b0d12" stroke-width="2.8" stroke-linecap="round"/>
  <rect x="34.5" y="21" width="9" height="16" rx="2.4" fill="#0b0d12"/>
</svg>`;

// Full-bleed (rx 0) for every icon — the OS/browser rounds them. A rounded rect
// baked in would leave dead corners on the home screen.
const TARGETS = [
  { name: "icon-192.png", size: 192, round: 0 },
  { name: "icon-512.png", size: 512, round: 0 },
  { name: "maskable-512.png", size: 512, round: 0 },
  { name: "apple-touch-icon.png", size: 180, round: 0 },
];

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new" });
const page = await browser.newPage();
for (const t of TARGETS) {
  await page.setViewport({ width: t.size, height: t.size, deviceScaleFactor: 1 });
  await page.setContent(`<style>*{margin:0}html,body{width:${t.size}px;height:${t.size}px}svg{width:${t.size}px;height:${t.size}px;display:block}</style>${svg(t.round)}`, { waitUntil: "load" });
  await new Promise((r) => setTimeout(r, 150));
  await page.screenshot({ path: join(outDir, t.name), type: "png", omitBackground: false, clip: { x: 0, y: 0, width: t.size, height: t.size } });
  console.log("icon:", t.name);
}
await browser.close();
console.log("done -> public/icons/");
