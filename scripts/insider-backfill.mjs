// insider-backfill.mjs — build the historical Form 4 panel the study needs.
//
// The live agent reads the daily index, which is the only source with a two-day
// lag. It is the wrong source for HISTORY: five years is roughly half a million
// Form 4 filings, one HTTP request each, against a 10 req/s courtesy limit —
// seventeen hours of downloading to answer one question.
//
// The SEC publishes the same filings already parsed, one ZIP per quarter, at
// files/structureddata/data/insider-transactions-data-sets/. Twenty downloads
// instead of half a million requests. They lag (2026Q2 was still 404 on 15 Aug
// 2026), which is fatal for a live tracker and irrelevant for a study.
//
// Output: one JSON per quarter under --dir, holding ONLY filings that contain an
// open-market purchase (code P). That is ~2% of Form 4 volume, which is the
// difference between a 40 MB cache and a 2 GB one, and everything downstream
// filters to purchases anyway.
//
//   node scripts/insider-backfill.mjs                 # 20 quarters back from the newest
//   node scripts/insider-backfill.mjs --quarters 8
//   node scripts/insider-backfill.mjs --to 2024q4 --quarters 4
//
// SEC returns 403 to a default HTTP client — a real User-Agent with a contact is
// mandatory. Override with SEC_USER_AGENT.

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { unzip } from "./unzip.mjs";
import { joinDataset, parseSecTsv, purchases } from "../src/lib/insider/form4.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const UA = process.env.SEC_USER_AGENT || "mmmxcix-quant/0.1 (admin@mmmxcix.com)";
const BASE = "https://www.sec.gov/files/structureddata/data/insider-transactions-data-sets";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** "2026q1" → previous quarter label, walking backwards. */
function prevQuarter(label) {
  const m = /^(\d{4})q([1-4])$/.exec(label);
  if (!m) throw new Error(`bad quarter label: ${label}`);
  let [y, q] = [+m[1], +m[2]];
  q -= 1;
  if (q === 0) { q = 4; y -= 1; }
  return `${y}q${q}`;
}

/** The newest quarter the SEC has actually published (it lags by a month or more). */
async function newestQuarter() {
  const now = new Date();
  let label = `${now.getUTCFullYear()}q${Math.floor(now.getUTCMonth() / 3) + 1}`;
  for (let i = 0; i < 6; i++) {
    const r = await fetch(`${BASE}/${label}_form345.zip`, { method: "HEAD", headers: { "user-agent": UA } });
    if (r.ok) return label;
    label = prevQuarter(label);
  }
  throw new Error("no published quarterly dataset found in the last 6 quarters");
}

async function download(label, dir) {
  const zipPath = join(dir, `${label}_form345.zip`);
  if (existsSync(zipPath)) return readFileSync(zipPath);
  const url = `${BASE}/${label}_form345.zip`;
  const res = await fetch(url, { headers: { "user-agent": UA } });
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(zipPath, buf);
  return buf;
}

function tableOf(files, name) {
  for (const [k, v] of files) if (k.toUpperCase().endsWith(`${name}.TSV`)) return v.toString("utf8");
  throw new Error(`${name}.tsv missing from the archive`);
}

async function buildQuarter(label, dir) {
  const outPath = join(dir, `${label}.json`);
  if (existsSync(outPath)) {
    const cached = JSON.parse(readFileSync(outPath, "utf8"));
    console.log(`${label}: cached — ${cached.filings.length} purchase filings`);
    return cached;
  }
  const buf = await download(label, dir);
  const files = unzip(buf);
  const submission = parseSecTsv(tableOf(files, "SUBMISSION"));
  const owners = parseSecTsv(tableOf(files, "REPORTINGOWNER"));
  const trans = parseSecTsv(tableOf(files, "NONDERIV_TRANS"));
  const all = joinDataset({ submission, owners, trans });
  const filings = all.filter((f) => purchases(f).length > 0);
  const payload = {
    quarter: label,
    builtAt: Date.now(),
    totals: { form4: all.length, withPurchase: filings.length },
    filings,
  };
  writeFileSync(outPath, JSON.stringify(payload));
  console.log(
    `${label}: ${all.length} Form 4 filings → ${filings.length} with an open-market purchase ` +
    `(${((filings.length / Math.max(all.length, 1)) * 100).toFixed(1)}%)`
  );
  return payload;
}

async function main() {
  const dir = join(ROOT, arg("dir", "data/insider"));
  mkdirSync(dir, { recursive: true });
  const nQuarters = +arg("quarters", 20);
  let label = arg("to", null) || (await newestQuarter());
  console.log(`newest published quarter: ${label} — going back ${nQuarters}\n`);

  const labels = [];
  for (let i = 0; i < nQuarters; i++) { labels.push(label); label = prevQuarter(label); }
  labels.reverse();

  let filings = 0;
  for (const q of labels) {
    try {
      const out = await buildQuarter(q, dir);
      filings += out.filings.length;
    } catch (e) {
      console.error(`${q}: ${e.message}`);
    }
  }
  console.log(`\npanel: ${filings} purchase filings across ${labels.length} quarters in ${dir}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
