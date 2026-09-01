// /api/bvol — BVOL, Binance's crypto volatility index (30-day implied vol for
// BTC and ETH, the crypto "VIX"), as a daily history with an hourly tail.
//
// ARCHITECTURE — same shape as /api/vol (the DoltHub IV snapshot): the upstream
// is unusable on a user request, so a scheduled job pulls it into D1 and every
// read is served from there. Here the upstream is data.binance.vision, which
// publishes one ZIP per UTC day holding a CSV with a row PER SECOND (~4 MB);
// there is no live REST endpoint for the index. The nightly digest-worker cron
// POSTs `sync`, this function fetches the days it is missing (bounded), samples
// each to hourly points + a daily OHLC (functions/_lib/bvol.mjs) and appends
// them to one JSON blob per symbol in argus_kv.
//
// The FULL history (2023-06-20 →) is seeded once from a machine that has run
// scripts/bvol-backfill.mjs: `node scripts/bvol-backfill.mjs --push` sends it
// here as `seed`. Without a seed the nightly sync starts from a few days back
// and the series grows from there — correct, just short.
//
//   GET  ?symbol=BTCBVOLUSDT      the series { daily[], hourly[] (last 45d) }
//   GET  ?what=status             per-symbol freshness
//   POST { token, sync: true, days? }              append missing days (≤ 14 per run)
//   POST { token, seed: true, symbol, daily, hourly } merge a pushed history (dev token or admin cookie)

import { rateLimit, clientIp } from "../_lib/ratelimit.mjs";
import { isAdminRequest } from "../_lib/auth.mjs";
import {
  BVOL_SYMBOLS, HOURLY_KEEP_DAYS, archiveUrl, utcDay, addDays, missingDays,
  locateZipEntry, sampleBvolCsv, mergeSeries, lastDay, trimForApi,
} from "../_lib/bvol.mjs";

const KEY = (symbol) => `bvol:series:v1:${symbol}`;
const STALE_MS = 3 * 24 * 60 * 60 * 1000; // the archive lags a day by design; three is a broken cron
const SYNC_DAYS_DEFAULT = 3;
const SYNC_DAYS_MAX = 14;
const SEED_DAILY_MAX = 6000;   // ~16 years
const SEED_HOURLY_MAX = 4000;  // the served tail is 45 days = 1080 points; headroom, not a target

function json(body, status = 200, cache = "no-store") {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": cache },
  });
}

const cleanSymbol = (s) => String(s || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 16);

// ── storage (D1 argus_kv, one blob per symbol — same table as /api/vol) ──────
async function readSeries(db, symbol) {
  try {
    const row = await db.prepare("SELECT data, updated_at FROM argus_kv WHERE key=?").bind(KEY(symbol)).first();
    if (!row) return null;
    const s = JSON.parse(row.data);
    return { ...s, at: s.at || row.updated_at };
  } catch { return null; }
}

async function writeSeries(db, symbol, series) {
  const m = mergeSeries(series, null, { hourlyKeepDays: HOURLY_KEEP_DAYS });
  const blob = { symbol, at: Date.now(), daily: m.daily, hourly: m.hourly };
  await db.prepare(
    "INSERT INTO argus_kv (key,data,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at"
  ).bind(KEY(symbol), JSON.stringify(blob), blob.at).run();
  return blob;
}

// ── upstream: one archive day → sampled series ───────────────────────────────
async function inflateRaw(bytes) {
  // Workers ship the WHATWG streams; "deflate-raw" is what a ZIP entry is.
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Response(stream).text();
}

/** @returns {{ok:true, sample}|{missing:true}|{failed:string}} */
async function fetchDay(symbol, day) {
  let res;
  try { res = await fetch(archiveUrl(symbol, day), { signal: AbortSignal.timeout(25_000) }); }
  catch (e) { return { failed: String(e.message || e).slice(0, 80) }; }
  if (res.status === 404 || res.status === 403) return { missing: true };
  if (!res.ok) return { failed: `http ${res.status}` };
  try {
    const entry = locateZipEntry(new Uint8Array(await res.arrayBuffer()));
    const text = entry.method === 0 ? new TextDecoder().decode(entry.data)
      : entry.method === 8 ? await inflateRaw(entry.data)
      : null;
    if (text == null) return { failed: `zip method ${entry.method}` };
    const sample = sampleBvolCsv(text);
    return sample ? { ok: true, sample } : { failed: "no rows" };
  } catch (e) {
    return { failed: String(e.message || e).slice(0, 80) };
  }
}

