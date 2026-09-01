// bvol-backfill.mjs — build the BVOL (Binance 30-day implied-vol index) history
// from the public daily archive, and optionally push it to the site.
//
//   node scripts/bvol-backfill.mjs                       # 2023-06-20 → yesterday, both symbols
//   node scripts/bvol-backfill.mjs --days 365            # only the last 365 days
//   node scripts/bvol-backfill.mjs --from 2025-01-01 --to 2025-03-31
//   node scripts/bvol-backfill.mjs --symbols BTCBVOLUSDT
//   node scripts/bvol-backfill.mjs --push                # …then seed /api/bvol (needs DEV_ACCESS_TOKEN)
//
// Output: data/bvol/<SYMBOL>.json as
//   { symbol, at, from, to, hourly:[{time,value}], daily:[{time,open,high,low,close}] }
// (time = unix seconds). data/ is gitignored — this is a local cache like the
// insider price cache; the site reads the series from D1 via /api/bvol, which
// `--push` seeds. After that the nightly digest-worker cron appends each new day
// on its own (functions/api/bvol.js, POST sync), so this only needs to run once —
// or again after an outage longer than the cron's catch-up window.
//
// Resumable: days already in the file are skipped, and the file is checkpointed
// every 40 days, so an interrupted run loses at most that. Polite: a small
// worker pool, timeouts, and exponential backoff on anything transient. A 404 is
// recorded as an archive gap and NOT retried — the bucket simply has no file for
// that day.

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { unzip } from "./unzip.mjs";
import {
  BVOL_SYMBOLS, FIRST_DAY, HOURLY_KEEP_DAYS, archiveUrl, utcDay, addDays,
  sampleBvolCsv, mergeSeries, trimForApi,
} from "../functions/_lib/bvol.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "data", "bvol");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── CLI ───────────────────────────────────────────────────────────────────────
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith("--")) continue;
  const next = process.argv[i + 1];
  if (next && !next.startsWith("--")) { args[a.slice(2)] = next; i++; } else args[a.slice(2)] = true;
}
const yesterday = utcDay(Date.now() - 86400_000);
const to = args.to || yesterday;
const from = args.from || (args.days ? addDays(to, -(Number(args.days) - 1)) : FIRST_DAY);
const symbols = String(args.symbols || BVOL_SYMBOLS.join(",")).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const concurrency = Math.max(1, Math.min(6, Number(args.concurrency) || 4));
const API = String(args.api || "https://quant.mmmxcix.com").replace(/\/$/, "");

for (const s of symbols) if (!BVOL_SYMBOLS.includes(s)) { console.error(`unknown symbol ${s} (known: ${BVOL_SYMBOLS.join(", ")})`); process.exit(2); }
if (!(from <= to)) { console.error(`bad range ${from} → ${to}`); process.exit(2); }

// ── one day ───────────────────────────────────────────────────────────────────
/** @returns {{ok:true, sample:object}|{missing:true}|{failed:string}} */
async function fetchDay(symbol, day) {
  const url = archiveUrl(symbol, day);
  let lastErr = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (res.status === 404 || res.status === 403) return { missing: true }; // S3 answers 403 for some absent keys
      if (!res.ok) { lastErr = `http ${res.status}`; }
      else {
        const buf = Buffer.from(await res.arrayBuffer());
        const entries = unzip(buf);
        const csv = [...entries.values()][0];
        if (!csv) return { failed: "empty zip" };
        const sample = sampleBvolCsv(csv.toString("utf8"));
        if (!sample) return { failed: "no rows" };
        return { ok: true, sample };
      }
    } catch (e) {
      lastErr = String(e.message || e).slice(0, 80);
    }
    await sleep(1000 * 2 ** attempt + Math.random() * 400);
  }
  return { failed: lastErr || "unknown" };
}

function loadFile(symbol) {
  const path = join(OUT_DIR, `${symbol}.json`);
  if (!existsSync(path)) return { symbol, hourly: [], daily: [] };
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { console.error(`  ${symbol}: existing file unreadable — starting fresh`); return { symbol, hourly: [], daily: [] }; }
}

function saveFile(symbol, series) {
  const m = mergeSeries(series, null); // sort + dedup, keep every hour
  const out = {
    symbol, at: Date.now(),
    from: m.daily.length ? utcDay(m.daily[0].time * 1000) : null,
    to: m.daily.length ? utcDay(m.daily[m.daily.length - 1].time * 1000) : null,
    hourly: m.hourly, daily: m.daily,
  };
  writeFileSync(join(OUT_DIR, `${symbol}.json`), JSON.stringify(out));
  return out;
}

// ── one symbol ────────────────────────────────────────────────────────────────
async function backfill(symbol) {
  let series = loadFile(symbol);
  const have = new Set(series.daily.map((d) => utcDay(d.time * 1000)));
  const queue = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (!have.has(d)) queue.push(d);
  console.log(`${symbol}: ${series.daily.length} days on disk, ${queue.length} to fetch (${from} → ${to}, ${concurrency} workers)`);
  if (!queue.length) return saveFile(symbol, series);

  const missing = [], failed = [];
  let done = 0, sinceCheckpoint = 0, pending = { daily: [], hourly: [] };
  const t0 = Date.now();

  async function worker() {
    while (queue.length) {
      const day = queue.shift();
      const r = await fetchDay(symbol, day);
      if (r.ok) { pending.daily.push(r.sample.daily); pending.hourly.push(...r.sample.hourly); }
      else if (r.missing) missing.push(day);
      else failed.push(`${day} (${r.failed})`);
      done++; sinceCheckpoint++;
      if (done % 25 === 0 || !queue.length) {
        const rate = done / ((Date.now() - t0) / 1000);
        process.stdout.write(`  ${symbol} ${done}/${done + queue.length} ${day}  ${rate.toFixed(1)}/s\n`);
      }
      if (sinceCheckpoint >= 40) {
        series = mergeSeries(series, pending); pending = { daily: [], hourly: [] }; sinceCheckpoint = 0;
        saveFile(symbol, series);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  series = mergeSeries(series, pending);
  const out = saveFile(symbol, series);
  console.log(`${symbol}: ${out.daily.length} daily bars, ${out.hourly.length} hourly points, ${out.from} → ${out.to}`);
  if (missing.length) console.log(`  archive gaps (404): ${missing.length} — ${missing.slice(0, 12).join(", ")}${missing.length > 12 ? " …" : ""}`);
  if (failed.length) console.log(`  FAILED (rerun to retry): ${failed.length} — ${failed.slice(0, 12).join(", ")}${failed.length > 12 ? " …" : ""}`);
  return out;
}

// ── push to the site (seeds the D1 blob behind /api/bvol) ────────────────────
async function push(out) {
  const token = process.env.DEV_ACCESS_TOKEN || process.env.LAB_TOKEN;
  if (!token) { console.error("  --push needs DEV_ACCESS_TOKEN (or LAB_TOKEN) in the environment"); return; }
  const body = { token, seed: true, symbol: out.symbol, ...trimForApi(out, HOURLY_KEEP_DAYS) };
  const res = await fetch(`${API}/api/bvol`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
  });
  const j = await res.json().catch(() => ({}));
  console.log(`  push ${out.symbol} → HTTP ${res.status} ${JSON.stringify(j).slice(0, 160)}`);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const symbol of symbols) {
  const out = await backfill(symbol);
  if (args.push) await push(out);
}
