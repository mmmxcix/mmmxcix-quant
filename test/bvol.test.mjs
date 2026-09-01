import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import {
  sampleBvolCsv, mergeSeries, trimForApi, missingDays, addDays, utcDay, locateZipEntry, archiveUrl,
} from "../functions/_lib/bvol.mjs";

// The BVOL archive pipeline: one CSV row per second → hourly points + a daily
// OHLC, merged into a growing series, read out of Binance's single-entry ZIPs.

const DAY0 = Date.UTC(2026, 7, 31); // 2026-08-31T00:00Z
function csvFor(values, { startMs = DAY0, stepMs = 1000, jitter = 2, crlf = false } = {}) {
  const nl = crlf ? "\r\n" : "\n";
  const rows = ["calc_time,symbol,base_asset,quote_asset,index_value"];
  values.forEach((v, i) => rows.push(`${startMs + i * stepMs + jitter},BTCBVOLUSDT,BTCBVOL,USDT,${v}`));
  return rows.join(nl) + nl;
}

test("sampleBvolCsv takes the first tick of each hour and the day's OHLC", () => {
  // 3 hours at 1-second resolution, a ramp up then down so high/low are interior.
  const n = 3 * 3600;
  const values = Array.from({ length: n }, (_, i) => 40 + (i < n / 2 ? i : n - i) / 1000);
  const s = sampleBvolCsv(csvFor(values));
  assert.equal(s.hourly.length, 3);
  assert.deepEqual(s.hourly.map((h) => h.time), [DAY0 / 1000, DAY0 / 1000 + 3600, DAY0 / 1000 + 7200], "stamped ON the hour despite the 2 ms jitter");
  assert.equal(s.hourly[0].value, 40);
  assert.equal(s.hourly[1].value, 40 + 3.6);
  assert.equal(s.daily.time, DAY0 / 1000);
  assert.equal(s.daily.open, 40);
  assert.equal(s.daily.close, values[n - 1]);
  assert.equal(s.daily.high, Math.max(...values));
  assert.equal(s.daily.low, 40);
});

test("sampleBvolCsv tolerates CRLF, ignores the header, returns null for no rows", () => {
  const s = sampleBvolCsv(csvFor([41.5, 41.6], { crlf: true }));
  assert.equal(s.hourly.length, 1);
  assert.equal(s.daily.close, 41.6);
  assert.equal(sampleBvolCsv("calc_time,symbol,base_asset,quote_asset,index_value\n"), null);
  assert.equal(sampleBvolCsv(""), null);
});

test("mergeSeries unions, dedups (newest wins), sorts, and trims the hourly tail", () => {
  const d = (day, close) => ({ time: DAY0 / 1000 + day * 86400, open: 1, high: 2, low: 0, close });
  const h = (day, hour, value) => ({ time: DAY0 / 1000 + day * 86400 + hour * 3600, value });
  const base = { daily: [d(0, 10), d(1, 11)], hourly: [h(0, 0, 1), h(0, 1, 2), h(1, 0, 3)] };
  const add = { daily: [d(1, 99), d(2, 12)], hourly: [h(1, 0, 33), h(2, 0, 4)] };
  const m = mergeSeries(base, add);
  assert.deepEqual(m.daily.map((x) => x.close), [10, 99, 12], "day 1 replaced by the newer copy");
  assert.deepEqual(m.hourly.map((x) => x.value), [1, 2, 33, 4]);
  // keep 1 day of hourly: only points from the last daily bar's day survive
  const t = mergeSeries(base, add, { hourlyKeepDays: 1 });
  assert.deepEqual(t.hourly.map((x) => x.value), [4]);
  assert.equal(t.daily.length, 3, "daily is never trimmed");
});