/** Append the days after the stored tail, up to yesterday (UTC), bounded per run. */
async function syncSymbol(db, symbol, maxDays) {
  const stored = await readSeries(db, symbol);
  const yesterday = utcDay(Date.now() - 86400_000);
  // Unseeded: start a short way back rather than crawling from 2023 three days
  // a night — the backfill script's --push is the way to get the full history.
  const last = lastDay(stored) || addDays(yesterday, -maxDays);
  const days = missingDays(last, yesterday, maxDays);
  const added = [], missing = [], failed = [];
  let pending = { daily: [], hourly: [] };
  for (const day of days) {
    const r = await fetchDay(symbol, day);
    if (r.ok) { pending.daily.push(r.sample.daily); pending.hourly.push(...r.sample.hourly); added.push(day); }
    else if (r.missing) missing.push(day);
    else failed.push(`${day}: ${r.failed}`);
  }
  let out = stored;
  if (added.length) out = await writeSeries(db, symbol, mergeSeries(stored, pending));
  return { symbol, from: last, to: lastDay(out), added: added.length, missing, failed, days: out?.daily?.length || 0 };
}

// ── seed validation: shapes only, but strictly — this lands in a served blob ──
const isFin = (v) => typeof v === "number" && Number.isFinite(v);
function cleanSeed(body) {
  const daily = Array.isArray(body.daily) ? body.daily : [];
  const hourly = Array.isArray(body.hourly) ? body.hourly : [];
  if (daily.length > SEED_DAILY_MAX || hourly.length > SEED_HOURLY_MAX) return null;
  const d = daily.map((x) => ({ time: x?.time, open: x?.open, high: x?.high, low: x?.low, close: x?.close }));
  const h = hourly.map((x) => ({ time: x?.time, value: x?.value }));
  if (!d.every((x) => isFin(x.time) && isFin(x.open) && isFin(x.high) && isFin(x.low) && isFin(x.close))) return null;
  if (!h.every((x) => isFin(x.time) && isFin(x.value))) return null;
  return { daily: d, hourly: h };
}

export async function onRequest({ request, env }) {
  const db = env.DB;
  if (!db) return json({ ok: false, error: "db_not_bound" }, 503);
  const url = new URL(request.url);

  // ── POST: privileged writes (sync from the cron, seed from the backfill) ──
  if (request.method === "POST") {
    let body = {};
    try { body = await request.json(); } catch { /* allow an empty body */ }
    const tokenOk = !!env.DEV_ACCESS_TOKEN &&
      (request.headers.get("x-lab-token") === env.DEV_ACCESS_TOKEN || body?.token === env.DEV_ACCESS_TOKEN);
    if (!tokenOk && !(await isAdminRequest(env, request))) return json({ ok: false, error: "unauthorized" }, 401);

    if (body.seed) {
      const symbol = cleanSymbol(body.symbol);
      if (!BVOL_SYMBOLS.includes(symbol)) return json({ ok: false, error: "bad_symbol" }, 400);
      const seed = cleanSeed(body);
      if (!seed) return json({ ok: false, error: "bad_seed" }, 400);
      try {
        const stored = await readSeries(db, symbol);
        const out = await writeSeries(db, symbol, mergeSeries(stored, seed));
        return json({ ok: true, seeded: true, symbol, days: out.daily.length, hourly: out.hourly.length, to: lastDay(out) });
      } catch (e) {
        return json({ ok: false, error: "seed_failed", detail: String(e.message || e).slice(0, 160) }, 502);
      }
    }

    if (body.sync) {
      const maxDays = Math.max(1, Math.min(SYNC_DAYS_MAX, Number(body.days) || SYNC_DAYS_DEFAULT));
      const symbols = body.symbol ? [cleanSymbol(body.symbol)].filter((s) => BVOL_SYMBOLS.includes(s)) : BVOL_SYMBOLS;
      const results = [];
      for (const s of symbols) {
        try { results.push(await syncSymbol(db, s, maxDays)); }
        catch (e) { results.push({ symbol: s, error: String(e.message || e).slice(0, 160) }); }
      }
      const anyError = results.some((r) => r.error || r.failed?.length);
      return json({ ok: !anyError, synced: true, results }, anyError ? 502 : 200);
    }

    return json({ ok: false, error: "bad_request" }, 400);
  }

  const rl = rateLimit(`bvol:${clientIp(request)}`, 30, 60_000);
  if (!rl.ok) return json({ ok: false, error: "rate_limited" }, 429);

  const what = url.searchParams.get("what") || "series";

  if (what === "status") {
    const out = {};
    for (const s of BVOL_SYMBOLS) {
      const st = await readSeries(db, s);
      out[s] = st ? { to: lastDay(st), days: st.daily?.length || 0, at: st.at, stale: Date.now() - st.at > STALE_MS } : null;
    }
    return json({ ok: true, symbols: out });
  }

  const symbol = cleanSymbol(url.searchParams.get("symbol"));
  if (!BVOL_SYMBOLS.includes(symbol)) return json({ ok: false, error: "bad_symbol", known: BVOL_SYMBOLS }, 400);
  const stored = await readSeries(db, symbol);
  // A missing series is a setup state (nothing seeded/synced yet), not the user's fault.
  if (!stored?.daily?.length) return json({ ok: false, error: "not_synced" }, 503);
  // The archive moves once a day, so a short public cache is free freshness-wise.
  return json({
    ok: true, symbol, at: stored.at, stale: Date.now() - stored.at > STALE_MS,
    ...trimForApi(stored, HOURLY_KEEP_DAYS),
  }, 200, "public, max-age=900");
}
