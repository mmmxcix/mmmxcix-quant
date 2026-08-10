// volData.js — client access to /api/vol (free options & volatility data from
// the public DoltHub `post-no-preference/options` database).
//
// This is the layer Yahoo's live option chain cannot provide: a symbol's IV
// history, so vol can be judged RELATIVE to its own past (IV rank / percentile)
// instead of in the abstract. "IV 28%" means nothing on its own; "IV rank 92"
// means options are near their most expensive in a year.

const API = "/api/vol";

async function get(params) {
  const res = await fetch(`${API}?${new URLSearchParams(params)}`);
  const data = await res.json().catch(() => null);
  if (!data) throw new Error("Volatility service unreachable.");
  if (!data.ok) {
    if (data.error === "no_data") throw new Error(`No options data for "${params.symbol}" — the database covers US-listed optionable names.`);
    if (data.error === "rate_limited") throw new Error("Too many requests — wait a minute.");
    if (data.error === "not_synced") throw new Error("The volatility snapshot hasn't been synced yet.");
    throw new Error(data.detail || data.error || "Request failed.");
  }
  return data;
}

/** One symbol's volatility card: IV/HV, 52-week band, IV rank, week/month ago. */
export function fetchIv(symbol) {
  return get({ what: "iv", symbol });
}

/** Cross-market IV-rank leaders: where premium is richest and cheapest today. */
export function fetchIvLeaders() {
  return get({ what: "leaders" });
}

/** Snapshot freshness — when the universe was last pulled from upstream. */
export function fetchVolStatus() {
  return get({ what: "status" });
}

/**
 * How to read an IV rank — kept here (not in the component) so the wording is
 * identical wherever it is shown. Deliberately educational, never advice.
 */
export function ivRankVerdict(rank) {
  if (rank == null) return null;
  if (rank >= 80) return { tone: "high", label: "Very expensive", note: "IV is near its 12-month high. Premium sellers get paid the most here — and pay the most for being wrong." };
  if (rank >= 55) return { tone: "high", label: "Expensive", note: "Options cost more than they usually do this year." };
  if (rank >= 30) return { tone: "mid", label: "Normal", note: "Vol is around its typical level for this name." };
  if (rank >= 12) return { tone: "low", label: "Cheap", note: "Options are cheaper than usual — long-vol structures cost less." };
  return { tone: "low", label: "Very cheap", note: "IV is near its 12-month low. Cheap for buyers; sellers are paid the least." };
}

/** IV over HV — what the market charges above what the stock actually did. */
export function premiumVerdict(ratio) {
  if (ratio == null || !Number.isFinite(ratio)) return null;
  if (ratio >= 1.3) return { tone: "high", label: "Rich vs realised", note: "Implied vol sits well above what the stock has actually been doing." };
  if (ratio >= 1.05) return { tone: "mid", label: "Slight premium", note: "Implied a little above realised — the normal state of affairs." };
  if (ratio >= 0.9) return { tone: "mid", label: "In line", note: "Implied and realised vol agree." };
  return { tone: "low", label: "Below realised", note: "Implied vol is UNDER what the stock has actually been doing — options look cheap for the movement." };
}
