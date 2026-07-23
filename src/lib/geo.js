// geo.js — country geometry for the world map: TopoJSON decoding (world-atlas
// countries), Mercator projection into the unit square, per-country hit
// testing, and the name bridge to the LSE bond-yield country codes.

import { mercX, mercY } from "@/lib/ais";

/** Decode a world-atlas countries topology → [{ id, name, polys }] in lon/lat. */
export function decodeCountries(topo) {
  const { scale, translate } = topo.transform;
  const arcs = topo.arcs.map((arc) => {
    let x = 0, y = 0;
    return arc.map(([dx, dy]) => {
      x += dx; y += dy;
      return [x * scale[0] + translate[0], y * scale[1] + translate[1]];
    });
  });
  const ring = (arcIdxs) => {
    const pts = [];
    for (const i of arcIdxs) {
      const a = i >= 0 ? arcs[i] : [...arcs[~i]].reverse();
      for (let k = pts.length ? 1 : 0; k < a.length; k++) pts.push(a[k]);
    }
    return pts;
  };
  const out = [];
  for (const g of topo.objects.countries.geometries) {
    const polys = [];
    if (g.type === "Polygon") polys.push(g.arcs.map(ring));
    else if (g.type === "MultiPolygon") for (const p of g.arcs) polys.push(p.map(ring));
    if (polys.length) out.push({ id: g.id, name: g.properties?.name || "?", polys });
  }
  return out;
}

/**
 * Project decoded countries to unit-square rings and precompute bounding
 * boxes (per polygon) so hover hit-testing stays cheap at pointer speed.
 */
export function projectCountries(countries) {
  return countries.map((c) => {
    const polys = c.polys.map((poly) => poly.map((r) => r.map(([lon, lat]) => [mercX(lon), mercY(lat)])));
    const boxes = polys.map((poly) => {
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      for (const [u, v] of poly[0]) { // outer ring bounds suffice
        if (u < x1) x1 = u; if (u > x2) x2 = u;
        if (v < y1) y1 = v; if (v > y2) y2 = v;
      }
      return [x1, y1, x2, y2];
    });
    return { id: c.id, name: c.name, polys, boxes };
  });
}

const inRing = (ring, u, v) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > v) !== (yj > v) && u < ((xj - xi) * (v - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

/** Which country contains unit-square point (u, v)? null when ocean. */
export function countryAt(projected, u, v) {
  for (const c of projected) {
    for (let p = 0; p < c.polys.length; p++) {
      const [x1, y1, x2, y2] = c.boxes[p];
      if (u < x1 || u > x2 || v < y1 || v > y2) continue;
      const poly = c.polys[p];
      if (!inRing(poly[0], u, v)) continue;
      // Holes (ring 1+) subtract — e.g. Lesotho inside South Africa.
      let inHole = false;
      for (let r = 1; r < poly.length; r++) if (inRing(poly[r], u, v)) { inHole = true; break; }
      if (!inHole) return c;
    }
  }
  return null;
}

/** Inverse Mercator: unit-square → lat/lon (for viewport → AIS bbox). */
export const invMercLon = (u) => u * 360 - 180;
export const invMercLat = (v) => (Math.asin(Math.tanh(2 * Math.PI * (0.5 - v))) * 180) / Math.PI;

// Bridge world-atlas country names → LSE bond-yield ISO2 codes (34 covered
// countries; matched by normalized name with the few mismatched aliases).
const norm = (s) => s.toLowerCase().replace(/[^a-z ]/g, "").trim();
const NAME_ALIASES = {
  "united states of america": "united states",
  czechia: "czech republic",
  "bosnia and herz": "bosnia and herzegovina",
  "dominican rep": "dominican republic",
  "s korea": "south korea",
  "korea south": "south korea",
};

/** Build { normalizedTopoName → ISO2 } from the LSE yield stats country list. */
export function yieldCodeLookup(statsCountries) {
  const byName = new Map(statsCountries.map((c) => [norm(c.name), c.code]));
  return (topoName) => {
    const n = norm(topoName);
    return byName.get(n) ?? byName.get(NAME_ALIASES[n] || "") ?? null;
  };
}
