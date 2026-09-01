// bvol.mjs — Binance's BVOL index (its crypto "VIX": 30-day implied vol for
// BTC / ETH), from the public daily archive. Shared by the Pages Function
// (functions/api/bvol.js), the local backfill (scripts/bvol-backfill.mjs), the
// vite dev shim and the tests, so it must stay runtime-neutral: no Buffer, no
// node:zlib, nothing but strings, Uint8Array and DataView.
//
// WHY AN ARCHIVE AND NOT A LIVE ENDPOINT. Binance publishes BVOL to
// data.binance.vision as one ZIP per UTC day, each holding a CSV with one row
// PER SECOND (86,400 rows, ~4 MB unpacked). There is no REST endpoint for the
// index itself. So the history is sampled here — the first tick of every hour
// plus a daily OHLC — and stored small, and a nightly job appends yesterday.
//
// The CSV: `calc_time,symbol,base_asset,quote_asset,index_value`, calc_time in
// ms with a couple of ms of jitter (1788134400002 = 00:00:00.002 UTC).

export const BVOL_SYMBOLS = ["BTCBVOLUSDT", "ETHBVOLUSDT"];
export const ARCHIVE_BASE = "https://data.binance.vision/data/option/daily/BVOLIndex";
/** First day the archive holds for either symbol (verified against the S3 listing). */
export const FIRST_DAY = "2023-06-20";
/** Hourly points kept in the served blob; the daily series is kept whole. */
export const HOURLY_KEEP_DAYS = 45;

export function archiveUrl(symbol, day) {
  return `${ARCHIVE_BASE}/${symbol}/${symbol}-BVOLIndex-${day}.zip`;
}

/** "YYYY-MM-DD" (UTC) for a ms timestamp. */
export function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}
export function dayToSec(day) {
  return Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);
}
export function addDays(day, n) {
  return utcDay(dayToSec(day) * 1000 + n * 86400_000);
}

/** The UTC days strictly after `lastDay` up to and including `untilDay`, at most `max`. */
export function missingDays(lastDay, untilDay, max = Infinity) {
  const out = [];
  if (!untilDay) return out;
  let d = lastDay ? addDays(lastDay, 1) : FIRST_DAY;
  while (d <= untilDay && out.length < max) { out.push(d); d = addDays(d, 1); }
  return out;
}

/**
 * Sample one day's CSV to { hourly: [{time,value}], daily: {time,open,high,low,close} }.
 * `time` is unix SECONDS (site candle contract). Hourly = the first tick seen in
 * each hour bucket, stamped ON the hour. Returns null for an empty file.
 * Scans with indexOf rather than split(): 86k substrings are cheap in Node but
 * this also runs inside a Worker's CPU budget.
 */
export function sampleBvolCsv(text) {
  const n = text.length;
  const hourly = [];
  let pos = 0, lastBucket = -1;
  let open = null, high = -Infinity, low = Infinity, close = null, firstSec = null;
  while (pos < n) {
    let end = text.indexOf("\n", pos);
    if (end < 0) end = n;
    let lineEnd = end;
    if (lineEnd > pos && text.charCodeAt(lineEnd - 1) === 13) lineEnd--; // \r
    const c0 = text.charCodeAt(pos);
    if (lineEnd > pos && c0 >= 48 && c0 <= 57) { // digits only — skips the header
      const c1 = text.indexOf(",", pos);
      const cLast = text.lastIndexOf(",", lineEnd);
      if (c1 > pos && c1 < lineEnd && cLast > c1) {
        const ms = Number(text.slice(pos, c1));
        const v = Number(text.slice(cLast + 1, lineEnd));
        if (Number.isFinite(ms) && Number.isFinite(v)) {
          const sec = Math.floor(ms / 1000);
          const bucket = Math.floor(sec / 3600);
          if (bucket !== lastBucket) { hourly.push({ time: bucket * 3600, value: v }); lastBucket = bucket; }
          if (firstSec == null) { firstSec = sec; open = v; }
          if (v > high) high = v;
          if (v < low) low = v;
          close = v;
        }
      }
    }
    pos = end + 1;
  }
  if (firstSec == null) return null;
  return { hourly, daily: { time: Math.floor(firstSec / 86400) * 86400, open, high, low, close } };
}

