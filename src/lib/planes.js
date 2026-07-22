// planes.js — live aircraft via the community ADS-B network (adsb.lol, no
// key) + route lookups from adsbdb.com, both through our CORS/cache proxy
// (/api/adsb/*). Nothing here needs auth — the data is community-open.

const PROXY = "/api/adsb";

// Region presets: point queries are capped at 250 nm radius, so "world" is
// not possible — these are the busiest hubs/corridors instead.
export const REGIONS = [
  { id: "zurich", label: "Zürich", lat: 47.46, lon: 8.55, radius: 250 },
  { id: "frankfurt", label: "Frankfurt", lat: 50.03, lon: 8.57, radius: 250 },
  { id: "london", label: "London", lat: 51.47, lon: -0.45, radius: 250 },
  { id: "newyork", label: "New York", lat: 40.64, lon: -73.78, radius: 250 },
  { id: "atlanta", label: "Atlanta", lat: 33.64, lon: -84.43, radius: 250 },
  { id: "la", label: "Los Angeles", lat: 33.94, lon: -118.41, radius: 250 },
  { id: "dubai", label: "Dubai", lat: 25.25, lon: 55.36, radius: 250 },
  { id: "singapore", label: "Singapur", lat: 1.36, lon: 103.99, radius: 250 },
  { id: "tokyo", label: "Tokio", lat: 35.55, lon: 139.78, radius: 250 },
];

// Cargo carriers by ICAO callsign prefix — the honest way to tag freighters
// from ADS-B (the transponder itself doesn't say "cargo").
const CARGO_PREFIX = new Set([
  "FDX", "UPS", "GTI", "CLX", "GEC", "ABW", "CKS", "BOX", "CAO", "SQC",
  "AZG", "ICL", "MPH", "BCS", "CMB", "NCA", "PAC", "ADB", "KYE", "MSX",
  "DHK", "BDA", "CTJ", "RCF", "TAY", "QAC", "LCO", "MRT",
]);

/**
 * Category from callsign + ADS-B emitter category:
 * cargo (known freight carriers) · passenger (large/heavy airline traffic) ·
 * light (GA/small/rotor) · other (military, unknown, no category).
 */
export function planeCategory(callsign, category) {
  const prefix = String(callsign || "").trim().slice(0, 3).toUpperCase();
  if (CARGO_PREFIX.has(prefix)) return "cargo";
  if (["A3", "A4", "A5"].includes(category)) return "passenger";
  if (["A1", "A2", "A7", "B1"].includes(category)) return "light";
  return "other";
}

/** One poll of live aircraft around a region. Normalized + classified. */
export async function fetchPlanes(region) {
  const res = await fetch(`${PROXY}/point/${region.lat}/${region.lon}/${region.radius}`);
  if (!res.ok) throw new Error(`ADS-B request failed (${res.status})`);
  const j = await res.json();
  const out = [];
  for (const a of j.ac || []) {
    if (a.lat == null || a.lon == null) continue;
    const callsign = String(a.flight || "").trim();
    out.push({
      hex: a.hex,
      callsign: callsign || a.r || a.hex,
      reg: a.r || "",
      type: a.t || "",
      lat: a.lat, lon: a.lon,
      alt: a.alt_baro === "ground" ? 0 : (Number(a.alt_baro) || 0),
      onGround: a.alt_baro === "ground",
      gs: Number(a.gs) || 0,
      track: Number(a.track ?? a.true_heading) || 0,
      vr: Number(a.baro_rate) || 0,
      category: planeCategory(callsign, a.category),
      t: Date.now(),
    });
  }
  return out;
}

// Route lookups are cached per callsign for the session (adsbdb is a static
// community DB — no reason to ask twice).
const routeCache = new Map();

/**
 * Origin/destination for a callsign via adsbdb. Returns
 * { airline, from, to, fromCity, toCity } or null when the DB doesn't know
 * (general aviation, military, fresh routes).
 */
export async function fetchRoute(callsign) {
  const cs = String(callsign || "").trim().toUpperCase();
  if (!cs) return null;
  if (routeCache.has(cs)) return routeCache.get(cs);
  let out = null;
  try {
    const res = await fetch(`${PROXY}/route/${encodeURIComponent(cs)}`);
    if (res.ok) {
      const j = await res.json();
      const fr = j?.response?.flightroute;
      if (fr?.origin?.iata_code && fr?.destination?.iata_code) {
        out = {
          airline: fr.airline?.name || "",
          from: fr.origin.iata_code, fromCity: fr.origin.municipality || "",
          to: fr.destination.iata_code, toCity: fr.destination.municipality || "",
        };
      }
    }
  } catch { /* route unknown — fine */ }
  routeCache.set(cs, out);
  return out;
}
