// insider-agent.mjs — the daily Form 4 ingest.
//
// Runs on the PC (agent-daemon.mjs forks it) rather than in a Worker, for three
// reasons that are all measured rather than assumed:
//
//   · SEC returns 403 to a default HTTP client and requires a real User-Agent
//     with a contact address. That is a policy, not a rate limit — Python's
//     default UA fails the same way and looks exactly like an auth error (the
//     Kronos setup already lost a session to that one).
//   · ~1,000 Form 4 filings are disseminated per trading day, one request each,
//     against a 10 req/s courtesy limit. That is minutes of wall clock, which is
//     nothing for a long-lived agent and impossible inside a Worker's CPU budget.
//   · The daily index only exists for days the SEC published. Weekends and
//     holidays 404, and a scheduler that treats a 404 as an error learns nothing.
//
// What it does, in order:
//   1. daily index for the last few days → the Form 4 accessions
//   2. the complete submission .txt for each new one (the XML is embedded, so
//      one request per filing rather than a directory listing plus a document)
//   3. push the normalized filings to /api/insider
//   4. re-read a trailing window back from the site, recompute clusters, push
//      them — stateless on purpose, so a lost local cache costs bandwidth and
//      not correctness
//
//   node scripts/insider-agent.mjs                # the last 3 published days
//   node scripts/insider-agent.mjs --days 10
//   node scripts/insider-agent.mjs --dry          # parse and report, push nothing
//
// Env: LAB_TOKEN (site machine token), LAB_SITE, SEC_USER_AGENT.

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { clusterBuys, DEFAULT_CLUSTER } from "../src/lib/insider/cluster.js";
import { extractOwnershipXml, parseDailyIndex, parseForm4, purchases } from "../src/lib/insider/form4.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CACHE = join(ROOT, "data", "insider");
const SEEN_PATH = join(CACHE, "seen.json");

const UA = process.env.SEC_USER_AGENT || "mmmxcix-quant/0.1 (admin@mmmxcix.com)";
const TOKEN = process.env.LAB_TOKEN || process.env.DEV_ACCESS_TOKEN || "";
const SITE = process.env.LAB_SITE || "https://quant.mmmxcix.com";
const DRY = process.argv.includes("--dry");

// The clustering the LIVE table is built with. Descriptive, not validated: the
// question of whether this shape predicts anything is answered in
// docs/INSIDER_FINDINGS.md, and nothing in this agent claims it does.
const LIVE_CLUSTER = { ...DEFAULT_CLUSTER, windowDays: 10, minInsiders: 2, minValue: 25_000 };
const CLUSTER_WINDOW_DAYS = 120;   // trailing filings re-read to catch late completions

const DAY = 86_400_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString();

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// ── a polite client ─────────────────────────────────────────────────────────
// SEC asks for no more than 10 requests a second. Eight, with a shared gate, so
// four workers cannot collectively exceed it — and a 429 or 403 backs the whole
// agent off rather than each worker independently deciding it was unlucky.
let nextSlot = 0;
let backoff = 0;

async function secFetch(url, { text = true } = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const now = Date.now();
    const wait = Math.max(nextSlot - now, backoff);
    nextSlot = Math.max(now, nextSlot) + 125;            // 8 requests/second
    if (wait > 0) await sleep(wait);
    let res;
    try {
      res = await fetch(url, { headers: { "user-agent": UA, "accept-encoding": "gzip, deflate" }, signal: AbortSignal.timeout(30_000) });
    } catch {
      await sleep(1000 * (attempt + 1));
      continue;
    }
    if (res.status === 404) return null;                  // a day the SEC did not publish
    if (res.status === 429 || res.status === 403) {
      backoff = Math.min(30_000, (backoff || 2_000) * 2);
      console.error(`[${stamp()}] SEC ${res.status} — backing off ${backoff}ms (${url.slice(0, 90)})`);
      continue;
    }
    if (!res.ok) { await sleep(500 * (attempt + 1)); continue; }
    backoff = Math.max(0, (backoff / 2) | 0);
    return text ? res.text() : res;
  }
  return null;
}

// ── the daily index ─────────────────────────────────────────────────────────

function indexUrl(d) {
  const y = d.getUTCFullYear();
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  const ymd = `${y}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  return `https://www.sec.gov/Archives/edgar/daily-index/${y}/QTR${q}/form.${ymd}.idx`;
}

async function form4sFor(date) {
  const body = await secFetch(indexUrl(date));
  if (!body) return null;                                 // weekend, holiday, or not yet published
  return parseDailyIndex(body, { forms: ["4"] });
}

// ── local seen-cache ────────────────────────────────────────────────────────
// Purely an optimisation: an accession already parsed is not downloaded again.
// Losing it re-downloads, it never changes what ends up in the database.