/**
 * Union two series, newest wins on a duplicate timestamp, ascending. With
 * `hourlyKeepDays` the hourly tail is trimmed to that many days before the
 * last daily bar (the served blob); null keeps everything (the local file).
 */
export function mergeSeries(base, add, { hourlyKeepDays = null } = {}) {
  const dailyBy = new Map();
  for (const d of base?.daily || []) dailyBy.set(d.time, d);
  for (const d of add?.daily || []) dailyBy.set(d.time, d);
  const hourlyBy = new Map();
  for (const h of base?.hourly || []) hourlyBy.set(h.time, h);
  for (const h of add?.hourly || []) hourlyBy.set(h.time, h);
  const daily = [...dailyBy.values()].sort((a, b) => a.time - b.time);
  let hourly = [...hourlyBy.values()].sort((a, b) => a.time - b.time);
  if (hourlyKeepDays && daily.length) {
    const cutoff = daily[daily.length - 1].time + 86400 - hourlyKeepDays * 86400;
    hourly = hourly.filter((h) => h.time >= cutoff);
  }
  return { daily, hourly };
}

/** "YYYY-MM-DD" of the last daily bar, or null when the series is empty. */
export function lastDay(series) {
  const d = series?.daily;
  return d?.length ? utcDay(d[d.length - 1].time * 1000) : null;
}

/** What the API serves: the whole daily history, a bounded hourly tail. */
export function trimForApi(series, hourlyKeepDays = HOURLY_KEEP_DAYS) {
  const m = mergeSeries(series, null, { hourlyKeepDays });
  return {
    from: m.daily.length ? utcDay(m.daily[0].time * 1000) : null,
    to: lastDay(m),
    days: m.daily.length,
    daily: m.daily,
    hourly: m.hourly,
  };
}

// ── ZIP entry locator (runtime-neutral) ───────────────────────────────────────
// The archive ZIPs are single-entry, deflate (method 8), no ZIP64. This finds
// the compressed bytes of the first file so the caller can inflate them with
// whatever its runtime has: zlib.inflateRawSync in Node,
// DecompressionStream("deflate-raw") in a Worker. Same layout knowledge as
// scripts/unzip.mjs, minus Buffer.

const EOCD = 0x06054b50, CEN = 0x02014b50, LOC = 0x04034b50;

/**
 * @param {Uint8Array} bytes  the whole archive
 * @returns {{ name: string, method: number, data: Uint8Array }} first file entry
 *   (`data` is the still-compressed slice; method 0 = stored, 8 = deflate)
 */
export function locateZipEntry(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (o) => dv.getUint32(o, true), u16 = (o) => dv.getUint16(o, true);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 66_000); i--) {
    if (u32(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file (no end-of-central-directory record)");
  const count = u16(eocd + 10);
  let off = u32(eocd + 16);
  if (off === 0xffffffff || count === 0xffff) throw new Error("ZIP64 archives are not supported here");
  for (let n = 0; n < count; n++) {
    if (u32(off) !== CEN) throw new Error(`corrupt central directory at entry ${n}`);
    const flags = u16(off + 8), method = u16(off + 10), compSize = u32(off + 20);
    const nameLen = u16(off + 28), extraLen = u16(off + 30), commentLen = u16(off + 32);
    const localOff = u32(off + 42);
    const name = new TextDecoder().decode(bytes.subarray(off + 46, off + 46 + nameLen));
    off += 46 + nameLen + extraLen + commentLen;
    if (flags & 0x1) throw new Error(`${name}: encrypted entries are not supported`);
    if (name.endsWith("/")) continue;
    if (u32(localOff) !== LOC) throw new Error(`${name}: bad local header`);
    const start = localOff + 30 + u16(localOff + 26) + u16(localOff + 28);
    return { name, method, data: bytes.subarray(start, start + compSize) };
  }
  throw new Error("zip has no file entries");
}
