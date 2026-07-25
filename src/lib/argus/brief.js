// argus/brief.js — turn the worldmonitor alt-data + news into a compact,
// DELTA-focused briefing for Argus's event channel (Phase 1). Pure functions:
// summarize the raw snapshots, diff against the previous brief (what's NEW /
// escalating), and render a short text the LLM reads. Never dumps raw data —
// the point is signal, not volume. See docs/DAYTRADER_AGENT.md.

// Trade-relevant maritime chokepoints (lat/lon bbox) — vessel counts here are a
// cheap congestion proxy (oil/shipping).
const CHOKEPOINTS = [
  { id: "hormuz", label: "Strait of Hormuz", box: [24.0, 55.0, 27.5, 58.5] },
  { id: "suez", label: "Suez / Red Sea", box: [12.0, 32.0, 31.0, 44.0] },
  { id: "malacca", label: "Malacca / Singapore", box: [-1.0, 100.0, 6.0, 105.0] },
  { id: "bosphorus", label: "Bosphorus / Black Sea", box: [40.5, 27.0, 47.0, 42.0] },
  { id: "panama", label: "Panama", box: [7.0, -81.0, 10.0, -78.0] },
];

const inBox = (lat, lon, b) => lat >= b[0] && lat <= b[2] && lon >= b[1] && lon <= b[3];

/** Vessel + anchored counts per chokepoint from /api/world ships rows. */
export function chokepointCongestion(ships = []) {
  const out = {};
  for (const cp of CHOKEPOINTS) out[cp.id] = { label: cp.label, ships: 0, anchored: 0 };
  for (const row of ships) {
    const lat = row[1], lon = row[2], sog = row[3] ?? 0;
    for (const cp of CHOKEPOINTS) {
      if (inBox(lat, lon, cp.box)) { out[cp.id].ships++; if (sog < 0.5) out[cp.id].anchored++; }
    }
  }
  return out;
}

// Decode the HTML entities RSS feeds leave in headlines (’ — & etc.).
const NAMED = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
export function decodeEntities(s) {
  return String(s || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return _; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(+d); } catch { return _; } })
    .replace(/&([a-z]+);/gi, (_, n) => NAMED[n.toLowerCase()] ?? _);
}

/** Top recent headlines, deduped, most recent first. */
export function summarizeNews(news = [], n = 12) {
  const items = Array.isArray(news) ? news : news.items || [];
  const seen = new Set();
  return items
    .filter((it) => it.title && !seen.has(it.title) && seen.add(it.title))
    .slice(0, n)
    .map((it) => ({ title: decodeEntities(it.title), source: it.source, date: it.pubDate, category: it.category }));
}

/** Conflict fatalities aggregated by country (recent = last ~30 rows by date). */
export function summarizeConflicts(conflicts = []) {
  const byCountry = new Map();
  for (const [, , best, , , country] of conflicts) {
    if (!country) continue;
    byCountry.set(country, (byCountry.get(country) || 0) + (best || 0));
  }
  return [...byCountry.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([country, deaths]) => ({ country, deaths }));
}

/** Orange/red GDACS hazards only (the ones that move markets). */
export function summarizeDisasters(disasters = []) {
  const TYPE = { FL: "flood", DR: "drought", TC: "cyclone", WF: "wildfire" };
  return disasters
    .filter((d) => (d[3] ?? 0) >= 1) // alert >= orange
    .sort((a, b) => b[3] - a[3])
    .slice(0, 10)
    .map(([, , type, alert, name, country]) => ({ type: TYPE[type] || type, alert: ["green", "orange", "red"][alert], name, country }));
}

/** Combine raw snapshots into one brief object. */
export function buildBrief(raw, now = Date.now()) {
  return {
    at: now,
    headlines: summarizeNews(raw.news),
    conflicts: summarizeConflicts(raw.conflicts || []),
    disasters: summarizeDisasters(raw.disasters || []),
    chokepoints: chokepointCongestion(raw.world?.ships || []),
  };
}

/** What changed vs the previous brief — new headlines, new red/orange hazards,
 *  escalating conflicts, and notable chokepoint congestion shifts. */
export function diffBrief(prev, cur) {
  const deltas = [];
  const prevTitles = new Set((prev?.headlines || []).map((h) => h.title));
  for (const h of cur.headlines) if (!prevTitles.has(h.title)) deltas.push({ kind: "news", text: `${h.title} (${h.source})` });
  const prevHaz = new Set((prev?.disasters || []).map((d) => d.name));
  for (const d of cur.disasters) if (!prevHaz.has(d.name)) deltas.push({ kind: "hazard", text: `${d.alert} ${d.type} — ${d.country}: ${d.name}` });
  const prevC = new Map((prev?.conflicts || []).map((c) => [c.country, c.deaths]));
  for (const c of cur.conflicts) {
    const before = prevC.get(c.country) || 0;
    if (c.deaths > before) deltas.push({ kind: "conflict", text: `${c.country} conflict fatalities up (+${c.deaths - before})` });
  }
  for (const [id, cp] of Object.entries(cur.chokepoints)) {
    const b = prev?.chokepoints?.[id];
    if (b && cp.ships >= 8 && cp.ships - b.ships >= 5) deltas.push({ kind: "chokepoint", text: `${cp.label}: vessels ${b.ships}→${cp.ships}` });
  }
  return deltas.slice(0, 20);
}

/** Compact text the LLM reads. Signal, not volume. */
export function renderBrief(brief) {
  const L = [];
  if (brief.deltas?.length) L.push("CHANGED SINCE LAST CHECK:\n" + brief.deltas.map((d) => `- [${d.kind}] ${d.text}`).join("\n"));
  L.push("TOP HEADLINES:\n" + brief.headlines.slice(0, 8).map((h) => `- ${h.title} (${h.source})`).join("\n"));
  if (brief.conflicts.length) L.push("CONFLICT (fatalities, ~6mo):\n" + brief.conflicts.slice(0, 5).map((c) => `- ${c.country}: ${c.deaths}`).join("\n"));
  if (brief.disasters.length) L.push("ACTIVE HAZARDS:\n" + brief.disasters.slice(0, 6).map((d) => `- ${d.alert} ${d.type} — ${d.country}`).join("\n"));
  const cp = Object.values(brief.chokepoints).filter((c) => c.ships > 0);
  if (cp.length) L.push("CHOKEPOINTS (vessels · anchored):\n" + cp.map((c) => `- ${c.label}: ${c.ships} · ${c.anchored}`).join("\n"));
  return L.join("\n\n");
}
