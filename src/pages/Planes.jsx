import { useEffect, useMemo, useRef, useState } from "react";
import { Radio, Plane, X } from "lucide-react";
import { cn, fmtNum } from "@/lib/utils";
import { decodeLand, mercX, mercY } from "@/lib/ais";
import { REGIONS, fetchPlanes, fetchRoute } from "@/lib/planes";
import { vizColor } from "@/lib/vizColors";

// Plane Tracking — live aircraft from the community ADS-B network (adsb.lol),
// polled through our proxy every ~8s. Same self-contained canvas map as the
// ship tracker. Routes (origin → destination) come from the adsbdb community
// DB on selection — airlines are well covered, GA/military mostly aren't.
// Scheduled/actual departure & arrival TIMES are not in any free source
// (that's FlightAware-paid territory), so we don't pretend to show them.

const POLL_MS = 8000;
const FILTERS = [
  { id: "all", label: "All" },
  { id: "passenger", label: "Passenger" },
  { id: "cargo", label: "Cargo" },
  { id: "light", label: "Light / GA" },
  { id: "other", label: "Other" },
];
const CAT_COLOR = {
  passenger: "var(--viz-blue)",
  cargo: "var(--viz-amber)",
  light: "var(--viz-teal)",
  other: "var(--viz-pink)",
};

const cssRgb = (name) => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v ? `rgb(${v.replaceAll(" ", ",")})` : "#888";
};

