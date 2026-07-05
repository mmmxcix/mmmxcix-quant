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
  timeScale: { borderColor: "#1c2433", timeVisible: true, secondsVisible: false },
};

// Candlestick chart with optional volume histogram and line overlays
// (e.g. moving averages). overlays: [{ label, color, points: [{time, value}] }]
export default function CandleChart({ candles, overlays = [], showVolume = true, height = 440 }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      ...THEME,
      height,
      width: containerRef.current.clientWidth,
      autoSize: false,
    });
    chartRef.current = chart;

    const candleSeries = chart.addCandlestickSeries({
      upColor: "#10b981",
      downColor: "#ef4444",
      borderUpColor: "#10b981",
      borderDownColor: "#ef4444",
      wickUpColor: "#10b98188",
      wickDownColor: "#ef444488",
    });
    candleSeries.setData(candles);

    if (showVolume) {
      const volSeries = chart.addHistogramSeries({
        priceFormat: { type: "volume" },
        priceScaleId: "vol",
        color: "#1c2433",
      });
      chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      volSeries.setData(
        candles.map((c) => ({
          time: c.time,
          value: c.volume,
          color: c.close >= c.open ? "#10b98133" : "#ef444433",
        }))
      );
    }

    for (const ov of overlays) {
      const line = chart.addLineSeries({
        color: ov.color,
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      line.setData(ov.points);
    }

    chart.timeScale().fitContent();

    const ro = new ResizeObserver(() => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth });
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, [candles, overlays, showVolume, height]);

  return <div ref={containerRef} style={{ height }} className="w-full" />;
}
