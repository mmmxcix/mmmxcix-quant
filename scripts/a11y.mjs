// a11y.mjs — WCAG 2.2 AA spot-check of the built app, in a real browser.
//
// Deliberately NOT a full axe run: this checks the failures that actually
// matter here and that a human would notice — a control a screen reader can't
// name, an input with no label, a tap target under 24px, a missing skip link,
// a page that can't say what language it is. Every finding names the element,
// so it is fixable rather than a score.
//
//   node scripts/a11y.mjs            # against the local build (starts preview)
//   node scripts/a11y.mjs --site URL # against a deployed site

import { spawn } from "node:child_process";
import puppeteer from "puppeteer-core";

const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const siteArg = process.argv.indexOf("--site");
const SITE = siteArg > -1 ? process.argv[siteArg + 1] : null;
const PORT = 4321;

const ROUTES = [
  "/welcome", "/", "/charts", "/news/headlines", "/backtest/run",
  "/portfolio/holdings", "/portfolio/volatility", "/screener/scan",
  "/learn/academy", "/tools", "/login", "/register", "/impressum", "/accessibility",
];

// Runs INSIDE the page. Returns concrete findings, not a score.
function audit() {
  const out = [];
  const add = (rule, impact, detail) => out.push({ rule, impact, detail });
  const label = (el) => {
    const t = (el.innerText || "").trim();
    return (
      el.getAttribute("aria-label") ||
      (el.getAttribute("aria-labelledby") && document.getElementById(el.getAttribute("aria-labelledby"))?.innerText) ||
      el.getAttribute("title") ||
      t
    );
  };
  const describe = (el) => {
    const cls = (el.className || "").toString().slice(0, 40);
    return `<${el.tagName.toLowerCase()}${cls ? ` class="${cls}"` : ""}>`;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };

  // 3.1.1 page language
  const lang = document.documentElement.getAttribute("lang");
  if (!lang) add("html-lang", "serious", "<html> has no lang attribute");

  // 1.1.1 images
  for (const img of document.querySelectorAll("img")) {
    if (!img.hasAttribute("alt")) add("img-alt", "critical", `${describe(img)} src=${(img.getAttribute("src") || "").slice(-40)}`);
  }

  // 4.1.2 controls a screen reader can name
  for (const el of document.querySelectorAll("button, a[href], [role='button']")) {
    if (!visible(el)) continue;
    if (el.getAttribute("aria-hidden") === "true") continue;
    if (!(label(el) || "").trim()) add("control-name", "critical", `${describe(el)} has no accessible name`);
  }

  // 3.3.2 form labels
  for (const el of document.querySelectorAll("input, select, textarea")) {
    if (!visible(el) || el.type === "hidden") continue;
    const id = el.getAttribute("id");
    const labelled =
      el.getAttribute("aria-label") ||
      el.getAttribute("aria-labelledby") ||
      (id && document.querySelector(`label[for="${CSS.escape(id)}"]`)) ||
      el.closest("label") ||
      el.getAttribute("placeholder"); // weak, but still an announced name
    if (!labelled) add("input-label", "critical", `${describe(el)} type=${el.type || "?"} has no label`);
  }

  // 2.4.1 skip link — first focusable should let you jump past the nav
  const firstFocusable = document.querySelector("a[href], button");
  const skip = document.querySelector("a[href^='#']");
  if (!skip || !/skip|content|inhalt/i.test(skip.innerText || skip.getAttribute("aria-label") || "")) {
    add("skip-link", "serious", `no skip link (first focusable: ${firstFocusable ? describe(firstFocusable) : "none"})`);
  }

  // 1.3.1 landmarks
  if (!document.querySelector("main")) add("landmark-main", "serious", "no <main> landmark");

  // 2.5.8 target size (AA: 24x24)
  for (const el of document.querySelectorAll("button, a[href], [role='button'], input[type='checkbox'], input[type='radio']")) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    // inline links in a paragraph are exempt
    if (el.tagName === "A" && el.closest("p, li")) continue;
    if (r.width < 24 || r.height < 24) {
      add("target-size", "moderate", `${describe(el)} is ${Math.round(r.width)}x${Math.round(r.height)} (min 24x24) — "${(label(el) || "").slice(0, 24)}"`);
    }
  }

  // 2.4.6 heading order — a jump (h1 → h3) breaks screen-reader outlines
  const hs = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].filter(visible);
  if (!hs.some((h) => h.tagName === "H1")) add("no-h1", "moderate", "page has no <h1>");
  let prev = 0;
  for (const h of hs) {
    const lvl = +h.tagName[1];
    if (prev && lvl > prev + 1) add("heading-order", "moderate", `${h.tagName} "${(h.innerText || "").slice(0, 30)}" follows H${prev}`);
    prev = lvl;
  }

  return out;
}

const results = [];
let preview;
if (!SITE) {
  preview = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "preview", "--port", String(PORT)], { stdio: "ignore", windowsHide: true });
  await new Promise((r) => setTimeout(r, 3000));
}
const base = SITE || `http://localhost:${PORT}`;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new" });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  for (const route of ROUTES) {
    try {
      await page.goto(`${base}${route}`, { waitUntil: "domcontentloaded", timeout: 40000 });
      // Wait for the app to actually PAINT before judging it. A fixed sleep is
      // fine locally but far too short against production (real API calls), and
      // auditing an unrendered page invents findings — a run against the live
      // site reported "no h1" on 13 routes purely because nothing had rendered.
      await page.waitForFunction(
        () => document.querySelector("main")?.innerText.trim().length > 40,
        { timeout: 25000, polling: 300 },
      ).catch(() => { /* genuinely empty page — let the audit report it */ });
      await new Promise((r) => setTimeout(r, 1200));
      // mark this browser as "seen the welcome page" so / renders the app
      await page.evaluate(() => { try { localStorage.setItem("quant_welcomed", "1"); } catch { /* ignore */ } });
      const found = await page.evaluate(audit);
      for (const f of found) results.push({ route, ...f });
      process.stdout.write(`${found.length ? "✗" : "✓"} ${route} (${found.length})\n`);
    } catch (e) {
      process.stdout.write(`! ${route} — ${e.message.slice(0, 60)}\n`);
    }
  }
} finally {
  await browser.close();
  preview?.kill();
}

// Group identical findings — the same header repeats on every route.
const byKey = new Map();
for (const r of results) {
  const k = `${r.rule}|${r.detail}`;
  if (!byKey.has(k)) byKey.set(k, { ...r, routes: [] });
  byKey.get(k).routes.push(r.route);
}
const order = { critical: 0, serious: 1, moderate: 2 };
const grouped = [...byKey.values()].sort((a, b) => order[a.impact] - order[b.impact]);

console.log(`\n── ${grouped.length} distinct findings ──`);
for (const g of grouped) {
  console.log(`[${g.impact}] ${g.rule}: ${g.detail}`);
  console.log(`    on ${g.routes.length > 4 ? `${g.routes.length} routes` : g.routes.join(", ")}`);
}
const criticals = grouped.filter((g) => g.impact === "critical").length;
console.log(`\n${criticals ? `${criticals} CRITICAL` : "no critical findings"}`);
process.exit(criticals ? 1 : 0);
