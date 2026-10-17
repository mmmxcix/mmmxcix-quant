#!/usr/bin/env node
// verify-yahoo-batch.mjs — check, against LIVE Yahoo, that the batched quote
// path in src/lib/quotes.js gets what the per-symbol path got.
//
//   node scripts/verify-yahoo-batch.mjs              # straight to Yahoo (crumb handshake here)
//   node scripts/verify-yahoo-batch.mjs --site URL   # through a deployed /api/yahoo proxy
//
// Checks, for the 28 Monitor stock symbols:
//   1. v7/finance/quote?symbols=… answers in ONE request and returns
//      regularMarketPrice + regularMarketChangePercent for every symbol;
//   2. regularMarketChangePercent is in PERCENT and agrees with the change the
//      old v8 chart path computes (prev close from the daily bars);
//   3. v8/finance/spark?symbols=… returns a close series per symbol, and which
//      of the two known response shapes it uses.
// Exit code 1 if any check fails. Prints a coverage table either way.

import { ALL_ENTRIES } from "../src/lib/universe.js";
import { parseQuoteBatch, parseSparkBatch } from "../src/lib/quotes.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const siteArg = process.argv.indexOf("--site");
const SITE = siteArg > 0 ? process.argv[siteArg + 1].replace(/\/$/, "") : null;
const symbols = ALL_ENTRIES.filter((e) => e.market !== "crypto").map((e) => e.symbol);

async function session() {
  const r1 = await fetch("https://fc.yahoo.com/", { headers: { "user-agent": UA }, redirect: "manual" });
  const cookie = (r1.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
  const r2 = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", { headers: { "user-agent": UA, cookie } });
  return { cookie, crumb: (await r2.text()).trim() };
}

let s = null;
async function yahoo(pathAndQuery, needsCrumb) {
  if (SITE) return fetch(`${SITE}/api/yahoo/${pathAndQuery}`);
  const headers = { "user-agent": UA };
  let url = `https://query1.finance.yahoo.com/${pathAndQuery}`;
  if (needsCrumb) {
    s ||= await session();
    headers.cookie = s.cookie;
    url += `&crumb=${encodeURIComponent(s.crumb)}`;
  }
  return fetch(url, { headers });
}

let failed = false;
const fail = (msg) => { failed = true; console.log(`  FAIL  ${msg}`); };

console.log(`Source: ${SITE ? `${SITE}/api/yahoo` : "query1.finance.yahoo.com (direct)"}\n`);

// 1 — one v7 batch
const list = symbols.map(encodeURIComponent).join(",");
const fields = "regularMarketPrice,regularMarketChangePercent,regularMarketPreviousClose,regularMarketTime";
const qr = await yahoo(`v7/finance/quote?symbols=${list}&fields=${fields}`, true);
console.log(`v7 quote: HTTP ${qr.status} (1 request, ${symbols.length} symbols)`);
const qjson = qr.ok ? await qr.json() : null;
if (!qr.ok) fail(`v7 quote returned ${qr.status}: ${(await qr.text()).slice(0, 160)}`);
const batch = parseQuoteBatch(qjson);
const raw = new Map((qjson?.quoteResponse?.result || []).map((r) => [r.symbol, r]));

// 2 — compare with the old per-symbol v8 path for every symbol
console.log("\nsymbol      v7 price    v7 chg%   v8 chg%   Δ(pp)  fields");
for (const sym of symbols) {
  const q = batch.get(sym.toUpperCase());
  const r = raw.get(sym);
  let v8chg = null;
  try {
    const cr = await yahoo(`v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=1d`, false);
    const res = (await cr.json())?.chart?.result?.[0];
    const closes = (res?.indicators?.quote?.[0]?.close || []).filter(Number.isFinite);
    const price = res?.meta?.regularMarketPrice ?? closes.at(-1);
    const prev = closes.at(-2);
    v8chg = prev ? ((price - prev) / prev) * 100 : null;
  } catch { /* reported as n/a */ }
  const have = r ? ["regularMarketPrice", "regularMarketChangePercent", "regularMarketPreviousClose", "regularMarketTime"].filter((f) => r[f] != null).length : 0;
  const d = q && v8chg != null && q.changePct != null ? q.changePct - v8chg : null;
  console.log(`${sym.padEnd(10)} ${String(q?.price ?? "—").padStart(10)} ${String(q?.changePct?.toFixed(2) ?? "—").padStart(9)} ${String(v8chg?.toFixed(2) ?? "n/a").padStart(9)} ${String(d?.toFixed(2) ?? "").padStart(7)}  ${have}/4`);
  if (!q) fail(`${sym}: missing from the v7 batch`);
  else if (!Number.isFinite(r?.regularMarketChangePercent)) fail(`${sym}: no regularMarketChangePercent`);
  // Same-day comparison; a gap > 0.5 pp means a unit or reference mismatch
  // (e.g. fraction vs percent, or a different previous close).
  else if (d != null && Math.abs(d) > 0.5) fail(`${sym}: v7 ${q.changePct.toFixed(3)}% vs v8 ${v8chg.toFixed(3)}%`);
}

// 3 — spark shape
const sr = await yahoo(`v8/finance/spark?symbols=${list}&range=3mo&interval=1d`, false);
const sjson = sr.ok ? await sr.json() : null;
const shape = sjson?.spark?.result ? "nested spark.result" : sjson ? "flat {SYMBOL: {close}}" : "none";
const sparks = parseSparkBatch(sjson);
console.log(`\nspark: HTTP ${sr.status}, shape: ${shape}, series for ${sparks.size}/${symbols.length} symbols`);
if (!sr.ok) fail(`spark returned ${sr.status}`);
for (const sym of symbols) if (!sparks.has(sym.toUpperCase())) fail(`${sym}: no spark series`);

console.log(failed ? "\nRESULT: FAIL" : "\nRESULT: OK — batched quotes match the per-symbol path");
process.exit(failed ? 1 : 0);
