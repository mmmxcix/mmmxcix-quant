import { useEffect, useRef } from "react";
import { createChart, CrosshairMode } from "lightweight-charts";

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

// Scrolling into the future is allowed, but at least this fraction of the
// viewport must always show candles (i.e. max ~2/3 empty space on the right).
const MIN_DATA_FRACTION = 1 / 3;

// Candlestick chart with volume, line overlays and infinite history:
// when the user pans near the left edge, `onNeedOlder()` is invoked (async,
// should prepend candles to the `candles` prop and resolve with the number
// of bars added, or 0 when the source is exhausted). The chart instance is
// created once — data updates preserve the current viewport.
export default function CandleChart({ candles, overlays = [], showVolume = true, height = 440, onNeedOlder }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const candleSeriesRef = useRef(null);
  const volSeriesRef = useRef(null);
  const overlaySeriesRef = useRef([]);
  const prevFirstTimeRef = useRef(null);
  const loadingOlderRef = useRef(false);
  const exhaustedRef = useRef(false);
  const barCountRef = useRef(0);
  const clampingRef = useRef(false);
  const onNeedOlderRef = useRef(onNeedOlder);
  onNeedOlderRef.current = onNeedOlder;

  // Create the chart once per mount.
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      ...THEME,
      height,
      width: containerRef.current.clientWidth,
    });
    chartRef.current = chart;

    candleSeriesRef.current = chart.addCandlestickSeries({
      upColor: "#10b981",
      downColor: "#ef4444",
      borderUpColor: "#10b981",
      borderDownColor: "#ef4444",
      wickUpColor: "#10b98188",
      wickDownColor: "#ef444488",
    });

    if (showVolume) {
      volSeriesRef.current = chart.addHistogramSeries({
        priceFormat: { type: "volume" },
        priceScaleId: "vol",
        color: "#1c2433",
      });
      chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    }

    chart.timeScale().subscribeVisibleLogicalRangeChange(async (range) => {
      if (!range) return;

      // Future clamp: cap the empty space right of the last candle so at
      // least MIN_DATA_FRACTION of the viewport keeps showing data.
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

      // Lazy history: fires while panning towards the left edge.
      if (range.from > 12) return;
      if (loadingOlderRef.current || exhaustedRef.current) return;
      const cb = onNeedOlderRef.current;
      if (!cb) return;
      loadingOlderRef.current = true;
      try {
        const added = await cb();
        if (!added) exhaustedRef.current = true;
      } catch {
        exhaustedRef.current = true; // don't hammer a failing source
      } finally {
        loadingOlderRef.current = false;
      }
    });

    const ro = new ResizeObserver(() => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth });
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volSeriesRef.current = null;
      overlaySeriesRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [height, showVolume]);

  // Data updates. A prepend (older history arrived) keeps the viewport
  // anchored by shifting the visible logical range by the number of bars
  // that were inserted before it; any other change refits the chart.
  useEffect(() => {
    const chart = chartRef.current;
    const series = candleSeriesRef.current;
    if (!chart || !series || !candles?.length) return;

    const prevFirst = prevFirstTimeRef.current;
    const isPrepend = prevFirst !== null && candles[0].time < prevFirst && candles.some((c) => c.time === prevFirst);
    const addedCount = isPrepend ? candles.findIndex((c) => c.time === prevFirst) : 0;
    const view = isPrepend ? chart.timeScale().getVisibleLogicalRange() : null;
    barCountRef.current = candles.length;

    series.setData(candles);
    if (volSeriesRef.current) {
      volSeriesRef.current.setData(
        candles.map((c) => ({
          time: c.time,
          value: c.volume,
          color: c.close >= c.open ? "#10b98133" : "#ef444433",
        }))
      );
    }

    if (isPrepend && view) {
      chart.timeScale().setVisibleLogicalRange({ from: view.from + addedCount, to: view.to + addedCount });
    } else {
      // Fresh symbol/interval — reset lazy-load state and refit.
      exhaustedRef.current = false;
      chart.timeScale().fitContent();
    }
    prevFirstTimeRef.current = candles[0].time;
  }, [candles]);

  // Overlays (moving averages etc.) — replaced wholesale on change.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    for (const s of overlaySeriesRef.current) {
      try { chart.removeSeries(s); } catch { /* already gone */ }
    }
    overlaySeriesRef.current = [];
    for (const ov of overlays) {
      const line = chart.addLineSeries({
        color: ov.color,
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      line.setData(ov.points);
      overlaySeriesRef.current.push(line);
    }
  }, [overlays]);

  return <div ref={containerRef} style={{ height }} className="w-full" />;
}
