// format.js — the board's digest vocabulary.
//
// Every resource returns BOTH structured data and a short text digest. The
// digest is not decoration: the Argus snapshot alone is 171 KB today and ~620 KB
// once the ledger reaches its 500-trade cap, which is more than a reader — human
// or model — can hold. Aggregating and phrasing the answer here means the layer
// carries the cost once, in tested pure functions, instead of at every caller.
//
// Two rules the digests keep, both borrowed from the agents themselves:
//   • Absence is stated, never implied. "no trades in this window" is an answer;
//     an empty table is not.
//   • Sample size travels with every number, because the whole project's
//     discipline is that an average without an n is not a result.

export const nf = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "—");
export const pct = (v, d = 1) => (Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : "—");
/** R is always signed — a bare "0.25R" reads as a win at a glance. */
export const signedR = (v) => (Number.isFinite(v) ? `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}R` : "—");
export const money = (v, cur = "USDT") => (Number.isFinite(v) ? `${v >= 0 ? "" : "−"}${Math.abs(v).toFixed(2)} ${cur}` : "—");

/**
 * Timestamps arrive in two units in this codebase and mixing them is a bug that
 * renders nothing and reports no error: Argus stores milliseconds, Kronos
 * (Python) stores seconds. Normalising at the layer's edge is one of the reasons
 * the layer exists — anything before 1e11 is seconds.
 */
export function toMs(t) {
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
}

export function ago(t, now = Date.now()) {
  const ms = toMs(t);
  if (!ms) return "never";
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** Fixed-width text table. Digests are read in a terminal, a prompt and a <pre>. */
export function table(headers, rows) {
  if (!rows.length) return "";
  const all = [headers, ...rows].map((r) => r.map((c) => String(c ?? "")));
  const w = headers.map((_, i) => Math.max(...all.map((r) => (r[i] || "").length)));
  const line = (r) => r.map((c, i) => (i === 0 ? c.padEnd(w[i]) : c.padStart(w[i]))).join("  ").trimEnd();
  return [line(all[0]), ...all.slice(1).map(line)].join("\n");
}

export const clip = (s, n = 140) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Join the non-empty parts of a digest with blank lines between blocks. */
export const block = (...parts) => parts.filter((p) => p != null && String(p).trim() !== "").join("\n");