function loadSeen() {
  try { return new Set(JSON.parse(readFileSync(SEEN_PATH, "utf8"))); } catch { return new Set(); }
}
function saveSeen(seen) {
  // A dry run must not mark filings as seen. It downloads and parses without
  // pushing, so recording them would make the next REAL pass skip exactly the
  // filings that never reached the database.
  if (DRY) return;
  try {
    // Bounded: 90 days at ~1,000 filings a day is the useful horizon, and an
    // unbounded set would eventually be the largest thing this agent does.
    writeFileSync(SEEN_PATH, JSON.stringify([...seen].slice(-120_000)));
  } catch { /* the cache is disposable */ }
}

// ── pushing ─────────────────────────────────────────────────────────────────

async function push(payload, label) {
  if (DRY) { console.log(`[${stamp()}] dry run — would push ${label}`); return { ok: true }; }
  const res = await fetch(`${SITE}/api/insider`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: TOKEN, ...payload }),
    signal: AbortSignal.timeout(60_000),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || !out.ok) throw new Error(`${label}: HTTP ${res.status} ${out.error || ""}`);
  return out;
}

// ── the pass ────────────────────────────────────────────────────────────────

async function ingest(days) {
  mkdirSync(CACHE, { recursive: true });
  const seen = loadSeen();
  const wanted = [];

  for (let back = 1; back <= days; back++) {
    const d = new Date(Date.now() - back * DAY);
    const rows = await form4sFor(d);
    if (rows === null) continue;
    const fresh = rows.filter((r) => !seen.has(r.accession));
    console.log(`[${stamp()}] ${d.toISOString().slice(0, 10)}: ${rows.length} Form 4 filings, ${fresh.length} new`);
    wanted.push(...fresh);
  }
  if (!wanted.length) { console.log(`[${stamp()}] nothing new`); return { filings: [], parsed: 0 }; }

  // Four workers behind the shared 8/s gate.
  const filings = [];
  let done = 0, failed = 0;
  const queue = [...wanted];
  async function worker() {
    while (queue.length) {
      const row = queue.shift();
      const body = await secFetch(`https://www.sec.gov/Archives/${row.path}`);
      done++;
      if (done % 200 === 0) console.log(`[${stamp()}]   ${done}/${wanted.length} submissions`);
      if (!body) { failed++; continue; }
      const xml = extractOwnershipXml(body);
      const f = xml && parseForm4(xml, { accession: row.accession, filedAt: row.filedAt });
      if (!f) { failed++; continue; }
      seen.add(row.accession);
      filings.push(f);
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
  saveSeen(seen);

  const buys = filings.filter((f) => purchases(f).length).length;
  console.log(`[${stamp()}] parsed ${filings.length}/${wanted.length} (${failed} unreadable) — ${buys} contain an open-market purchase`);

  // Batched so a single request never carries more than the endpoint accepts.
  for (let i = 0; i < filings.length; i += 500) {
    const out = await push({ filings: filings.slice(i, i + 500) }, "filings");
    if (!DRY) console.log(`[${stamp()}]   pushed ${out.filings} filings`);
  }
  return { filings, parsed: filings.length };
}

/**
 * Recompute clusters from a trailing window read back off the site.
 *
 * Stateless by choice: the alternative is to cluster over whatever the local
 * cache happens to hold, which quietly changes the answer after any interruption.
 * A cluster is a claim about several filings, so it has to be computed over all
 * of them or not at all.
 */
async function recluster() {
  if (DRY) { console.log(`[${stamp()}] dry run — skipping the cluster pass`); return; }
  const url = `${SITE}/api/insider?what=filings&days=${CLUSTER_WINDOW_DAYS}&limit=2000&purchases=1`;
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || !out.ok) { console.error(`[${stamp()}] cluster pass: could not read back (${res.status})`); return; }
  const filings = (out.filings || []).filter((f) => f?.symbol);
  const { events, stats } = clusterBuys(filings, LIVE_CLUSTER);
  console.log(
    `[${stamp()}] clusters over ${filings.length} purchase filings (${CLUSTER_WINDOW_DAYS}d): ` +
    `${events.length} events, ${stats.symbols} symbols ` +
    `(rejected: ${stats.rejectedSingleInsider} single-insider, ${stats.rejectedJointFilingOnly} joint-filing, ${stats.rejectedBelowValue} below value)`
  );
  if (!events.length) return;
  const res2 = await push({ clusters: events, clusterParams: LIVE_CLUSTER }, "clusters");
  console.log(`[${stamp()}]   pushed ${res2.clusters} clusters`);
}

async function main() {
  if (!TOKEN && !DRY) { console.error("LAB_TOKEN is not set."); process.exit(1); }
  const days = Math.max(1, Math.min(30, +arg("days", 3)));
  console.log(`[${stamp()}] insider agent — last ${days} published day(s), UA "${UA}"`);
  const { parsed } = await ingest(days);
  if (parsed) await recluster();
  console.log(`[${stamp()}] done`);
}

main().catch((e) => { console.error(e); process.exit(1); });
