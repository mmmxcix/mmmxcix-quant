import { useEffect, useReducer, useRef, useState } from "react";
import {
  POINTS_REQUIRED,
  fibLevels,
  loadDrawings,
  newId,
  saveDrawings,
} from "../lib/drawings";

// Tool descriptors for the parent-rendered toolbar. `icon` is the *name* of a
// lucide-react component (the parent resolves it to a real component), so this
// module stays free of icon imports. The trailing "clear" entry is the
// "alle löschen" affordance, not a placement tool.
export const DRAW_TOOLS = [
  { id: "trendline", label: "Trendlinie", icon: "TrendingUp" },
  { id: "horizontal", label: "Horizontale (SL/TP)", icon: "Minus" },
  { id: "ray", label: "Strahl", icon: "MoveHorizontal" },
  { id: "vertical", label: "Vertikale", icon: "AlignVerticalJustifyCenter" },
  { id: "rectangle", label: "Rechteck (Zone)", icon: "Square" },
  { id: "fib", label: "Fibonacci", icon: "GitBranch" },
  { id: "clear", label: "Alle löschen", icon: "Trash2" },
];

// Locale-aware price formatting with a sensible number of decimals.
function fmt(v) {
  if (v == null || !isFinite(v)) return "";
  const a = Math.abs(v);
  const dec = a >= 1000 ? 0 : a >= 1 ? 2 : a >= 0.01 ? 4 : 6;
  return v.toLocaleString("de-DE", { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

// Given a segment p1→p2, return the point where the forward extension (a ray
// leaving p1 through p2) meets the [0,w]×[0,h] viewport boundary.
function rayEnd(x1, y1, x2, y2, w, h) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx === 0 && dy === 0) return { x: x2, y: y2 };
  const cands = [];
  if (dx !== 0) {
    cands.push((0 - x1) / dx, (w - x1) / dx);
  }
  if (dy !== 0) {
    cands.push((0 - y1) / dy, (h - y1) / dy);
  }
  let best = null;
  for (const t of cands) {
    if (t <= 0) continue; // forward direction only
    const px = x1 + t * dx;
    const py = y1 + t * dy;
    if (px >= -1 && px <= w + 1 && py >= -1 && py <= h + 1) {
      if (best === null || t < best) best = t;
    }
  }
  if (best === null) return { x: x2, y: y2 };
  return { x: x1 + best * dx, y: y1 + best * dy };
}

/**
 * Transparent overlay that captures clicks to place drawings and renders all
 * drawings (existing + in-progress) as an SVG on top of a lightweight-charts
 * price chart.
 *
 * Props contract:
 *   chart          lightweight-charts IChartApi instance
 *   series         the price series (used for price↔coordinate conversions)
 *   containerRef   ref to the chart's container <div> (defines the overlay box)
 *   chartKey       persistence + reload key, e.g. "crypto:BTCUSDT"
 *   activeTool     one of DRAW_TOOLS ids or null; null = chart interactive
 *   color          hex color applied to newly-created drawings
 *   onToolConsumed callback fired after a drawing commits (parent resets tool)
 */
export default function ChartDrawLayer({
  chart,
  series,
  containerRef,
  chartKey,
  activeTool,
  color = "#38bdf8",
  onToolConsumed,
}) {
  const overlayRef = useRef(null);
  const pendingRef = useRef([]); // chart-coord points collected so far
  const mouseRef = useRef(null); // last cursor position in overlay pixels
  const [drawings, setDrawings] = useState(() => loadDrawings(chartKey));
  const [selected, setSelected] = useState(null);
  const [, forceRender] = useReducer((n) => n + 1, 0);

  const placing = activeTool && activeTool !== "clear";

  // Reload persisted drawings when the symbol/timeframe key changes.
  useEffect(() => {
    setDrawings(loadDrawings(chartKey));
    setSelected(null);
    pendingRef.current = [];
  }, [chartKey]);

  // Persist on every change to the drawing list.
  useEffect(() => {
    saveDrawings(chartKey, drawings);
  }, [chartKey, drawings]);

  // A fresh tool cancels any half-placed drawing.
  useEffect(() => {
    pendingRef.current = [];
    if (placing) setSelected(null);
    forceRender();
  }, [activeTool, placing]);

  // "clear" is a pseudo-tool: wipe everything and hand control straight back.
  useEffect(() => {
    if (activeTool === "clear") {
      setDrawings([]);
      setSelected(null);
      onToolConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTool]);

  // Re-render the SVG whenever the chart pans/zooms or the container resizes so
  // that every drawing tracks the underlying price/time coordinates.
  useEffect(() => {
    if (!chart || !containerRef?.current) return;
    const ts = chart.timeScale();
    const onRange = () => forceRender();
    ts.subscribeVisibleLogicalRangeChange(onRange);
    const ro = new ResizeObserver(() => forceRender());
    ro.observe(containerRef.current);
    return () => {
      try {
        ts.unsubscribeVisibleLogicalRangeChange(onRange);
      } catch {
        /* chart already disposed */
      }
      ro.disconnect();
    };
  }, [chart, containerRef]);

  if (!chart || !series || !containerRef?.current) {
    return <div ref={overlayRef} style={overlayStyle(false)} />;
  }

  const el = containerRef.current;
  const width = el.clientWidth || 0;
  const height = el.clientHeight || 0;

  // Coordinate conversions (null-safe: return null for off-screen values).
  const toX = (time) => {
    if (time == null) return null;
    const c = chart.timeScale().timeToCoordinate(time);
    return c == null ? null : c;
  };
  const toY = (price) => {
    if (price == null) return null;
    const c = series.priceToCoordinate(price);
    return c == null ? null : c;
  };
  const fromXY = (x, y) => ({
    time: chart.timeScale().coordinateToTime(x),
    price: series.coordinateToPrice(y),
  });

  function localXY(e) {
    const rect = overlayRef.current.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function commit(type, pts) {
    const d = {
      id: newId(),
      type,
      points: pts.map((p) => ({ time: p.time ?? null, price: p.price ?? null })),
      color,
      label: "",
    };
    setDrawings((prev) => [...prev, d]);
    onToolConsumed?.();
  }

  function handleClick(e) {
    if (!placing) return;
    const { x, y } = localXY(e);
    const pt = fromXY(x, y);
    const need = POINTS_REQUIRED[activeTool] || 2;
    const next = [...pendingRef.current, pt];
    if (next.length >= need) {
      pendingRef.current = [];
      commit(activeTool, next);
    } else {
      pendingRef.current = next;
    }
    forceRender();
  }

  function handleMove(e) {
    if (!placing) return;
    mouseRef.current = localXY(e);
    if (pendingRef.current.length) forceRender();
  }

  function handleLeave() {
    mouseRef.current = null;
    if (placing && pendingRef.current.length) forceRender();
  }

  function removeDrawing(id) {
    setDrawings((prev) => prev.filter((d) => d.id !== id));
    setSelected(null);
  }

  // ---- render ------------------------------------------------------------
  const shapes = [];
  const handles = [];

  for (const d of drawings) {
    shapes.push(...renderDrawing(d, { toX, toY, width, height }));
    if (!placing) {
      // Selectable handles: tiny dots that stay clickable even though the
      // overlay itself is click-through (pointer-events:none) when idle.
      d.points.forEach((p, i) => {
        const hx = p.time != null ? toX(p.time) : d.type === "horizontal" ? width - 8 : null;
        const hy = p.price != null ? toY(p.price) : d.type === "vertical" ? 8 : null;
        if (hx == null || hy == null) return;
        handles.push(
          <circle
            key={`h-${d.id}-${i}`}
            cx={hx}
            cy={hy}
            r={5}
            fill={selected === d.id ? d.color : "#0b0e14"}
            stroke={d.color}
            strokeWidth={1.5}
            style={{ pointerEvents: "auto", cursor: "pointer" }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              setSelected((cur) => (cur === d.id ? null : d.id));
            }}
          >
            <title>Zeichnung auswählen</title>
          </circle>
        );
      });

      // ✕ delete affordance next to the first visible handle.
      if (selected === d.id) {
        const p0 = d.points[0];
        const dx = p0.time != null ? toX(p0.time) : width - 8;
        const dy = p0.price != null ? toY(p0.price) : 8;
        if (dx != null && dy != null) {
          const bx = Math.min(Math.max(dx + 12, 12), width - 12);
          const by = Math.min(Math.max(dy - 12, 12), height - 12);
          handles.push(
            <g
              key={`x-${d.id}`}
              transform={`translate(${bx},${by})`}
              style={{ pointerEvents: "auto", cursor: "pointer" }}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                removeDrawing(d.id);
              }}
            >
              <title>Zeichnung löschen</title>
              <circle r={9} fill="#ef4444" stroke="#0b0e14" strokeWidth={1.5} />
              <text
                x={0}
                y={0}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={11}
                fontWeight={700}
                fill="#fff"
              >
                ✕
              </text>
            </g>
          );
        }
      }
    }
  }

  // In-progress preview (from committed pending points to the cursor).
  const preview = placing ? renderPreview(activeTool, pendingRef.current, mouseRef.current, { toX, toY, width, height, color }) : null;

  return (
    <div
      ref={overlayRef}
      style={overlayStyle(placing)}
      onClick={handleClick}
      onMouseMove={handleMove}
      onMouseLeave={handleLeave}
    >
      <svg
        width={width}
        height={height}
        style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "visible" }}
      >
        {shapes}
        {preview}
        {handles}
      </svg>
    </div>
  );
}