export default function Planes() {
  const [region, setRegion] = useState("zurich");
  const [filter, setFilter] = useState("all");
  const [status, setStatus] = useState("connecting");
  const [counts, setCounts] = useState({ total: 0, passenger: 0, cargo: 0, light: 0, other: 0 });
  const [hover, setHover] = useState(null);      // { x, y, plane }
  const [selected, setSelected] = useState(null); // plane + route
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const landRef = useRef(null);
  const planesRef = useRef([]);
  const filterRef = useRef(filter);
  const viewRef = useRef({ cx: 0.5, cy: 0.5, scale: 1 });
  const needsDraw = useRef(true);
  filterRef.current = filter;

  useEffect(() => {
    fetch("/world-110m.json").then((r) => r.json()).then((topo) => {
      landRef.current = decodeLand(topo).map((poly) =>
        poly.map((ring) => ring.map(([lon, lat]) => [mercX(lon), mercY(lat)])));
      needsDraw.current = true;
    }).catch(() => { /* vessels still render */ });
  }, []);

  const fitRegion = (r) => {
    const dLat = r.radius / 60;
    const dLon = r.radius / (60 * Math.cos((r.lat * Math.PI) / 180));
    const x1 = mercX(r.lon - dLon), x2 = mercX(r.lon + dLon);
    const y1 = mercY(r.lat + dLat), y2 = mercY(r.lat - dLat);
    const el = wrapRef.current;
    const w = el?.clientWidth || 800, h = el?.clientHeight || 500;
    const scale = Math.min(w / (x2 - x1), h / (y2 - y1)) * 0.94;
    viewRef.current = { cx: (x1 + x2) / 2, cy: (y1 + y2) / 2, scale };
    needsDraw.current = true;
  };

  // Poll loop for the active region.
  useEffect(() => {
    const r = REGIONS.find((x) => x.id === region) || REGIONS[0];
    fitRegion(r);
    setSelected(null);
    let alive = true;
    const load = async () => {
      try {
        const planes = await fetchPlanes(r);
        if (!alive) return;
        planesRef.current = planes;
        const c = { total: planes.length, passenger: 0, cargo: 0, light: 0, other: 0 };
        for (const p of planes) c[p.category]++;
        setCounts(c);
        setStatus("live");
        needsDraw.current = true;
      } catch (e) {
        if (alive) setStatus(e.message);
      }
    };
    load();
    const id = setInterval(() => { if (!document.hidden) load(); }, POLL_MS);
    return () => { alive = false; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [region]);

  // Draw loop (shared style with the ship tracker).
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

      const tracePoly = (poly) => {
        ctx.beginPath();
        for (const ring of poly) {
          for (let i = 0; i < ring.length; i++) {
            const [u, v] = ring[i];
            if (i === 0 || Math.abs(u - ring[i - 1][0]) > 0.5) ctx.moveTo(X(u), Y(v));
            else ctx.lineTo(X(u), Y(v));
          }
        }
      };
      const landFill = cssRgb("--c-text");
      ctx.globalAlpha = 0.08; ctx.fillStyle = landFill;
      for (const poly of landRef.current || []) { tracePoly(poly); ctx.fill("evenodd"); }
      ctx.globalAlpha = 0.25; ctx.strokeStyle = landFill; ctx.lineWidth = 0.6;
      for (const poly of landRef.current || []) { tracePoly(poly); ctx.stroke(); }
      ctx.globalAlpha = 1;

      // Aircraft: triangles rotated to track, colored by category, dimmer on
      // the ground. Altitude shows in hover/detail, not on the glyph.
      const f = filterRef.current;
      for (const p of planesRef.current) {
        if (f !== "all" && p.category !== f) continue;
        const px = X(mercX(p.lon)), py = Y(mercY(p.lat));
        if (px < -10 || py < -10 || px > w + 10 || py > h + 10) continue;
        // Canvas can't resolve var() — CAT_COLOR is for DOM chips only.
        const VIZ = { passenger: "blue", cargo: "amber", light: "teal", other: "pink" };
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(((p.track || 0) * Math.PI) / 180);
        ctx.globalAlpha = p.onGround ? 0.35 : 0.9;
        ctx.fillStyle = vizColor(VIZ[p.category] || "pink");
        ctx.beginPath();
        ctx.moveTo(0, -5); ctx.lineTo(3.4, 4.4); ctx.lineTo(0, 2.2); ctx.lineTo(-3.4, 4.4);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Pan / zoom / hover / click-select.
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
    const nearest = (px, py) => {
      const { cx, cy, scale } = viewRef.current;
      const r = el.getBoundingClientRect();
      let best = null, bd = 144;
      for (const p of planesRef.current) {
        if (filterRef.current !== "all" && p.category !== filterRef.current) continue;
        const x = (mercX(p.lon) - cx) * scale + r.width / 2;
        const y = (mercY(p.lat) - cy) * scale + r.height / 2;
        const d = (x - px) ** 2 + (y - py) ** 2;
        if (d < bd) { bd = d; best = { x, y, plane: p }; }
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
        return;
      }
      setHover(nearest(p.px, p.py));
    };
    const onUp = (e) => {
      const wasClick = downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) < 5;
      drag = null; downAt = null;
      if (!wasClick) return;
      const r = el.getBoundingClientRect();
      const hit = nearest(e.clientX - r.left, e.clientY - r.top);
      if (!hit) { setSelected(null); return; }
      const plane = hit.plane;
      setSelected({ plane, route: undefined }); // undefined = route loading
      fetchRoute(plane.callsign).then((route) =>
        setSelected((cur) => (cur?.plane?.hex === plane.hex ? { plane: cur.plane, route } : cur)));
    };
    const onWheel = (e) => {
      e.preventDefault();
      const p = toWorld(e);
      const factor = Math.exp(-e.deltaY * 0.0015);
      const view = viewRef.current;
      const ns = Math.max(300, Math.min(600_000, view.scale * factor));
      view.cx = p.u - (p.u - view.cx) * (view.scale / ns);
      view.cy = p.v - (p.v - view.cy) * (view.scale / ns);
      view.scale = ns;
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
  }, []);

  useEffect(() => { needsDraw.current = true; }, [filter]);

  const sel = selected?.plane;
  const filterCounts = useMemo(() => ({
    all: counts.total, passenger: counts.passenger, cargo: counts.cargo,
    light: counts.light, other: counts.other,
  }), [counts]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {REGIONS.map((r) => (
          <button key={r.id} onClick={() => setRegion(r.id)}
            className={cn("chip", region === r.id ? "chip-active" : "chip-idle")}>
            {r.label}
          </button>
        ))}
        <span title={status}
          className={cn("ml-auto inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wide max-w-[340px] truncate",
            status === "live" ? "border-up/40 bg-up/10 text-up uppercase" : "border-line bg-bg text-dim")}>
          <Radio className="w-3 h-3 shrink-0" /> {status}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {FILTERS.map((f) => (
          <button key={f.id} onClick={() => setFilter(f.id)}
            className={cn("chip !text-[11px] flex items-center gap-1.5", filter === f.id ? "chip-active" : "chip-idle")}>
            {f.id !== "all" && <span className="w-2 h-2 rounded-full" style={{ background: CAT_COLOR[f.id] }} />}
            {f.label}
            <span className="font-mono text-[10px] opacity-70">{fmtNum(filterCounts[f.id] ?? 0, 0)}</span>
          </button>
        ))}
      </div>

      <div className="grid lg:grid-cols-[1fr_290px] gap-3 [&>*]:min-w-0">
        <div ref={wrapRef} className="relative rounded-xl border border-line lg-glass overflow-hidden cursor-grab active:cursor-grabbing"
          style={{ height: "min(58vh, 600px)" }}>
          <canvas ref={canvasRef} className="block w-full h-full" />
          {hover && (
            <div className="absolute pointer-events-none rounded-lg border border-line bg-bg/95 px-2.5 py-1.5 text-[11px] font-mono whitespace-nowrap z-10"
              style={{ left: hover.x + 12, top: hover.y - 10 }}>
              <span className="text-text font-semibold">{hover.plane.callsign}</span>
              <span className="text-dim ml-2">{hover.plane.type}</span>
              <span className="text-dim ml-2">{hover.plane.onGround ? "ground" : `${fmtNum(hover.plane.alt, 0)} ft`}</span>
            </div>
          )}
          <p className="absolute bottom-2 left-3 text-[10px] text-dim pointer-events-none">
            drag = pan · wheel = zoom · click a plane for route &amp; details
          </p>
        </div>

        {/* Detail panel */}
        <div className="rounded-xl border border-line lg-glass p-4">
          {!sel ? (
            <div className="h-full grid place-items-center text-center">
              <div>
                <Plane className="w-6 h-6 text-dim mx-auto mb-2" />
                <p className="text-sm text-dim leading-relaxed">Click an aircraft on the map<br />for route &amp; details.</p>
              </div>
            </div>
          ) : (
            <div className="space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <p className="font-semibold font-mono">{sel.callsign}</p>
                <button onClick={() => setSelected(null)} className="text-dim hover:text-text" aria-label="Close details">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full" style={{ background: CAT_COLOR[sel.category] }} />
                <span className="text-xs text-dim capitalize">{sel.category}</span>
                {sel.type && <span className="text-xs font-mono text-dim">· {sel.type}</span>}
                {sel.reg && <span className="text-xs font-mono text-dim">· {sel.reg}</span>}
              </div>
              <div className="border-t border-line/60 pt-2 text-xs space-y-1.5">
                {selected.route === undefined ? (
                  <p className="text-dim">Looking up route…</p>
                ) : selected.route ? (
                  <>
                    {selected.route.airline && <p className="text-dim">{selected.route.airline}</p>}
                    <p className="font-mono text-sm">
                      <span className="text-text font-semibold">{selected.route.from}</span>
                      <span className="text-dim"> {selected.route.fromCity}</span>
                      <span className="text-accent mx-2">→</span>
                      <span className="text-text font-semibold">{selected.route.to}</span>
                      <span className="text-dim"> {selected.route.toCity}</span>
                    </p>
                  </>
                ) : (
                  <p className="text-dim">Route unknown — the community DB covers airlines, rarely GA/military.</p>
                )}
              </div>
              <div className="border-t border-line/60 pt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs font-mono">
                <span className="text-dim">Altitude</span><span className="text-right">{sel.onGround ? "on ground" : `${fmtNum(sel.alt, 0)} ft`}</span>
                <span className="text-dim">Ground speed</span><span className="text-right">{fmtNum(sel.gs, 0)} kt</span>
                <span className="text-dim">Track</span><span className="text-right">{Math.round(sel.track)}°</span>
                <span className="text-dim">Vert. rate</span>
                <span className={cn("text-right", sel.vr > 200 ? "text-up" : sel.vr < -200 ? "text-down" : "")}>
                  {sel.vr > 0 ? "+" : ""}{fmtNum(sel.vr, 0)} ft/min
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      <p className="text-xs text-dim leading-relaxed">
        Community ADS-B data (adsb.lol) polled every 8s, routes from the adsbdb community DB — both
        free, no keys. Honest limits: origin/destination airports come from a community mapping
        (airlines well covered, private/military mostly not), and scheduled or actual departure/
        arrival <em>times</em> exist only in paid data (FlightAware &amp; co) — so we don't show any.
      </p>
    </div>
  );
}
