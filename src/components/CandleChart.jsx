import { useEffect, useRef, useState } from "react";
import { createChart, CrosshairMode } from "lightweight-charts";
import { toSeriesData } from "@/lib/chartTypes";

// Chart colours are read from the app's theme tokens so the chart matches the
// light/dark UI. Grid/border pick per-theme neutrals; series colours come from
// the --c-* variables (rgb triplets).
function chartColors() {
  const dark = document.documentElement.dataset.theme === "dark";
  const rgb = (name, a) => {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim().split(/\s+/).map(Number);
    if (v.length < 3 || v.some(Number.isNaN)) return null;
    return a != null ? `rgba(${v[0]},${v[1]},${v[2]},${a})` : `rgb(${v[0]},${v[1]},${v[2]})`;
  };
  const grid = dark ? "#141a26" : "rgba(17,21,40,0.06)";
  const border = dark ? "#1c2433" : "rgba(17,21,40,0.12)";
  return {
    up: rgb("--c-up") || "#10b981",
    down: rgb("--c-down") || "#ef4444",
    accent: rgb("--c-accent") || "#2dd4bf",
    wickUp: rgb("--c-up", 0.53) || "rgba(16,185,129,0.53)",
    wickDown: rgb("--c-down", 0.53) || "rgba(239,68,68,0.53)",
    accentTop: rgb("--c-accent", 0.28) || "rgba(45,212,191,0.28)",
    accentBottom: rgb("--c-accent", 0.02) || "rgba(45,212,191,0.02)",
    vol: dark ? "#1c2433" : "rgba(17,21,40,0.10)",
    layout: { background: { color: "transparent" }, textColor: rgb("--c-dim") || "#64748b" },
    grid: { vertLines: { color: grid }, horzLines: { color: grid } },
    crosshair: { mode: CrosshairMode.Normal },
    rightPriceScale: { borderColor: border },
    timeScale: { borderColor: border, timeVisible: true, secondsVisible: false },
  };
}

// Volume-bar + trade-marker tint. Kept as hex (concatenated with an alpha
// suffix below) and green/red reads correctly on both themes.
const UP = "#10b981", DOWN = "#ef4444";

// Scrolling into the future is allowed, but at least this fraction of the
// viewport must always show candles (i.e. max ~2/3 empty space on the right).
const MIN_DATA_FRACTION = 1 / 3;

// Fresh loads (new symbol/timeframe/range) zoom to a comfortable candle size
// instead of squeezing the whole dataset into view: aim for ~14px per candle,
// clamped so phones still show context and huge screens don't overzoom.
function defaultVisibleBars(containerWidth) {
  return Math.round(Math.min(110, Math.max(50, (containerWidth || 800) / 14)));
}
const RIGHT_PAD_BARS = 8; // small breathing room after the latest candle

function addPriceSeries(chart, type, c) {
  if (type === "line") {
    return chart.addLineSeries({ color: c.accent, lineWidth: 2, priceLineVisible: false });
  }
  if (type === "area") {
    return chart.addAreaSeries({
      lineColor: c.accent, topColor: c.accentTop, bottomColor: c.accentBottom,
      lineWidth: 2, priceLineVisible: false,
    });
  }
  if (type === "bars") {
    return chart.addBarSeries({ upColor: c.up, downColor: c.down });
  }
  // candles + heikin-ashi both use a candlestick series
  return chart.addCandlestickSeries({
    upColor: c.up, downColor: c.down, borderUpColor: c.up, borderDownColor: c.down,
    wickUpColor: c.wickUp, wickDownColor: c.wickDown,
  });
}

