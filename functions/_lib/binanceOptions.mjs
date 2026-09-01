// binanceOptions.mjs — the SNAPSHOT shape for Binance options: what the PC-side
// relay pushes, what /api/binance-options stores and serves, what the panel
// reads. Runtime-neutral (Pages Function, Node relay, vite dev shim, tests).
//
// WHY A SNAPSHOT. Binance's options host (eapi) sends no CORS headers, so the
// browser cannot read it — and it also answers every request from Cloudflare
// Workers with a CloudFront "403 Request blocked", so a proxy cannot either
// (verified in production 2026-09-01; the Yahoo proxy and the BVOL archive from
// the same edge work fine). The user's PC reaches eapi without trouble, so the
// chain is summarised THERE (scripts/binance-options-relay.mjs, via
// src/lib/binanceOptions.js) and pushed here — the same arrangement as the
// DoltHub IV snapshot and the AIS relay.
//
// Compact by construction: summaries per underlying (a dozen numbers plus the
// term structure and skew curve), never the 1,946 raw contracts. ~10 KB today.

export const SNAPSHOT_MAX_ROWS = 40;    // underlyings (8 listed today)
export const SNAPSHOT_MAX_POINTS = 60;  // term / skew points per underlying (11 expiries today)

const fin = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const r4 = (v) => (fin(v) == null ? null : Math.round(v * 1e4) / 1e4);
const r1 = (v) => (fin(v) == null ? null : Math.round(v * 10) / 10);
const r0 = (v) => (fin(v) == null ? null : Math.round(v));

/**
 * fetchOptionsOverview() result → { at, meta, overview[] } — the wire shape.
 * IVs and skews stay fractions (0.355 = 35.5%), rounded to 4 places; money to
 * whole USDT; dte to a tenth of a day. `skew25` is the 30-day-interpolated
 * 25-delta skew; the full curve is `skewByExpiry`.
 */
export function compactOverview(ov) {
  return {
    at: fin(ov?.at) ?? Date.now(),
    meta: {
      oiMaxDays: fin(ov?.oiCoverage?.maxDays),
      oiRequested: fin(ov?.oiCoverage?.requested) ?? 0,
      oiFailed: fin(ov?.oiCoverage?.failed) ?? 0,
    },
    overview: (ov?.rows || []).map((r) => ({
      underlying: r.underlying,
      base: r.base,
      index: fin(r.indexPrice),
      atmIv30: r4(r.atmIv30),
      skew25: r4(r.skew30),
      pcVol: r4(r.pcrVolume),
      pcOi: r4(r.pcrOi),
      oi: r4(r.oi),
      oiUsd: r0(r.oiUsd),
      oiExpiries: r0(r.oiExpiries) ?? 0,
      turnover: r0(r.turnover24h) ?? 0,
      expiries: Array.isArray(r.expiries) ? r.expiries.length : r0(r.expiries) ?? 0,
      contracts: r0(r.contractCount) ?? 0,
      illiquid: !!r.illiquid,
      term: (r.term || []).map((t) => ({ expiry: t.expiry, dte: r1(t.dte), atmIv: r4(t.atmIv) })),
      skewByExpiry: (r.term || []).filter((t) => fin(t.skew25) != null).map((t) => ({ expiry: t.expiry, dte: r1(t.dte), skew25: r4(t.skew25) })),
    })),
  };
}

// ── validation of a pushed snapshot: whitelist fields, bound sizes ───────────
const SYMBOL_RE = /^[A-Z0-9]{2,20}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const numOrNull = (v) => (v == null ? null : fin(v));
const bad = (v) => v != null && fin(v) == null; // present but not a finite number

function cleanPoints(list, valueKey) {
  if (list == null) return [];
  if (!Array.isArray(list) || list.length > SNAPSHOT_MAX_POINTS) return null;
  const out = [];
  for (const p of list) {
    if (!p || typeof p !== "object") return null;
    if (p.expiry != null && !(typeof p.expiry === "string" && DAY_RE.test(p.expiry))) return null;
    if (bad(p.dte) || bad(p[valueKey]) || fin(p[valueKey]) == null) return null;
    out.push({ expiry: p.expiry ?? null, dte: numOrNull(p.dte), [valueKey]: fin(p[valueKey]) });
  }
  return out;
}

/**
 * @returns {{ok:true, overview:object[]}|{ok:false, error:string}}
 * Accepts only the fields compactOverview emits; anything else is dropped so a
 * push can never park an arbitrary blob in the served row.
 */
export function validateOverviewSnapshot(overview) {
  if (!Array.isArray(overview)) return { ok: false, error: "overview_not_array" };
  if (!overview.length) return { ok: false, error: "overview_empty" };
  if (overview.length > SNAPSHOT_MAX_ROWS) return { ok: false, error: "overview_too_large" };
  const out = [];
  const seen = new Set();
  for (const r of overview) {
    if (!r || typeof r !== "object") return { ok: false, error: "row_not_object" };
    if (typeof r.underlying !== "string" || !SYMBOL_RE.test(r.underlying)) return { ok: false, error: "bad_underlying" };
    if (seen.has(r.underlying)) return { ok: false, error: "duplicate_underlying" };
    seen.add(r.underlying);
    for (const k of ["index", "atmIv30", "skew25", "pcVol", "pcOi", "oi", "oiUsd", "oiExpiries", "turnover", "expiries", "contracts"]) {
      if (bad(r[k])) return { ok: false, error: `bad_${k}` };
    }
    const term = cleanPoints(r.term, "atmIv");
    const skewByExpiry = cleanPoints(r.skewByExpiry, "skew25");
    if (!term || !skewByExpiry) return { ok: false, error: "bad_curve" };
    out.push({
      underlying: r.underlying,
      base: typeof r.base === "string" ? r.base.slice(0, 10) : r.underlying.replace(/USDT$/, ""),
      index: numOrNull(r.index), atmIv30: numOrNull(r.atmIv30), skew25: numOrNull(r.skew25),
      pcVol: numOrNull(r.pcVol), pcOi: numOrNull(r.pcOi),
      oi: numOrNull(r.oi), oiUsd: numOrNull(r.oiUsd), oiExpiries: numOrNull(r.oiExpiries) ?? 0,
      turnover: numOrNull(r.turnover) ?? 0, expiries: numOrNull(r.expiries) ?? 0, contracts: numOrNull(r.contracts) ?? 0,
      illiquid: !!r.illiquid,
      term, skewByExpiry,
    });
  }
  return { ok: true, overview: out };
}

/** The optional meta block, same whitelist idea. */
export function cleanMeta(meta) {
  if (!meta || typeof meta !== "object") return null;
  return { oiMaxDays: numOrNull(meta.oiMaxDays), oiRequested: numOrNull(meta.oiRequested) ?? 0, oiFailed: numOrNull(meta.oiFailed) ?? 0 };
}
