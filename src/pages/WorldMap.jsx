import { useEffect, useMemo, useRef, useState } from "react";
import { Layers, X, Ship, Plane, Activity, Anchor, Landmark, Radio, Cable, TrendingDown, Newspaper, Flame, AlertTriangle, Swords, CloudRain, Zap, Satellite, Building2, Pickaxe, Waypoints, Factory, ChevronDown } from "lucide-react";
import { cn, fmtNum, fmtPct } from "@/lib/utils";
import { shipCategory, formatEta, CORRIDORS } from "@/lib/ais";
import { fetchRoute, planeCategory } from "@/lib/planes";
import { fetchNewsPins, COUNTRY_PINS } from "@/lib/geoNews";
import { fetchSatellites, propagateAll, SAT_GROUPS } from "@/lib/satellites";
import { decodeCountries, projectCountries, countryAt, invMercLon, invMercLat, yieldCodeLookup } from "@/lib/geo";
import { mercX, mercY } from "@/lib/ais";
import { fetchYieldStats, fetchYields, yieldCurves } from "@/lib/macro";
import { vizColor } from "@/lib/vizColors";

// The unified world map (worldmonitor.app-inspired, own implementation):
// ONE map, layer toggles instead of separate tabs. Countries with real
// borders — 110m resolution paints instantly, the detailed 50m borders swap
// in silently once loaded — hover highlights the exact outline, click opens
// a side panel (with our LSE bond-yield data where the country is covered).
// Ships stream from the AIS relay scoped to the current viewport; planes
// poll the community ADS-B network around the map centre; earthquakes come
// straight from USGS.

const STALE_MS = 10 * 60_000;
const MAX_VESSELS = 6000;

// Canvas can't resolve CSS var() strings — resolve through vizColor() at
// draw time (theme-aware). Keys are viz token names.
const SHIP_VIZ = { cargo: "amber", tanker: "pink", passenger: "purple", fishing: "teal" };
const PLANE_VIZ = { passenger: "blue", cargo: "amber", light: "teal", other: "pink" };
const bucketOf = (v) => {
  const c = shipCategory(v.type);
  return c === "unknown" ? "other" : c;
};

const CHOKEPOINTS = CORRIDORS.filter((c) => c.id !== "world").map((c) => ({
  ...c,
  lat: (c.bbox[0][0] + c.bbox[1][0]) / 2,
  lon: (c.bbox[0][1] + c.bbox[1][1]) / 2,
}));

const LAYER_DEFS = [
  { id: "ships", label: "Ship traffic", icon: Ship },
  { id: "planes", label: "Air traffic", icon: Plane },
  { id: "satellites", label: "Satellites (live)", icon: Satellite },
  { id: "quakes", label: "Earthquakes (24h)", icon: Activity },
  { id: "chokepoints", label: "Chokepoints + transits", icon: Anchor },
  { id: "cables", label: "Submarine cables", icon: Cable },
  { id: "yields", label: "Yield-curve stress", icon: TrendingDown },
  { id: "news", label: "News pins", icon: Newspaper },
  { id: "fires", label: "Fires (24h)", icon: Flame },
  { id: "conflicts", label: "Conflict events", icon: Swords },
  { id: "disasters", label: "Disasters (GDACS)", icon: CloudRain },
  { id: "power", label: "Power infrastructure", icon: Zap },
  { id: "pipelines", label: "Oil/NGL pipelines", icon: Waypoints },
  { id: "mines", label: "Mines (producing)", icon: Pickaxe },
  { id: "rigs", label: "Offshore platforms", icon: Factory },
  { id: "jamming", label: "GPS interference", icon: Satellite },
  { id: "projects", label: "World Bank projects", icon: Building2 },
  { id: "instab", label: "Instability signals", icon: AlertTriangle },
];

const LS_LAYERS = "quant_map_layers_v3"; // v3: cables + yield stress
const LAYER_DEFAULTS = { ships: true, planes: true, satellites: false, quakes: true, chokepoints: true, cables: true, yields: true, news: true, fires: true, conflicts: true, disasters: true, power: false, pipelines: false, mines: false, rigs: false, jamming: false, projects: false, instab: true };

const RIG_TYPES = { o: ["pink", "Oil"], g: ["amber", "Gas"], p: ["blue", "Platform"] };

// Mine commodity code -> [viz color, label]
const MINE_TYPES = {
  a: ["amber", "Gold"], s: ["dim", "Silver"], c: ["pink", "Copper"], i: ["down", "Iron"],
  k: ["dim", "Coal"], z: ["purple", "Zinc"], l: ["purple", "Lead"], u: ["up", "Uranium"],
  n: ["teal", "Nickel"], t: ["blue", "Tin"], m: ["pink", "Manganese"], w: ["blue", "Tungsten"],
  y: ["teal", "Molybdenum"], o: ["purple", "Cobalt"], p: ["dim", "Platinum"], r: ["pink", "Chromium"],
  b: ["blue", "Bauxite"], g: ["dim", "Sand/Stone"], e: ["purple", "Gemstone"], x: ["up", "Rare earth/Li"],
  h: ["amber", "Phosphate/S"], d: ["dim", "Other"],
};
const PIPE_TYPES = { o: ["pink", "Oil"], n: ["amber", "NGL"] };

// GDACS hazard type -> [viz color, label, single-char glyph]
const DISASTER_TYPES = {
  FL: ["blue", "Flood", "≈"], DR: ["amber", "Drought", "☀"],
  TC: ["purple", "Cyclone", "◍"], WF: ["down", "Wildfire", "▲"],
};
// Power-plant fuel code -> [viz color, label]
const FUEL_TYPES = {
  c: ["down", "Coal"], g: ["amber", "Gas"], o: ["pink", "Oil"], n: ["purple", "Nuclear"],
  h: ["blue", "Hydro"], w: ["teal", "Wind"], s: ["amber", "Solar"], b: ["up", "Biomass"],
  t: ["pink", "Geothermal"], x: ["dim", "Waste"], d: ["teal", "Tidal"], e: ["dim", "Storage"], z: ["dim", "Other"],
};

// Sub-category filters (ships/planes) — "only cargo", "only tankers", etc.
const LS_FILTERS = "quant_map_filters_v1";
const SHIP_CATS = ["cargo", "tanker", "passenger", "fishing", "other"];
const PLANE_CATS = ["passenger", "cargo", "light", "other"];
const FILTER_DEFAULTS = {
  ship: Object.fromEntries(SHIP_CATS.map((c) => [c, true])),
  plane: Object.fromEntries(PLANE_CATS.map((c) => [c, true])),
};
const loadFilters = () => {
  try {
    const v = JSON.parse(localStorage.getItem(LS_FILTERS) || "null");
    if (v && typeof v === "object") return {
      ship: { ...FILTER_DEFAULTS.ship, ...(v.ship || {}) },
      plane: { ...FILTER_DEFAULTS.plane, ...(v.plane || {}) },
    };
  } catch { /* fall through */ }
  return { ship: { ...FILTER_DEFAULTS.ship }, plane: { ...FILTER_DEFAULTS.plane } };
};
// UCDP type_of_violence → viz color key + label
const CONFLICT_TYPES = { 1: ["down", "state-based"], 2: ["amber", "non-state"], 3: ["purple", "one-sided"] };
const loadLayers = () => {
  try {
    const v = JSON.parse(localStorage.getItem(LS_LAYERS) || "null");
    if (v && typeof v === "object") return { ...LAYER_DEFAULTS, ...v };
  } catch { /* fall through */ }
  return { ...LAYER_DEFAULTS };
};

const cssRgb = (name) => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v ? `rgb(${v.replaceAll(" ", ",")})` : "#888";
};

