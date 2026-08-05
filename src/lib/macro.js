// macro.js — client for the LSE macro datasets through our server proxy
// (/api/lse/*): government bond yields (34 countries, some from 1990),
// the historical economic-events archive (125k events, 2015 → Mar 2026),
// and the Level-3 order-book file archive (99 instruments, csv.gz).

const PROXY = "/api/lse";

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

async function getJson(path) {
  const res = await fetch(`${PROXY}/${path}`);
  if (res.status === 503) throw new Error("London data not configured (LSE_API_KEY missing).");
  if (!res.ok) throw new Error(`London request failed (${res.status}).`);
  return res.json();
}

/** Countries + per-maturity coverage. Sorted by observation count, richest first. */
export async function fetchYieldStats() {
  const j = await getJson("bond-yields/stats");
  const countries = Object.values(j.countries || {})
    .map((c) => ({
      code: c.code, name: c.name, currency: c.currency,
      firstDate: c.first_date, lastDate: c.last_date, observations: c.observations,
      maturities: (c.maturities || []).map((m) => ({ tenor: m.tenor, days: m.days })),
    }))
    .sort((a, b) => b.observations - a.observations);
  return { countries, totalObservations: j.total_observations };
}

/**
 * All yield observations for one country (optionally from a start date).
 * Rows: { date: "YYYY-MM-DD", tenor, days, close } sorted by date asc.
 */
export async function fetchYields(country, startDate) {
  const q = startDate ? `&start_date=${startDate}` : "";
  const j = await getJson(`bond-yields?country=${encodeURIComponent(country)}&format=json${q}`);
  const rows = [];
  for (const r of j.data || []) {
    const close = num(r.close);
    const days = num(r.maturity_days);
    if (close == null || days == null) continue;
    // Real (inflation-linked / TIPS) yields sit ~2pp below the nominal curve —
    // plotting them as a point on the same axis makes the term structure crash
    // into a V-shape at that tenor. Keep the nominal curve nominal-only.
    if (/tips|real|inflation|linked|breakeven/i.test(String(r.maturity || ""))) continue;
    rows.push({ date: r.date, tenor: r.maturity, days, close });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.days - b.days));
  return rows;
}

/** Latest full yield curve + the closest curve to `compareDate` (optional). */
export function yieldCurves(rows) {
  if (!rows.length) return { latest: null, yearAgo: null };
  const lastDate = rows[rows.length - 1].date;
  const curveAt = (targetDate) => {
    // Last observation per tenor at or before targetDate.
    const byTenor = new Map();
    for (const r of rows) {
      if (r.date > targetDate) break;
      byTenor.set(r.days, r);
    }
    const pts = [...byTenor.values()].sort((a, b) => a.days - b.days);
    return pts.length >= 3 ? { date: targetDate, points: pts } : null;
  };
  const yearAgoDate = new Date(Date.parse(lastDate) - 365 * 86400_000).toISOString().slice(0, 10);
  return { latest: curveAt(lastDate), yearAgo: curveAt(yearAgoDate), lastDate };
}

/** Historical economic events. Filters are all optional. */
export async function fetchCalendar({ country, impact, startDate, endDate } = {}) {
  const q = new URLSearchParams({ format: "json" });
  if (country) q.set("country", country);
  if (impact) q.set("impact", impact);
  if (startDate) q.set("start_date", startDate);
  if (endDate) q.set("end_date", endDate);
  const j = await getJson(`economic-calendar?${q}`);
  return (j.data || []).map((r) => ({
    date: r.event_date, country: r.country, event: r.event, currency: r.currency,
    previous: num(r.previous), estimate: num(r.estimate), actual: num(r.actual),
    changePct: num(r.change_percentage), impact: r.impact, unit: r.unit || "",
  }));
}

export async function fetchCalendarStats() {
  const j = await getJson("economic-calendar/stats");
  return { earliest: j.earliest, latest: j.latest, totalEvents: j.total_events, countries: j.countries || [] };
}

/** L3 order-book archive: instruments with their daily csv.gz files. */
export async function fetchL3List() {
  const j = await getJson("l3-equities/list");
  return {
    totalInstruments: j.total_instruments, totalFiles: j.total_files, totalSize: j.total_size,
    instruments: (j.instruments || []).map((i) => ({
      name: i.name, displayName: i.display_name, category: i.category,
      fileCount: i.file_count, totalSize: i.total_size, from: i.date_range?.from, to: i.date_range?.to,
      files: i.files || [],
    })),
  };
}

/** Proxied download URL for one L3 file (key stays server-side). */
export const l3DownloadUrl = (instrument, filename) =>
  `${PROXY}/l3-equities/download/${encodeURIComponent(instrument)}/${encodeURIComponent(filename)}`;

export const fmtBytes = (n) => {
  if (!Number.isFinite(n)) return "–";
  if (n >= 1e9) return (n / 1e9).toFixed(1) + " GB";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + " MB";
  return Math.round(n / 1e3) + " KB";
};
