import { useEffect, useMemo, useRef, useState } from "react";

// Lightweight responsive SVG line chart for (x, y) data that isn't a time
// series — used for option payoff diagrams (x = underlying price, y = P/L) and
// the volatility smile (x = strike, y = IV). Supports multiple series, an
// emphasized zero line, an optional vertical marker (e.g. spot), shaded
// profit/loss regions for a single payoff series, and a hover readout.
//
// series: [{ label, color, points: [{x, y}] }]
export default function XYLineChart({
  series,
  height = 300,
  markerX = null,
  markerLabel = "",
  fmtX = (v) => String(Math.round(v)),
  fmtY = (v) => String(Math.round(v)),
  shadeZero = false, // green above 0 / red below 0 for the first series
  zeroLine = true,
}) {
  const wrapRef = useRef(null);
  const [w, setW] = useState(640);
  const [hoverX, setHoverX] = useState(null);

  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver((entries) => setW(entries[0].contentRect.width));
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  const pad = { l: 52, r: 16, t: 12, b: 26 };
  const iw = Math.max(10, w - pad.l - pad.r);
  const ih = Math.max(10, height - pad.t - pad.b);

  const { xMin, xMax, yMin, yMax } = useMemo(() => {
    const xs = [], ys = [0];
    for (const s of series || []) for (const p of s.points) { xs.push(p.x); ys.push(p.y); }
    if (!xs.length) return { xMin: 0, xMax: 1, yMin: 0, yMax: 1 };
    let yLo = Math.min(...ys), yHi = Math.max(...ys);
    if (yLo === yHi) { yLo -= 1; yHi += 1; }
    const padY = (yHi - yLo) * 0.08;
    return { xMin: Math.min(...xs), xMax: Math.max(...xs), yMin: yLo - padY, yMax: yHi + padY };
  }, [series]);

  const sx = (x) => pad.l + ((x - xMin) / (xMax - xMin || 1)) * iw;
  const sy = (y) => pad.t + ih - ((y - yMin) / (yMax - yMin || 1)) * ih;

  const path = (pts) => pts.map((p, i) => `${i ? "L" : "M"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(" ");

  // Area path for shading (first series) clipped above/below the zero line.
  const shadeArea = (pts, aboveZero) => {
    if (!pts.length) return "";
    const y0 = sy(0);
    let d = `M${sx(pts[0].x).toFixed(1)},${y0.toFixed(1)}`;
    for (const p of pts) {
      const yv = aboveZero ? Math.min(sy(p.y), y0) : Math.max(sy(p.y), y0);
      d += ` L${sx(p.x).toFixed(1)},${yv.toFixed(1)}`;
    }
    d += ` L${sx(pts[pts.length - 1].x).toFixed(1)},${y0.toFixed(1)} Z`;
    return d;
  };

  const xTicks = useMemo(() => {
    const n = Math.max(2, Math.min(7, Math.floor(iw / 90)));
    return Array.from({ length: n + 1 }, (_, i) => xMin + ((xMax - xMin) * i) / n);
  }, [xMin, xMax, iw]);
  const yTicks = useMemo(() => {
    const n = 4;
    return Array.from({ length: n + 1 }, (_, i) => yMin + ((yMax - yMin) * i) / n);
  }, [yMin, yMax]);

  const onMove = (e) => {
    const rect = wrapRef.current.getBoundingClientRect();
    const px = e.clientX - rect.left;
    if (px < pad.l || px > pad.l + iw) { setHoverX(null); return; }
    setHoverX(xMin + ((px - pad.l) / iw) * (xMax - xMin));
  };

  const hover = useMemo(() => {
    if (hoverX == null || !series?.length) return null;
    const readouts = series.map((s) => {
      let best = null;
      for (const p of s.points) if (best === null || Math.abs(p.x - hoverX) < Math.abs(best.x - hoverX)) best = p;
      return { label: s.label, color: s.color, y: best?.y };
    });
    return { x: hoverX, readouts };
  }, [hoverX, series]);

  const first = series?.[0]?.points || [];

  return (
    <div ref={wrapRef} className="w-full relative" style={{ height }}>
      <svg width={w} height={height} onMouseMove={onMove} onMouseLeave={() => setHoverX(null)}>
        {/* grid + y labels */}
        {yTicks.map((t, i) => (
          <g key={i}>
            <line x1={pad.l} y1={sy(t)} x2={pad.l + iw} y2={sy(t)} stroke="#141a26" />
            <text x={pad.l - 6} y={sy(t) + 3} textAnchor="end" fontSize="10" fill="#64748b" fontFamily="monospace">{fmtY(t)}</text>
          </g>
        ))}
        {xTicks.map((t, i) => (
          <text key={i} x={sx(t)} y={height - 8} textAnchor="middle" fontSize="10" fill="#64748b" fontFamily="monospace">{fmtX(t)}</text>
        ))}

        {/* shaded P/L regions for the first series */}
        {shadeZero && first.length > 1 && (
          <>
            <path d={shadeArea(first, true)} fill="#10b981" opacity="0.12" />
            <path d={shadeArea(first, false)} fill="#ef4444" opacity="0.12" />
          </>
        )}

        {/* zero line */}
        {zeroLine && 0 >= yMin && 0 <= yMax && (
          <line x1={pad.l} y1={sy(0)} x2={pad.l + iw} y2={sy(0)} stroke="#334155" strokeDasharray="3 3" />
        )}

        {/* spot / strike marker */}
        {markerX != null && markerX >= xMin && markerX <= xMax && (
          <g>
            <line x1={sx(markerX)} y1={pad.t} x2={sx(markerX)} y2={pad.t + ih} stroke="#2dd4bf" strokeDasharray="2 2" opacity="0.7" />
            <text x={sx(markerX)} y={pad.t + 9} textAnchor="middle" fontSize="9" fill="#2dd4bf" fontFamily="monospace">{markerLabel}</text>
          </g>
        )}

        {/* series */}
        {(series || []).map((s, i) => (
          <path key={i} d={path(s.points)} fill="none" stroke={s.color} strokeWidth="2" />
        ))}

        {/* hover */}
        {hover && (
          <line x1={sx(hover.x)} y1={pad.t} x2={sx(hover.x)} y2={pad.t + ih} stroke="#64748b" opacity="0.4" />
        )}
      </svg>

      {hover && (
        <div className="absolute top-1 right-2 rounded-lg border border-line bg-surface/90 backdrop-blur px-2.5 py-1.5 text-[11px] font-mono pointer-events-none">
          <div className="text-dim">{fmtX(hover.x)}</div>
          {hover.readouts.map((r, i) => (
            <div key={i} style={{ color: r.color }}>{r.label}: {r.y != null ? fmtY(r.y) : "–"}</div>
          ))}
        </div>
      )}
    </div>
  );
}