// Price chart with selectable series type, volume, indicator overlays,
// infinite history (onNeedOlder), trade markers, and an optional render-prop
// (`children`) that receives the live chart + main series so an overlay
// (drawing layer) can position itself. The chart instance is recreated only
// when the series TYPE changes; data/marker/overlay updates preserve state.
export default function CandleChart({
  candles,
  chartType = "candles",
  overlays = [],
  markers = [],
  showVolume = true,
  height = 440,
  magnet = false, // crosshair snaps to the hovered candle instead of floating free
  fitAll = false, // always show the whole dataset (backtest results: every marker visible)
  livePrice = null, // latest tick price — updates the forming candle imperatively
  onNeedOlder,
  onChartReady,
  children,
}) {
  const onReadyRef = useRef(onChartReady);
  onReadyRef.current = onChartReady;
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const priceSeriesRef = useRef(null);
  const volSeriesRef = useRef(null);
  const overlaySeriesRef = useRef([]);
  const prevFirstTimeRef = useRef(null);
  const loadingOlderRef = useRef(false);
  const exhaustedRef = useRef(false);
  const barCountRef = useRef(0);
  const clampingRef = useRef(false);
  const onNeedOlderRef = useRef(onNeedOlder);
  onNeedOlderRef.current = onNeedOlder;

  // Bump this so children (draw layer) re-attach when the chart is rebuilt.
  const [chartEpoch, setChartEpoch] = useState(0);

  // Re-apply chart colours when the light/dark theme flips (no chart rebuild).
  useEffect(() => {
    const apply = () => {
      const chart = chartRef.current;
      if (!chart) return;
      const c = chartColors();
      chart.applyOptions({ layout: c.layout, grid: c.grid, rightPriceScale: c.rightPriceScale, timeScale: c.timeScale });
      if (volSeriesRef.current) { try { volSeriesRef.current.applyOptions({ color: c.vol }); } catch { /* noop */ } }
      const ps = priceSeriesRef.current;
      if (ps) {
        try {
          ps.applyOptions({
            color: c.accent, lineColor: c.accent, topColor: c.accentTop, bottomColor: c.accentBottom,
            upColor: c.up, downColor: c.down, borderUpColor: c.up, borderDownColor: c.down,
            wickUpColor: c.wickUp, wickDownColor: c.wickDown,
          });
        } catch { /* options not valid for this series type — harmless */ }
      }
    };
    const obs = new MutationObserver(apply);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);

  // (Re)create the chart when mount-time options or the series TYPE change.
  useEffect(() => {
    if (!containerRef.current) return;
    const col = chartColors();
    const chart = createChart(containerRef.current, {
      layout: col.layout, grid: col.grid, crosshair: col.crosshair,
      rightPriceScale: col.rightPriceScale, timeScale: col.timeScale,
      height,
      width: containerRef.current.clientWidth,
    });
    chartRef.current = chart;
    priceSeriesRef.current = addPriceSeries(chart, chartType, col);
    prevFirstTimeRef.current = null;

    if (showVolume) {
      volSeriesRef.current = chart.addHistogramSeries({
        priceFormat: { type: "volume" }, priceScaleId: "vol", color: col.vol,
        lastValueVisible: false, priceLineVisible: false, // no confusing volume tag on the price axis
      });
      chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    }

    chart.timeScale().subscribeVisibleLogicalRangeChange(async (range) => {
      if (!range) return;
      const lastIndex = barCountRef.current - 1;
      if (lastIndex > 0 && !clampingRef.current) {
        const width = range.to - range.from;
        const maxTo = lastIndex + width * (1 - MIN_DATA_FRACTION);
        if (range.to > maxTo + 0.5) {
          clampingRef.current = true;
          chart.timeScale().setVisibleLogicalRange({ from: maxTo - width, to: maxTo });
          clampingRef.current = false;
          return;
        }
      }
      if (range.from > 12) return;
      if (loadingOlderRef.current || exhaustedRef.current) return;
      const cb = onNeedOlderRef.current;
      if (!cb) return;
      loadingOlderRef.current = true;
      try {
        const added = await cb();
        if (!added) exhaustedRef.current = true;
      } catch {
        exhaustedRef.current = true;
      } finally {
        loadingOlderRef.current = false;
      }
    });

    const ro = new ResizeObserver(() => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth });
    });
    ro.observe(containerRef.current);
    setChartEpoch((e) => e + 1);
    onReadyRef.current?.(chart, priceSeriesRef.current);

    return () => {
      ro.disconnect();
      onReadyRef.current?.(null, null);
      chart.remove();
      chartRef.current = null;
      priceSeriesRef.current = null;
      volSeriesRef.current = null;
      overlaySeriesRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [height, showVolume, chartType]);

  // Data updates, keeping the viewport anchored on prepend.
  useEffect(() => {
    const chart = chartRef.current;
    const series = priceSeriesRef.current;
    if (!chart || !series || !candles?.length) return;

    const prevFirst = prevFirstTimeRef.current;
    const isPrepend = prevFirst !== null && candles[0].time < prevFirst && candles.some((c) => c.time === prevFirst);
    // A "tail update" is a live poll: same starting bar, only the last bar(s)
    // changed/appended. Keep the viewport steady instead of refitting so the
    // user's zoom/scroll survives every refresh.
    const isTailUpdate = !isPrepend && prevFirst !== null && candles[0].time === prevFirst;
    const addedCount = isPrepend ? candles.findIndex((c) => c.time === prevFirst) : 0;
    const view = (isPrepend || isTailUpdate) ? chart.timeScale().getVisibleLogicalRange() : null;
    barCountRef.current = candles.length;

    series.setData(toSeriesData(chartType, candles));
    if (volSeriesRef.current) {
      volSeriesRef.current.setData(
        candles.map((c) => ({ time: c.time, value: c.volume, color: c.close >= c.open ? UP + "33" : DOWN + "33" }))
      );
    }

    if (isPrepend && view) {
      chart.timeScale().setVisibleLogicalRange({ from: view.from + addedCount, to: view.to + addedCount });
    } else if (isTailUpdate && view) {
      chart.timeScale().setVisibleLogicalRange(view); // hold zoom/scroll on live refresh
    } else {
      exhaustedRef.current = false;
      // Fresh load: manual price-axis scaling from the previous view must not
      // survive (once the user drags the axis, lightweight-charts disables
      // autoscale permanently — a monthly chart would be squeezed into the old
      // intraday price window and render as unreadable full-height bars).
      try { chart.priceScale("right").applyOptions({ autoScale: true }); } catch { /* scale gone */ }
      // Zoom to the most recent candles at a readable size — unless the caller
      // wants the whole dataset in view (backtest results with trade markers).
      const n = defaultVisibleBars(containerRef.current?.clientWidth);
      if (!fitAll && candles.length > n) {
        const lastIdx = candles.length - 1;
        chart.timeScale().setVisibleLogicalRange({
          from: lastIdx - n + 0.5,
          to: lastIdx + RIGHT_PAD_BARS,
        });
      } else {
        chart.timeScale().fitContent();
      }
    }
    prevFirstTimeRef.current = candles[0].time;
  }, [candles, chartType]);

  // Crosshair magnet: snap the crosshair to the bar under the cursor.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.applyOptions({ crosshair: { mode: magnet ? CrosshairMode.Magnet : CrosshairMode.Normal } });
  }, [magnet, chartEpoch]);

  // Live tick: repaint ONLY the forming (last) candle via series.update(), so
  // price ticks in real time without re-rendering the page or recomputing
  // indicators. Heikin-Ashi is skipped (its last bar depends on the whole
  // recomputation) — it still updates on the ~2s kline cadence.
  useEffect(() => {
    const series = priceSeriesRef.current;
    if (!series || livePrice == null || !candles?.length || chartType === "heikin-ashi") return;
    const last = candles[candles.length - 1];
    const bar = {
      ...last,
      close: livePrice,
      high: Math.max(last.high, livePrice),
      low: Math.min(last.low, livePrice),
    };
    try {
      if (chartType === "line" || chartType === "area") series.update({ time: bar.time, value: bar.close });
      else series.update({ time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
    } catch { /* series torn down / stale time */ }
  }, [livePrice, chartType, candles]);

  // Trade markers (backtest buy/sell arrows). lightweight-charts renders
  // markers on the main series; line/area series support them too.
  useEffect(() => {
    const series = priceSeriesRef.current;
    if (!series) return;
    try {
      series.setMarkers(
        (markers || []).map((m) => ({
          time: m.time,
          position: m.side === "buy" ? "belowBar" : "aboveBar",
          color: m.side === "buy" ? UP : DOWN,
          shape: m.side === "buy" ? "arrowUp" : "arrowDown",
          text: m.text || (m.side === "buy" ? "Kauf" : "Verkauf"),
        }))
      );
    } catch { /* series torn down */ }
  }, [markers, chartEpoch]);

  // Indicator overlays — replaced wholesale on change.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    for (const s of overlaySeriesRef.current) {
      try { chart.removeSeries(s); } catch { /* gone */ }
    }
    overlaySeriesRef.current = [];
    for (const ov of overlays) {
      const line = chart.addLineSeries({
        color: ov.color, lineWidth: 2, priceLineVisible: false,
        lastValueVisible: false, crosshairMarkerVisible: false,
      });
      line.setData(ov.points);
      overlaySeriesRef.current.push(line);
    }
  }, [overlays, chartEpoch]);

  return (
    <div ref={containerRef} style={{ height }} className="w-full relative">
      {children && chartEpoch > 0 && chartRef.current
        ? children({ chart: chartRef.current, series: priceSeriesRef.current, containerRef, epoch: chartEpoch })
        : null}
    </div>
  );
}
