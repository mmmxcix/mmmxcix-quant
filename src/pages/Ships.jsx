import { useEffect, useMemo, useRef, useState } from "react";
import { Radio, Anchor } from "lucide-react";
import { cn, fmtNum } from "@/lib/utils";
import { connectAis, decodeLand, mercX, mercY, CORRIDORS } from "@/lib/ais";

// Ship Tracking — live AIS vessel positions on a self-contained canvas map
// (vendored Natural Earth coastlines, no external tiles → CSP stays tight,
// dark theme stays dark). Data flows through our websocket relay
// (/api/ais-stream): aisstream.io blocks browser connections, so the Pages
// Function bridges the stream and injects the key server-side. No key entry
// anywhere — works on every device with the dev session.

const STALE_MS = 10 * 60_000; // drop vessels not heard from in 10 min
const MAX_VESSELS = 6000;

const cssRgb = (name) => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v ? `rgb(${v.replaceAll(" ", ",")})` : "#888";
};

export default function Ships() {
  const key = true; // relay handles auth + key — nothing to enter client-side
  const [corridor, setCorridor] = useState("world");
  const [status, setStatus] = useState("connecting");
  const [stats, setStats] = useState({ vessels: 0, moving: 0, anchored: 0, rate: 0 });
  const [hover, setHover] = useState(null); // { x, y, vessel }

  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const landRef = useRef(null);       // decoded polygons (screen-independent)
  const vesselsRef = useRef(new Map()); // mmsi → { lat, lon, sog, cog, name, t }
  const viewRef = useRef({ cx: 0.5, cy: 0.5, scale: 1 }); // unit-square camera
  const connRef = useRef(null);
  const msgCount = useRef(0);
  const needsDraw = useRef(true);

  // World map (vendored, 55 KB) — fetched once, decoded once.
  useEffect(() => {
    fetch("/world-110m.json").then((r) => r.json()).then((topo) => {
      landRef.current = decodeLand(topo).map((poly) =>
        poly.map((ring) => ring.map(([lon, lat]) => [mercX(lon), mercY(lat)])));
      needsDraw.current = true;
    }).catch(() => { /* map missing — vessels still render */ });
  }, []);

  const fitBbox = (bbox) => {
    const [[latMin, lonMin], [latMax, lonMax]] = bbox;
    const x1 = mercX(lonMin), x2 = mercX(lonMax);
    const y1 = mercY(latMax), y2 = mercY(latMin); // y is inverted
    const el = wrapRef.current;
    const w = el?.clientWidth || 800, h = el?.clientHeight || 500;
    const scale = Math.min(w / (x2 - x1 || 1e-6), h / (y2 - y1 || 1e-6)) * 0.92;
    viewRef.current = { cx: (x1 + x2) / 2, cy: (y1 + y2) / 2, scale };
    needsDraw.current = true;
  };

  // AIS connection — reopened when the key changes; corridor switches
  // re-subscribe on the same socket and re-center the camera.
  useEffect(() => {
    if (!key) return;
    const bbox = CORRIDORS.find((c) => c.id === corridor)?.bbox || CORRIDORS[0].bbox;
    fitBbox(bbox);
    const conn = connectAis({
      bbox,
      onStatus: setStatus,
      onPosition: (p) => {
        const store = vesselsRef.current;
        store.set(p.mmsi, p);
        msgCount.current++;
        if (store.size > MAX_VESSELS) {
          // Drop the stalest fifth so we never do this per message.
          const sorted = [...store.entries()].sort((a, b) => a[1].t - b[1].t);
          for (let i = 0; i < sorted.length / 5; i++) store.delete(sorted[i][0]);
        }
        needsDraw.current = true;
      },
    });
    connRef.current = conn;
    return () => { connRef.current = null; conn.close(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const switchCorridor = (id) => {
    setCorridor(id);
    const bbox = CORRIDORS.find((c) => c.id === id)?.bbox || CORRIDORS[0].bbox;
    connRef.current?.subscribe(bbox);
    fitBbox(bbox);
  };

  // Stats + stale pruning on a slow tick.
  useEffect(() => {
    if (!key) return;
    const id = setInterval(() => {
      const store = vesselsRef.current;
      const now = Date.now();
      for (const [mmsi, v] of store) if (now - v.t > STALE_MS) store.delete(mmsi);
      let moving = 0, anchored = 0;
      for (const v of store.values()) (v.sog >= 0.5 ? moving++ : anchored++);
      setStats({ vessels: store.size, moving, anchored, rate: msgCount.current / 5 });
      msgCount.current = 0;
      needsDraw.current = true;
    }, 5000);
    return () => clearInterval(id);
  }, [key]);

  // Render loop — draws only when something changed (stream, pan, resize).
  useEffect(() => {
    if (!key) return;
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

      // Land. Rings that wrap the antimeridian (Russia, Antarctica, Fiji)
      // would otherwise draw as long horizontal streaks across the map —
      // break the path whenever a segment jumps more than half the world.
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
      ctx.globalAlpha = 0.08;
      ctx.fillStyle = landFill;
      const land = landRef.current || [];
      for (const poly of land) { tracePoly(poly); ctx.fill("evenodd"); }
      ctx.globalAlpha = 0.25;
      ctx.strokeStyle = landFill;
      ctx.lineWidth = 0.6;
      for (const poly of land) { tracePoly(poly); ctx.stroke(); }
      ctx.globalAlpha = 1;

      // Vessels: moving = up-green with a heading tick, near-stationary = dim.
      const upCol = cssRgb("--c-up"), dimCol = cssRgb("--c-dim");
      for (const v of vesselsRef.current.values()) {
        const px = X(mercX(v.lon)), py = Y(mercY(v.lat));
        if (px < -8 || py < -8 || px > w + 8 || py > h + 8) continue;
        const moving = v.sog >= 0.5;
        ctx.fillStyle = moving ? upCol : dimCol;
        ctx.globalAlpha = moving ? 0.9 : 0.55;
        ctx.beginPath();
        ctx.arc(px, py, moving ? 2.2 : 1.6, 0, Math.PI * 2);
        ctx.fill();
        if (moving && scale > 2000) {
          const a = ((v.cog - 90) * Math.PI) / 180;
          ctx.strokeStyle = upCol;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(px, py);
          ctx.lineTo(px + Math.cos(a) * 7, py + Math.sin(a) * 7);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [key]);

  // Pan / zoom / hover — same interaction model as the Brain Vault.
  useEffect(() => {
    if (!key) return;
    const el = wrapRef.current;
    if (!el) return;
    let drag = null;
    const toWorld = (e) => {
      const r = el.getBoundingClientRect();
      const { cx, cy, scale } = viewRef.current;
      return {
        u: (e.clientX - r.left - r.width / 2) / scale + cx,
        v: (e.clientY - r.top - r.height / 2) / scale + cy,
        px: e.clientX - r.left, py: e.clientY - r.top,
      };
    };
    const onDown = (e) => { drag = toWorld(e); el.setPointerCapture(e.pointerId); };
    const onMove = (e) => {
      const p = toWorld(e);
      if (drag) {
        viewRef.current.cx += drag.u - p.u;
        viewRef.current.cy += drag.v - p.v;
        needsDraw.current = true;
        setHover(null);
        return;
      }
      // Hover: nearest vessel within 10 px.
      const { cx, cy, scale } = viewRef.current;
      const r = el.getBoundingClientRect();
      let best = null, bd = 100;
      for (const v of vesselsRef.current.values()) {
        const px = (mercX(v.lon) - cx) * scale + r.width / 2;
        const py = (mercY(v.lat) - cy) * scale + r.height / 2;
        const d = (px - p.px) ** 2 + (py - p.py) ** 2;
        if (d < bd) { bd = d; best = { x: px, y: py, vessel: v }; }
      }
      setHover(best);
    };
    const onUp = () => { drag = null; };
    const onWheel = (e) => {
      e.preventDefault();
      const p = toWorld(e);
      const f = Math.exp(-e.deltaY * 0.0015);
      const view = viewRef.current;
      const ns = Math.max(200, Math.min(400_000, view.scale * f));
      // Zoom toward the cursor.
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
  }, [key]);

  const congestion = useMemo(() => {
    const total = stats.moving + stats.anchored;
    return total ? Math.round((stats.anchored / total) * 100) : null;
  }, [stats]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {CORRIDORS.map((c) => (
          <button key={c.id} onClick={() => switchCorridor(c.id)}
            className={cn("chip", corridor === c.id ? "chip-active" : "chip-idle")}>
            {c.label}
          </button>
        ))}
        <span title={status}
          className={cn("ml-auto inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wide max-w-[340px] truncate",
          status === "live" ? "border-up/40 bg-up/10 text-up uppercase" : "border-line bg-bg text-dim")}>
          <Radio className="w-3 h-3 shrink-0" /> {status}
        </span>
      </div>

      <div ref={wrapRef} className="relative rounded-xl border border-line lg-glass overflow-hidden cursor-grab active:cursor-grabbing"
        style={{ height: "min(62vh, 640px)" }}>
        <canvas ref={canvasRef} className="block w-full h-full" />
        {hover && (
          <div className="absolute pointer-events-none rounded-lg border border-line bg-bg/95 px-2.5 py-1.5 text-[11px] font-mono whitespace-nowrap z-10"
            style={{ left: hover.x + 12, top: hover.y - 10 }}>
            <span className="text-text font-semibold">{hover.vessel.name}</span>
            <span className="text-dim ml-2">{hover.vessel.sog.toFixed(1)} kn · {Math.round(hover.vessel.cog)}°</span>
          </div>
        )}
        <p className="absolute bottom-2 left-3 text-[10px] text-dim pointer-events-none">
          drag = pan · wheel = zoom · hover a dot for vessel info
        </p>
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs font-mono">
        <span className="text-dim">vessels <span className="text-text">{fmtNum(stats.vessels, 0)}</span></span>
        <span className="text-dim">under way <span className="text-up">{fmtNum(stats.moving, 0)}</span></span>
        <span className="text-dim"><Anchor className="w-3 h-3 inline -mt-0.5" /> anchored/moored <span className="text-text">{fmtNum(stats.anchored, 0)}</span></span>
        {congestion != null && (
          <span className="text-dim">congestion proxy <span className={congestion > 55 ? "text-down" : "text-text"}>{congestion}%</span></span>
        )}
        <span className="text-dim">{stats.rate.toFixed(0)} msg/s</span>
      </div>
      <p className="text-xs text-dim leading-relaxed">
        Live AIS position reports via the site's stream relay (aisstream.io; key server-side, dev
        session required). Vessels fade out after 10 minutes without a report. "Congestion proxy" =
        share of ships at ≤0.5 kn in the current corridor — a rough anchorage/queue indicator, not an
        official port metric. Coverage depends on volunteer AIS receivers: open ocean is sparse,
        coasts and choke points are dense. aisstream is a free community service — brief outages
        happen; the page reconnects on its own.
      </p>
    </div>
  );
}
