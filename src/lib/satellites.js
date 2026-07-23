// satellites.js — turn CelesTrak TLEs into live sub-satellite points via SGP4.
// The fleet agent pushes curated TLEs to /api/satellites (they age over days);
// the browser propagates each to the current instant with satellite.js.
import {
  twoline2satrec, propagate, gstime, eciToGeodetic, degreesLong, degreesLat,
} from "satellite.js";

// CelesTrak group -> [viz color key, display label]
export const SAT_GROUPS = {
  stations: ["accent", "Space station"],
  "gps-ops": ["blue", "GPS"],
  galileo: ["blue", "Galileo"],
  "glo-ops": ["blue", "GLONASS"],
  beidou: ["blue", "BeiDou"],
  geo: ["amber", "Geostationary"],
  weather: ["teal", "Weather"],
  science: ["purple", "Science"],
  starlink: ["dim", "Starlink"],
};

/** Load and parse the TLE snapshot into satrecs. Returns [] if none yet. */
export async function fetchSatellites() {
  const r = await fetch("/api/satellites");
  if (!r.ok) return [];
  const j = await r.json();
  const out = [];
  for (const [name, group, l1, l2] of j.satellites || []) {
    try {
      const satrec = twoline2satrec(l1, l2);
      if (satrec.error === 0) out.push({ name, group, satrec });
    } catch { /* skip malformed */ }
  }
  return out;
}

/**
 * Propagate every satellite to `date` and return its sub-point.
 * @returns [{ name, group, lon, lat, alt }]  (alt in km; skips decayed sats)
 */
export function propagateAll(sats, date = new Date()) {
  const gmst = gstime(date);
  const out = [];
  for (const s of sats) {
    let pv;
    try { pv = propagate(s.satrec, date); } catch { continue; }
    const p = pv && pv.position;
    if (!p || Number.isNaN(p.x)) continue;
    const geo = eciToGeodetic(p, gmst);
    const lon = degreesLong(geo.longitude), lat = degreesLat(geo.latitude);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    out.push({ name: s.name, group: s.group, lon, lat, alt: Math.round(geo.height) });
  }
  return out;
}
