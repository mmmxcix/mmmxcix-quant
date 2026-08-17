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
  "/", "/charts", "/news", "/tools", "/regimes", "/argus", "/map", "/board",
  "/backtest/run", "/backtest/compare", "/backtest/ml", "/backtest/events", "/backtest/mm",
  "/screener/scan", "/screener/anomalies", "/screener/correlation",
  "/portfolio/holdings", "/portfolio/options",
  "/macro/yields", "/macro/calendar", "/macro/l3",
  "/learn/academy", "/learn/guide", "/learn/resources", "/learn/formulas",
  "/login", "/register", "/accessibility",
  // Admin-gated pages render a lock screen when signed out, but their MODULES still
  // load — which is exactly where a runtime ReferenceError would hide.
  "/coach", "/cortex/lab", "/cortex/registry", "/cortex/paper", "/cortex/riskgate", "/cortex/brain",
  // This list had drifted from App.jsx: /arena, /theme, /account, /pricing,
  // /about, /changelog and the Cortex "lab" tab (the one showing the live paper
  // book) were all outside the harness.
  "/arena", "/theme", "/account", "/pricing", "/about", "/changelog",
  "/nope-this-route-does-not-exist", // the not-found view must render, not white-screen
];

const preview = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "preview", "--port", String(PORT)], { stdio: "ignore", windowsHide: true });
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

  // ── First-visit flow ──────────────────────────────────────────────────────
  // Route rendering alone cannot catch this, and it has already broken once:
  // the root gate additionally required a SESSION, so a signed-out visitor
  // clicking "Enter the desk" (which links to "/") was bounced back to
  // /welcome forever — the entire site unreachable without an account, on a
  // landing page that promises "no account needed". Each check runs in its own
  // browser context so localStorage really is empty, like a new machine.
  const flow = async (label, fn) => {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    try {
      const problem = await fn(page);
      if (problem) { fails++; console.log(`✗ ${label} → ${problem}`); }
      else console.log(`✓ ${label}`);
    } catch (e) {
      fails++; console.log(`✗ ${label} → ${e.message.slice(0, 90)}`);
    } finally { await ctx.close(); }
  };
  const at = (page) => new URL(page.url()).pathname;
  const settle = (ms = 1200) => new Promise((r) => setTimeout(r, ms));

  await flow("first visit to / lands on /welcome", async (page) => {
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle2", timeout: 30000 });
    await settle();
    return at(page) === "/welcome" ? null : `landed on ${at(page)}`;
  });

  await flow("'Enter the desk' actually enters the desk", async (page) => {
    await page.goto(`http://localhost:${PORT}/welcome`, { waitUntil: "networkidle2", timeout: 30000 });
    await settle();
    const clicked = await page.evaluate(() => {
      const el = [...document.querySelectorAll("a")].find((a) => /enter the desk/i.test(a.textContent || ""));
      if (!el) return false;
      el.click();
      return true;
    });
    if (!clicked) return "no 'Enter the desk' link on the landing page";
    await settle(1800);
    return at(page) !== "/welcome" ? null : "bounced straight back to /welcome (redirect loop)";
  });

  await flow("a returning visitor goes straight to the desk", async (page) => {
    await page.goto(`http://localhost:${PORT}/welcome`, { waitUntil: "networkidle2", timeout: 30000 });
    await settle(800);
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle2", timeout: 30000 });
    await settle();
    return at(page) === "/" ? null : `sent back to ${at(page)}`;
  });

  await browser.close();
} finally {
  preview.kill();
}
console.log(fails === 0 ? `\nSMOKE PASS — ${ROUTES.length} routes + first-visit flow clean` : `\nSMOKE FAIL — ${fails} check(s) broken`);
process.exit(fails === 0 ? 0 : 1);
