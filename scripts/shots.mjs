// shots.mjs — capture desktop + mobile screenshots of key routes against the
// local build, for visual QA. Writes PNGs to $SHOTS_DIR (or a temp dir) and
// prints their paths. Layout/chrome renders even though /api/* isn't served by
// `vite preview` (data layers show their empty/skeleton states).
//
//   npm run shots           # default temp dir
//   SHOTS_DIR=... npm run shots

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 4198;
const OUT = process.env.SHOTS_DIR || join(tmpdir(), "quant-shots");
mkdirSync(OUT, { recursive: true });

// [route, mobileToo]
const SHOTS = [
  ["/", true],
  ["/charts", false],
  ["/backtest/run", false],
  ["/backtest/ml", false],
  ["/screener/correlation", false],
  ["/portfolio/holdings", false],
  ["/map", true],
  ["/macro/yields", false],
  ["/learn/formulas", false],
];

const preview = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "preview", "--port", String(PORT)], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 2500));

const slug = (p) => p.replace(/\//g, "_").replace(/^_/, "") || "home";
try {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new" });
  for (const [route, mobileToo] of SHOTS) {
    const targets = [["desktop", 1440, 900], ...(mobileToo ? [["mobile", 390, 844]] : [])];
    for (const [kind, w, h] of targets) {
      const page = await browser.newPage();
      await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
      try {
        await page.goto(`http://localhost:${PORT}${route}`, { waitUntil: "networkidle2", timeout: 30000 });
        await new Promise((r) => setTimeout(r, 1200));
        const file = join(OUT, `${slug(route)}.${kind}.png`);
        await page.screenshot({ path: file, fullPage: false });
        console.log(file);
      } catch (e) {
        console.log(`FAIL ${route} ${kind}: ${e.message.slice(0, 80)}`);
      }
      await page.close();
    }
  }
  await browser.close();
} finally {
  preview.kill();
}
console.log(`\nshots written to: ${OUT}`);
