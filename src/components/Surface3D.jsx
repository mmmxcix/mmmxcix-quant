import { useEffect, useRef, useState } from "react";

// Dependency-free 3D surface plot on a canvas (isometric projection, painter's
// algorithm). Used by the Anomalies page for the drawdown topology and the
// option Greeks manifold. Drag horizontally to rotate.
//
// Contract: `grid` is rows×cols of z-values ALREADY normalized to 0..1 (the
// caller owns scaling); `colorFor(z01)` returns a CSS color per cell.
// Optional `lines` are ridge overlays in the same normalized space:
// [{ points: [{x01, y01, z01}], color, width }].
export default function Surface3D({
  grid,
  colorFor,
  height = 320,
  initialYaw = -35, // degrees
  tilt = 55, // degrees from vertical — higher = flatter view
  zScale = 0.55, // surface height relative to base size
  lines = [],
  xLabel = "",
  yLabel = "",
}) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const [w, setW] = useState(640);
  const [yaw, setYaw] = useState(initialYaw);
  const drag = useRef(null); // { startX, startYaw }

  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver((entries) => setW(entries[0].contentRect.width));
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !grid?.length || !grid[0]?.length) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, height);

    const rows = grid.length, cols = grid[0].length;
    const rad = (d) => (d * Math.PI) / 180;
    const cosT = Math.cos(rad(tilt));
    const cosY = Math.cos(rad(yaw)), sinY = Math.sin(rad(yaw));

    // Project normalized (x01, y01, z01) → unscaled plane coords.
    const proj = (x01, y01, z01) => {
      const cx = x01 - 0.5, cy = y01 - 0.5;
      const rx = cx * cosY - cy * sinY;
      const ry = cx * sinY + cy * cosY;
      return { px: rx, py: ry * cosT - z01 * zScale, depth: ry };
    };

    // Fit: project the 8 bounding-box corners, scale into the canvas.
    const corners = [];
    for (const x of [0, 1]) for (const y of [0, 1]) for (const z of [0, 1]) corners.push(proj(x, y, z));
    const minX = Math.min(...corners.map((c) => c.px)), maxX = Math.max(...corners.map((c) => c.px));
    const minY = Math.min(...corners.map((c) => c.py)), maxY = Math.max(...corners.map((c) => c.py));
    const pad = 26;
    const S = Math.min((w - pad * 2) / (maxX - minX || 1), (height - pad * 2) / (maxY - minY || 1));
    const toScreen = (p) => ({
      x: pad + (p.px - minX) * S + ((w - pad * 2) - (maxX - minX) * S) / 2,
      y: pad + (p.py - minY) * S + ((height - pad * 2) - (maxY - minY) * S) / 2,
    });
    const P = (x01, y01, z01) => {
      const p = proj(x01, y01, z01);
      return { ...toScreen(p), depth: p.depth };
    };

    // Base outline (z = 0) under the surface.
    const base = [P(0, 0, 0), P(1, 0, 0), P(1, 1, 0), P(0, 1, 0)];
    ctx.beginPath();
    base.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.strokeStyle = "rgba(51, 65, 85, 0.8)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // Build all quads, then paint back-to-front.
    const quads = [];
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const x0 = c / (cols - 1), x1 = (c + 1) / (cols - 1);
        const y0 = r / (rows - 1), y1 = (r + 1) / (rows - 1);
        const z00 = grid[r][c], z10 = grid[r][c + 1], z11 = grid[r + 1][c + 1], z01v = grid[r + 1][c];
        const pts = [P(x0, y0, z00), P(x1, y0, z10), P(x1, y1, z11), P(x0, y1, z01v)];
        quads.push({
          pts,
          depth: (pts[0].depth + pts[1].depth + pts[2].depth + pts[3].depth) / 4,
          z: (z00 + z10 + z11 + z01v) / 4,
        });
      }
    }
    quads.sort((a, b) => a.depth - b.depth);
    for (const q of quads) {
      ctx.beginPath();
      q.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.fillStyle = colorFor(q.z);
      ctx.fill();
      ctx.strokeStyle = "rgba(10, 14, 20, 0.35)";
      ctx.lineWidth = 0.5;
      ctx.stroke();
    }

    // Ridge overlays (median drawdown path etc.) — drawn on top.
    for (const line of lines) {
      if (!line?.points?.length) continue;
      ctx.beginPath();
      line.points.forEach((pt, i) => {
        const p = P(pt.x01, pt.y01, pt.z01);
        i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
      });
      ctx.strokeStyle = line.color || "#e2e8f0";
      ctx.lineWidth = line.width || 1.5;
      ctx.stroke();
    }

    // Axis labels along the two front base edges.
    ctx.font = "10px ui-monospace, monospace";
    ctx.fillStyle = "#64748b";
    ctx.textAlign = "center";
    if (xLabel) {
      const a = P(0, 1, 0), b = P(1, 1, 0);
      ctx.fillText(xLabel, (a.x + b.x) / 2, Math.min(height - 6, Math.max(a.y, b.y) + 16));
    }
    if (yLabel) {
      const a = P(1, 0, 0), b = P(1, 1, 0);
      ctx.fillText(yLabel, (a.x + b.x) / 2 + 14, (a.y + b.y) / 2 + 14);
    }
  }, [grid, colorFor, w, height, yaw, tilt, zScale, lines, xLabel, yLabel]);

  const onPointerDown = (e) => {
    drag.current = { startX: e.clientX, startYaw: yaw };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e) => {
    if (!drag.current) return;
    setYaw(drag.current.startYaw + (e.clientX - drag.current.startX) * 0.4);
  };
  const onPointerUp = () => { drag.current = null; };

  return (
    <div ref={wrapRef} className="w-full relative select-none" style={{ height }}>
      <canvas
        ref={canvasRef}
        style={{ width: w, height, cursor: "grab", touchAction: "pan-y" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
      <p className="absolute top-1 right-2 text-[10px] text-dim/60 font-mono pointer-events-none">drag to rotate</p>
    </div>
  );
}
