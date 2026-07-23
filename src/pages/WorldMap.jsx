import { useEffect, useMemo, useRef, useState } from "react";
import { Layers, X, Ship, Plane, Activity, Anchor, Landmark, Radio } from "lucide-react";
import { cn, fmtNum, fmtPct } from "@/lib/utils";
import { connectAis, shipCategory, formatEta, CORRIDORS } from "@/lib/ais";
import { fetchPlanes, fetchRoute } from "@/lib/planes";
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
  { id: "planes", label: "Air traffic", icon: Plane, hint: "streams within 250 nm of map centre" },
  { id: "quakes", label: "Earthquakes (24h)", icon: Activity },
  { id: "chokepoints", label: "Chokepoints", icon: Anchor },
];

const LS_LAYERS = "quant_map_layers";
const loadLayers = () => {
  try {
    const v = JSON.parse(localStorage.getItem(LS_LAYERS) || "null");
    if (v && typeof v === "object") return { ships: true, planes: false, quakes: true, chokepoints: true, ...v };
  } catch { /* fall through */ }
  return { ships: true, planes: false, quakes: true, chokepoints: true };
};

const cssRgb = (name) => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v ? `rgb(${v.replaceAll(" ", ",")})` : "#888";
};

export default function WorldMap() {
  const [layers, setLayers] = useState(loadLayers);
  const [shipStatus, setShipStatus] = useState("off");
  const [planeStatus, setPlaneStatus] = useState("off");
  const [hover, setHover] = useState(null);       // { x, y, label, sub }
  const [hoverCountry, setHoverCountry] = useState(null); // name (for redraw)
  const [selected, setSelected] = useState(null); // { kind, ...data }
  const [counts, setCounts] = useState({ ships: 0, planes: 0, quakes: 0 });

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
  const connRef = useRef(null);
  const layersRef = useRef(layers);
  layersRef.current = layers;
  selectedRef.current = selected;

  const toggleLayer = (id) => {
    setLayers((l) => {
      const next = { ...l, [id]: !l[id] };
      try { localStorage.setItem(LS_LAYERS, JSON.stringify(next)); } catch { /* quota */ }
      return next;
    });
  };

  /* ── Country geometry: fast 110m first, exact 50m swapped in silently ── */
  useEffect(() => {
    let alive = true;
    fetch("/world-countries-110m.json").then((r) => r.json()).then((topo) => {
      if (!alive) return;
      countriesRef.current = projectCountries(decodeCountries(topo));
      needsDraw.current = true;
      // Detail upgrade in the background — exact borders, no coarse fallback.
      fetch("/world-countries-50m.json").then((r) => r.json()).then((topo50) => {
        if (!alive) return;
        countriesRef.current = projectCountries(decodeCountries(topo50));
        needsDraw.current = true;
      }).catch(() => { /* stay on 110m */ });
    }).catch(() => { /* map renders data layers only */ });
    return () => { alive = false; };
  }, []);

  /* ── Yield lookup for the country panel (LSE covers 34 countries) ────── */
  const yieldLookupRef = useRef(null);
  const yieldCacheRef = useRef(new Map());
  useEffect(() => {
    fetchYieldStats()
      .then((s) => { yieldLookupRef.current = yieldCodeLookup(s.countries); })
      .catch(() => { /* panel simply shows no yield data */ });
  }, []);

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
    return { lat: invMercLat(cy), lon: invMercLon(cx) };
  };

  /* ── Ships layer (AIS relay, viewport-scoped, re-subscribed on move) ── */
  const resubTimer = useRef(null);
  useEffect(() => {
    if (!layers.ships) { setShipStatus("off"); return; }
    const conn = connectAis({
      bbox: viewportBbox(),
      onStatus: setShipStatus,
      onPosition: (p) => {
        const store = vesselsRef.current;
        const prev = store.get(p.mmsi);
        store.set(p.mmsi, prev ? { ...prev, ...p } : p);
        if (store.size > MAX_VESSELS) {
          const sorted = [...store.entries()].sort((a, b) => a[1].t - b[1].t);
          for (let i = 0; i < sorted.length / 5; i++) store.delete(sorted[i][0]);
        }
        needsDraw.current = true;
      },
      onStatic: (s) => {
        const store = vesselsRef.current;
        const prev = store.get(s.mmsi);
        store.set(s.mmsi, { ...(prev || { mmsi: s.mmsi, t: Date.now() }), ...s });
      },
    });
    connRef.current = conn;
    return () => { connRef.current = null; conn.close(); setShipStatus("off"); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layers.ships]);

  // Debounced re-subscribe after pan/zoom (aisstream allows 1 update/s).
  const scheduleResub = () => {
    if (!layersRef.current.ships || !connRef.current) return;
    clearTimeout(resubTimer.current);
    resubTimer.current = setTimeout(() => connRef.current?.subscribe(viewportBbox()), 1200);
  };

  /* ── Planes layer (poll around map centre) ───────────────────────────── */
  useEffect(() => {
    if (!layers.planes) { planesRef.current = []; setPlaneStatus("off"); needsDraw.current = true; return; }
    let alive = true;
    const load = async () => {
      try {
        const c = viewportCenter();
        const planes = await fetchPlanes({ lat: c.lat, lon: c.lon, radius: 250 });
        if (!alive) return;
        planesRef.current = planes;
        setPlaneStatus("live");
        needsDraw.current = true;
      } catch (e) { if (alive) setPlaneStatus(e.message); }
    };
    load();
    const id = setInterval(() => { if (!document.hidden) load(); }, 8000);
    return () => { alive = false; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layers.planes]);

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
      let ships = 0;
      for (const v of store.values()) if (v.lat != null) ships++;
      setCounts({ ships, planes: planesRef.current.length, quakes: quakesRef.current.length });
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
      const { cx, cy, scale } = viewRef.current;
      const X = (u) => (u - cx) * scale + w / 2;
      const Y = (v) => (v - cy) * scale + h / 2;
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
      for (const c of countriesRef.current) {
        const hot = c.id === hovId || c.id === selId;
        // Cheap viewport cull via first polygon bbox union
        trace(c.polys);
        ctx.fillStyle = hot ? accent : ink;
        ctx.globalAlpha = hot ? 0.14 : 0.06;
        ctx.fill("evenodd");
        ctx.strokeStyle = hot ? accent : ink;
        ctx.globalAlpha = hot ? 0.8 : 0.2;
        ctx.lineWidth = hot ? 1.2 : 0.5;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // Quakes: circles sized by magnitude.
      if (L.quakes) {
        const qc = vizColor("pink");
        for (const q of quakesRef.current) {
          const px = X(mercX(q.lon)), py = Y(mercY(q.lat));
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
        for (const v of vesselsRef.current.values()) {
          if (v.lat == null) continue;
          const px = X(mercX(v.lon)), py = Y(mercY(v.lat));
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
        for (const p of planesRef.current) {
          const px = X(mercX(p.lon)), py = Y(mercY(p.lat));
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
          const px = X(mercX(cp.lon)), py = Y(mercY(cp.lat));
          if (px < -20 || py < -20 || px > w + 20 || py > h + 20) continue;
          ctx.globalAlpha = 0.9;
          ctx.save();
          ctx.translate(px, py);
          ctx.rotate(Math.PI / 4);
          ctx.fillRect(-3, -3, 6, 6);
          ctx.restore();
          if (scale > 1600) {
            ctx.globalAlpha = 0.75;
            ctx.font = "10px ui-monospace, monospace";
            ctx.fillText(cp.label, px + 7, py + 3);
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
      const P = (lon, lat) => [(mercX(lon) - cx) * scale + r.width / 2, (mercY(lat) - cy) * scale + r.height / 2];
      let best = null, bd = 144;
      const L = layersRef.current;
      if (L.planes) for (const p of planesRef.current) {
        const [x, y] = P(p.lon, p.lat);
        const d = (x - px) ** 2 + (y - py) ** 2;
        if (d < bd) { bd = d; best = { kind: "plane", x, y, data: p }; }
      }
      if (L.ships) for (const v of vesselsRef.current.values()) {
        if (v.lat == null) continue;
        const [x, y] = P(v.lon, v.lat);
        const d = (x - px) ** 2 + (y - py) ** 2;
        if (d < bd) { bd = d; best = { kind: "ship", x, y, data: v }; }
      }
      if (L.quakes) for (const q of quakesRef.current) {
        const [x, y] = P(q.lon, q.lat);
        const d = (x - px) ** 2 + (y - py) ** 2;
        if (d < bd) { bd = d; best = { kind: "quake", x, y, data: q }; }
      }
      return best;
    };
    const onDown = (e) => { drag = toWorld(e); downAt = { x: e.clientX, y: e.clientY }; el.setPointerCapture(e.pointerId); };
    const onMove = (e) => {
      const p = toWorld(e);
      if (drag) {
        viewRef.current.cx += drag.u - p.u;
        viewRef.current.cy += drag.v - p.v;
        needsDraw.current = true;
        setHover(null);
        scheduleResub();
        return;
      }
      const obj = nearestObject(p.px, p.py);
      if (obj) {
        if (hoverCountryRef.current) { hoverCountryRef.current = null; setHoverCountry(null); needsDraw.current = true; }
        const d = obj.data;
        setHover({
          x: obj.x, y: obj.y,
          label: obj.kind === "ship" ? (d.staticName || d.name) : obj.kind === "plane" ? d.callsign : `M${d.mag?.toFixed(1)}`,
          sub: obj.kind === "ship" ? `${(d.sog ?? 0).toFixed(1)} kn${d.destination ? ` → ${d.destination}` : ""}`
            : obj.kind === "plane" ? `${d.type || ""} ${d.onGround ? "ground" : fmtNum(d.alt, 0) + " ft"}`
            : d.place,
        });
        return;
      }
      setHover(null);
      const c = countryAt(countriesRef.current, p.u, p.v);
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
      const c = countryAt(countriesRef.current, u, v);
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
      e.preventDefault();
      const p = toWorld(e);
      const f = Math.exp(-e.deltaY * 0.0015);
      const view = viewRef.current;
      const ns = Math.max(250, Math.min(600_000, view.scale * f));
      view.cx = p.u - (p.u - view.cx) * (view.scale / ns);
      view.cy = p.v - (p.v - view.cy) * (view.scale / ns);
      view.scale = ns;
      needsDraw.current = true;
      scheduleResub();
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
    needsDraw.current = true;
    scheduleResub();
  };

  const sel = selected;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => { viewRef.current = { cx: 0.5, cy: 0.42, scale: (wrapRef.current?.clientWidth || 800) * 1.05 }; needsDraw.current = true; scheduleResub(); }}
          className="chip chip-idle">World</button>
        {CHOKEPOINTS.map((cp) => (
          <button key={cp.id} onClick={() => jumpTo(cp)} className="chip chip-idle">{cp.label}</button>
        ))}
        <span title={`ships: ${shipStatus} · planes: ${planeStatus}`}
          className={cn("ml-auto inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wide max-w-[300px] truncate",
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

          {/* Layer panel (worldmonitor-style, our design language) */}
          <div className="absolute top-3 left-3 rounded-xl border border-line bg-bg/85 backdrop-blur px-3 py-2.5 z-10 w-52">
            <p className="text-[10px] uppercase tracking-widest text-dim mb-1.5 flex items-center gap-1.5">
              <Layers className="w-3 h-3" /> Layers
            </p>
            {LAYER_DEFS.map((ld) => (
              <label key={ld.id} className="flex items-center gap-2 py-1 cursor-pointer select-none">
                <input type="checkbox" checked={!!layers[ld.id]} onChange={() => toggleLayer(ld.id)} className="accent-current w-3.5 h-3.5" />
                <ld.icon className="w-3.5 h-3.5 text-dim" />
                <span className="text-xs">{ld.label}</span>
                <span className="ml-auto text-[10px] font-mono text-dim">
                  {ld.id === "ships" ? fmtNum(counts.ships, 0) : ld.id === "planes" ? fmtNum(counts.planes, 0) : ld.id === "quakes" ? fmtNum(counts.quakes, 0) : ""}
                </span>
              </label>
            ))}
            <p className="text-[9px] text-dim/70 leading-snug mt-1">Air traffic streams within 250 nm of the map centre.</p>
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
          <p className="absolute bottom-2 right-3 text-[10px] text-dim pointer-events-none">
            drag = pan · wheel = zoom · click country / ship / plane / quake
          </p>
        </div>

        {/* Selection panel */}
        {sel && (
          <div className="absolute top-3 right-3 w-72 max-w-[calc(100%-1.5rem)] rounded-xl border border-line bg-bg/90 backdrop-blur p-4 z-20 space-y-2 text-sm">
            <div className="flex items-center justify-between gap-2">
              <p className="font-semibold truncate">
                {sel.kind === "country" ? sel.name
                  : sel.kind === "ship" ? (sel.data.staticName || sel.data.name)
                  : sel.kind === "plane" ? sel.data.callsign
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
        live AIS ships scoped to the viewport, community ADS-B air traffic around the map centre,
        USGS earthquakes (24h, M2.5+), and the trade chokepoints. Click anything for details —
        countries show our London bond-yield data where covered.
      </p>
    </div>
  );
}
