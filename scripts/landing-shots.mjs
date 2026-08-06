// landing-shots.mjs — capture real, polished screenshots of the LIVE app in
// dark theme (real data, real accent) for the landing's product proof.
// Uses system Chrome via puppeteer-core. Run: node scripts/landing-shots.mjs
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";

const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const ORIGIN = process.env.SHOTS_ORIGIN || "https://quant.mmmxcix.com";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "public", "shots");
mkdirSync(outDir, { recursive: true });

const TARGETS = [
  { name: "dashboard", path: "/", wait: 5000 },
  { name: "regimes", path: "/regimes", wait: 7000 },
  { name: "charts", path: "/charts?market=crypto&symbol=BTCUSDT&interval=1d", wait: 6000 },
  { name: "map", path: "/map", wait: 8000 },
];

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--force-color-profile=srgb"] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1.5 });

await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
await page.evaluate(() => {
  localStorage.setItem("theme", "dark");
  localStorage.setItem("quant_welcomed", "1");
});

for (const t of TARGETS) {
  try {
    await page.goto(ORIGIN + t.path, { waitUntil: "domcontentloaded", timeout: 45000 });
    await new Promise((r) => setTimeout(r, t.wait));
    await page.screenshot({ path: join(outDir, `${t.name}.jpg`), type: "jpeg", quality: 86, clip: { x: 0, y: 0, width: 1440, height: 900 } });
    console.log("shot:", t.name);
  } catch (e) {
    console.log("FAILED", t.name, e.message);
  }
}
await browser.close();
console.log("done -> public/shots/");