test("trimForApi reports the range and bounds the hourly tail", () => {
  const daily = Array.from({ length: 100 }, (_, i) => ({ time: DAY0 / 1000 + i * 86400, open: 1, high: 1, low: 1, close: 1 }));
  const hourly = Array.from({ length: 100 * 24 }, (_, i) => ({ time: DAY0 / 1000 + i * 3600, value: 1 }));
  const out = trimForApi({ daily, hourly }, 10);
  assert.equal(out.days, 100);
  assert.equal(out.from, "2026-08-31");
  assert.equal(out.to, utcDay((DAY0 / 1000 + 99 * 86400) * 1000));
  assert.equal(out.hourly.length, 10 * 24);
});

test("missingDays enumerates the gap after the stored tail, capped, and from the archive start when empty", () => {
  assert.deepEqual(missingDays("2026-08-28", "2026-08-31"), ["2026-08-29", "2026-08-30", "2026-08-31"]);
  assert.deepEqual(missingDays("2026-08-28", "2026-08-31", 2), ["2026-08-29", "2026-08-30"]);
  assert.deepEqual(missingDays("2026-08-31", "2026-08-31"), []);
  assert.equal(missingDays(null, "2023-06-21")[0], "2023-06-20");
  assert.equal(addDays("2026-02-28", 1), "2026-03-01");
  assert.equal(archiveUrl("ETHBVOLUSDT", "2025-01-02"), "https://data.binance.vision/data/option/daily/BVOLIndex/ETHBVOLUSDT/ETHBVOLUSDT-BVOLIndex-2025-01-02.zip");
});

// A minimal single-entry ZIP (local header + data + central directory + EOCD),
// the layout Binance's archive uses — so the runtime-neutral locator is tested
// against real structure, not a mock.
function makeZip(name, content, { deflate = true } = {}) {
  const raw = Buffer.from(content, "utf8");
  const data = deflate ? deflateRawSync(raw) : raw;
  const nameB = Buffer.from(name, "utf8");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6);
  local.writeUInt16LE(deflate ? 8 : 0, 8); local.writeUInt32LE(0, 10); local.writeUInt32LE(0, 14);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameB.length, 26); local.writeUInt16LE(0, 28);
  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0, 8);
  cen.writeUInt16LE(deflate ? 8 : 0, 10); cen.writeUInt32LE(0, 12); cen.writeUInt32LE(0, 16);
  cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(raw.length, 24);
  cen.writeUInt16LE(nameB.length, 28); cen.writeUInt16LE(0, 30); cen.writeUInt16LE(0, 32);
  cen.writeUInt16LE(0, 34); cen.writeUInt16LE(0, 36); cen.writeUInt32LE(0, 38); cen.writeUInt32LE(0, 42);
  const cenOff = local.length + nameB.length + data.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cen.length + nameB.length, 12); eocd.writeUInt32LE(cenOff, 16); eocd.writeUInt16LE(0, 20);
  return Buffer.concat([local, nameB, data, cen, nameB, eocd]);
}

test("locateZipEntry finds the (deflated or stored) entry without Buffer or zlib", async () => {
  const csv = csvFor([43.68, 43.69]);
  const z = makeZip("BTCBVOLUSDT-BVOLIndex-2026-08-31.csv", csv);
  const entry = locateZipEntry(new Uint8Array(z.buffer, z.byteOffset, z.byteLength));
  assert.equal(entry.name, "BTCBVOLUSDT-BVOLIndex-2026-08-31.csv");
  assert.equal(entry.method, 8);
  // inflate the located slice the way the Worker does
  const text = await new Response(new Blob([entry.data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).text();
  assert.equal(text, csv);
  assert.equal(sampleBvolCsv(text).daily.close, 43.69);

  const stored = locateZipEntry(new Uint8Array(makeZip("a.csv", csv, { deflate: false })));
  assert.equal(stored.method, 0);
  assert.equal(new TextDecoder().decode(stored.data), csv);

  assert.throws(() => locateZipEntry(new Uint8Array([1, 2, 3, 4])), /not a zip/);
});
