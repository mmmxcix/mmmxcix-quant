// og-png.mjs — rasterize public/og.svg to public/og.png at 1200×630 for maximum
// social-preview compatibility (some platforms don't render SVG OG images).
// Uses system Chrome via puppeteer-core. Run: npm run og
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import puppeteer from "puppeteer-core";

const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const svg = readFileSync(join(root, "public", "og.svg"), "utf8");

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new" });
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 2 });
await page.setContent(
  `<!doctype html><meta charset="utf-8"><style>*{margin:0}html,body{width:1200px;height:630px;overflow:hidden}svg{display:block;width:1200px;height:630px}</style>${svg}`,
  { waitUntil: "networkidle0" },
);
await page.screenshot({ path: join(root, "public", "og.png"), type: "png", clip: { x: 0, y: 0, width: 1200, height: 630 } });
await browser.close();
console.log("wrote public/og.png (1200×630 @2x)");
