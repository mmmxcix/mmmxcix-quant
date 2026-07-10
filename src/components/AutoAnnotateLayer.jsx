import { useEffect, useMemo, useReducer } from "react";
import { detectLevels, detectTrendlines, detectFVGs, autoFibSwing, detectDoublePatterns } from "@/lib/autoAnnotate";
import { fibLevels } from "@/lib/drawings";

// Read-only SVG overlay that draws the auto-detected annotations (levels,
// trendlines, FVGs, auto-fib, double patterns) on top of the price chart.
// Never captures pointer events — it annotates, the user keeps full control.

const COL = {
  support: "#10b981",
  resistance: "#ef4444",
  up: "#2dd4bf",
  down: "#f87171",
  fvgBull: "#10b981",
  fvgBear: "#ef4444",
  fib: "#a78bfa",
  pattern: "#f59e0b",
};

function fmt(v) {
  if (v == null || !isFinite(v)) return "";
  const a = Math.abs(v);
  const dec = a >= 1000 ? 0 : a >= 1 ? 2 : a >= 0.01 ? 4 : 6;
  return v.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

export default function AutoAnnotateLayer({ chart, series, containerRef, candles, show }) {
  const [, forceRender] = useReducer((n) => n + 1, 0);

  // Track pan/zoom/resize exactly like the manual draw layer does.
  useEffect(() => {
    if (!chart || !containerRef?.current) return;
    const ts = chart.timeScale();
    const onRange = () => forceRender();
    ts.subscribeVisibleLogicalRangeChange(onRange);
    const ro = new ResizeObserver(() => forceRender());
    ro.observe(containerRef.current);
    return () => {
      try { ts.unsubscribeVisibleLogicalRangeChange(onRange); } catch { /* disposed */ }
      ro.disconnect();
    };
  }, [chart, containerRef]);

  const anyOn = show.levels || show.trend || show.fvg || show.fib || show.patterns;

  // Detection is O(n·lookback) over a few hundred bars — fine to recompute per
  // candle update, and memoized against the candles reference in between.
  const ann = useMemo(() => {
    if (!candles || candles.length < 20 || !anyOn) return null;
    return {
      levels: show.levels ? detectLevels(candles) : [],
      trendlines: show.trend ? detectTrendlines(candles) : [],
      fvgs: show.fvg ? detectFVGs(candles) : [],
      fib: show.fib ? autoFibSwing(candles) : null,
      patterns: show.patterns ? detectDoublePatterns(candles) : [],
    };
  }, [candles, anyOn, show.levels, show.trend, show.fvg, show.fib, show.patterns]);

  if (!chart || !series || !containerRef?.current || !ann) return null;

  const el = containerRef.current;
  // Clip to the chart PANE: the container includes the price axis (right) and
  // time axis (bottom), and zones/labels must never spill onto them.
  let axisW = 0, axisH = 0;
  try { axisW = chart.priceScale("right").width() || 0; } catch { /* not ready */ }
  try { axisH = chart.timeScale().height() || 0; } catch { /* not ready */ }
  const width = Math.max(0, (el.clientWidth || 0) - axisW);
  const height = Math.max(0, (el.clientHeight || 0) - axisH);
  const toX = (time) => (time == null ? null : chart.timeScale().timeToCoordinate(time));
  const toY = (price) => (price == null ? null : series.priceToCoordinate(price));
  const lastTime = candles[candles.length - 1].time;
  const lastX = toX(lastTime) ?? width;
  // Times scrolled off the left edge yield null coordinates — clamp them to
  // x=0 so zones/lines that START off-screen still render their visible part.
  const visRange = chart.timeScale().getVisibleRange?.() || null;
  const toXClamped = (time) => {
    const x = toX(time);
    if (x != null) return x;
    if (visRange && time != null && time < visRange.from) return 0;
    return null;
  };

  const shapes = [];

  // ── Support / resistance levels ─────────────────────────────────────────
  for (const lv of ann.levels) {
    const y = toY(lv.price);
    if (y == null || y < 0 || y > height) continue;
    const c = COL[lv.kind];
    shapes.push(
      <g key={`lv-${lv.price}`}>
        <line x1={0} y1={y} x2={width} y2={y} stroke={c} strokeWidth={1} strokeOpacity={0.55} strokeDasharray="8 5" />
        <text x={6} y={y - 4} fontSize={9} fontFamily="monospace" fill={c} fillOpacity={0.9}>
          {lv.kind === "support" ? "S" : "R"} {fmt(lv.price)} ·{lv.touches}×
        </text>
      </g>
    );
  }

  // ── Trendlines ──────────────────────────────────────────────────────────
  for (const tl of ann.trendlines) {
    // If the first pivot scrolled off-screen, fall back to the second pivot
    // (the anchor) — the visible part of the line stays identical.
    let a = tl.p1;
    let x1 = toX(a.time);
    if (x1 == null && tl.anchor) { a = tl.anchor; x1 = toX(a.time); }
    const y1 = toY(a.price);
    const x2 = toX(tl.p2.time), y2 = toY(tl.p2.price);
    if (x1 == null || y1 == null || x2 == null || y2 == null || x1 === x2) continue;
    const c = tl.kind === "up" ? COL.up : COL.down;
    shapes.push(
      <g key={`tl-${tl.kind}`}>
        <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={c} strokeWidth={1.8} strokeOpacity={0.85} />
        <text x={Math.min(x2 + 4, width - 70)} y={y2 + (tl.kind === "up" ? 12 : -6)}
          fontSize={9} fontFamily="monospace" fill={c}>
          {tl.kind === "up" ? "auto uptrend" : "auto downtrend"}
        </text>
      </g>
    );
  }

  // ── Fair value gaps ─────────────────────────────────────────────────────
  // The zone is the frozen 3-candle gap; `tested` gaps (touched but not
  // filled) render fainter so fresh imbalances stand out.
  for (const g of ann.fvgs) {
    const x1 = toXClamped(g.fromTime);
    const yT = toY(g.top), yB = toY(g.bottom);
    if (x1 == null || yT == null || yB == null) continue;
    const c = g.kind === "bull" ? COL.fvgBull : COL.fvgBear;
    const w = Math.max(0, lastX - x1);
    if (w <= 0) continue;
    const fillO = g.tested ? 0.05 : 0.12;
    const strokeO = g.tested ? 0.22 : 0.45;
    shapes.push(
      <g key={`fvg-${g.fromTime}-${g.kind}`}>
        <rect x={x1} y={yT} width={w} height={Math.max(1, yB - yT)} fill={c} fillOpacity={fillO}
          stroke={c} strokeOpacity={strokeO} strokeWidth={1} strokeDasharray="3 3" />
        <text x={x1 + 3} y={Math.min(yT + 10, yB - 2)} fontSize={8} fontFamily="monospace" fill={c} fillOpacity={g.tested ? 0.5 : 0.85}>
          {g.tested ? "FVG ·tested" : "FVG"}
        </text>
      </g>
    );
  }

  // ── Auto Fibonacci ──────────────────────────────────────────────────────
  if (ann.fib) {
    const { p1, p2 } = ann.fib;
    const xa = toXClamped(p1.time), xb = toXClamped(p2.time);
    if (xa != null && xb != null) {
      const left = Math.min(xa, xb);
      for (const lv of fibLevels(p1, p2)) {
        const y = toY(lv.price);
        if (y == null || y < 0 || y > height) continue;
        const strong = lv.ratio === 0.618;
        shapes.push(
          <g key={`fib-${lv.ratio}`}>
            <line x1={left} y1={y} x2={width} y2={y} stroke={COL.fib}
              strokeWidth={strong ? 1.5 : 0.8} strokeOpacity={strong ? 0.9 : 0.45}
              strokeDasharray={strong ? "none" : "2 4"} />
            <text x={width - 4} y={y - 3} textAnchor="end" fontSize={9} fontFamily="monospace"
              fill={COL.fib} fillOpacity={strong ? 1 : 0.7}>
              {lv.label} {fmt(lv.price)}
            </text>
          </g>
        );
      }
    }
  }

  // ── Double top / bottom ─────────────────────────────────────────────────
  for (const p of ann.patterns) {
    const xa = toX(p.a.time), ya = toY(p.a.price);
    const xb = toX(p.b.time), yb = toY(p.b.price);
    const yn = toY(p.neckline);
    if (xa == null || ya == null || xb == null || yb == null || yn == null) continue;
    shapes.push(
      <g key={`pat-${p.type}-${p.a.time}`}>
        <line x1={xa} y1={ya} x2={xb} y2={yb} stroke={COL.pattern} strokeWidth={1.2} strokeDasharray="4 3" />
        <circle cx={xa} cy={ya} r={3.5} fill="none" stroke={COL.pattern} strokeWidth={1.5} />
        <circle cx={xb} cy={yb} r={3.5} fill="none" stroke={COL.pattern} strokeWidth={1.5} />
        <line x1={Math.min(xa, xb)} y1={yn} x2={lastX} y2={yn} stroke={COL.pattern} strokeWidth={1}
          strokeOpacity={0.6} strokeDasharray="6 4" />
        <text x={(xa + xb) / 2} y={p.type === "double-top" ? ya - 8 : ya + 14} textAnchor="middle"
          fontSize={9} fontFamily="monospace" fill={COL.pattern}>
          {p.type === "double-top" ? "double top" : "double bottom"}
        </text>
        <text x={lastX - 4} y={yn - 4} textAnchor="end" fontSize={8} fontFamily="monospace"
          fill={COL.pattern} fillOpacity={0.8}>
          neckline
        </text>
      </g>
    );
  }

  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 2, pointerEvents: "none" }}>
      <svg width={width} height={height} style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
        {shapes}
      </svg>
    </div>
  );
}
