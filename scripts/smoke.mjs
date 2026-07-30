// smoke.mjs — headless render test of every route against the local build.
// Catches the bug class the bundler can't: runtime ReferenceErrors from
// missing imports (rollup treats bare identifiers as globals), unguarded
// reads in the always-mounted shell, etc. Run after `vite build`:
//
//   node scripts/vite-preview & node scripts/smoke.mjs
//
// or simply: npm run smoke (starts its own preview server).

import { spawn } from "node:child_process";
import puppeteer from "puppeteer-core";

const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 4199;
const ROUTES = [
  "/", "/charts", "/news", "/tools", "/regimes", "/argus", "/map",
  "/backtest/run", "/backtest/compare", "/backtest/ml", "/backtest/events", "/backtest/mm",
  "/screener/scan", "/screener/anomalies", "/screener/correlation",
  "/portfolio/holdings", "/portfolio/options",
  "/macro/yields", "/macro/calendar", "/macro/l3",
  "/learn/academy", "/learn/guide", "/learn/resources", "/learn/formulas",
  "/login", "/register",
  // Admin-gated pages render a lock screen when signed out, but their MODULES still
  // load — which is exactly where a runtime ReferenceError would hide.
  "/coach", "/cortex/registry", "/cortex/paper", "/cortex/riskgate", "/cortex/brain",
];

const preview = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "preview", "--port", String(PORT)], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 2500));

let fails = 0;
try {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new" });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message.slice(0, 140)));
  for (const path of ROUTES) {
    errors.length = 0;
    try {
      await page.goto(`http://localhost:${PORT}${path}`, { waitUntil: "networkidle2", timeout: 30000 });
      await new Promise((r) => setTimeout(r, 800));
      // React's ErrorBoundary CATCHES a render error, so it never surfaces as a
      // `pageerror` and the fallback text is >50 chars — a TDZ/ReferenceError
      // would sail through. Detect the fallback in the DOM and treat it as broken.
      const state = await page.evaluate(() => ({
        len: document.body.innerText.length,
        boundary: /went wrong on this page/i.test(document.body.innerText),
      }));
      const ok = state.len > 50 && !state.boundary;
      if (!ok || errors.length) {
        fails++;
        const why = state.boundary ? "ERROR BOUNDARY (render crashed)" : state.len > 50 ? "renders but throws" : "WHITE";
        console.log(`✗ ${path} → ${why} ${errors.length ? "| " + errors.join(" | ") : ""}`);
      } else {
        console.log(`✓ ${path}`);
      }
    } catch (e) {
      fails++;
      console.log(`✗ ${path} → nav failed: ${e.message.slice(0, 90)}`);
    }
  }
  await browser.close();
} finally {
  preview.kill();
}
console.log(fails === 0 ? `\nSMOKE PASS — ${ROUTES.length} routes clean` : `\nSMOKE FAIL — ${fails}/${ROUTES.length} routes broken`);
process.exit(fails === 0 ? 0 : 1);
