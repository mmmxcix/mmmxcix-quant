import { useEffect, useRef, useState } from "react";
import { createChart, CrosshairMode } from "lightweight-charts";
import { toSeriesData } from "@/lib/chartTypes";

const THEME = {
  layout: { background: { color: "transparent" }, textColor: "#64748b" },
  grid: {
    vertLines: { color: "#141a26" },
    horzLines: { color: "#141a26" },
  },
  crosshair: { mode: CrosshairMode.Normal },
  rightPriceScale: { borderColor: "#1c2433" },
  timeScale: {
    borderColor: "#1c2433",
    timeVisible: true,
    secondsVisible: false,
  },
};

const UP = "#10b981", DOWN = "#ef4444";

// Scrolling into the future is allowed, but at least this fraction of the
// viewport must always show candles (i.e. max ~2/3 empty space on the right).
const MIN_DATA_FRACTION = 1 / 3;

function addPriceSeries(chart, type) {
  if (type === "line") {
    return chart.addLineSeries({ color: "#2dd4bf", lineWidth: 2, priceLineVisible: false });
  }
  if (type === "area") {
    return chart.addAreaSeries({
      lineColor: "#2dd4bf", topColor: "rgba(45,212,191,0.28)", bottomColor: "rgba(45,212,191,0.02)",
      lineWidth: 2, priceLineVisible: false,
    });
  }
  if (type === "bars") {
    return chart.addBarSeries({ upColor: UP, downColor: DOWN });
  }
  // candles + heikin-ashi both use a candlestick series
  return chart.addCandlestickSeries({
    upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN,
    wickUpColor: UP + "88", wickDownColor: DOWN + "88",
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
  onNeedOlder,
  children,
}) {
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

  // (Re)create the chart when mount-time options or the series TYPE change.
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      ...THEME,
      height,
      width: containerRef.current.clientWidth,
    });
    chartRef.current = chart;
    priceSeriesRef.current = addPriceSeries(chart, chartType);
    prevFirstTimeRef.current = null;

    if (showVolume) {
      volSeriesRef.current = chart.addHistogramSeries({
        priceFormat: { type: "volume" }, priceScaleId: "vol", color: "#1c2433",
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

    return () => {
      ro.disconnect();
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
      chart.timeScale().fitContent();
    }
    prevFirstTimeRef.current = candles[0].time;
  }, [candles, chartType]);

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