function overlayStyle(placing) {
  return {
    position: "absolute",
    inset: 0,
    zIndex: 3,
    pointerEvents: placing ? "auto" : "none",
    cursor: placing ? "crosshair" : "default",
  };
}

// Renders one committed drawing to an array of SVG elements. Anything with an
// off-screen (null) required coordinate is silently skipped for that frame.
function renderDrawing(d, { toX, toY, width, height }) {
  const c = d.color || "#38bdf8";
  const key = d.id;

  if (d.type === "horizontal") {
    const y = toY(d.points[0]?.price);
    if (y == null) return [];
    const price = d.points[0]?.price;
    return [
      <line key={`${key}-l`} x1={0} y1={y} x2={width} y2={y} stroke={c} strokeWidth={1.5} strokeDasharray="6 4" />,
      <g key={`${key}-tag`} transform={`translate(${width - 4},${y})`}>
        <rect x={-64} y={-9} width={64} height={18} rx={3} fill={c} opacity={0.9} />
        <text x={-32} y={0} textAnchor="middle" dominantBaseline="central" fontSize={11} fontWeight={600} fill="#0b0e14">
          {fmt(price)}
        </text>
      </g>,
    ];
  }

  if (d.type === "vertical") {
    const x = toX(d.points[0]?.time);
    if (x == null) return [];
    return [<line key={`${key}-l`} x1={x} y1={0} x2={x} y2={height} stroke={c} strokeWidth={1.5} strokeDasharray="6 4" />];
  }

  const p1 = d.points[0];
  const p2 = d.points[1];
  const x1 = toX(p1?.time);
  const y1 = toY(p1?.price);
  const x2 = toX(p2?.time);
  const y2 = toY(p2?.price);
  if (x1 == null || y1 == null || x2 == null || y2 == null) return [];

  if (d.type === "trendline") {
    return [<line key={`${key}-l`} x1={x1} y1={y1} x2={x2} y2={y2} stroke={c} strokeWidth={2} />];
  }

  if (d.type === "ray") {
    const end = rayEnd(x1, y1, x2, y2, width, height);
    return [<line key={`${key}-l`} x1={x1} y1={y1} x2={end.x} y2={end.y} stroke={c} strokeWidth={2} />];
  }

  if (d.type === "rectangle") {
    const rx = Math.min(x1, x2);
    const ry = Math.min(y1, y2);
    return [
      <rect
        key={`${key}-r`}
        x={rx}
        y={ry}
        width={Math.abs(x2 - x1)}
        height={Math.abs(y2 - y1)}
        fill={c}
        fillOpacity={0.12}
        stroke={c}
        strokeWidth={1.5}
      />,
    ];
  }

  if (d.type === "fib") {
    const levels = fibLevels(p1, p2);
    const left = Math.min(x1, x2);
    const right = Math.max(x1, x2);
    const out = [];
    for (const lv of levels) {
      const y = toY(lv.price);
      if (y == null) continue;
      const emphasized = lv.ratio === 0.618;
      out.push(
        <line
          key={`${key}-f-${lv.ratio}`}
          x1={left}
          y1={y}
          x2={right}
          y2={y}
          stroke={c}
          strokeWidth={emphasized ? 1.8 : 1}
          strokeOpacity={emphasized ? 1 : 0.55}
          strokeDasharray={emphasized ? "none" : "2 3"}
        />
      );
      out.push(
        <text
          key={`${key}-ft-${lv.ratio}`}
          x={left + 4}
          y={y - 3}
          fontSize={10}
          fontWeight={emphasized ? 700 : 500}
          fill={c}
          fillOpacity={emphasized ? 1 : 0.7}
        >
          {`${lv.label}  ${fmt(lv.price)}`}
        </text>
      );
    }
    // faint connector spanning the fib box
    out.push(
      <line key={`${key}-fc`} x1={x1} y1={y1} x2={x2} y2={y2} stroke={c} strokeWidth={1} strokeOpacity={0.25} strokeDasharray="4 4" />
    );
    return out;
  }

  return [];
}

// Live preview while a multi-point tool is mid-placement.
function renderPreview(tool, pending, mouse, ctx) {
  if (!pending.length || !mouse) return null;
  const { toX, toY, width, height, color } = ctx;
  const x1 = toX(pending[0].time);
  const y1 = toY(pending[0].price);
  if (x1 == null || y1 == null) return null;
  const x2 = mouse.x;
  const y2 = mouse.y;

  if (tool === "rectangle") {
    return (
      <rect
        x={Math.min(x1, x2)}
        y={Math.min(y1, y2)}
        width={Math.abs(x2 - x1)}
        height={Math.abs(y2 - y1)}
        fill={color}
        fillOpacity={0.1}
        stroke={color}
        strokeWidth={1}
        strokeDasharray="4 4"
      />
    );
  }
  if (tool === "ray") {
    const end = rayEnd(x1, y1, x2, y2, width, height);
    return <line x1={x1} y1={y1} x2={end.x} y2={end.y} stroke={color} strokeWidth={1.5} strokeDasharray="4 4" />;
  }
  // trendline / fib preview: simple guide line
  return <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={1.5} strokeDasharray="4 4" />;
}