export default function WorldMap() {
  const [layers, setLayers] = useState(loadLayers);
  // Layer panel folds away on small screens so it doesn't cover the map.
  const [panelOpen, setPanelOpen] = useState(() =>
    typeof window === "undefined" ? true : !window.matchMedia("(max-width: 640px)").matches);
  const [shipStatus, setShipStatus] = useState("off");
  const [planeStatus, setPlaneStatus] = useState("off");
  const [hover, setHover] = useState(null);       // { x, y, label, sub }
  const [hoverCountry, setHoverCountry] = useState(null); // name (for redraw)
  const [selected, setSelected] = useState(null); // { kind, ...data }
  const [counts, setCounts] = useState({ ships: 0, planes: 0, quakes: 0, fires: 0 });
  const [instabTop, setInstabTop] = useState([]);
  const [filters, setFilters] = useState(loadFilters);

  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const viewRef = useRef({ cx: 0.5, cy: 0.42, scale: 0 }); // scale 0 → fit on first draw
  const needsDraw = useRef(true);
  const countriesRef = useRef([]);      // projected features (110m, then 50m)
  const hoverCountryRef = useRef(null); // id, for the draw loop
  const selectedRef = useRef(null);
  const vesselsRef = useRef(new Map());
  const planesRef = useRef([]);
  const quakesRef = useRef([]);
  const cablesRef = useRef(null);       // projected cable polylines (lazy)
  const spreadsRef = useRef(new Map()); // ISO2 -> 10Y-2Y spread (pp)
  const newsRef = useRef([]);           // geolocated news pins
  const firesRef = useRef([]);          // FIRMS detections {lat,lon,frp,u,v}
  const conflictsRef = useRef([]);      // UCDP events {lat,lon,best,type,date,country,a,b,u,v}
  const disastersRef = useRef([]);      // GDACS {lat,lon,type,alert,name,country,date,severity,u,v}
  const powerRef = useRef([]);          // power plants {lat,lon,fuel,mw,u,v}
  const pipesRef = useRef(null);        // projected pipeline polylines (lazy)
  const minesRef = useRef([]);          // producing mines {lat,lon,commod,name,u,v}
  const rigsRef = useRef([]);           // offshore platforms {lat,lon,k,name,u,v}
  const satsRef = useRef([]);           // parsed satrecs {name,group,satrec}
  const satPosRef = useRef([]);         // current sub-points {name,group,lon,lat,alt}
  const jammingRef = useRef([]);        // GPS-interference cells {lat,lon,frac,total,u,v}
  const projectsRef = useRef([]);       // WB per-country {country,count,usd,names,u,v}
  const centroidRef = useRef(new Map()); // country-name(lower) -> {u,v} for project pins
  const instabRef = useRef({ byId: new Map(), top: [] });
  const countryBoxesRef = useRef([]);   // per-polygon bounding boxes, small-first
  const pinNameCacheRef = useRef(new Map()); // country name -> COUNTRY_PINS entry
  const chokeStatsRef = useRef(new Map()); // chokepoint id -> {n, anchored}
  const layersRef = useRef(layers);
  layersRef.current = layers;
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  selectedRef.current = selected;

  const toggleLayer = (id) => {
    setLayers((l) => {
      const next = { ...l, [id]: !l[id] };
      try { localStorage.setItem(LS_LAYERS, JSON.stringify(next)); } catch { /* quota */ }
      return next;
    });
  };
  // Solo mode: show ONLY this layer; "all on" restores everything.
  const soloLayer = (id) => {
    const next = Object.fromEntries(LAYER_DEFS.map((d) => [d.id, d.id === id]));
    setLayers(next);
    try { localStorage.setItem(LS_LAYERS, JSON.stringify(next)); } catch { /* quota */ }
  };
  const allLayers = () => {
    setLayers({ ...LAYER_DEFAULTS });
    try { localStorage.setItem(LS_LAYERS, JSON.stringify(LAYER_DEFAULTS)); } catch { /* quota */ }
  };
  const toggleCat = (kind, cat) => {
    setFilters((f) => {
      const next = { ...f, [kind]: { ...f[kind], [cat]: !f[kind][cat] } };
      try { localStorage.setItem(LS_FILTERS, JSON.stringify(next)); } catch { /* quota */ }
      needsDraw.current = true;
      return next;
    });
  };

  /* ── Country geometry: fast 110m first, exact 50m swapped in silently ── */
  // Per-POLYGON bounding boxes (not per country — a per-country box for the
  // US or Russia would span the dateline and swallow the world). Sorted
  // smallest-area-first so point→country hits resolve to the tightest match.
  const buildBoxes = () => {
    const out = [];
    for (const c of countriesRef.current) {
      const boxes = [];
      let area = 0;
      for (const poly of c.polys) {
        const ring = poly[0] || [];
        let u1 = 9, v1 = 9, u2 = -9, v2 = -9;
        for (const [u, v] of ring) {
          if (u < u1) u1 = u; if (v < v1) v1 = v;
          if (u > u2) u2 = u; if (v > v2) v2 = v;
        }
        if (u2 > -9) { boxes.push([u1, v1, u2, v2]); area += (u2 - u1) * (v2 - v1); }
      }
      out.push({ id: c.id, name: c.name, boxes, area });
      // Centroid = center of the country's largest polygon box (for project pins).
      let big = null, bigA = -1;
      for (const b of boxes) { const a = (b[2] - b[0]) * (b[3] - b[1]); if (a > bigA) { bigA = a; big = b; } }
      if (big) centroidRef.current.set(c.name.toLowerCase(), { u: (big[0] + big[2]) / 2, v: (big[1] + big[3]) / 2 });
    }
    out.sort((a, b) => a.area - b.area);
    countryBoxesRef.current = out;
  };
  useEffect(() => {
    let alive = true;
    fetch("/world-countries-110m.json").then((r) => r.json()).then((topo) => {
      if (!alive) return;
      countriesRef.current = projectCountries(decodeCountries(topo));
      buildBoxes();
      needsDraw.current = true;
      // Detail upgrade in the background — exact borders, no coarse fallback.
      fetch("/world-countries-50m.json").then((r) => r.json()).then((topo50) => {
        if (!alive) return;
        countriesRef.current = projectCountries(decodeCountries(topo50));
        buildBoxes();
        needsDraw.current = true;
      }).catch(() => { /* stay on 110m */ });
    }).catch(() => { /* map renders data layers only */ });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── Yield lookup for the country panel (LSE covers 34 countries) ────── */
  const yieldLookupRef = useRef(null);
  const yieldCacheRef = useRef(new Map());
  useEffect(() => {
    fetchYieldStats()
      .then((s) => { yieldLookupRef.current = yieldCodeLookup(s.countries); })
      .catch(() => { /* panel simply shows no yield data */ });
  }, []);

  /* ── Submarine cables: vendored TeleGeography lines, loaded on demand ── */
  useEffect(() => {
    if (!layers.cables || cablesRef.current) { needsDraw.current = true; return; }
    let alive = true;
    fetch("/cables.json").then((r) => r.json()).then((cables) => {
      if (!alive) return;
      cablesRef.current = cables.map((c) => ({
        n: c.n,
        p: c.p.map((line) => line.map(([lon, lat]) => [mercX(lon), mercY(lat)])),
      }));
      needsDraw.current = true;
    }).catch(() => { /* layer stays empty */ });
    return () => { alive = false; };
  }, [layers.cables]);

  /* ── Yield-curve stress: 10Y−2Y per covered country (OUR LSE data) ───── */
  useEffect(() => {
    if (!layers.yields || spreadsRef.current.size) { needsDraw.current = true; return; }
    let alive = true;
    (async () => {
      try {
        const stats = await fetchYieldStats();
        const since = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10);
        const results = await Promise.allSettled(stats.countries.map(async (c) => {
          const rows = await fetchYields(c.code, since);
          const { latest } = yieldCurves(rows);
          const p10 = latest?.points.find((p) => p.tenor === "10Y");
          const p2 = latest?.points.find((p) => p.tenor === "2Y");
          return p10 && p2 ? { code: c.code, spread: p10.close - p2.close } : null;
        }));
        if (!alive) return;
        for (const r of results) {
          if (r.status === "fulfilled" && r.value) spreadsRef.current.set(r.value.code, r.value.spread);
        }
        needsDraw.current = true;
      } catch { /* choropleth simply stays neutral */ }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layers.yields]);

  /* ── Viewport helpers ────────────────────────────────────────────────── */
  const viewportBbox = () => {
    const el = wrapRef.current;
    const { cx, cy, scale } = viewRef.current;
    const w = el?.clientWidth || 800, h = el?.clientHeight || 560;
    const u1 = cx - w / 2 / scale, u2 = cx + w / 2 / scale;
    const v1 = cy - h / 2 / scale, v2 = cy + h / 2 / scale;
    return [
      [Math.max(-85, invMercLat(Math.min(1, v2))), Math.max(-180, invMercLon(Math.max(0, u1)))],
      [Math.min(85, invMercLat(Math.max(0, v1))), Math.min(180, invMercLon(Math.min(1, u2)))],
    ];
  };
  const viewportCenter = () => {
    const { cx, cy } = viewRef.current;
    return { lat: invMercLat(cy), lon: invMercLon(((cx % 1) + 1) % 1) };
  };

  // Google-Maps geometry: the map wraps forever left/right (cx normalized to
  // [0,1), the world redraws per visible copy), can't scroll past the poles
  // (cy clamped), and can't zoom out past "world fills the viewport width".
  const clampView = () => {
    const el = wrapRef.current;
    if (!el) return;
    const w = el.clientWidth || 800, h = el.clientHeight || 560;
    const v = viewRef.current;
    const vTop = 0.02, vBot = 0.98;
    // Min zoom shows the FULL map band — both poles on screen at once; the
    // horizontal wrap fills whatever width is left (Google-Maps behaviour).
    v.scale = Math.max(h / (vBot - vTop), Math.min(600_000, v.scale || w));
    v.cx = ((v.cx % 1) + 1) % 1;
    const halfV = h / (2 * v.scale);
    if (vBot - vTop <= 2 * halfV) v.cy = (vTop + vBot) / 2;
    else v.cy = Math.max(vTop + halfV, Math.min(vBot - halfV, v.cy));
  };

  /* ── Ships layer: FLEET SNAPSHOT (worldmonitor pattern) ───────────────
     aisstream ignores Cloudflare egress, so a server relay can't work.
     Instead the 24/7 PC agent (scripts/ais-agent.mjs) holds the aisstream
     connection and pushes a world snapshot to /api/ships every ~45s — the
     map paints the ENTIRE fleet on load instead of filling a stream from
     zero, and every visitor shares one cached read. */
  useEffect(() => {
    if (!layers.ships) { vesselsRef.current.clear(); setShipStatus("off"); needsDraw.current = true; return; }
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/world");
        if (r.status === 404) { if (alive) setShipStatus("fleet agent warming up…"); return; }
        if (!r.ok) throw new Error(`snapshot HTTP ${r.status}`);
        const j = await r.json();
        if (!alive) return;
        const store = vesselsRef.current;
        store.clear();
        for (const row of j.ships || []) {
          const [mmsi, lat, lon, sog, cog, type, name, dest] = row;
          store.set(mmsi, {
            mmsi, lat, lon, sog, cog,
            type: type || null,
            name: name || `MMSI ${mmsi}`, staticName: name || "",
            destination: dest || "", t: j.at,
          });
        }
        const age = Math.max(0, Math.round((Date.now() - j.at) / 1000));
        setShipStatus(age > 300 ? `stale snapshot (${Math.round(age / 60)}min) — agent down?` : "live");
        needsDraw.current = true;
      } catch (e) { if (alive) setShipStatus(String(e.message || e).slice(0, 60)); }
    };
    load();
    const id = setInterval(() => { if (!document.hidden) load(); }, 45000);
    return () => { alive = false; clearInterval(id); };
  }, [layers.ships]);


  /* ── Planes layer: GLOBAL SNAPSHOT (same fleet agent as ships) ───────
     The PC agent sweeps ~26 dense flight regions from a home IP (no
     Cloudflare-egress rate limits) and pushes one merged snapshot every
     ~90s — global air traffic paints instantly, no per-viewport polling. */
  useEffect(() => {
    if (!layers.planes) { planesRef.current = []; setPlaneStatus("off"); needsDraw.current = true; return; }
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/world");
        if (r.status === 404) { if (alive) setPlaneStatus("plane sweep warming up…"); return; }
        if (!r.ok) throw new Error(`snapshot HTTP ${r.status}`);
        const j = await r.json();
        if (!alive) return;
        planesRef.current = (j.planes || []).map((row) => {
          const [hex, lat, lon, alt, gs, track, category, callsign, type] = row;
          return {
            hex, lat, lon,
            alt: alt < 0 ? 0 : alt, onGround: alt < 0,
            gs, track, reg: "", type: type || "",
            callsign: callsign || hex,
            category: planeCategory(callsign, category),
            t: j.at,
          };
        });
        const age = Math.max(0, Math.round((Date.now() - j.at) / 1000));
        setPlaneStatus(age > 300 ? `stale (${Math.round(age / 60)}min) — agent down?` : "live");
        needsDraw.current = true;
      } catch (e) { if (alive) setPlaneStatus(String(e.message || e).slice(0, 60)); }
    };
    load();
    const id = setInterval(() => { if (!document.hidden) load(); }, 30000);
    return () => { alive = false; clearInterval(id); };
  }, [layers.planes]);

  /* ── News pins: headlines from our feed, pinned by country ──────────── */
  useEffect(() => {
    if (!layers.news) { newsRef.current = []; needsDraw.current = true; return; }
    let alive = true;
    const load = async () => {
      try {
        const pins = await fetchNewsPins();
        if (!alive) return;
        newsRef.current = pins;
        needsDraw.current = true;
      } catch { /* pins simply stay absent */ }
    };
    load();
    const id = setInterval(load, 5 * 60_000);
    return () => { alive = false; clearInterval(id); };
  }, [layers.news]);

  /* ── Fires (NASA FIRMS 24h): global snapshot via the fleet agent ─────── */
  useEffect(() => {
    if (!layers.fires) { firesRef.current = []; needsDraw.current = true; return; }
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/fires");
        if (!r.ok) return; // 404 until the agent's first FIRMS sweep
        const j = await r.json();
        if (!alive) return;
        firesRef.current = (j.fires || []).map(([lat, lon, frp]) => ({ lat, lon, frp, u: mercX(lon), v: mercY(lat) }));
        needsDraw.current = true;
      } catch { /* keep last data */ }
    };
    load();
    const id = setInterval(load, 10 * 60_000);
    return () => { alive = false; clearInterval(id); };
  }, [layers.fires]);

  /* ── Conflicts (UCDP candidate, ~6 months): snapshot via fleet agent ─── */
  useEffect(() => {
    if (!layers.conflicts) { conflictsRef.current = []; needsDraw.current = true; return; }
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/conflicts");
        if (!r.ok) return; // 404 until the agent's first UCDP sweep
        const j = await r.json();
        if (!alive) return;
        conflictsRef.current = (j.conflicts || []).map(([lat, lon, best, type, date, country, a, b]) => ({
          lat, lon, best, type, date, country, a, b, u: mercX(lon), v: mercY(lat),
        }));
        needsDraw.current = true;
      } catch { /* keep last data */ }
    };
    load();
    const id = setInterval(load, 30 * 60_000);
    return () => { alive = false; clearInterval(id); };
  }, [layers.conflicts]);

  /* ── Disasters (GDACS floods/droughts/cyclones/wildfires) ────────────── */
  useEffect(() => {
    if (!layers.disasters) { disastersRef.current = []; needsDraw.current = true; return; }
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/disasters");
        if (!r.ok) return;
        const j = await r.json();
        if (!alive) return;
        disastersRef.current = (j.disasters || []).map(([lat, lon, type, alert, name, country, date, severity]) =>
          ({ lat, lon, type, alert, name, country, date, severity, u: mercX(lon), v: mercY(lat) }));
        needsDraw.current = true;
      } catch { /* keep last */ }
    };
    load();
    const id = setInterval(load, 15 * 60_000);
    return () => { alive = false; clearInterval(id); };
  }, [layers.disasters]);

  /* ── Power infrastructure (vendored WRI plants >= 50 MW) ─────────────── */
  useEffect(() => {
    if (!layers.power || powerRef.current.length) { needsDraw.current = true; return; }
    let alive = true;
    fetch("/powerplants.json").then((r) => r.json()).then((rows) => {
      if (!alive) return;
      powerRef.current = rows.map(([lat, lon, fuel, mw]) => ({ lat, lon, fuel, mw, u: mercX(lon), v: mercY(lat) }));
      needsDraw.current = true;
    }).catch(() => { /* layer stays empty */ });
    return () => { alive = false; };
  }, [layers.power]);

  /* ── Pipelines (vendored GEM oil/NGL routes) ─────────────────────────── */
  useEffect(() => {
    if (!layers.pipelines || pipesRef.current) { needsDraw.current = true; return; }
    let alive = true;
    fetch("/pipelines.json").then((r) => r.json()).then((rows) => {
      if (!alive) return;
      pipesRef.current = rows.map((c) => ({
        n: c.n, k: c.k,
        p: c.p.map((line) => line.map(([lon, lat]) => [mercX(lon), mercY(lat)])),
      }));
      needsDraw.current = true;
    }).catch(() => { /* layer stays empty */ });
    return () => { alive = false; };
  }, [layers.pipelines]);

  /* ── Mines (vendored USGS MRDS producers) ────────────────────────────── */
  useEffect(() => {
    if (!layers.mines || minesRef.current.length) { needsDraw.current = true; return; }
    let alive = true;
    fetch("/mines.json").then((r) => r.json()).then((rows) => {
      if (!alive) return;
      minesRef.current = rows.map(([lat, lon, commod, name]) => ({ lat, lon, commod, name, u: mercX(lon), v: mercY(lat) }));
      needsDraw.current = true;
    }).catch(() => { /* layer stays empty */ });
    return () => { alive = false; };
  }, [layers.mines]);

  /* ── Satellites (live SGP4 from CelesTrak TLEs) ──────────────────────── */
  useEffect(() => {
    if (!layers.satellites) { satsRef.current = []; satPosRef.current = []; needsDraw.current = true; return; }
    let alive = true, timer = null;
    const tick = () => {
      if (!satsRef.current.length) return;
      satPosRef.current = propagateAll(satsRef.current, new Date());
      needsDraw.current = true;
    };
    fetchSatellites().then((sats) => {
      if (!alive) return;
      satsRef.current = sats;
      tick();
      // 1s steps are smooth enough for orbital motion and cheap for ~700 sats.
      timer = setInterval(() => { if (!document.hidden) tick(); }, 1000);
    }).catch(() => { /* layer stays empty */ });
    // Refresh the TLE set every 6h in case the tab lives that long.
    const reload = setInterval(() => {
      fetchSatellites().then((sats) => { if (alive && sats.length) satsRef.current = sats; }).catch(() => {});
    }, 6 * 3600_000);
    return () => { alive = false; if (timer) clearInterval(timer); clearInterval(reload); };
  }, [layers.satellites]);

  /* ── Offshore oil/gas platforms (vendored OpenStreetMap) ─────────────── */
  useEffect(() => {
    if (!layers.rigs || rigsRef.current.length) { needsDraw.current = true; return; }
    let alive = true;
    fetch("/oilrigs.json").then((r) => r.json()).then((rows) => {
      if (!alive) return;
      rigsRef.current = rows.map(([lat, lon, k, name]) => ({ lat, lon, k, name, u: mercX(lon), v: mercY(lat) }));
      needsDraw.current = true;
    }).catch(() => { /* layer stays empty */ });
    return () => { alive = false; };
  }, [layers.rigs]);

  /* ── GPS interference (derived from our plane sweep) ─────────────────── */
  useEffect(() => {
    if (!layers.jamming) { jammingRef.current = []; needsDraw.current = true; return; }
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/world");
        if (!r.ok) return;
        const j = await r.json();
        if (!alive) return;
        jammingRef.current = (j.jamming || []).map(([lat, lon, frac, total]) =>
          ({ lat, lon, frac, total, u: mercX(lon), v: mercY(lat) }));
        needsDraw.current = true;
      } catch { /* keep last */ }
    };
    load();
    const id = setInterval(load, 2 * 60_000);
    return () => { alive = false; clearInterval(id); };
  }, [layers.jamming]);

  /* ── World Bank projects (per country, pinned at centroid) ───────────── */
  useEffect(() => {
    if (!layers.projects) { projectsRef.current = []; needsDraw.current = true; return; }
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/projects");
        if (!r.ok) return;
        const j = await r.json();
        if (!alive) return;
        projectsRef.current = (j.projects || []).map(([country, count, usd, names]) => {
          const cen = centroidRef.current.get(String(country).toLowerCase());
          return cen ? { country, count, usd, names, u: cen.u, v: cen.v,
            lat: invMercLat(cen.v), lon: invMercLon(cen.u) } : null;
        }).filter(Boolean);
        needsDraw.current = true;
      } catch { /* keep last */ }
    };
    load();
    const id = setInterval(load, 30 * 60_000);
    return () => { alive = false; clearInterval(id); };
  }, [layers.projects]);

  /* ── Quakes layer (USGS, direct — they send CORS) ────────────────────── */
  useEffect(() => {
    if (!layers.quakes) { quakesRef.current = []; needsDraw.current = true; return; }
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson");
        const j = await res.json();
        if (!alive) return;
        quakesRef.current = (j.features || [])
          .filter((f) => (f.properties?.mag ?? 0) >= 2.5)
          .map((f) => ({
            mag: f.properties.mag, place: f.properties.place, time: f.properties.time,
            depth: f.geometry.coordinates[2], lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1],
          }));
        needsDraw.current = true;
      } catch { /* keep last data */ }
    };
    load();
    const id = setInterval(load, 5 * 60_000);
    return () => { alive = false; clearInterval(id); };
  }, [layers.quakes]);

  /* ── Counts tick + vessel pruning ────────────────────────────────────── */
  useEffect(() => {
    const id = setInterval(() => {
      const store = vesselsRef.current;
      const now = Date.now();
      for (const [k, v] of store) if (now - v.t > STALE_MS) store.delete(k);
      const F = filtersRef.current;
      let ships = 0;
      for (const v of store.values()) if (v.lat != null && F.ship[bucketOf(v)] !== false) ships++;
      let planesN = 0;
      for (const pl of planesRef.current) if (F.plane[pl.category] !== false) planesN++;
      // Live transit stats per chokepoint: vessels inside its bbox and the
      // anchored share — the queue signal commodity traders actually watch.
      for (const cp of CHOKEPOINTS) {
        const [[laMin, loMin], [laMax, loMax]] = cp.bbox;
        let n = 0, anch = 0;
        for (const v of store.values()) {
          if (v.lat == null) continue;
          if (v.lat >= laMin && v.lat <= laMax && v.lon >= loMin && v.lon <= loMax) {
            n++;
            if ((v.sog ?? 0) < 0.5) anch++;
          }
        }
        chokeStatsRef.current.set(cp.id, { n, anchoredPct: n >= 5 ? Math.round((anch / n) * 100) : null });
      }
      // Instability signals: an honest 0–100 mix per country from OUR OWN
      // layers — inverted yield curve, news attention, M5.5+ quakes, fire
      // density. Point→country uses per-polygon bounding boxes: fast and
      // deliberately border-fuzzy. A signal mix, not a forecast.
      const boxes = countryBoxesRef.current;
      if (boxes.length) {
        const hits = new Map(); // country id -> { q, f }
        const hit = (u, v) => {
          for (const c of boxes) for (const b of c.boxes)
            if (u >= b[0] && u <= b[2] && v >= b[1] && v <= b[3]) return c;
          return null;
        };
        for (const q of quakesRef.current) {
          if ((q.mag ?? 0) < 5.5) continue;
          const c = hit(mercX(q.lon), mercY(q.lat));
          if (c) { const e = hits.get(c.id) || { q: 0, f: 0 }; e.q++; hits.set(c.id, e); }
        }
        const fires = firesRef.current;
        const step = Math.max(1, Math.floor(fires.length / 3000)); // sample, scale back up
        for (let i = 0; i < fires.length; i += step) {
          const c = hit(fires[i].u, fires[i].v);
          if (c) { const e = hits.get(c.id) || { q: 0, f: 0 }; e.f += step; hits.set(c.id, e); }
        }
        for (const ev of conflictsRef.current) {
          if (!ev.best) continue;
          const c = hit(ev.u, ev.v);
          if (c) { const e = hits.get(c.id) || { q: 0, f: 0 }; e.k = (e.k || 0) + ev.best; hits.set(c.id, e); }
        }
        for (const dz of disastersRef.current) {
          if (!dz.alert) continue; // only orange/red hazards move the needle
          const c = hit(dz.u, dz.v);
          if (c) { const e = hits.get(c.id) || { q: 0, f: 0 }; e.h = (e.h || 0) + dz.alert; hits.set(c.id, e); }
        }
        const newsBy = new Map(newsRef.current.map((p) => [p.code, p.items.length]));
        const pinCache = pinNameCacheRef.current;
        const out = [];
        for (const c of boxes) {
          if (!pinCache.has(c.name)) pinCache.set(c.name, COUNTRY_PINS.find((p) => p.re.test(c.name)) || null);
          const pin = pinCache.get(c.name);
          const news = pin ? newsBy.get(pin.code) || 0 : 0;
          const code = yieldLookupRef.current?.(c.name);
          const spread = code != null ? spreadsRef.current.get(code) : undefined;
          const e = hits.get(c.id) || { q: 0, f: 0 };
          const inv = spread != null && spread < 0 ? Math.min(40, Math.round(14 + Math.abs(spread) * 26)) : 0;
          const newsPts = Math.min(25, news * 5);
          const qPts = Math.min(20, e.q * 10);
          const fPts = Math.min(15, Math.round(Math.sqrt(e.f) * 1.6));
          // Conflict fatalities (UCDP, ~6 months) — the strongest signal we have.
          const kPts = Math.min(35, Math.round(Math.sqrt(e.k || 0) * 1.4));
          const hPts = Math.min(15, (e.h || 0) * 5);
          const score = Math.min(100, inv + newsPts + qPts + fPts + kPts + hPts);
          if (score > 0) out.push({ id: c.id, name: c.name, score, inv, newsPts, qPts, fPts, kPts, hPts });
        }
        out.sort((a, b) => b.score - a.score);
        instabRef.current = { byId: new Map(out.map((o) => [o.id, o])), top: out.slice(0, 8) };
        setInstabTop(instabRef.current.top);
        if (layersRef.current.instab) needsDraw.current = true;
      }
      setCounts({ ships, planes: planesN, quakes: quakesRef.current.length, fires: firesRef.current.length });
    }, 5000);
    return () => clearInterval(id);
  }, []);

  /* ── Render loop ─────────────────────────────────────────────────────── */
  useEffect(() => {
    let raf;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      if (!needsDraw.current) return;
      needsDraw.current = false;
      const canvas = canvasRef.current, el = wrapRef.current;
      if (!canvas || !el) return;
      const dpr = window.devicePixelRatio || 1;
      const w = el.clientWidth, h = el.clientHeight;
      if (viewRef.current.scale === 0) viewRef.current.scale = w * 1.05; // first fit
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr; canvas.height = h * dpr;
        canvas.style.width = w + "px"; canvas.style.height = h + "px";
      }
      const ctx = canvas.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      clampView();
      const { cx, cy, scale } = viewRef.current;
      // Static layers (countries, cables) redraw once per visible world copy
      // via kOff; point layers use XP, which snaps each point to its nearest
      // copy — that is the seamless wrap.
      let kOff = 0;
      const X = (u) => (u + kOff - cx) * scale + w / 2;
      const Y = (v) => (v - cy) * scale + h / 2;
      const XP = (u) => { let du = u - cx; du -= Math.round(du); return du * scale + w / 2; };
      const halfW = w / (2 * scale);
      const copies = [];
      for (let k = Math.floor(cx - halfW - 1); k <= Math.floor(cx + halfW); k++) copies.push(k);
      const L = layersRef.current;

      // Countries: subtle fill + real borders; hovered/selected outlined hot.
      const ink = cssRgb("--c-text");
      const accent = cssRgb("--c-accent");
      const hovId = hoverCountryRef.current;
      const selId = selectedRef.current?.kind === "country" ? selectedRef.current.id : null;
      const trace = (polys) => {
        ctx.beginPath();
        for (const poly of polys) for (const ring of poly) {
          for (let i = 0; i < ring.length; i++) {
            const [u, v] = ring[i];
            if (i === 0 || Math.abs(u - ring[i - 1][0]) > 0.5) ctx.moveTo(X(u), Y(v));
            else ctx.lineTo(X(u), Y(v));
          }
        }
      };
      const downCol = cssRgb("--c-down"), upColC = cssRgb("--c-up");
      const amberC = vizColor("amber");
      for (const kCopy of copies) {
      kOff = kCopy;
      for (const c of countriesRef.current) {
        const hot = c.id === hovId || c.id === selId;
        trace(c.polys);
        // Yield-curve stress choropleth (our LSE data): an inverted 10Y−2Y
        // tints the country red, deeper inversion = deeper tint; healthy
        // curves get the faintest green; no coverage stays neutral ink.
        let fill = ink, alpha = 0.06, tinted = false;
        // Instability tint (amber) wins over the yield choropleth for the
        // handful of hot countries; everything else falls through to yields.
        if (L.instab && !hot) {
          const sc = instabRef.current.byId.get(c.id);
          if (sc && sc.score >= 25) {
            fill = amberC; alpha = Math.min(0.4, 0.1 + (sc.score / 100) * 0.35); tinted = true;
          }
        }
        if (!tinted && L.yields && !hot && spreadsRef.current.size) {
          const code = yieldLookupRef.current?.(c.name);
          const spread = code != null ? spreadsRef.current.get(code) : undefined;
          if (spread != null) {
            if (spread < 0) { fill = downCol; alpha = Math.min(0.42, 0.14 + Math.abs(spread) * 0.28); }
            else { fill = upColC; alpha = 0.07; }
          }
        }
        ctx.fillStyle = hot ? accent : fill;
        ctx.globalAlpha = hot ? 0.14 : alpha;
        ctx.fill("evenodd");
        ctx.strokeStyle = hot ? accent : ink;
        ctx.globalAlpha = hot ? 0.8 : 0.2;
        ctx.lineWidth = hot ? 1.2 : 0.5;
        ctx.stroke();
      }

      // Submarine cables — thin teal arcs under the traffic layers.
      if (L.cables && cablesRef.current) {
        ctx.strokeStyle = vizColor("teal");
        ctx.lineWidth = 0.7;
        ctx.globalAlpha = 0.28;
        for (const cab of cablesRef.current) {
          ctx.beginPath();
          for (const line of cab.p) {
            for (let i = 0; i < line.length; i++) {
              const [u, v] = line[i];
              if (i === 0 || Math.abs(u - line[i - 1][0]) > 0.5) ctx.moveTo(X(u), Y(v));
              else ctx.lineTo(X(u), Y(v));
            }
          }
          ctx.stroke();
        }
      }

      // Oil / NGL pipelines — pink (oil) and amber (NGL) routes.
      if (L.pipelines && pipesRef.current) {
        ctx.lineWidth = 0.9;
        ctx.globalAlpha = 0.5;
        for (const pipe of pipesRef.current) {
          ctx.strokeStyle = vizColor(pipe.k === "n" ? "amber" : "pink");
          ctx.beginPath();
          for (const line of pipe.p) {
            for (let i = 0; i < line.length; i++) {
              const [u, v] = line[i];
              if (i === 0 || Math.abs(u - line[i - 1][0]) > 0.5) ctx.moveTo(X(u), Y(v));
              else ctx.lineTo(X(u), Y(v));
            }
          }
          ctx.stroke();
        }
      }
      } // end world copies
      kOff = 0;
      ctx.globalAlpha = 1;

      // GPS-interference heat cells (under traffic): amber squares by bad-fraction.
      if (L.jamming) {
        const jc = vizColor("amber");
        for (const cell of jammingRef.current) {
          const px = XP(cell.u), py = Y(cell.v);
          if (px < -20 || py < -20 || px > w + 20 || py > h + 20) continue;
          const sz = Math.max(6, scale / 90);
          ctx.fillStyle = jc;
          ctx.globalAlpha = 0.12 + cell.frac * 0.4;
          ctx.fillRect(px - sz / 2, py - sz / 2, sz, sz);
        }
        ctx.globalAlpha = 1;
      }

      // Power infrastructure: small fuel-colored squares (dense — draw thin).
      if (L.power) {
        for (const pp of powerRef.current) {
          const px = XP(pp.u), py = Y(pp.v);
          if (px < -4 || py < -4 || px > w + 4 || py > h + 4) continue;
          const [vk] = FUEL_TYPES[pp.fuel] || ["dim"];
          ctx.fillStyle = vk === "down" ? cssRgb("--c-down") : vk === "up" ? cssRgb("--c-up") : vk === "dim" ? cssRgb("--c-dim") : vizColor(vk);
          ctx.globalAlpha = 0.7;
          const r = pp.mw >= 1000 ? 2.4 : 1.4;
          ctx.fillRect(px - r, py - r, r * 2, r * 2);
        }
        ctx.globalAlpha = 1;
      }

      // Mines: small commodity-colored diamonds.
      if (L.mines) {
        for (const m of minesRef.current) {
          const px = XP(m.u), py = Y(m.v);
          if (px < -4 || py < -4 || px > w + 4 || py > h + 4) continue;
          const [vk] = MINE_TYPES[m.commod] || ["dim"];
          ctx.fillStyle = vk === "down" ? cssRgb("--c-down") : vk === "up" ? cssRgb("--c-up") : vk === "dim" ? cssRgb("--c-dim") : vizColor(vk);
          ctx.globalAlpha = 0.7;
          ctx.save();
          ctx.translate(px, py);
          ctx.rotate(Math.PI / 4);
          ctx.fillRect(-1.5, -1.5, 3, 3);
          ctx.restore();
        }
        ctx.globalAlpha = 1;
      }

      // Offshore platforms: small hollow squares in the sea.
      if (L.rigs) {
        ctx.lineWidth = 1;
        for (const rg of rigsRef.current) {
          const px = XP(rg.u), py = Y(rg.v);
          if (px < -4 || py < -4 || px > w + 4 || py > h + 4) continue;
          const [vk] = RIG_TYPES[rg.k] || ["blue"];
          ctx.strokeStyle = vk === "pink" ? vizColor("pink") : vk === "amber" ? vizColor("amber") : vizColor("blue");
          ctx.globalAlpha = 0.85;
          ctx.strokeRect(px - 2, py - 2, 4, 4);
        }
        ctx.globalAlpha = 1;
      }

      // Fires (NASA FIRMS VIIRS 24h): heat dots, hotter = redder + bigger.
      if (L.fires && firesRef.current.length) {
        const fCool = vizColor("amber"), fHot = downCol;
        for (const f of firesRef.current) {
          const px = XP(f.u), py = Y(f.v);
          if (px < -6 || py < -6 || px > w + 6 || py > h + 6) continue;
          const big = f.frp >= 40;
          ctx.fillStyle = big ? fHot : fCool;
          ctx.globalAlpha = big ? 0.8 : 0.5;
          ctx.beginPath();
          ctx.arc(px, py, big ? 2.2 : 1.3, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }

      // Conflict events (UCDP): dots colored by violence type, sized by deaths.
      if (L.conflicts && conflictsRef.current.length) {
        for (const ev of conflictsRef.current) {
          const px = XP(ev.u), py = Y(ev.v);
          if (px < -8 || py < -8 || px > w + 8 || py > h + 8) continue;
          const [vk] = CONFLICT_TYPES[ev.type] || ["pink"];
          ctx.fillStyle = vk === "down" ? downCol : vizColor(vk);
          ctx.globalAlpha = ev.best > 0 ? 0.6 : 0.3;
          ctx.beginPath();
          ctx.arc(px, py, Math.min(7, 1.6 + Math.sqrt(ev.best) * 0.7), 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }

      // Satellites: live sub-points, colored by constellation group.
      if (L.satellites && satPosRef.current.length) {
        for (const st of satPosRef.current) {
          const px = XP(mercX(st.lon)), py = Y(mercY(st.lat));
          if (px < -4 || py < -4 || px > w + 4 || py > h + 4) continue;
          const [vk] = SAT_GROUPS[st.group] || ["dim"];
          ctx.fillStyle = vk === "accent" ? accent : vk === "dim" ? cssRgb("--c-dim") : vizColor(vk);
          ctx.globalAlpha = vk === "dim" ? 0.5 : 0.9;
          ctx.beginPath();
          ctx.arc(px, py, vk === "accent" ? 2.4 : 1.5, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }

      // Quakes: circles sized by magnitude.
      if (L.quakes) {
        const qc = vizColor("pink");
        for (const q of quakesRef.current) {
          const px = XP(mercX(q.lon)), py = Y(mercY(q.lat));
          if (px < -20 || py < -20 || px > w + 20 || py > h + 20) continue;
          const r = Math.max(2, (q.mag - 2) * 2.4);
          ctx.beginPath();
          ctx.arc(px, py, r, 0, Math.PI * 2);
          ctx.fillStyle = qc;
          ctx.globalAlpha = 0.24;
          ctx.fill();
          ctx.globalAlpha = 0.8;
          ctx.lineWidth = 1;
          ctx.strokeStyle = qc;
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }

      // Ships.
      if (L.ships) {
        const dim = cssRgb("--c-dim"), up = cssRgb("--c-up");
        const FS = filtersRef.current.ship;
        for (const v of vesselsRef.current.values()) {
          if (v.lat == null || FS[bucketOf(v)] === false) continue;
          const px = XP(mercX(v.lon)), py = Y(mercY(v.lat));
          if (px < -8 || py < -8 || px > w + 8 || py > h + 8) continue;
          const moving = v.sog >= 0.5;
          const vk = SHIP_VIZ[bucketOf(v)];
          ctx.fillStyle = vk ? vizColor(vk) : (moving ? up : dim);
          ctx.globalAlpha = moving ? 0.9 : 0.45;
          ctx.beginPath();
          ctx.arc(px, py, moving ? 2.1 : 1.5, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }

      // Planes: track-rotated triangles.
      if (L.planes) {
        const FP = filtersRef.current.plane;
        for (const p of planesRef.current) {
          if (FP[p.category] === false) continue;
          const px = XP(mercX(p.lon)), py = Y(mercY(p.lat));
          if (px < -10 || py < -10 || px > w + 10 || py > h + 10) continue;
          ctx.save();
          ctx.translate(px, py);
          ctx.rotate(((p.track || 0) * Math.PI) / 180);
          ctx.globalAlpha = p.onGround ? 0.35 : 0.9;
          ctx.fillStyle = vizColor(PLANE_VIZ[p.category] || "pink");
          ctx.beginPath();
          ctx.moveTo(0, -5); ctx.lineTo(3.4, 4.4); ctx.lineTo(0, 2.2); ctx.lineTo(-3.4, 4.4);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }
        ctx.globalAlpha = 1;
      }

      // Chokepoints: diamonds + label when zoomed.
      if (L.chokepoints) {
        ctx.fillStyle = accent;
        for (const cp of CHOKEPOINTS) {
          const px = XP(mercX(cp.lon)), py = Y(mercY(cp.lat));
          if (px < -20 || py < -20 || px > w + 20 || py > h + 20) continue;
          ctx.globalAlpha = 0.9;
          ctx.save();
          ctx.translate(px, py);
          ctx.rotate(Math.PI / 4);
          ctx.fillRect(-3, -3, 6, 6);
          ctx.restore();
          const cs = chokeStatsRef.current.get(cp.id);
          if (scale > 1600 || (cs && cs.n > 0)) {
            ctx.globalAlpha = 0.8;
            ctx.font = "10px ui-monospace, monospace";
            const label = cs && cs.n > 0
              ? `${cp.label} · ${cs.n} ships${cs.anchoredPct != null ? ` · ${cs.anchoredPct}% anchored` : ""}`
              : cp.label;
            ctx.fillText(label, px + 7, py + 3);
          }
        }
        ctx.globalAlpha = 1;
      }

      // Disasters (GDACS): glyph markers, alert-colored ring.
      if (L.disasters && disastersRef.current.length) {
        ctx.font = "11px ui-monospace, monospace";
        ctx.textAlign = "center";
        for (const dz of disastersRef.current) {
          const px = XP(dz.u), py = Y(dz.v);
          if (px < -12 || py < -12 || px > w + 12 || py > h + 12) continue;
          const [vk, , glyph] = DISASTER_TYPES[dz.type] || ["dim", "", "?"];
          const col = vk === "down" ? cssRgb("--c-down") : vk === "blue" ? vizColor("blue") : vizColor(vk);
          if (dz.alert >= 1) { // orange/red get a halo
            ctx.fillStyle = dz.alert >= 2 ? cssRgb("--c-down") : vizColor("amber");
            ctx.globalAlpha = 0.28;
            ctx.beginPath(); ctx.arc(px, py, 8, 0, Math.PI * 2); ctx.fill();
          }
          ctx.globalAlpha = 0.95;
          ctx.fillStyle = col;
          ctx.fillText(glyph, px, py + 4);
        }
        ctx.textAlign = "start";
        ctx.globalAlpha = 1;
      }

      // World Bank projects: hollow rings at country centroids, sized by count.
      if (L.projects && projectsRef.current.length) {
        const pc = vizColor("teal");
        ctx.strokeStyle = pc;
        for (const pr of projectsRef.current) {
          const px = XP(pr.u), py = Y(pr.v);
          if (px < -14 || py < -14 || px > w + 14 || py > h + 14) continue;
          const rr = Math.min(11, 4 + Math.sqrt(pr.count) * 1.4);
          ctx.globalAlpha = 0.85;
          ctx.lineWidth = 1.6;
          ctx.beginPath(); ctx.arc(px, py, rr, 0, Math.PI * 2); ctx.stroke();
          ctx.globalAlpha = 0.12;
          ctx.fillStyle = pc;
          ctx.beginPath(); ctx.arc(px, py, rr, 0, Math.PI * 2); ctx.fill();
        }
        ctx.globalAlpha = 1;
      }

      // News pins — accent dots sized by headline count.
      if (L.news && newsRef.current.length) {
        const nCol = accent;
        for (const pin of newsRef.current) {
          const px = XP(mercX(pin.lon)), py = Y(mercY(pin.lat));
          if (px < -20 || py < -20 || px > w + 20 || py > h + 20) continue;
          const rr = Math.min(7, 2.5 + pin.items.length * 0.8);
          ctx.fillStyle = nCol;
          ctx.globalAlpha = 0.3;
          ctx.beginPath(); ctx.arc(px, py, rr + 3, 0, Math.PI * 2); ctx.fill();
          ctx.globalAlpha = 0.95;
          ctx.beginPath(); ctx.arc(px, py, rr, 0, Math.PI * 2); ctx.fill();
          if (pin.items.length > 1) {
            ctx.globalAlpha = 1;
            ctx.fillStyle = cssRgb("--c-bg");
            ctx.font = "bold 8px ui-monospace, monospace";
            ctx.textAlign = "center";
            ctx.fillText(String(pin.items.length), px, py + 3);
            ctx.textAlign = "start";
          }
        }
        ctx.globalAlpha = 1;
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  /* ── Interaction: pan / zoom / hover / click ─────────────────────────── */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    let drag = null, downAt = null;
    const toWorld = (e) => {
      const r = el.getBoundingClientRect();
      const { cx, cy, scale } = viewRef.current;
      return {
        u: (e.clientX - r.left - r.width / 2) / scale + cx,
        v: (e.clientY - r.top - r.height / 2) / scale + cy,
        px: e.clientX - r.left, py: e.clientY - r.top,
      };
    };
    const nearestObject = (px, py) => {
      const { cx, cy, scale } = viewRef.current;
      const r = el.getBoundingClientRect();
      const P = (lon, lat) => {
        let du = mercX(lon) - cx;
        du -= Math.round(du); // nearest world copy — matches the wrapped draw
        return [du * scale + r.width / 2, (mercY(lat) - cy) * scale + r.height / 2];
      };
      let best = null, bd = 144;
      const L = layersRef.current;
      const F = filtersRef.current;
      if (L.satellites) for (const st of satPosRef.current) {
        const [x, y] = P(st.lon, st.lat);
        const d = (x - px) ** 2 + (y - py) ** 2;
        if (d < bd) { bd = d; best = { kind: "satellite", x, y, data: st }; }
      }
      if (L.planes) for (const p of planesRef.current) {
        if (F.plane[p.category] === false) continue;
        const [x, y] = P(p.lon, p.lat);
        const d = (x - px) ** 2 + (y - py) ** 2;
        if (d < bd) { bd = d; best = { kind: "plane", x, y, data: p }; }
      }
      if (L.ships) for (const v of vesselsRef.current.values()) {
        if (v.lat == null || F.ship[bucketOf(v)] === false) continue;
        const [x, y] = P(v.lon, v.lat);
        const d = (x - px) ** 2 + (y - py) ** 2;
        if (d < bd) { bd = d; best = { kind: "ship", x, y, data: v }; }
      }
      if (L.quakes) for (const q of quakesRef.current) {
        const [x, y] = P(q.lon, q.lat);
        const d = (x - px) ** 2 + (y - py) ** 2;
        if (d < bd) { bd = d; best = { kind: "quake", x, y, data: q }; }
      }
      if (L.news) for (const pin of newsRef.current) {
        const [x, y] = P(pin.lon, pin.lat);
        const d = (x - px) ** 2 + (y - py) ** 2;
        if (d < bd) { bd = d; best = { kind: "news", x, y, data: pin }; }
      }
      if (L.conflicts) for (const ev of conflictsRef.current) {
        const [x, y] = P(ev.lon, ev.lat);
        const d = (x - px) ** 2 + (y - py) ** 2;
        if (d < bd) { bd = d; best = { kind: "conflict", x, y, data: ev }; }
      }
      if (L.disasters) for (const dz of disastersRef.current) {
        const [x, y] = P(dz.lon, dz.lat);
        const d = (x - px) ** 2 + (y - py) ** 2;
        if (d < bd) { bd = d; best = { kind: "disaster", x, y, data: dz }; }
      }
      if (L.projects) for (const pr of projectsRef.current) {
        const [x, y] = P(pr.lon, pr.lat);
        const d = (x - px) ** 2 + (y - py) ** 2;
        if (d < bd) { bd = d; best = { kind: "project", x, y, data: pr }; }
      }
      if (L.mines) for (const m of minesRef.current) {
        const [x, y] = P(m.lon, m.lat);
        const d = (x - px) ** 2 + (y - py) ** 2;
        if (d < bd) { bd = d; best = { kind: "mine", x, y, data: m }; }
      }
      if (L.rigs) for (const rg of rigsRef.current) {
        const [x, y] = P(rg.lon, rg.lat);
        const d = (x - px) ** 2 + (y - py) ** 2;
        if (d < bd) { bd = d; best = { kind: "rig", x, y, data: rg }; }
      }
      if (L.fires) for (const f of firesRef.current) {
        const [x, y] = P(f.lon, f.lat);
        const d = (x - px) ** 2 + (y - py) ** 2;
        if (d < bd) { bd = d; best = { kind: "fire", x, y, data: f }; }
      }
      return best;
    };
    // The overlay panels (layer toggles, selection, instability) live INSIDE
    // the map wrapper, so their clicks bubble here. Without this guard, onDown
    // would setPointerCapture and swallow every checkbox/button click.
    const onUi = (e) => e.target.closest?.("[data-mapui]");
    const onDown = (e) => {
      if (onUi(e)) return;
      drag = toWorld(e); downAt = { x: e.clientX, y: e.clientY }; el.setPointerCapture(e.pointerId);
    };
    const onMove = (e) => {
      if (!drag && onUi(e)) { setHover(null); return; }
      const p = toWorld(e);
      if (drag) {
        viewRef.current.cx += drag.u - p.u;
        viewRef.current.cy += drag.v - p.v;
        clampView();
        needsDraw.current = true;
        setHover(null);
        return;
      }
      const obj = nearestObject(p.px, p.py);
      if (obj) {
        if (hoverCountryRef.current) { hoverCountryRef.current = null; setHoverCountry(null); needsDraw.current = true; }
        const d = obj.data;
        setHover({
          x: obj.x, y: obj.y,
          label: obj.kind === "ship" ? (d.staticName || d.name)
            : obj.kind === "satellite" ? d.name
            : obj.kind === "plane" ? d.callsign
            : obj.kind === "news" ? `${d.name} · ${d.items.length} headline${d.items.length > 1 ? "s" : ""}`
            : obj.kind === "fire" ? `Fire · ${d.frp} MW`
            : obj.kind === "conflict" ? `${d.country} · ${d.best} death${d.best === 1 ? "" : "s"}`
            : obj.kind === "disaster" ? ((DISASTER_TYPES[d.type] || [])[1] || "Hazard") + ` · ${d.country}`
            : obj.kind === "project" ? `${d.country} · ${d.count} WB project${d.count === 1 ? "" : "s"}`
            : obj.kind === "mine" ? (d.name || "Mine")
            : obj.kind === "rig" ? (d.name || "Offshore platform")
            : `M${d.mag?.toFixed(1)}`,
          sub: obj.kind === "ship" ? `${(d.sog ?? 0).toFixed(1)} kn${d.destination ? ` → ${d.destination}` : ""}`
            : obj.kind === "satellite" ? `${(SAT_GROUPS[d.group] || [])[1] || "satellite"} · ${fmtNum(d.alt, 0)} km`
            : obj.kind === "plane" ? `${d.type || ""} ${d.onGround ? "ground" : fmtNum(d.alt, 0) + " ft"}`
            : obj.kind === "news" ? (d.items[0]?.title || "").slice(0, 60)
            : obj.kind === "fire" ? "VIIRS thermal anomaly · NASA FIRMS"
            : obj.kind === "conflict" ? `${(CONFLICT_TYPES[d.type] || [])[1] || "violence"} · ${d.date}`
            : obj.kind === "disaster" ? `${["green","orange","red"][d.alert] || ""} alert · ${d.date}`
            : obj.kind === "project" ? `$${(d.usd / 1e9).toFixed(1)}B committed`
            : obj.kind === "mine" ? ((MINE_TYPES[d.commod] || [])[1] || "mineral") + " · producing"
            : obj.kind === "rig" ? ((RIG_TYPES[d.k] || [])[1] || "platform") + " · offshore"
            : d.place,
        });
        return;
      }
      setHover(null);
      const c = countryAt(countriesRef.current, ((p.u % 1) + 1) % 1, p.v);
      const id = c?.id ?? null;
      if (id !== hoverCountryRef.current) {
        hoverCountryRef.current = id;
        setHoverCountry(c ? c.name : null);
        needsDraw.current = true;
      }
    };
    const onUp = (e) => {
      const wasClick = downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) < 5;
      drag = null; downAt = null;
      if (!wasClick) return;
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      const obj = nearestObject(px, py);
      if (obj) {
        if (obj.kind === "plane") {
          const plane = obj.data;
          setSelected({ kind: "plane", data: plane, route: undefined });
          fetchRoute(plane.callsign).then((route) =>
            setSelected((cur) => (cur?.kind === "plane" && cur.data.hex === plane.hex ? { ...cur, route } : cur)));
        } else {
          setSelected({ kind: obj.kind, data: { ...obj.data } });
        }
        needsDraw.current = true;
        return;
      }
      const { cx, cy, scale } = viewRef.current;
      const u = (px - r.width / 2) / scale + cx, v = (py - r.height / 2) / scale + cy;
      const c = countryAt(countriesRef.current, ((u % 1) + 1) % 1, v);
      if (c) {
        const sel = { kind: "country", id: c.id, name: c.name, yield: undefined };
        setSelected(sel);
        needsDraw.current = true;
        // Bond-yield tie-in where the LSE archive covers the country.
        const code = yieldLookupRef.current?.(c.name);
        if (!code) { setSelected((cur) => (cur?.kind === "country" && cur.id === c.id ? { ...cur, yield: null } : cur)); return; }
        const cached = yieldCacheRef.current.get(code);
        const apply = (y) => setSelected((cur) => (cur?.kind === "country" && cur.id === c.id ? { ...cur, yield: y, code } : cur));
        if (cached) { apply(cached); return; }
        fetchYields(code).then((rows) => {
          const { latest } = yieldCurves(rows);
          const p10 = latest?.points.find((p) => p.tenor === "10Y");
          const p2 = latest?.points.find((p) => p.tenor === "2Y");
          const y = p10 ? { y10: p10.close, spread: p2 ? p10.close - p2.close : null, asOf: latest.date } : null;
          yieldCacheRef.current.set(code, y);
          apply(y);
        }).catch(() => apply(null));
      } else {
        setSelected(null);
        needsDraw.current = true;
      }
    };
    const onWheel = (e) => {
      if (onUi(e)) return; // let the (scrollable) layer panel scroll
      e.preventDefault();
      const p = toWorld(e);
      const f = Math.exp(-e.deltaY * 0.0015);
      const view = viewRef.current;
      const ns = Math.min(600_000, view.scale * f);
      view.cx = p.u - (p.u - view.cx) * (view.scale / ns);
      view.cy = p.v - (p.v - view.cy) * (view.scale / ns);
      view.scale = ns;
      clampView();
      needsDraw.current = true;
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("wheel", onWheel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const jumpTo = (cp) => {
    const el = wrapRef.current;
    const w = el?.clientWidth || 800, h = el?.clientHeight || 560;
    const [[latMin, lonMin], [latMax, lonMax]] = cp.bbox;
    const x1 = mercX(lonMin), x2 = mercX(lonMax);
    const y1 = mercY(latMax), y2 = mercY(latMin);
    viewRef.current = {
      cx: (x1 + x2) / 2, cy: (y1 + y2) / 2,
      scale: Math.min(w / (x2 - x1), h / (y2 - y1)) * 0.9,
    };
    clampView();
    needsDraw.current = true;
  };

  const sel = selected;

  return (
    <div className="space-y-3">
      <div className="flex flex-col sm:flex-row sm:items-center gap-2">
        {/* One scrollable row on mobile instead of six wrapped ones. */}
        <div className="flex gap-2 overflow-x-auto pb-1 -mb-1 sm:flex-wrap sm:overflow-visible sm:pb-0 sm:mb-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <button onClick={() => { viewRef.current = { cx: 0.5, cy: 0.42, scale: (wrapRef.current?.clientWidth || 800) * 1.05 }; clampView(); needsDraw.current = true; }}
            className="chip chip-idle shrink-0">World</button>
          {CHOKEPOINTS.map((cp) => (
            <button key={cp.id} onClick={() => jumpTo(cp)} className="chip chip-idle shrink-0">{cp.label}</button>
          ))}
        </div>
        <span title={`ships: ${shipStatus} · planes: ${planeStatus}`}
          className={cn("self-start sm:self-auto sm:ml-auto inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wide max-w-full sm:max-w-[300px] truncate shrink-0",
            shipStatus === "live" || planeStatus === "live" ? "border-up/40 bg-up/10 text-up uppercase" : "border-line bg-bg text-dim")}>
          <Radio className="w-3 h-3 shrink-0" />
          {layers.ships ? `ships ${shipStatus}` : ""}{layers.ships && layers.planes ? " · " : ""}{layers.planes ? `planes ${planeStatus}` : ""}
          {!layers.ships && !layers.planes ? "static layers" : ""}
        </span>
      </div>

      <div className="relative">
        <div ref={wrapRef} className="relative rounded-xl border border-line lg-glass overflow-hidden cursor-grab active:cursor-grabbing"
          style={{ height: "min(68vh, 720px)" }}>
          <canvas ref={canvasRef} className="block w-full h-full" />

          {/* Layer panel (worldmonitor-style, our design language) — folds away on mobile */}
          <div data-mapui className="absolute top-3 left-3 z-10 w-52 max-w-[calc(100vw-1.5rem)] rounded-xl border border-line bg-bg/85 backdrop-blur flex flex-col max-h-[calc(100%-1.5rem)]">
            <button onClick={() => setPanelOpen((o) => !o)}
              className="flex items-center gap-1.5 px-3 py-2 text-[10px] uppercase tracking-widest text-dim shrink-0">
              <Layers className="w-3 h-3" /> Layers
              <span className="ml-auto flex items-center gap-2">
                {panelOpen && (
                  <span role="button" tabIndex={0} onClick={(e) => { e.stopPropagation(); allLayers(); }}
                    className="text-[9px] normal-case tracking-normal text-accent hover:underline cursor-pointer">all on</span>
                )}
                <ChevronDown className={cn("w-3.5 h-3.5 transition-transform", panelOpen ? "" : "-rotate-90")} />
              </span>
            </button>
            {panelOpen && (
            <div className="px-3 pb-2.5 overflow-y-auto overscroll-contain">
            {LAYER_DEFS.map((ld) => (
              <div key={ld.id}>
              <label className="group flex items-center gap-2 py-1 cursor-pointer select-none">
                <input type="checkbox" checked={!!layers[ld.id]} onChange={() => toggleLayer(ld.id)} className="accent-current w-3.5 h-3.5" />
                <ld.icon className="w-3.5 h-3.5 text-dim" />
                <span className="text-xs">{ld.label}</span>
                <button onClick={(e) => { e.preventDefault(); soloLayer(ld.id); }}
                  className="text-[9px] text-dim/0 group-hover:text-dim hover:!text-accent transition-colors" title="Show only this layer">only</button>
                <span className="ml-auto text-[10px] font-mono text-dim">
                  {ld.id === "ships" ? fmtNum(counts.ships, 0)
                    : ld.id === "planes" ? fmtNum(counts.planes, 0)
                    : ld.id === "satellites" ? (satPosRef.current.length || "")
                    : ld.id === "quakes" ? fmtNum(counts.quakes, 0)
                    : ld.id === "cables" ? (cablesRef.current ? cablesRef.current.length : "")
                    : ld.id === "yields" ? (spreadsRef.current.size || "")
                    : ld.id === "news" ? (newsRef.current.length || "")
                    : ld.id === "fires" ? (counts.fires ? fmtNum(counts.fires, 0) : "")
                    : ld.id === "conflicts" ? (conflictsRef.current.length ? fmtNum(conflictsRef.current.length, 0) : "")
                    : ld.id === "disasters" ? (disastersRef.current.length || "")
                    : ld.id === "power" ? (powerRef.current.length ? fmtNum(powerRef.current.length, 0) : "")
                    : ld.id === "pipelines" ? (pipesRef.current ? pipesRef.current.length : "")
                    : ld.id === "mines" ? (minesRef.current.length ? fmtNum(minesRef.current.length, 0) : "")
                    : ld.id === "rigs" ? (rigsRef.current.length ? fmtNum(rigsRef.current.length, 0) : "")
                    : ld.id === "jamming" ? (jammingRef.current.length || "")
                    : ld.id === "projects" ? (projectsRef.current.length || "")
                    : ld.id === "instab" ? (instabTop.length || "") : ""}
                </span>
              </label>
              {ld.id === "ships" && layers.ships && (
                <div className="flex flex-wrap gap-1 pl-6 pb-1">
                  {SHIP_CATS.map((cat) => (
                    <button key={cat} onClick={() => toggleCat("ship", cat)}
                      className={cn("inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[9px] capitalize transition-colors",
                        filters.ship[cat] ? "border-line text-text" : "border-line/40 text-dim/50 line-through")}>
                      <span className="w-1.5 h-1.5 rounded-full" style={{ background: SHIP_VIZ[cat] ? vizColor(SHIP_VIZ[cat]) : "var(--tw-prose-body, #888)" }} />
                      {cat}
                    </button>
                  ))}
                </div>
              )}
              {ld.id === "planes" && layers.planes && (
                <div className="flex flex-wrap gap-1 pl-6 pb-1">
                  {PLANE_CATS.map((cat) => (
                    <button key={cat} onClick={() => toggleCat("plane", cat)}
                      className={cn("inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[9px] capitalize transition-colors",
                        filters.plane[cat] ? "border-line text-text" : "border-line/40 text-dim/50 line-through")}>
                      <span className="w-1.5 h-1.5 rounded-full" style={{ background: PLANE_VIZ[cat] ? vizColor(PLANE_VIZ[cat]) : "#888" }} />
                      {cat}
                    </button>
                  ))}
                </div>
              )}
              </div>
            ))}
            <p className="text-[9px] text-dim/70 leading-snug mt-1">Ships, planes and fires are global snapshots pushed by our 24/7 agent. Yield stress: <span className="text-down">red = inverted 10Y−2Y curve</span> (our London bond data); <span className="text-accent">amber</span> = instability signals. Chokepoints label live vessel counts + anchored share.</p>
            </div>
            )}
          </div>

          {/* Hover tooltip: object or country name */}
          {hover && (
            <div className="absolute pointer-events-none rounded-lg border border-line bg-bg/95 px-2.5 py-1.5 text-[11px] font-mono whitespace-nowrap z-10"
              style={{ left: hover.x + 12, top: hover.y - 10 }}>
              <span className="text-text font-semibold">{hover.label}</span>
              {hover.sub && <span className="text-dim ml-2">{hover.sub}</span>}
            </div>
          )}
          {!hover && hoverCountry && (
            <div className="absolute bottom-3 left-3 rounded-lg border border-line bg-bg/85 backdrop-blur px-2.5 py-1 text-xs font-semibold z-10">
              {hoverCountry}
            </div>
          )}
          {layers.instab && instabTop.length > 0 && (
            <div data-mapui className="absolute bottom-8 right-3 w-60 max-w-[calc(100vw-1.5rem)] rounded-xl border border-line bg-bg/85 backdrop-blur px-3 py-2.5 z-10 hidden sm:block">
              <p className="text-[10px] uppercase tracking-widest text-dim mb-1.5 flex items-center gap-1.5">
                <AlertTriangle className="w-3 h-3" /> Instability signals
              </p>
              {instabTop.map((c) => (
                <div key={c.id} className="flex items-center gap-2 py-0.5">
                  <span className="text-xs truncate flex-1">{c.name}</span>
                  <div className="w-16 h-1.5 rounded-full bg-line/60 overflow-hidden shrink-0">
                    <div className="h-full bg-accent" style={{ width: `${c.score}%` }} />
                  </div>
                  <span className="text-[10px] font-mono text-dim w-6 text-right shrink-0">{c.score}</span>
                </div>
              ))}
              <p className="text-[9px] text-dim/70 leading-snug mt-1">Mix of our own layers: UCDP conflict deaths · inverted curve · news attention · M5.5+ quakes · fire density. A signal mix, not a forecast.</p>
            </div>
          )}
          <p className="absolute bottom-2 right-3 text-[10px] text-dim pointer-events-none">
            drag = pan · wheel = zoom · click anything for details
          </p>
        </div>

        {/* Selection panel */}
        {sel && (
          <div data-mapui className="absolute top-3 right-3 w-72 max-w-[calc(100%-1.5rem)] rounded-xl border border-line bg-bg/90 backdrop-blur p-4 z-20 space-y-2 text-sm">
            <div className="flex items-center justify-between gap-2">
              <p className="font-semibold truncate">
                {sel.kind === "country" ? sel.name
                  : sel.kind === "ship" ? (sel.data.staticName || sel.data.name)
                  : sel.kind === "satellite" ? sel.data.name
                  : sel.kind === "plane" ? sel.data.callsign
                  : sel.kind === "news" ? `${sel.data.name} — news`
                  : sel.kind === "fire" ? "Fire detection"
                  : sel.kind === "conflict" ? `${sel.data.country} — conflict event`
                  : sel.kind === "disaster" ? ((DISASTER_TYPES[sel.data.type] || [])[1] || "Hazard") + ` — ${sel.data.country}`
                  : sel.kind === "project" ? `${sel.data.country} — World Bank`
                  : sel.kind === "mine" ? (sel.data.name || "Mine")
                  : sel.kind === "rig" ? (sel.data.name || "Offshore platform")
                  : `M${sel.data.mag?.toFixed(1)} earthquake`}
              </p>
              <button onClick={() => { setSelected(null); needsDraw.current = true; }} className="text-dim hover:text-text shrink-0" aria-label="Close">
                <X className="w-4 h-4" />
              </button>
            </div>

            {sel.kind === "country" && (
              <div className="text-xs space-y-1.5">
                {sel.yield === undefined ? (
                  <p className="text-dim">Loading bond data…</p>
                ) : sel.yield ? (
                  <>
                    <div className="flex items-center gap-2">
                      <Landmark className="w-3.5 h-3.5 text-accent" />
                      <span className="font-mono">10Y <span className="text-text font-semibold">{sel.yield.y10.toFixed(2)}%</span></span>
                      {sel.yield.spread != null && (
                        <span className={cn("font-mono", sel.yield.spread < 0 ? "text-down" : "text-up")}>
                          10Y−2Y {sel.yield.spread >= 0 ? "+" : ""}{sel.yield.spread.toFixed(2)}pp{sel.yield.spread < 0 ? " · inverted" : ""}
                        </span>
                      )}
                    </div>
                    <p className="text-dim">as of {sel.yield.asOf} · <a href="/macro/yields" className="text-accent hover:underline">full curve in Macro →</a></p>
                  </>
                ) : (
                  <p className="text-dim">No bond-yield coverage for this country in the archive.</p>
                )}
                {(() => {
                  const sc = instabRef.current.byId.get(sel.id);
                  return sc ? (
                    <p className="text-dim pt-1.5 border-t border-line/60">
                      Instability <span className="text-text font-semibold">{sc.score}</span>/100
                      {sc.inv ? ` · curve +${sc.inv}` : ""}{sc.newsPts ? ` · news +${sc.newsPts}` : ""}
                      {sc.kPts ? ` · conflict +${sc.kPts}` : ""}{sc.hPts ? ` · hazards +${sc.hPts}` : ""}{sc.qPts ? ` · quakes +${sc.qPts}` : ""}{sc.fPts ? ` · fires +${sc.fPts}` : ""}
                    </p>
                  ) : null;
                })()}
              </div>
            )}

            {sel.kind === "satellite" && (
              <div className="text-xs space-y-1.5">
                <p className="text-dim">{(SAT_GROUPS[sel.data.group] || [])[1] || "satellite"}</p>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono pt-1 border-t border-line/60">
                  <span className="text-dim">Altitude</span><span className="text-right">{fmtNum(sel.data.alt, 0)} km</span>
                  <span className="text-dim">Sub-point</span><span className="text-right">{sel.data.lat.toFixed(1)}, {sel.data.lon.toFixed(1)}</span>
                </div>
                <p className="text-[10px] text-dim/70">Live SGP4 from CelesTrak TLEs. Position is the ground track, not the orbit.</p>
              </div>
            )}

            {sel.kind === "ship" && (
              <div className="text-xs space-y-1.5">
                <p className="capitalize text-dim">{bucketOf(sel.data) === "other" && sel.data.type == null ? "type not yet broadcast" : bucketOf(sel.data)}</p>
                {sel.data.destination && <p className="font-mono"><span className="text-dim">Destination</span> <span className="text-text font-semibold ml-1">{sel.data.destination}</span></p>}
                {formatEta(sel.data.eta) && <p className="font-mono"><span className="text-dim">ETA</span> <span className="text-text ml-1">{formatEta(sel.data.eta)}</span> <span className="text-dim">(crew-entered)</span></p>}
                <div className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono pt-1 border-t border-line/60">
                  <span className="text-dim">Speed</span><span className="text-right">{(sel.data.sog ?? 0).toFixed(1)} kn</span>
                  <span className="text-dim">Course</span><span className="text-right">{Math.round(sel.data.cog ?? 0)}°</span>
                  <span className="text-dim">MMSI</span><span className="text-right">{sel.data.mmsi}</span>
                  {sel.data.draught ? (<><span className="text-dim">Draught</span><span className="text-right">{sel.data.draught.toFixed(1)} m</span></>) : null}
                </div>
              </div>
            )}

            {sel.kind === "plane" && (
              <div className="text-xs space-y-1.5">
                <p className="text-dim capitalize">{sel.data.category}{sel.data.type ? ` · ${sel.data.type}` : ""}{sel.data.reg ? ` · ${sel.data.reg}` : ""}</p>
                {sel.route === undefined ? <p className="text-dim">Looking up route…</p>
                  : sel.route ? (
                    <>
                      {sel.route.airline && <p className="text-dim">{sel.route.airline}</p>}
                      <p className="font-mono"><span className="text-text font-semibold">{sel.route.from}</span>
                        <span className="text-dim"> {sel.route.fromCity}</span>
                        <span className="text-accent mx-1.5">→</span>
                        <span className="text-text font-semibold">{sel.route.to}</span>
                        <span className="text-dim"> {sel.route.toCity}</span></p>
                    </>
                  ) : <p className="text-dim">Route unknown (community DB covers airlines, rarely GA/military).</p>}
                <div className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono pt-1 border-t border-line/60">
                  <span className="text-dim">Altitude</span><span className="text-right">{sel.data.onGround ? "ground" : `${fmtNum(sel.data.alt, 0)} ft`}</span>
                  <span className="text-dim">Speed</span><span className="text-right">{fmtNum(sel.data.gs, 0)} kt</span>
                  <span className="text-dim">Track</span><span className="text-right">{Math.round(sel.data.track)}°</span>
                </div>
              </div>
            )}

            {sel.kind === "news" && (
              <div className="text-xs space-y-2 max-h-72 overflow-y-auto">
                {sel.data.items.map((it, i) => (
                  <a key={i} href={it.link} target="_blank" rel="noreferrer"
                    className="block leading-snug hover:text-accent transition-colors">
                    {it.title}
                    <span className="block text-[10px] text-dim mt-0.5">{it.source}</span>
                  </a>
                ))}
                <p className="text-[10px] text-dim/70 pt-1">Headline keyword matching — first country named wins. Not NLP.</p>
              </div>
            )}

            {sel.kind === "rig" && (
              <div className="text-xs space-y-1.5">
                <p className="text-dim capitalize">{(RIG_TYPES[sel.data.k] || [])[1] || "platform"} · offshore</p>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono pt-1 border-t border-line/60">
                  <span className="text-dim">Position</span><span className="text-right">{sel.data.lat.toFixed(2)}, {sel.data.lon.toFixed(2)}</span>
                </div>
                <p className="text-[10px] text-dim/70">OpenStreetMap (man_made=offshore_platform), ODbL.</p>
              </div>
            )}

            {sel.kind === "mine" && (
              <div className="text-xs space-y-1.5">
                <p className="text-dim capitalize">{(MINE_TYPES[sel.data.commod] || [])[1] || "mineral"} · producing</p>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono pt-1 border-t border-line/60">
                  <span className="text-dim">Position</span><span className="text-right">{sel.data.lat.toFixed(2)}, {sel.data.lon.toFixed(2)}</span>
                </div>
                <p className="text-[10px] text-dim/70">USGS MRDS (Mineral Resources Data System, public domain). Coverage is US-dense.</p>
              </div>
            )}

            {sel.kind === "disaster" && (
              <div className="text-xs space-y-1.5">
                <p className="leading-snug">{sel.data.name}</p>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono pt-1 border-t border-line/60">
                  <span className="text-dim">Alert</span><span className={cn("text-right capitalize", sel.data.alert >= 2 ? "text-down" : sel.data.alert === 1 ? "text-amber" : "")}>{["green","orange","red"][sel.data.alert] || "green"}</span>
                  <span className="text-dim">Since</span><span className="text-right">{sel.data.date}</span>
                  {sel.data.severity ? (<><span className="text-dim">Severity</span><span className="text-right">{sel.data.severity}</span></>) : null}
                </div>
                <p className="text-dim">Source: GDACS (Global Disaster Alert &amp; Coordination System, UN/EC).</p>
              </div>
            )}

            {sel.kind === "project" && (
              <div className="text-xs space-y-1.5">
                <div className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono">
                  <span className="text-dim">Active projects</span><span className="text-right">{sel.data.count}</span>
                  <span className="text-dim">Total committed</span><span className="text-right">${(sel.data.usd / 1e9).toFixed(2)}B</span>
                </div>
                {sel.data.names?.length ? (
                  <ul className="space-y-1 pt-1 border-t border-line/60 max-h-40 overflow-y-auto">
                    {sel.data.names.map((n, i) => <li key={i} className="leading-snug text-dim">{n}</li>)}
                  </ul>
                ) : null}
                <p className="text-[10px] text-dim/70">Pinned at country centroid (WB API gives no per-project coords). Source: World Bank.</p>
              </div>
            )}

            {sel.kind === "fire" && (
              <div className="text-xs space-y-1.5">
                <div className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono">
                  <span className="text-dim">Radiative power</span><span className="text-right">{sel.data.frp} MW</span>
                  <span className="text-dim">Position</span><span className="text-right">{sel.data.lat.toFixed(2)}, {sel.data.lon.toFixed(2)}</span>
                </div>
                <p className="text-dim">VIIRS thermal anomaly, last 24h. Includes wildfires, agricultural burns, gas flares. Source: NASA FIRMS.</p>
              </div>
            )}

            {sel.kind === "conflict" && (
              <div className="text-xs space-y-1.5">
                <p className="text-dim capitalize">{(CONFLICT_TYPES[sel.data.type] || [])[1] || "organized violence"}</p>
                <p className="leading-snug">{sel.data.a}{sel.data.b ? <span className="text-dim"> vs </span> : null}{sel.data.b}</p>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono pt-1 border-t border-line/60">
                  <span className="text-dim">Fatalities (best)</span><span className="text-right">{sel.data.best}</span>
                  <span className="text-dim">Date</span><span className="text-right">{sel.data.date}</span>
                </div>
                <p className="text-dim">Source: UCDP candidate (preliminary monthly coding, Uppsala University).</p>
              </div>
            )}

            {sel.kind === "quake" && (
              <div className="text-xs space-y-1.5">
                <p className="text-dim">{sel.data.place}</p>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono pt-1 border-t border-line/60">
                  <span className="text-dim">Magnitude</span><span className="text-right">{sel.data.mag?.toFixed(1)}</span>
                  <span className="text-dim">Depth</span><span className="text-right">{fmtNum(sel.data.depth, 0)} km</span>
                  <span className="text-dim">When</span><span className="text-right">{new Date(sel.data.time).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} UTC</span>
                </div>
                <p className="text-dim">Source: USGS</p>
              </div>
            )}
          </div>
        )}
      </div>

      <p className="text-xs text-dim leading-relaxed">
        One map, all layers: real country borders (detailed 50m outlines load in the background),
        the global AIS fleet and worldwide air traffic (both pushed by our 24/7 agent),
        live satellites (SGP4 from CelesTrak),
        NASA FIRMS fires, GDACS disasters (floods/droughts/cyclones/wildfires),
        UCDP conflict events (~6 months, preliminary), USGS earthquakes (24h, M2.5+),
        power infrastructure, oil/NGL pipelines, producing mines and offshore platforms,
        GPS-interference cells (derived from our own ADS-B sweep),
        World Bank projects, submarine cables, news pins, chokepoints, and per-country
        instability signals. Ship/plane categories are filterable; hover a layer for
        "only" to view it solo. Click anything for
        details — countries show our London bond-yield data where covered.
      </p>
    </div>
  );
}
